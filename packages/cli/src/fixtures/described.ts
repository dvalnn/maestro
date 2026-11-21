// A bare composition file whose one param has a description long enough to wrap in its help.
import { code, composition, Text } from "@maestro/sdk";

export function echoText(inputs: { text: string }): { text: string } {
	return { text: inputs.text };
}

export const described = composition(
	"described",
	{
		params: {
			name: Text({
				description:
					"Who to greet, by the name the greeting uses in its one line",
			}),
		},
		examples: [{ name: "world" }],
	},
	({ name }) => code(echoText, { in: { text: name }, out: { text: Text() } }),
);
