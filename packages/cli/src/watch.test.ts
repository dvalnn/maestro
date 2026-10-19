import { describe, expect, setSystemTime, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { HostNodeResult } from "@maestro/core/host";
import { fakeHost } from "@maestro/testkit";
import {
	ECHO,
	FIRST,
	GREET,
	hostOf,
	idOf,
	type Outcome,
	world,
} from "./fixtures/world";

const TOOL = { kind: "tool", name: "bash", input: { command: "ls" } };
const TERMINAL = () => ({ columns: 120, rows: 40 });
const ESC = "\u001b";
/** A redraw: the cursor up some lines to column 1, then the screen cleared below it. */
const REDRAW = new RegExp(`^${ESC}\\[\\d+F${ESC}\\[J`);
const SGR = new RegExp(`${ESC}\\[[\\d;]*m`);
const STATE_CHANGES = ["running", "settled", "reused"];
/** How long the held step stays running once watched, so several polls draw the same frame. */
const HOLD_MS = 400;
const START = new Date("2026-10-19T00:00:00Z");

const linesOf = (text: string) => text.split("\n").map((l) => JSON.parse(l));

describe("watch without a terminal", () => {
	test.each([
		["ok", ECHO, 0, ECHO.outputs],
		["failed", { outcome: "failed", reason: "flaky" }, 1, undefined],
		["rejected", { outcome: "rejected", reason: "not today" }, 3, undefined],
	])(
		"prints a %s concert's state changes in seq order, then the concert line, and exits %d",
		async (status, echo, code, outputs) => {
			const w = await world();
			const id = idOf(await w.call(["p", ...GREET], { hosts: [hostOf(echo)] }));
			const watched = await w.call(["watch", id]);
			expect(watched.code).toBe(code);
			const lines = linesOf(watched.out);
			const events = lines.slice(0, -1);
			expect(events.map((e) => e.type)).toContain("settled");
			for (const e of events) expect(STATE_CHANGES).toContain(e.type);
			const seqs = events.map((e) => e.seq);
			expect(seqs).toEqual(seqs.toSorted((a, b) => a - b));
			expect(lines.at(-1)).toMatchObject({
				type: "concert",
				id,
				status,
				resultNode: "echo/echo",
			});
			expect(lines.at(-1).outputs).toEqual(outputs);
		},
	);
});

describe("watch on a running concert", async () => {
	// A frozen clock keeps the running times still, so an unchanged frame is drawn once.
	setSystemTime(START);
	const w = await world();
	const step = Promise.withResolvers<HostNodeResult>();
	const host = fakeHost({
		steps: {
			first: [FIRST],
			"echo/echo": (_instance, _inputs, { emit }) => {
				emit(TOOL);
				return step.promise;
			},
		},
	});
	const announced = Promise.withResolvers<string>();
	const performed = w.call(["perform", ...GREET], {
		hosts: [host],
		stderr: (line) => {
			const id = idOf({ code: 0, out: "", err: line });
			if (id) announced.resolve(id);
		},
	});
	const id = await announced.promise;

	/** `watch id` with `args`, its stdout writes kept apart, each seen by `look`. */
	const watching = async (
		args: string[],
		over: Parameters<typeof w.call>[1] = {},
		look: (write: string) => void = () => {},
	) => {
		const writes: string[] = [];
		const outcome: Outcome = await w.call(["watch", id, ...args], {
			...over,
			stdout: (write) => {
				writes.push(write);
				look(write);
			},
		});
		return { ...outcome, writes };
	};
	const graph = watching([], { terminal: TERMINAL }, (write) => {
		if (
			/echo\/echo .*running .*tool bash/.test(stripVTControlCharacters(write))
		)
			setTimeout(() => step.resolve(ECHO), HOLD_MS);
	});
	const json = watching(["--events", "--json"], { terminal: TERMINAL });
	const lines = watching(["--events"], { terminal: TERMINAL });
	const piped = watching([]);
	const [drawn, streamed, listed, changes] = await Promise.all([
		graph,
		json,
		lines,
		piped,
	]);
	setSystemTime();

	test("redraws the graph in place until the concert settles, then exits as wait does", async () => {
		expect((await performed).code).toBe(0);
		expect(drawn.code).toBe(0);
		expect(drawn.err.split("\n")).toEqual([
			`watching concert ${id}; ctrl-c stops watching, not the concert`,
			`concert ${id} ok`,
		]);
		expect(drawn.writes.slice(1).some((write) => REDRAW.test(write))).toBe(
			true,
		);
		expect(drawn.writes[0]).not.toMatch(REDRAW);
		const frames = drawn.writes.map((write) => write.replace(REDRAW, ""));
		expect(frames.filter((f, i) => f === frames[i - 1])).toEqual([]);
		const last = stripVTControlCharacters(drawn.writes.at(-1) ?? "");
		expect(last).toMatch(/✓ echo\/echo +fake\.task +ok/);
		expect(last).toMatch(/^concert \S+ demo\.greet {2}ok/m);
	});

	test("--events --json holds the progress event verbatim", () => {
		expect(streamed.code).toBe(0);
		const events = streamed.writes.slice(0, -1).map((l) => JSON.parse(l));
		expect(events).toContainEqual(
			expect.objectContaining({
				node: "echo/echo",
				type: "progress",
				event: TOOL,
			}),
		);
		expect(JSON.parse(streamed.writes.at(-1) ?? "")).toMatchObject({
			type: "concert",
			id,
			status: "ok",
		});
	});

	test("without --events, a watch off a terminal leaves progress events out", () => {
		expect(changes.code).toBe(0);
		const types = changes.writes.map((l) => JSON.parse(l).type);
		expect(types).not.toContain("progress");
		expect(types.at(-1)).toBe("concert");
	});

	test("--events on a terminal prints a text line per event", () => {
		expect(listed.code).toBe(0);
		expect(listed.writes.map(stripVTControlCharacters)).toContainEqual(
			expect.stringMatching(
				/^\+\S+ +echo\/echo +tool bash \{"command":"ls"\}$/,
			),
		);
	});

	test.each([
		["NO_COLOR=1", [], { NO_COLOR: "1" }],
		["--no-color", ["--no-color"], {}],
	])("%s leaves color out on a terminal", async (_what, args, env) => {
		for (const mode of [[], ["--events"]]) {
			const plain = await watching([...mode, ...args], {
				terminal: TERMINAL,
				env,
			});
			expect(plain.writes.join("\n")).not.toMatch(SGR);
			expect(plain.err).toBe(`concert ${id} ok`);
		}
		const colored = await watching([], { terminal: TERMINAL });
		expect(colored.writes.join("\n")).toMatch(SGR);
	});
});
