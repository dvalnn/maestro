import { expect, test } from "bun:test";
import type { Rejection } from "@maestro/sdk";
import { checkNotes } from "./notes";

const ref = (n: number) =>
	`[#${n}](https://git.amorimcasa.org/tiago/maestro/issues/${n})`;

/** Notes in the release structure: a heading per section, and the given `fixed` bullet under `## Fixed`. */
const notesWith = (
	fixed = `- \`ls\` reads the compact row of a running concert. (${ref(713)}, ${ref(718)})`,
) => `The fourth stable release. \`ls --json\` is lean.

## Install or upgrade

\`\`\`sh
curl -fsSL https://raw.githubusercontent.com/dvalnn/maestro/next/install.sh | sh
\`\`\`

## Upgrade notes

- **The record store moves to schema version 10.** The first command of this release upgrades it.

## Added

- \`maestro config <concert>\` shows the config a concert was performed under, with where each value came from.
  (${ref(716)})

## Changed

- \`ls --json\` rows hold what places a concert. (${ref(713)})

## Fixed

${fixed}
`;

/** Expects `result` to be a rejection whose reason names each of `named`: a heading, a section or a bullet. */
function expectRejected(result: unknown, ...named: string[]) {
	expect(result).toMatchObject({ outcome: "rejected" });
	const { reason } = result as Rejection;
	expect(named.filter((name) => !reason.includes(name))).toEqual([]);
}

const BARE = "- `ls` reads the compact row of a running concert.";

// Seam: checkNotes passes notes in the release structure on, and rejects the rest naming each problem.
test("notes with the required heading and a ref on every Added, Changed and Fixed bullet pass unchanged, a wrapped ref too", () => {
	const notes = notesWith();
	expect(checkNotes({ notes })).toEqual({ notes });
});

test("notes missing the Install or upgrade heading are rejected", () => {
	const notes = notesWith().replace("## Install or upgrade", "## Install");
	expectRejected(checkNotes({ notes }), "`## Install or upgrade`");
});

test.each(["Added", "Changed", "Fixed"])(
	"a bullet with no issue ref under ## %s is rejected",
	(section) => {
		const notes = notesWith().replace(
			`## ${section}\n`,
			`## ${section}\n\n${BARE}\n`,
		);
		expectRejected(checkNotes({ notes }), `## ${section}`, BARE);
	},
);

test.each([
	["a bare #N", `${BARE} (#713)`],
	[
		"a link to another host",
		`${BARE} ([#713](https://github.com/dvalnn/maestro/issues/713))`,
	],
])("%s is not an issue ref", (_, fixed) => {
	expectRejected(checkNotes({ notes: notesWith(fixed) }), "## Fixed", fixed);
});

test("notes with two problems report both", () => {
	const notes = notesWith(BARE).replace("## Install or upgrade", "## Install");
	expectRejected(
		checkNotes({ notes }),
		"`## Install or upgrade`",
		"## Fixed",
		BARE,
	);
});
