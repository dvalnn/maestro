// Exported functions that code nodes and map keys name. Builds never call them.
import { type ArtifactRef, type CodeContext, reject } from "../index";

export function merge(inputs: { parts: string[]; sep: string }): {
	text: string;
} {
	return { text: inputs.parts.join(inputs.sep) };
}

export function stamp(): { at: number } {
	return { at: 0 };
}

export function verdict(inputs: { text: string }) {
	return inputs.text ? { text: inputs.text } : reject("empty");
}

export function lint(inputs: { text: string }) {
	const findings = inputs.text.split(" ");
	return findings.length > 1 ? reject("dirty", { findings }) : { findings };
}

export function miscount(inputs: { text: string }) {
	return inputs.text
		? { findings: [inputs.text] }
		: reject("dirty", { findings: 0 });
}

export function partKey(item: { name: string }): string {
	return item.name;
}

export function renderOk(inputs: { plans: { outcome: string }[] }): {
	text: string;
	nonEmpty: boolean;
} {
	const ok = inputs.plans.filter((p) => p.outcome === "ok");
	return { text: JSON.stringify(ok), nonEmpty: ok.length > 0 };
}

export function copyOut(
	inputs: { doc: ArtifactRef },
	ctx: CodeContext,
): { copy: string } {
	return { copy: `${ctx.scratch}/${ctx.path(inputs.doc)}` };
}

export async function fetchText(inputs: { url: string }) {
	return inputs.url ? { text: inputs.url } : reject("no url");
}

export function wantsOtherContext(
	_inputs: Record<never, never>,
	ctx: { scratch: number },
): { at: number } {
	return { at: ctx.scratch };
}
