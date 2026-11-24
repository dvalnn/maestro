import { copyMarkdown, toMarkdown } from "@maestro/classics";
import {
	type changeset,
	check,
	fork,
	fresh,
	read,
	seat,
} from "@maestro/host-repo-sdk";
import {
	type ArtifactRef,
	code,
	literal,
	Markdown,
	type Ref,
} from "@maestro/sdk";
import GROUNDS from "./prompts/_grounds.md" with { type: "text" };
import PLAIN from "./prompts/_plain.md" with { type: "text" };
import TEST_GROUNDS from "./prompts/_test-grounds.md" with { type: "text" };
import PROVER from "./prompts/prover.md" with { type: "text" };

/** A seat's task: `parts`, each a prompt file or fragment, a blank line apart. */
export const task = (...parts: string[]) => parts.join("\n\n");

/** One base version of the target, sealed by a no-op check, for every seat of a read-only composition to read. */
export const sealedBase = () =>
	check(fresh(), { run: "true" }, { label: "base" }).out.lane;

/**
 * `text` as a Markdown file, by a code node labelled `label`; the calling composition must export `toMarkdown`
 * (ADR 0008).
 */
export const markdownOf = (text: Ref<string> | string, label: string) =>
	code(toMarkdown, {
		in: { text },
		out: { file: Markdown() },
		label,
	}).out.file;

/**
 * The parameter file at `path` as a copy in a code node's scratch, by a node labelled `label`, so the agent's recorded
 * inputs hold what it read; the calling composition must export `copyMarkdown` (ADR 0008).
 */
export const fileOf = (path: ArtifactRef, label: string) =>
	code(copyMarkdown, {
		in: { file: literal(path, Markdown()) },
		out: { file: Markdown() },
		label,
	}).out.file;

/** Every ground, which the consolidator rules a finding by whatever lens found it. */
export const JUDGED = task(GROUNDS, TEST_GROUNDS);

type Lane = Parameters<typeof read>[0];

/** The shell word for a base, and the environment it reads. */
export type Base = { word: string; env?: Record<string, string> };

/** The lane's own base. */
export const LANE_BASE: Base = { word: '"$MAESTRO_LANE_BASE"' };

/**
 * A check of `command` in a read of `lane`, whose `output` is `$MAESTRO_CHECK_OUTPUT`. `command` is given the shell
 * word for `base`. Tolerates a rejection.
 */
export const onBase = (
	lane: Lane,
	base: Base,
	command: (base: string) => string,
	label: string,
) =>
	check(
		read(lane),
		{
			run: command(base.word),
			timeout: "10m",
			...(base.env && { env: base.env }),
		},
		{ label, tolerate: "rejected" },
	);

/** The recipe `just <recipe> <out> <base>`, as a command of `onBase`. */
export const recipe = (name: string) => (base: string) =>
	`just ${name} "$MAESTRO_CHECK_OUTPUT" ${base}`;

/**
 * The prover's script run on the base's tree and the lane, then the files of `.proof` copied into `scripts/` of the
 * output, which the tick reads as regular files only. Shell and no recipe: the lane under proof must not hold its own harness,
 * and a lane cut before the recipe existed is proved too. One line, as each line of a check runs in its own shell.
 */
export const proving = (base: string) =>
	[
		'tree="$(mktemp -d)"',
		`git archive ${base} | tar -x -C "$tree"`,
		'(cd "$tree" && bun install --frozen-lockfile >/dev/null)',
		'sh .proof/prove.sh "$tree" "$PWD" "$MAESTRO_CHECK_OUTPUT"',
		'mkdir "$MAESTRO_CHECK_OUTPUT/scripts"',
		'find .proof -maxdepth 1 -type f -exec cp {} "$MAESTRO_CHECK_OUTPUT/scripts/" \\;',
	].join(" && ");

const prover = seat("prover");

/**
 * A prover that writes `.proof/prove.sh` for `claims` in a fork of `lane`, so `.proof/` never enters a changeset taken
 * from `lane`. `start` is the changeset whose `base` file names the commit the change starts from, which the prover
 * builds the base tree from.
 */
export const proverOn = (
	lane: Lane,
	claims: string,
	start: ReturnType<typeof changeset>["out"]["changeset"],
) =>
	prover({
		label: "prover",
		task: task(PROVER, PLAIN, `## claims\n\n${claims}`),
		lane: fork(lane),
		attachments: {
			changes: {
				artifact: start,
				hint: "for its `base` file: the commit the change starts from",
			},
		},
		tolerate: "rejected",
	});
