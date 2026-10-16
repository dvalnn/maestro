// A bare composition file that exports one function under two names.
import { code, composition, Text } from "@maestro/sdk";
import { exclaim } from "./demo/helpers";

export * as again from "./demo/helpers";
export { exclaim };

export const twice = composition("twice", { examples: [{}] }, () =>
	code(exclaim, { in: { text: "x" }, out: { text: Text() } }),
);
