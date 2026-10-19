// A bare composition file that declares no example input set, which the types refuse and the load rejects.
import { code, composition, Text } from "@maestro/sdk";
import { shout } from "./loud";

export const bare = composition(
	"bare",
	// @ts-expect-error neither ports nor examples
	{ params: {} },
	() => code(shout, { in: { text: "hey" }, out: { text: Text() } }),
);
