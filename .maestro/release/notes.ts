import { type Rejection, reject } from "@maestro/sdk";

/** The headings every release's notes carry. */
const REQUIRED = ["Install or upgrade"];
/** The sections each of whose bullets must hold an issue ref somewhere in its text. */
const REFERENCED = new Set(["Added", "Changed", "Fixed"]);
const ISSUE_REF =
	/\[#\d+\]\(https:\/\/git\.amorimcasa\.org\/tiago\/maestro\/issues\/\d+\)/;

type Bullet = { section: string; text: string };

/** The `## ` headings of `notes`, and each top-level bullet with its indented lines and the section it sits in. */
function outlineOf(notes: string): {
	headings: Set<string>;
	bullets: Bullet[];
} {
	const headings = new Set<string>();
	const bullets: Bullet[] = [];
	let section = "";
	for (const line of notes.split("\n")) {
		const last = bullets.at(-1);
		if (line.startsWith("## ")) {
			section = line.slice(3).trim();
			headings.add(section);
		} else if (line.startsWith("- ")) bullets.push({ section, text: line });
		else if (last && line.startsWith("  ")) last.text += `\n${line}`;
	}
	return { headings, bullets };
}

/** Each problem of `notes`: a required heading it lacks, or a bullet under Added, Changed or Fixed with no issue ref. */
function notesProblems(notes: string): string[] {
	const { headings, bullets } = outlineOf(notes);
	return [
		...REQUIRED.filter((h) => !headings.has(h)).map(
			(h) => `missing the heading \`## ${h}\``,
		),
		...bullets
			.filter((b) => REFERENCED.has(b.section) && !ISSUE_REF.test(b.text))
			.map(
				(b) =>
					`a bullet under ## ${b.section} has no issue ref: ${b.text.split("\n")[0]}`,
			),
	];
}

/** The code node that passes release `notes` on unchanged when they keep the release structure, else rejects them naming each problem. */
export function checkNotes({
	notes,
}: {
	notes: string;
}): { notes: string } | Rejection {
	const problems = notesProblems(notes);
	if (problems.length)
		return reject(
			`the release notes break their structure:\n- ${problems.join("\n- ")}`,
		);
	return { notes };
}
