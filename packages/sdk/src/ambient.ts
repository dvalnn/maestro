import { fail } from "./graph";

const ambient = (what: string) =>
	fail(
		"BUILD.ambient",
		`the build read ${what}, which is frozen during a build`,
		"Pass the value in as a param, or read it in a code node at perform time",
	);

// A trap also answers `.bigint()`, as `process.hrtime` has one.
const trap = (what: string) =>
	Object.assign(
		() => {
			throw ambient(what);
		},
		{
			bigint: () => {
				throw ambient(what);
			},
		},
	);

const env = () => {
	const read = () => {
		throw ambient("process.env");
	};
	return new Proxy(
		{},
		{ get: read, has: read, ownKeys: read, getOwnPropertyDescriptor: read },
	);
};

const clock = () => {
	const now = trap("the clock (Date)");
	return new Proxy(Date, {
		construct: (target, args, newTarget) =>
			args.length === 0 ? now() : Reflect.construct(target, args, newTarget),
		apply: now,
		get: (target, key, receiver) =>
			key === "now" ? now : Reflect.get(target, key, receiver),
	});
};

// The reads SDK-11 freezes: environment, clock and randomness. Detection is best effort (R-2): `Bun.env` and
// `import.meta.env` are the same object as `process.env` but cannot be replaced, so only `process.env` throws.
const FROZEN: [owner: object, key: string, stand: () => unknown][] = [
	[process, "env", env],
	[globalThis, "Date", clock],
	[process, "hrtime", () => trap("process.hrtime()")],
	[Bun, "nanoseconds", () => trap("Bun.nanoseconds()")],
	[performance, "now", () => trap("performance.now()")],
	[Math, "random", () => trap("Math.random()")],
	[crypto, "getRandomValues", () => trap("crypto.getRandomValues()")],
	[crypto, "randomUUID", () => trap("crypto.randomUUID()")],
];

/** Calls `fn` with the environment, the clock and randomness throwing `BUILD.ambient` (SDK-11). */
export function frozen<T>(fn: () => T): T {
	const restores: (() => void)[] = [];
	try {
		for (const [owner, key, stand] of FROZEN)
			restores.push(replace(owner, key, stand()));
		return fn();
	} finally {
		for (const restore of restores.reverse()) restore();
	}
}

/** Puts `value` in place of `owner[key]`, keeping its attributes. Returns what puts the original back. */
function replace(owner: object, key: string, value: unknown): () => void {
	const original = Object.getOwnPropertyDescriptor(owner, key);
	Object.defineProperty(owner, key, {
		...(original ?? { configurable: true, writable: true }),
		value,
	});
	return () => {
		if (original) Object.defineProperty(owner, key, original);
		else delete (owner as Record<string, unknown>)[key];
	};
}
