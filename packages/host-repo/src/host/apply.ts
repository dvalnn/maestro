import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
	HostContext,
	HostInstance,
	HostNodeResult,
	NodeKind,
} from "@maestro/core/host";
import type { Inputs } from "@maestro/core/node";
import { CORE_TYPES, MAESTRO_TYPE, type Ports } from "@maestro/ir";
import type { Changeset } from "../lane/index";
import {
	APPLY_CONFIG,
	APPLY_KIND,
	type ApplyConfig,
	applyConfig,
	CHANGESET_CONFIG,
	CHANGESET_KIND,
	CHANGESET_PORT,
	COMMITS_CONFIG,
	COMMITS_KIND,
	commitsConfig,
	LANE_PORT,
	repoSetup,
	requireTarget,
} from "./config";
import { artifactInput, textInput } from "./inputs";
import {
	baseOf,
	lanePorts,
	laneVersion,
	versionAt,
	withLane,
} from "./lane-input";
import { type Live, liveInstances } from "./live";
import { openTarget } from "./store";

/** The file in a changeset directory that names the target commit its patches were cut from. */
export const BASE_FILE = "base";
const PATCH_EXT = ".patch";
const PATCH_DIGITS = 4;
const DIGITS = /^\d+$/;

/** The file in a changeset directory that holds its commit message, when it has one. */
export const MESSAGE_FILE = "message";
const MESSAGE_PORT = "message";

const CHANGESET_DIR = "changeset";

/**
 * Writes `changeset` into the directory `dir`, replacing what is there: its `base` file, and its patches as `0001.patch`,
 * `0002.patch` and on, which `git am` applies in name order, and a `message` file when it has a commit message.
 * Returns `dir`.
 */
export function writeChangeset(
	dir: string,
	changeset: Changeset,
	message: string | undefined,
): string {
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, BASE_FILE), `${changeset.base}\n`);
	if (message !== undefined) writeFileSync(join(dir, MESSAGE_FILE), message);
	for (const [i, patch] of changeset.patches.entries())
		writeFileSync(
			join(dir, `${String(i + 1).padStart(PATCH_DIGITS, "0")}${PATCH_EXT}`),
			patch,
		);
	return dir;
}

/** The number in the patch file name `f`, or `undefined` when `f` is not a patch file. */
function patchIndex(f: string): number | undefined {
	const digits = f.endsWith(PATCH_EXT) ? f.slice(0, -PATCH_EXT.length) : "";
	return DIGITS.test(digits) ? Number(digits) : undefined;
}

/** The names of the patch files in the changeset directory `dir`, in the order they apply. */
export const patchFiles = (dir: string): string[] =>
	readdirSync(dir)
		.flatMap((f) => {
			const index = patchIndex(f);
			return index === undefined ? [] : [{ f, index }];
		})
		.sort((a, b) => a.index - b.index)
		.map(({ f }) => f);

/**
 * The changeset in `dir`, the artifact on the apply node's `changeset` port.
 * @throws Error when `dir` has no `base` file.
 */
function readChangeset(dir: string): Changeset {
	let base: string;
	try {
		base = readFileSync(join(dir, BASE_FILE), "utf8").trim();
	} catch {
		throw new Error(
			`input '${CHANGESET_PORT}' is not a changeset: it has no '${BASE_FILE}' file. Wire it from a '${CHANGESET_KIND}' node's '${CHANGESET_PORT}' output`,
		);
	}
	const patches = patchFiles(dir).map((f) =>
		readFileSync(join(dir, f), "utf8"),
	);
	return { base, patches };
}

async function executeChangeset(
	inputs: Inputs,
	context: HostContext,
): Promise<HostNodeResult> {
	const setup = repoSetup(context.setup);
	const store = openTarget(setup.store, requireTarget(setup).repo);
	const changeset = await store.lanes.changeset(laneVersion(inputs[LANE_PORT]));
	const message =
		inputs[MESSAGE_PORT] === undefined
			? undefined
			: textInput(inputs, MESSAGE_PORT);
	return {
		outcome: "ok",
		outputs: {
			[CHANGESET_PORT]: writeChangeset(
				join(context.scratch, CHANGESET_DIR),
				changeset,
				message,
			),
		},
	};
}

/** The `repo.changeset` kind: the patch series of a lane version, as an artifact. */
export function changesetKind(): NodeKind {
	return {
		name: CHANGESET_KIND,
		config: CHANGESET_CONFIG,
		ports: (node) => ({
			in: {
				...lanePorts({ mode: "read" }).in,
				...(Object.hasOwn(node.in ?? {}, MESSAGE_PORT)
					? { [MESSAGE_PORT]: { type: "string" } }
					: {}),
			},
			out: { [CHANGESET_PORT]: { [MAESTRO_TYPE]: CORE_TYPES.dir } },
		}),
		execute: (_, inputs, context) => executeChangeset(inputs, context),
		cancel: async () => {},
	};
}

async function executeCommits(
	instance: HostInstance,
	context: HostContext,
): Promise<HostNodeResult> {
	const setup = repoSetup(context.setup);
	const store = openTarget(setup.store, requireTarget(setup).repo);
	const at = versionAt(context.concert, instance);
	await store.lanes.commits(
		commitsConfig(instance.node.config).revs,
		baseOf(setup),
		at,
	);
	return { outcome: "ok", outputs: { [LANE_PORT]: at } };
}

/** The `repo.commits` kind: the target commits git revisions name, as a lane version. It opens no lane. */
export function commitsKind(): NodeKind {
	return {
		name: COMMITS_KIND,
		config: COMMITS_CONFIG,
		ports: () => lanePorts({ mode: "fresh" }),
		execute: (instance, _, context) => executeCommits(instance, context),
		cancel: async () => {},
	};
}

const conflictReason = (files: string[], strategy?: string) => {
	const named = files.map((f) => `'${f}'`).join(", ");
	return strategy === "clean"
		? `changeset does not apply cleanly to ${named}. Use strategy 3way to merge it into a version an agent can resolve`
		: `changeset conflicts in ${named}. Extend the lane output in an agent that resolves them`;
};

async function executeApply(
	instance: HostInstance,
	inputs: Inputs,
	context: HostContext,
	live: Live,
): Promise<HostNodeResult> {
	const setup = repoSetup(context.setup);
	const config = applyConfig(instance.node.config);
	const target = requireTarget(setup);
	const store = openTarget(setup.store, target.repo, target.sparse);
	const changeset = readChangeset(
		artifactInput(inputs, context, CHANGESET_PORT),
	);
	const run = { concert: context.concert, instance, live, emit: context.emit };
	return withLane(
		store,
		setup,
		config.lane,
		inputs[LANE_PORT],
		run,
		async ({ lane }) => {
			const conflicts = await lane.apply(changeset, config.strategy);
			const outputs = { [LANE_PORT]: await lane.seal() };
			if (!conflicts.length) return { outcome: "ok", outputs };
			return {
				outcome: "rejected",
				reason: conflictReason(conflicts, config.strategy),
				outputs,
			};
		},
	);
}

const applyPorts = (config: ApplyConfig): { in: Ports; out: Ports } => {
	const lane = lanePorts(config.lane);
	return {
		in: { ...lane.in, [CHANGESET_PORT]: { [MAESTRO_TYPE]: CORE_TYPES.dir } },
		out: lane.out,
	};
};

/** The `repo.apply` kind: a changeset applied to a lane, which a conflict leaves for an agent to extend. */
export function applyKind(): NodeKind {
	const live = liveInstances();
	return {
		name: APPLY_KIND,
		config: APPLY_CONFIG,
		ports: (node) => applyPorts(applyConfig(node.config)),
		execute: (instance, inputs, context) =>
			live.execute(instance, (state) =>
				executeApply(instance, inputs, context, state),
			),
		cancel: (instance) => live.cancel(instance),
	};
}
