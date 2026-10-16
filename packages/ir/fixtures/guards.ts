import type { Settled } from "../src/outcome";

export function plan(): { parts: string[] } {
	return { parts: ["intro", "body", "outro"] };
}

export function partKey(item: string): string {
	return item;
}

export function merge(ports: {
	parts: Settled<{ result?: { text?: string } }>[];
	separator: string;
}): {
	text: string;
	nonEmpty: boolean;
} {
	const texts = ports.parts.flatMap((p) => {
		const text = p.value?.result?.text;
		return text ? [text] : [];
	});
	return { text: texts.join(ports.separator), nonEmpty: texts.length > 0 };
}

export function summarize(ports: { text: string }): { summary: string } {
	return { summary: ports.text.slice(0, 80) };
}
