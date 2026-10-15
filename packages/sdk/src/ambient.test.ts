import { describe, expect, test } from "bun:test";
import { buildOf, diagnose } from "./fixtures/context";
import { hostNode } from "./index";

describe("ambient reads during build", () => {
	test.each([
		["process.env", () => process.env.HOME],
		["Date.now()", () => Date.now()],
		["new Date()", () => new Date()],
		["Date()", () => (Date as unknown as () => string)()],
		["process.hrtime()", () => process.hrtime()],
		["process.hrtime.bigint()", () => process.hrtime.bigint()],
		["Bun.nanoseconds()", () => Bun.nanoseconds()],
		["Math.random()", () => Math.random()],
		["performance.now()", () => performance.now()],
		["crypto.randomUUID()", () => crypto.randomUUID()],
		[
			"crypto.getRandomValues()",
			() => crypto.getRandomValues(new Uint8Array(1)),
		],
	])("%s fails with PURE.ambient", (_name, read) => {
		const error = diagnose(() =>
			buildOf(() => hostNode("fake.task", { config: { x: read() as never } })),
		);
		expect(error.code).toBe("PURE.ambient");
	});

	test("a fixed date is no ambient read", () => {
		expect(() =>
			buildOf(() =>
				hostNode("fake.task", { config: { y: new Date(0).getTime() } }),
			),
		).not.toThrow();
	});

	test("every trap installed is restored when installing a later one fails", () => {
		const define = Object.defineProperty;
		Object.defineProperty = ((owner, key, attributes) => {
			if (key === "randomUUID") throw new TypeError("locked");
			return define(owner, key, attributes);
		}) as typeof define;
		try {
			expect(() => buildOf(() => 0)).toThrow("locked");
		} finally {
			Object.defineProperty = define;
		}
		expect(Date.now()).toBeGreaterThan(0);
		expect(Math.random()).toBeLessThan(1);
		expect(typeof process.env.PATH).toBe("string");
	});

	test("every read is restored after a build, a failed one included", () => {
		diagnose(() => buildOf(() => Math.random()));
		expect(typeof process.env.PATH).toBe("string");
		expect(Date.now()).toBeGreaterThan(0);
		expect(new Date().getFullYear()).toBeGreaterThan(2000);
		expect(Math.random()).toBeLessThan(1);
		expect(performance.now()).toBeGreaterThanOrEqual(0);
		expect(crypto.randomUUID()).toHaveLength(36);
		expect(process.hrtime.bigint()).toBeGreaterThan(0n);
		expect(Bun.nanoseconds()).toBeGreaterThan(0);
	});
});
