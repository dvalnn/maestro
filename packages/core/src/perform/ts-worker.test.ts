import { expect, test } from "bun:test";
import type { CodeContext } from "@maestro/ir";
import { validator } from "../ports";
import { portCheck } from "./execute";
import { invokeCode } from "./ts-worker";

const context: CodeContext = {
	concert: "c1",
	clock: 0,
	path: (ref) => `/area/${ref.path}`,
	scratch: "/scratch/c1",
	env: {},
	log: () => {},
};

test("invokeCode settles failed on inputs off the in schemas, without calling the function", async () => {
	let called = false;
	const result = await invokeCode(
		() => {
			called = true;
			return {};
		},
		{ in: { n: { type: "integer" } }, inputs: { n: "one" }, context },
		portCheck(validator()),
	);
	expect(result).toEqual({
		outcome: "failed",
		reason: "input 'n' must be integer",
	});
	expect(called).toBe(false);
});
