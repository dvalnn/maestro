// A bare composition file: its own entry, bundled in memory by the loader.
import { code, composition, Text } from "@maestro/sdk";
import { exclaim } from "./demo/helpers";

export { exclaim };

export const hello = composition(
	"hello",
	{ params: { name: Text({ default: "you" }) }, examples: [{}] },
	({ name }) => code(exclaim, { in: { text: name }, out: { text: Text() } }),
);
