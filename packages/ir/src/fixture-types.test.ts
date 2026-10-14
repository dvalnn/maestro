import { expect, test } from "bun:test";
import fanoutFaninLoop from "../fixtures/fanout-fanin-loop.json";
import guardsAndEscalation from "../fixtures/guards-and-escalation.json";
import minimal from "../fixtures/minimal.json";
import nestedGroups from "../fixtures/nested-groups.json";
import type { Ir, IrNode } from "./types";

// JSON imports type every string as `string`, so `satisfies Ir` cannot hold on them: widen the literals,
// and make the node union strict so a node matches only the kind whose fields it has, not the host kind's
// open shape. Record values admit `undefined` because TypeScript gives sibling JSON objects each other's
// keys as optional `undefined`.
type Widen<T> = T extends string
	? string
	: T extends readonly (infer U)[]
		? Widen<U>[]
		: T extends object
			? { [K in keyof T]: Widen<T[K]> | (string extends K ? undefined : never) }
			: T;
type Keys<T> = T extends unknown ? keyof T : never;
type Strict<T, All = T> = T extends unknown
	? T & { [K in Exclude<Keys<All>, keyof T>]?: never }
	: never;
type FixtureIr = Widen<Omit<Ir, "nodes">> & { nodes: Strict<Widen<IrNode>>[] };

test("golden fixtures type-check against types.ts", () => {
	const fixtures = [
		minimal,
		fanoutFaninLoop,
		guardsAndEscalation,
		nestedGroups,
	] satisfies FixtureIr[];
	expect(fixtures).toHaveLength(4);
});
