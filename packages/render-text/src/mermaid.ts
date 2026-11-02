/** `s` with the characters Mermaid reads as markup or entities escaped. */
export const escaped = (s: string) =>
	s
		.replaceAll("#", "#35;")
		.replaceAll('"', "#quot;")
		.replaceAll("<", "#lt;")
		.replaceAll(">", "#gt;");

/** A Mermaid label: quoted, its lines escaped and joined by line breaks. */
export const label = (...lines: string[]) =>
	`"${lines.map(escaped).join("<br/>")}"`;

/** Mermaid ids of the start and end markers. `end` is a Mermaid keyword, so it cannot name a node. */
export const START = "start";
export const STOP = "stop";
