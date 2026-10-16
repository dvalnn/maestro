// A bare composition file whose code node prints.
import { code, composition, Text } from "@maestro/sdk";

export function shout(inputs: { text: string }): { text: string } {
	console.log(`shout ${inputs.text}`);
	return { text: inputs.text };
}

export const loud = composition("loud", { params: {}, examples: [{}] }, () =>
	code(shout, { in: { text: "hey" }, out: { text: Text() } }),
);
