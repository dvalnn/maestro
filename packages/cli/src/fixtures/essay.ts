// A bare composition: drafts a paragraph per topic in parallel, then polishes the joined text in a bounded loop.
import { existsSync } from "node:fs";
import {
	Bool,
	code,
	composition,
	Int,
	List,
	loop,
	map,
	not,
	Text,
} from "@maestro/sdk";

/** Drafting "dogs" fails while a file named `dog` sits in the working directory. */
export function draft(inputs: { topic: string }) {
	if (inputs.topic === "dogs" && existsSync("dog"))
		throw new Error("the dog ate the draft");
	return { text: `${inputs.topic} are great.` };
}

export function gather(inputs: {
	drafts: { value?: Record<string, unknown> }[];
}) {
	return {
		text: inputs.drafts
			.map((d) => JSON.stringify(d.value?.result ?? "(missing)"))
			.join(" "),
	};
}

export function polish(inputs: { text: string; round: number }) {
	return {
		text: `${inputs.text}!`,
		round: inputs.round + 1,
		done: inputs.round + 1 >= 2,
	};
}

export const essay = composition(
	"essay",
	{
		params: { topics: List(Text(), { default: ["cats", "dogs"] }) },
		examples: [{}],
	},
	({ topics }) => {
		const drafts = map(
			topics,
			(topic) => code(draft, { in: { topic }, out: { text: Text() } }),
			{
				onError: "propagate",
			},
		);
		const joined = code(gather, {
			in: { drafts: drafts.out.results },
			out: { text: Text() },
		});
		const Polished = { text: Text(), round: Int(), done: Bool() };
		return loop.doWhile((p) => not(p.out.done), {
			init: code(polish, {
				in: { text: joined.out.text, round: 0 },
				out: Polished,
			}),
			step: (p) =>
				code(polish, {
					in: { text: p.out.text, round: p.out.round },
					out: Polished,
				}),
			max: 3,
		});
	},
);
