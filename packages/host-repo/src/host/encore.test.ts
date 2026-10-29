import { afterEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostInstance } from "@maestro/core/host";
import { formatExpansion, type GroupNode } from "@maestro/ir";
import { counterpartSession } from "./encore";
import { keepLatest, mintSession } from "./store";
import { cleanup, tmp } from "./test-support";

afterEach(cleanup);

const KEPT_TURN = {
	task: "go",
	attachments: {},
	commit: "c",
	reply: "r",
	copies: "attachments-1",
};

/** The instance of node `node` at `keys` in groups of `kinds`. */
const instanceAt = (
	node: string,
	keys: string[],
	kinds: GroupNode["kind"][],
): HostInstance => {
	const expansion = formatExpansion(keys);
	return {
		node: { id: node, kind: "agent", config: {}, literals: {} },
		expansion,
		id: `${node}${expansion}`,
		groups: kinds,
	} as unknown as HostInstance;
};

/**
 * A row: the earlier concert's instances as node and keys, the encore's instance as node, keys and group kinds, and
 * the session it continues or why it starts fresh.
 */
type Row = [
	string,
	[string, string[]][],
	[string, string[], GroupNode["kind"][]],
	string,
];
test.each<Row>([
	["the same node outside groups", [["w", []]], ["w", [], []], "E.w"],
	[
		"another node only",
		[["w", []]],
		["r", [], []],
		"concert E kept no session of 'r'",
	],
	[
		"a loop's iterations",
		[
			["w", ["0"]],
			["w", ["2"]],
			["w", ["1"]],
		],
		["w", ["0"], ["loop"]],
		"E.w[2]",
	],
	[
		"a map's items",
		[
			["w", ["0"]],
			["w", ["1"]],
		],
		["w", ["1"], ["map"]],
		"E.w[1]",
	],
	[
		"fewer map items",
		[["w", ["0"]]],
		["w", ["1"], ["map"]],
		"concert E kept no session of 'w[1]'",
	],
	[
		"a loop in a map",
		[
			["w", ["a", "0"]],
			["w", ["a", "1"]],
			["w", ["b", "3"]],
		],
		["w", ["a", "0"], ["parMap", "loop"]],
		"E.w[a][1]",
	],
])(
	"an encore's instance, given %s, continues its counterpart's session",
	(_, earlier, [node, keys, kinds], expected) => {
		const root = tmp("target");
		for (const [n, k] of earlier) {
			const id = `${n}${formatExpansion(k)}`;
			const session = mintSession(root, "stub", "E", id);
			writeFileSync(join(session.home, "turn.json"), JSON.stringify(KEPT_TURN));
			keepLatest(root, "E", id, { node: n, keys: k, session: session.id });
		}
		const found = counterpartSession(root, "E", instanceAt(node, keys, kinds), {
			harness: "stub",
			profile: "builder",
		});
		expect("session" in found ? found.session.id : found.fresh).toBe(expected);
	},
);

/** A row: what is done to the counterpart's session, the harness of the encore's profile, and why it starts fresh. */
type Broken = [string, (home: string) => void, string, string];
test.each<Broken>([
	[
		"its concert was pruned",
		(home) => rmSync(home, { recursive: true }),
		"stub",
		"session E.w is gone from the store: its concert was pruned",
	],
	[
		"it runs on another harness",
		() => {},
		"other",
		"session E.w runs on harness 'stub', and profile builder on 'other'",
	],
	[
		"it has no settled turn",
		(home) => rmSync(join(home, "turn.json")),
		"stub",
		"session E.w has no settled turn to continue",
	],
])(
	"an encore's instance starts fresh when its counterpart's session %s",
	(_, broken, harness, reason) => {
		const root = tmp("target");
		const session = mintSession(root, "stub", "E", "w");
		writeFileSync(join(session.home, "turn.json"), JSON.stringify(KEPT_TURN));
		keepLatest(root, "E", "w", { node: "w", keys: [], session: session.id });
		broken(session.home);
		expect(
			counterpartSession(root, "E", instanceAt("w", [], []), {
				harness,
				profile: "builder",
			}),
		).toEqual({ fresh: reason });
	},
);
