// A bare composition file that uses the installed `demo` pack's `echo`.
import { composition, use } from "@maestro/sdk";
import { echo } from "./demo/index";

export const usesEcho = composition("uses_echo", { examples: [{}] }, () =>
	use(echo, { text: "hi" }),
);
