import { expect, test } from "bun:test";
import { type CodeContext, reject } from "@maestro/ir";
import { portCheck, validator } from "./ports";
import { type CodeFunction, invokeCode, type Outputs } from "./worker";

const context: CodeContext = {
	concert: "c1",
	clock: 0,
	path: (ref) => `/area/${ref.path}`,
	scratch: "/scratch/c1",
	env: {},
	log: () => {},
};

test("outputs exclude a rejection's keys, so a code function's return discriminates", async () => {
	// @ts-expect-error `outcome` and `reason` are never output ports.
	const outputs: Outputs = { outcome: "rejected", reason: "no" };
	// @ts-expect-error a rejection without its reason is neither outputs nor a `Rejection`.
	const unreasoned: CodeFunction = () => ({ outcome: "rejected" });
	const verdict: CodeFunction = ({ ok }) =>
		ok ? { text: "yes" } : reject("no");
	expect([outputs, await unreasoned({}, context)]).toHaveLength(2);
	expect(await verdict({ ok: true }, context)).toEqual({ text: "yes" });
	expect(await verdict({ ok: false }, context)).toEqual(reject("no"));
});

test("invokeCode settles failed on inputs off the in schemas, without calling the function", async () => {
	let called = false;
	const settlement = await invokeCode(
		() => {
			called = true;
			return {};
		},
		{ in: { n: { type: "integer" } }, inputs: { n: "one" }, context },
		portCheck(validator()),
	);
	expect(settlement).toEqual({
		outcome: "failed",
		reason: "input 'n' must be integer",
	});
	expect(called).toBe(false);
});
