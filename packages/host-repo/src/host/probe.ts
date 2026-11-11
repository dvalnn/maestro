import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { HostSetup } from "@maestro/core/host";
import type {
	Harness,
	HarnessEvent,
	HarnessRequest,
	ObservedEnvironment,
} from "../harness/index";
import { attachmentPath, type Profile } from "../profile/index";
import {
	profileAttached,
	profileSkills,
	sessionsOf,
	skillBinds,
	stage,
} from "./agent";
import { repoSetup } from "./config";
import { type Run, WORK } from "./frame";
import { pathBinds } from "./run-lines";
import { contextIn } from "./windows";

/** The user message of a probe. The harness reports its environment before the model answers it. */
const PROBE_PROMPT = "Reply with ok.";

/**
 * The request that starts `profile`'s agent as a concert would, under `scratch`, an empty directory: the same sandbox
 * binds, instructions, attachments and harness extras, an empty lane, no checks and no outputs. A context policy
 * that needs a window none is known for is left out, as the probe is what finds it.
 */
export function probeRequest(
	profile: Profile,
	setup: HostSetup,
	scratch: string,
): HarnessRequest {
	const repo = repoSetup(setup);
	const { runtime, instructions, readOnly, context, harnessExtras } =
		profile.fields;
	const policy = contextIn(profile, repo.store);
	const attachments = Object.entries(profile.fields.attachments);
	const made = (name: string) => {
		const dir = join(scratch, name);
		mkdirSync(dir);
		return dir;
	};
	const told: Run = {
		lane: "write",
		checks: [],
		attachments: profileAttached(profile),
		skills: profileSkills(profile),
		out: [],
		kind: WORK,
		sessions:
			context?.strategy === "handoff" ? sessionsOf(context.max) : undefined,
	};
	return {
		runtime,
		prompt: PROBE_PROMPT,
		lane: made("lane"),
		readOnly: [
			...pathBinds(repo.readOnly, readOnly),
			...attachments.map(([name, a]) => ({
				src: a.path,
				dst: attachmentPath(name),
			})),
			...skillBinds(profile),
		],
		env: { PATH: repo.path },
		instructions: stage(made("staged"), PROBE_PROMPT, instructions, told),
		outbox: made("out"),
		outputs: [],
		session: { dir: made("session"), id: crypto.randomUUID() },
		...(!("message" in policy) && policy),
		...(harnessExtras !== undefined && { extras: harnessExtras }),
	};
}

/** How long a probe waits for the environment report before it stops the harness. */
export const PROBE_TIMEOUT_MS = 60_000;
const MS_PER_S = 1000;

/** What a probe saw: the harness's environment report and the model's context window in tokens, each if reported. */
export type Probed = { observed?: ObservedEnvironment; window?: number };

/** Notes what `e` reports in `seen`. Returns whether `seen` then holds both the environment and the window. */
function note(seen: Probed, e: HarnessEvent): boolean {
	if (e.kind === "window") seen.window = e.tokens;
	if (e.kind === "environment") {
		const { kind: _, ...observed } = e;
		seen.observed = observed;
	}
	return seen.observed !== undefined && seen.window !== undefined;
}

/**
 * Starts `harness` on `req` and kills it once it has reported both its environment and the model's window, or once
 * `timeoutMs` pass. Returns what it reported, nothing when it reported neither before its run ended.
 * @throws Error with the run's reason when it failed on its own, even after a partial report, or when the time ran out
 * with no report.
 */
export async function probe(
	harness: Harness,
	req: HarnessRequest,
	timeoutMs = PROBE_TIMEOUT_MS,
): Promise<Probed> {
	const run = harness.run(req);
	let late = false;
	const timer = setTimeout(() => {
		late = true;
		void run.cancel();
	}, timeoutMs);
	const seen: Probed = {};
	try {
		for await (const e of run.events)
			if (note(seen, e)) {
				await run.cancel();
				return seen;
			}
		const result = await run.result;
		// The probe's own stop is no failure of the run: it returns what was reported, if anything was.
		if (late && Object.keys(seen).length > 0) return seen;
		if (late)
			throw new Error(`no startup report within ${timeoutMs / MS_PER_S}s`);
		if (result.outcome === "failed")
			throw new Error(result.reason ?? "the harness failed");
		return seen;
	} finally {
		clearTimeout(timer);
	}
}
