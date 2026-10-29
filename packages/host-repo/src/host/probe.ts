import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { HostSetup } from "@maestro/core/host";
import type {
	Harness,
	HarnessRequest,
	ObservedEnvironment,
} from "../harness/index";
import { attachmentPath, type Profile } from "../profile/index";
import { sessionsOf, stage } from "./agent";
import { repoSetup } from "./config";
import { frame, type Run, WORK } from "./frame";
import { pathBinds } from "./run-lines";

/** The user message of a probe. The harness reports its environment before the model answers it. */
const PROBE_PROMPT = "Reply with ok.";

/**
 * The request that starts `profile`'s agent as a concert would, under `scratch`, an empty directory: the same sandbox
 * binds, instructions and attachments, an empty lane, no checks and no outputs.
 */
export function probeRequest(
	profile: Profile,
	setup: HostSetup,
	scratch: string,
): HarnessRequest {
	const repo = repoSetup(setup);
	const { runtime, instructions, readOnly, context } = profile.fields;
	const attachments = Object.entries(profile.fields.attachments);
	const made = (name: string) => {
		const dir = join(scratch, name);
		mkdirSync(dir);
		return dir;
	};
	const told: Run = {
		lane: "write",
		checks: [],
		attachments: attachments.map(([name, a]) => [name, a.hint]),
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
		],
		env: { PATH: repo.path },
		instructions: stage(
			made("staged"),
			PROBE_PROMPT,
			instructions,
			frame(told),
		),
		outbox: made("out"),
		outputs: [],
		session: { dir: made("session"), id: crypto.randomUUID() },
		context,
	};
}

/** How long a probe waits for the environment report before it stops the harness. */
export const PROBE_TIMEOUT_MS = 60_000;
const MS_PER_S = 1000;

/**
 * Starts `harness` on `req` and kills it at its environment report, or once `timeoutMs` pass without one. Returns the
 * report, or nothing when the run ended without one.
 * @throws Error with the run's reason when it failed before it reported, or when the time ran out.
 */
export async function probe(
	harness: Harness,
	req: HarnessRequest,
	timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ObservedEnvironment | undefined> {
	const run = harness.run(req);
	let late = false;
	const timer = setTimeout(() => {
		late = true;
		void run.cancel();
	}, timeoutMs);
	try {
		for await (const e of run.events) {
			if (e.kind !== "environment") continue;
			await run.cancel();
			const { kind: _, ...observed } = e;
			return observed;
		}
		if (late)
			throw new Error(`no startup report within ${timeoutMs / MS_PER_S}s`);
		const result = await run.result;
		if (result.outcome === "failed")
			throw new Error(result.reason ?? "the harness failed");
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}
