// The worked examples of sdk-spec 14 that need no host, with the fake host kind standing in for host nodes.

import {
	Bool,
	code,
	composition,
	firstOk,
	hostNode,
	Int,
	List,
	loop,
	map,
	not,
	type Ref,
	seq,
	Text,
	use,
} from "../index";
import { buildValid } from "./context";
import { renderOk } from "./workers";

const task = (inputs: Record<string, unknown>, label?: string) =>
	hostNode("fake.task", { label, in: inputs, out: { text: Text() } });

const check = (text: Ref<string>) =>
	hostNode("fake.check", { in: { text }, out: { text: Text(), logs: Text() } });

/** Repair until green: check, then repair while the check is red, bounded by a param. */
export const fixUntilGreen = composition(
	"fix_until_green",
	{
		ports: { draft: Text(), prompt: Text() },
		params: { maxRepairs: Int({ default: 2 }) },
	},
	({ maxRepairs }, { draft, prompt }) =>
		loop.while((checked) => not(checked.ok), {
			init: check(draft),
			step: (checked, i) =>
				check(task({ prompt, failures: checked.out.logs, index: i }).out.text),
			max: maxRepairs,
			tolerate: "rejected",
		}),
);

const Params = {
	models: List(Text(), { default: ["small", "large"] }),
	prompt: Text({ default: "write it" }),
};

const triedOn = (model: Ref<string>, prompt: string) =>
	use(fixUntilGreen, { draft: task({ prompt, model }).out.text, prompt });

/** Escalate over models: stop at the first that ends green. */
export const escalate = composition(
	"escalate",
	{ params: Params, examples: [{}] },
	({ models, prompt }) =>
		seq(models, (m) => triedOn(m, prompt), { until: (r) => r.ok }),
);

/** Fan out over models, and keep the first that ends green. */
export const fanout = composition(
	"fanout",
	{ params: Params, examples: [{}] },
	({ models, prompt }) =>
		firstOk(
			map(models, (m) => triedOn(m, prompt), { onError: "settle" }).out.results,
		),
);

/** Plan from several angles, then synthesize, falling back to a plan that succeeded (ADR 0006). */
export const planPanel = composition(
	"plan_panel",
	{
		params: { angles: List(Text(), { default: ["risk", "cost"] }) },
		examples: [{}],
	},
	({ angles }) => {
		const scout = task({ prompt: "scout" }, "scout");
		const plans = map(
			angles,
			(a) => task({ prompt: a, context: scout.out.text }, "plan"),
			{
				onError: "settle",
			},
		);
		const good = code(renderOk, {
			in: { plans: plans.out.results },
			out: { text: Text(), nonEmpty: Bool() },
		});
		const synthesis = hostNode("fake.task", {
			label: "synthesis",
			when: good.out.nonEmpty,
			in: { prompt: good.out.text },
			out: { text: Text() },
		});
		return firstOk<unknown>(
			[synthesis.out.text, firstOk(plans).out.value.pick("result.text")],
			{ label: "answer" },
		);
	},
);

/** The IR of `planPanel`, emitted with the test context. */
export const planPanelIr = () => buildValid(planPanel);
