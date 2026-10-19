import {
	changeset,
	check,
	fork,
	fresh,
	JsonOut,
	read,
} from "@maestro/host-repo-sdk";
import {
	code,
	composition,
	iter,
	List,
	lookup,
	Markdown,
	readJson,
	Text,
	use,
} from "@maestro/sdk";
import { dossierOf, riskKey, toMarkdown, traceOf } from "./code";
import { EXAMPLE_REQUEST, maxRepairs, repairUntilGreen } from "./repair";
import { panel } from "./review";
import { builder, documenter, planner, scout } from "./seats";
import { atLeastOne, Design, Risk } from "./types";

/** Each angle a scout looks from, by name, as its task. */
const ANGLES = {
	map: "Map where the request lands: the files, functions and tests it touches.",
	proof:
		"Find how the target proves its behaviour: its checks and tests, how they run, and which would show the request met.",
	risk: "Find what could go wrong in making the request: fragile code, callers it could break, edge cases.",
};

const ANGLE_NAMES = ["map", "proof", "risk"] as const;

const planTask = (maxApproaches: number) =>
	`Plan the request. Write the plan in plan.md. In design.json, give its acceptance criteria, numbered C1 on, each with its proof, and up to ${maxApproaches} approaches, numbered A1 on, the preferred first.`;

const DOCUMENT_TASK =
	"Write up the change in notes.md. In acceptance.json, rule on each criterion of the design, by its id, against the request and the patches.";

export const vModel = composition(
	"v_model",
	{
		doc: "Deliver a request down and up a V: scouts, a plan and a build on the left, each verified on the right by its mirror: checks, a review of every scouted risk, and acceptance traced back to the plan's criteria.",
		params: {
			request: Text({ description: "What to build" }),
			maxApproaches: atLeastOne(2, "The most approaches the plan may give"),
			maxRisks: atLeastOne(4, "The most scouted risks the review rules on"),
			maxRepairs,
		},
		examples: [{ request: EXAMPLE_REQUEST }],
	},
	(p) => {
		const spec = code(toMarkdown, {
			in: { text: p.request },
			out: { file: Markdown() },
			label: "request",
		});
		const request = {
			artifact: spec.out.file,
			hint: "for what the change must do",
		};
		// A no-op check seals one base version that every level reads or forks.
		const base = check(fresh(), { run: "true" }, { label: "base" });

		const scouts = iter.parMap(
			ANGLE_NAMES,
			(angle) =>
				scout({
					label: "scout",
					task: lookup(ANGLES, angle),
					lane: read(base.out.lane),
					attachments: { request },
				}),
			{ onError: "continue", label: "scouts" },
		);
		const dossier = code(dossierOf, {
			in: {
				scouts: scouts.out.results,
				angles: ANGLE_NAMES,
				maxRisks: p.maxRisks,
			},
			out: { dossier: Markdown(), risks: List(Risk) },
		});

		const plan = planner({
			label: "plan",
			task: planTask(p.maxApproaches),
			lane: read(base.out.lane),
			attachments: {
				request,
				dossier: {
					artifact: dossier.out.dossier,
					hint: "for what the scouts found and the risks they raised",
				},
			},
			out: { design: JsonOut("design.json", Design(p.maxApproaches)) },
		});
		const design = readJson(plan.out.design);
		const planned = {
			artifact: plan.out.plan,
			hint: "for how to make the change",
		};

		const built = iter.find(
			design.get("approaches"),
			(approach) =>
				use(
					repairUntilGreen,
					{
						lane: builder({
							label: "build",
							task: approach.get("approach"),
							lane: fork(base.out.lane),
							attachments: { request, plan: planned },
						}).out.lane,
						spec: plan.out.plan,
					},
					{ params: { maxRepairs: p.maxRepairs } },
				),
			(result) => result.ok,
			{ max: p.maxApproaches, label: "approaches" },
		);

		const patches = changeset(built.out.lane, { label: "patches" });
		const reviewed = panel({
			items: dossier.out.risks,
			task: (risk) => risk.get("risk"),
			key: riskKey,
			max: p.maxRisks,
			change: built.out.lane,
			patches: patches.out.changeset,
			spec: plan.out.plan,
			design: plan.out.design,
		});

		const accepted = documenter({
			label: "document",
			task: DOCUMENT_TASK,
			lane: read(built.out.lane),
			attachments: {
				request,
				plan: planned,
				design: {
					artifact: plan.out.design,
					hint: "for the criteria to rule on",
				},
				review: {
					artifact: reviewed.out.review,
					hint: "for how the review ruled",
				},
				patches: {
					artifact: patches.out.changeset,
					hint: "first, for what the change did, patch by patch",
				},
			},
		});
		const traced = code(traceOf, {
			in: {
				design,
				verdict: readJson(reviewed.out.verdict),
				acceptance: readJson(accepted.out.acceptance),
			},
			out: { trace: Markdown() },
		});
		return changeset(built.out.lane, { label: "result", when: traced.ok });
	},
);
