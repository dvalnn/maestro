// The source of the fixture pack `demo`, which `packOf` bundles behind the SDK's glue.
import { code, composition, Int, Json, Text, use } from "@maestro/sdk";
import { hostNode } from "@maestro/sdk/host";
import * as helpers from "./helpers";

export * as helpers from "./helpers";

/** The text `shape` appends. */
const MARK = "v1";

export function shape(inputs: { text: string }): { text: string } {
	return { text: `${inputs.text} ${MARK}` };
}

export const echo = composition(
	"echo",
	{ ports: { text: Text() }, params: { times: Int({ default: 1 }) } },
	({ times }, { text }) =>
		hostNode("fake.task", {
			label: "echo",
			in: { text, times },
			out: { text: Text() },
		}),
);

export const greet = composition(
	"greet",
	{
		doc: "Greets someone, then echoes the greeting.",
		params: { name: Text(), loud: Int({ default: 0 }) },
		examples: [{ name: "world" }],
	},
	({ name }) => {
		const first = hostNode("fake.task", {
			label: "first",
			out: { text: Text() },
		});
		const loud = code(helpers.exclaim, {
			in: { text: name },
			out: { text: Text() },
		});
		const shaped = code(shape, {
			in: { text: first.out.text },
			out: { text: Text() },
			when: loud.ok,
		});
		return use(echo, { text: shaped.out.text });
	},
);

export const ticket = composition(
	"ticket",
	{
		params: {
			handle: Json<{ name: string; number: number }>({
				"x-maestro-type": "fake.handle",
			}),
		},
		examples: [{}],
	},
	({ handle }) => hostNode("fake.task", { label: "file", in: { handle } }),
);
