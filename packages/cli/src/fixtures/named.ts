// A bare composition file with a required param, given in its example set.
import { code, composition, Text } from "@maestro/sdk";
import { shout } from "./loud";

export { shout };

export const named = composition(
	"named",
	{ params: { name: Text() }, examples: [{ name: "x" }] },
	({ name }) => code(shout, { in: { text: name }, out: { text: Text() } }),
);
