const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * `text` with each `{name}` replaced by its value in `values`.
 * @throws Error when a `{name}` in `text` has no value, or a value has no `{name}` in `text`.
 */
export function fill(
	text: string,
	values: Record<string, string | number>,
): string {
	const used = new Set<string>();
	const filled = text.replace(PLACEHOLDER, (_, name: string) => {
		if (!(name in values))
			throw new Error(
				`the prompt has {${name}} and no value for it\nPass a value for "${name}"`,
			);
		used.add(name);
		return String(values[name]);
	});
	const unused = Object.keys(values).find((k) => !used.has(k));
	if (unused !== undefined)
		throw new Error(
			`the prompt has no {${unused}} for its value\nDrop "${unused}" from the values, or add {${unused}} to the prompt`,
		);
	return filled;
}

/** The prompt parts joined, one blank line between: every part but the last loses its trailing whitespace. */
export const task = (...parts: string[]) =>
	parts
		.map((part, i) => (i < parts.length - 1 ? part.trimEnd() : part))
		.join("\n\n");
