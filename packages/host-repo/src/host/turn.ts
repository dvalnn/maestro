import {
	cpSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "@maestro/core";
import { validator, violations } from "@maestro/ir";
import { attachmentPath } from "../profile/index";
import type { Bind } from "../sandbox/index";
import { previousPath } from "./frame";
import type { Session } from "./store";

/** Under a session's home: its last settled turn, which names the directory of its attachments' copies. */
const TURN_FILE = "turn.json";
/** The name prefix of a directory of one turn's attachment copies, under a session's home. */
const COPIES = "attachments-";

/** What one turn of a session was given. */
export type Turn = {
	task: string;
	/** The content digest of each attachment, by name. */
	attachments: Record<string, string>;
	/** The commit its working copy stood on. */
	commit: string;
	/** The digest of the frame's `## Reply` section. */
	reply: string;
};

const TEXT = { type: "string" } as const;
/** A kept turn, and the directory under the session's home holding its attachments' copies. */
type Kept = Turn & { copies: string };

const KEPT_SCHEMA = {
	type: "object",
	required: ["task", "attachments", "commit", "reply", "copies"],
	additionalProperties: false,
	properties: {
		task: TEXT,
		attachments: { type: "object", additionalProperties: TEXT },
		commit: TEXT,
		reply: TEXT,
		copies: { type: "string", pattern: `^${COPIES}` },
	},
} as const;

const ajv = validator();

/** The SHA-256 of a file's bytes, a link's target, or a directory's sorted entries with their digests. */
function digestOf(path: string): string {
	const stats = lstatSync(path);
	if (stats.isSymbolicLink()) return sha256Hex(`link\0${readlinkSync(path)}`);
	if (!stats.isDirectory()) return sha256Hex(readFileSync(path));
	const entries = readdirSync(path)
		.sort()
		.map((name) => `${name}\0${digestOf(join(path, name))}\0`);
	return sha256Hex(`dir\0${entries.join("")}`);
}

/** The content digest of each attachment at its host path in `sources`, by name. */
export const digests = (sources: Record<string, string>) =>
	Object.fromEntries(
		Object.entries(sources).map(([name, src]) => [
			name,
			digestOf(realpathSync(src)),
		]),
	);

/**
 * The last settled turn of `session`.
 * @throws Error when the store holds none, or it is malformed.
 */
function lastTurn(session: Session): Kept {
	const file = join(session.home, TURN_FILE);
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		value = undefined;
	}
	if (violations(ajv, KEPT_SCHEMA, value, () => file).length)
		throw new Error(
			`session ${session.id} has no readable last turn at '${file}'. Perform the composition anew`,
		);
	return value as Kept;
}

/** The attachments line, and the earlier copies a changed attachment binds under `previousPath`. */
function attachmentsSince(session: Session, last: Kept, now: Turn) {
	const parts: string[] = [];
	const readOnly: Bind[] = [];
	for (const [name, hash] of Object.entries(now.attachments)) {
		const before = last.attachments[name];
		if (before === hash) continue;
		if (before === undefined) {
			parts.push(`\`${attachmentPath(name)}\` new`);
			continue;
		}
		parts.push(
			`\`${attachmentPath(name)}\` changed, the earlier copy at \`${previousPath(name)}\``,
		);
		readOnly.push({
			src: join(session.home, last.copies, name),
			dst: previousPath(name),
		});
	}
	for (const name of Object.keys(last.attachments))
		if (!Object.hasOwn(now.attachments, name))
			parts.push(`\`${attachmentPath(name)}\` dropped`);
	return { line: parts.join("; ") || "unchanged", readOnly };
}

const workingCopy = (last: Turn, now: Turn) =>
	last.commit === now.commit
		? "unchanged"
		: `was \`${last.commit}\`, now \`${now.commit}\`; \`git diff ${last.commit} ${now.commit}\` shows what changed`;

/**
 * The user message of a turn that continues `session`, given `now`: what changed since its last settled turn, then the
 * task, and the earlier copies of its changed attachments to bind read-only.
 * @throws Error as `lastTurn` does.
 */
export function continuation(
	session: Session,
	now: Turn,
): { message: string; readOnly: Bind[] } {
	const last = lastTurn(session);
	const attachments = attachmentsSince(session, last, now);
	const lines = [
		`- Task: ${last.task === now.task ? "unchanged" : "changed, the new text below"}.`,
		`- Attachments: ${attachments.line}.`,
		`- Working copy: ${workingCopy(last, now)}.`,
		...(last.reply === now.reply ? [] : ["- Contract: changed."]),
	];
	return {
		message: [
			"# Since your last turn",
			lines.join("\n"),
			"# Task",
			now.task,
		].join("\n\n"),
		readOnly: attachments.readOnly,
	};
}

/**
 * Keeps `turn` as the last settled turn of `session`, with a copy of each attachment at its host path in `sources`. One
 * rename replaces the earlier turn, so a run cut short leaves that one in place.
 */
export function keepTurn(
	session: Session,
	turn: Turn,
	sources: Record<string, string>,
) {
	const copies = `${COPIES}${crypto.randomUUID()}`;
	mkdirSync(join(session.home, copies));
	for (const [name, src] of Object.entries(sources))
		cpSync(realpathSync(src), join(session.home, copies, name), {
			recursive: true,
		});
	const next = join(session.home, `${TURN_FILE}.next`);
	writeFileSync(next, JSON.stringify({ ...turn, copies } satisfies Kept));
	renameSync(next, join(session.home, TURN_FILE));
	for (const name of readdirSync(session.home))
		if (name.startsWith(COPIES) && name !== copies)
			rmSync(join(session.home, name), { recursive: true, force: true });
}
