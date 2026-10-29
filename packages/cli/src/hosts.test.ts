import { expect, test } from "bun:test";
import { join } from "node:path";
import { builtinHarnesses } from "./hosts";

test("pi's agent dir is the user's PI_CODING_AGENT_DIR", () => {
	const pi = builtinHarnesses({ PI_CODING_AGENT_DIR: "/none/agent" }).find(
		(h) => h.name === "pi",
	);
	const request = {
		runtime: { harness: "pi", model: "m" },
		prompt: "x",
		lane: "/lane",
		outbox: "/out",
		outputs: [],
		session: { dir: join("/none", "session"), id: "s" },
	};
	expect(() => pi?.run(request)).toThrow(
		"pi config dir does not exist: /none/agent",
	);
});
