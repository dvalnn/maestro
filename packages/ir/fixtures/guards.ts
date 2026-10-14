type Settled = {
	outcome: "ok" | "skipped" | "rejected" | "failed";
	value?: { text?: string };
};

export function plan(): { parts: string[] } {
	return { parts: ["intro", "body", "outro"] };
}

export function partKey(item: string): string {
	return item;
}

export function merge(ports: { parts: Settled[]; separator: string }): {
	text: string;
	nonEmpty: boolean;
} {
	const texts = ports.parts.flatMap((p) =>
		p.value?.text ? [p.value.text] : [],
	);
	return { text: texts.join(ports.separator), nonEmpty: texts.length > 0 };
}

export function summarize(ports: { text: string }): { summary: string } {
	return { summary: ports.text.slice(0, 80) };
}
