import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isPlainObject } from "@maestro/ir";
import {
	type ContextAt,
	type ContextPolicy,
	type Runtime,
	STUB,
} from "../harness/index";
import { PROFILES, type Profile } from "../profile/index";

/** Under the host store: the context window of each model in tokens, by harness, then by model as profiles name it. */
const WINDOWS_FILE = "windows.json";
const PERCENT = 100;

type Windows = Record<string, Record<string, number>>;

/** The windows of `models`, each a whole number of at least 1; any other entry is left out. */
const modelWindows = (models: Record<string, unknown>) =>
	Object.fromEntries(
		Object.entries(models).flatMap(([model, tokens]) =>
			typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens > 0
				? [[model, tokens] as const]
				: [],
		),
	);

/** The windows kept under host store `store`; none when the file is missing or malformed. */
function windowsAt(store: string): Windows {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(join(store, WINDOWS_FILE), "utf8"));
	} catch {
		return {};
	}
	if (!isPlainObject(value)) return {};
	return Object.fromEntries(
		Object.entries(value).flatMap(([harness, models]) =>
			isPlainObject(models) ? [[harness, modelWindows(models)] as const] : [],
		),
	);
}

/** The context window of `runtime`'s model in tokens, as last kept under host store `store`. */
export function windowOf(store: string, { harness, model }: Runtime) {
	const windows = windowsAt(store);
	const models = Object.hasOwn(windows, harness) ? windows[harness] : undefined;
	return models && Object.hasOwn(models, model) ? models[model] : undefined;
}

/** Keeps `tokens` as the context window of `runtime`'s model under host store `store`, over the one kept before. */
export function keepWindow(
	store: string,
	{ harness, model }: Runtime,
	tokens: number,
) {
	const windows = windowsAt(store);
	if (windows[harness]?.[model] === tokens) return;
	windows[harness] = { ...windows[harness], [model]: tokens };
	mkdirSync(store, { recursive: true });
	const path = join(store, WINDOWS_FILE);
	// Written aside and renamed, so a concert reading it never sees half a file.
	const aside = `${path}.${process.pid}`;
	writeFileSync(aside, JSON.stringify(windows));
	renameSync(aside, path);
}

/** `at` in tokens, a percentage of `window` rounded down; undefined for a percentage without a window. */
const tokensOf = (at: ContextAt, window: number | undefined) =>
	"tokens" in at
		? at.tokens
		: window === undefined
			? undefined
			: Math.floor((window * at.percent) / PERCENT);

/** A profile's context policy as its harness takes it, and the model's window, or why it cannot be. */
export type ContextIn =
	| { context?: ContextPolicy; window?: number }
	| { message: string; fix: string };

/**
 * `profile`'s context policy with `at` in tokens, and its model's window, as kept under host store `store`. A stub
 * profile's policy that no window known puts in tokens is dropped, not refused: the stub runs no model.
 */
export function contextIn(profile: Profile, store: string): ContextIn {
	const { runtime, context } = profile.fields;
	const window = windowOf(store, runtime);
	const known = window === undefined ? {} : { window };
	if (context === undefined) return known;
	const at = tokensOf(context.at, window);
	if (at === undefined && runtime.harness === STUB) return known;
	if (at === undefined)
		return {
			message: `${PROFILES}.${profile.name}.context.at: no context window is known for ${runtime.harness} model '${runtime.model}'`,
			fix: `Run maestro agent show ${profile.name} --probe, or write at in tokens`,
		};
	if (window !== undefined && at >= window)
		return {
			message: `${PROFILES}.${profile.name}.context.at: at ${at} tokens is at or past the ${runtime.harness} model '${runtime.model}' window of ${window} tokens`,
			fix: `Set at below ${window}`,
		};
	return { context: { ...context, at }, ...known };
}
