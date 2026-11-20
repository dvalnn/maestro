// A bare composition file named for a config key, `workspace`, with a required param.
import { code, composition, Text } from "@maestro/sdk";
import { shout } from "./loud";

export { shout };

export const named = composition(
	"named",
	{ params: { name: Text() }, examples: [{ name: "x" }] },
	({ name }) => code(shout, { in: { text: name }, out: { text: Text() } }),
);
