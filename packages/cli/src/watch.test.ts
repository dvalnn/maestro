import { describe, expect, setSystemTime, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Host, HostNodeResult } from "@maestro/core/host";
import { fakeHost } from "@maestro/testkit";
import {
	closingOf,
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
/** A terminal too narrow for `DETAIL` on one row. */
const NARROW = () => ({ columns: 50, rows: 40 });
/** A tool call's detail past the narrow terminal's width. */
const DETAIL = "over the lane and read what it printed";
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
		"prints a %s concert's state changes in seq order, then the concert document, or with --events the closing block's concert row alone, and exits %d",
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
			const textual = await w.call(["watch", id, "--events"]);
			expect(textual.err).toMatch(
				new RegExp(`^${closingOf(id, status).source}`),
			);
			expect(textual.out.split("\n").at(-1)).toMatch(/^ *\+\S+ {2}echo\/echo /);
		},
	);
});

describe("watch on a running concert", async () => {
	// A frozen clock keeps the running times still, so an unchanged frame is drawn once.
	setSystemTime(START);
	const w = await world();
	const step = Promise.withResolvers<HostNodeResult>();
	const host: Host = {
		...fakeHost({
			steps: {
				first: [FIRST],
				"echo/echo": (_instance, _inputs, { emit }) => {
					emit(TOOL);
					return step.promise;
				},
			},
		}),
		text: {
			progress: (e) =>
				e.kind === "tool"
					? { word: "tool", detail: `ran ${e.name} ${DETAIL}` }
					: undefined,
			actor: (e) => (e.kind === "tool" ? "pi · haiku" : undefined),
		},
	};
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
			hosts: [host],
			...over,
			stdout: (write) => {
				writes.push(write);
				look(write);
			},
		});
		return { ...outcome, writes };
	};
	const graph = watching([], { terminal: TERMINAL }, (write) => {
		if (/^ +● echo .*running .*ran bash/m.test(stripVTControlCharacters(write)))
			setTimeout(() => step.resolve(ECHO), HOLD_MS);
	});
	const json = watching(["--events", "--json"], { terminal: TERMINAL });
	const lines = watching(["--events"], { terminal: TERMINAL });
	const narrow = watching(["--events"], { terminal: NARROW });
	const piped = watching([]);
	const pipedEvents = watching(["--events"]);
	const [drawn, streamed, listed, changes, pipedLines, wrapping] =
		await Promise.all([graph, json, lines, piped, pipedEvents, narrow]);
	setSystemTime();

	test("redraws the graph in place until the concert settles, then exits as wait does", async () => {
		expect((await performed).code).toBe(0);
		expect(drawn.code).toBe(0);
		const [watching, ...closing] = drawn.err.split("\n");
		expect(watching).toBe(
			`watching concert ${id}; ctrl-c stops watching, not the concert`,
		);
		expect(stripVTControlCharacters(closing.join("\n"))).toMatch(
			new RegExp(`^${closingOf(id, "ok").source}`),
		);
		expect(stripVTControlCharacters(drawn.writes.at(-1) ?? "")).toBe(
			"text       done",
		);
		expect(drawn.writes.slice(1).some((write) => REDRAW.test(write))).toBe(
			true,
		);
		expect(drawn.writes[0]).not.toMatch(REDRAW);
		const frames = drawn.writes
			.slice(0, -1)
			.map((write) => write.replace(REDRAW, ""));
		expect(frames.filter((f, i) => f === frames[i - 1])).toEqual([]);
		const last = stripVTControlCharacters(frames.at(-1) ?? "");
		expect(last).toMatch(/^ {2}✓ echo +fake\.task +ok/m);
		expect(
			frames.some((f) =>
				/● echo .*running .*pi · haiku +tool ran bash/.test(
					stripVTControlCharacters(f),
				),
			),
		).toBe(true);
		expect(last).toMatch(/^✓ demo\.greet {2}\S+ +ok/m);
		expect(last).toMatch(/^── 4 ok ─+$/m);
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

	test("--events on a terminal prints a text line per event, a host's wording of its progress in place of the generic line", () => {
		expect(listed.code).toBe(0);
		expect(listed.writes.map(stripVTControlCharacters)).toContainEqual(
			expect.stringMatching(
				new RegExp(`^ *\\+\\S+ {2}echo/echo +tool {6}ran bash ${DETAIL}$`),
			),
		);
	});

	test("--events on a terminal colors its lines, and wraps a long detail under its column at the terminal's width", () => {
		expect(listed.writes.join("\n")).toMatch(SGR);
		const wrapped = wrapping.writes
			.map(stripVTControlCharacters)
			.find((w) => w.includes("ran bash"));
		const [first, ...more] = wrapped?.split("\n") ?? [];
		expect(first).toMatch(/tool {6}ran bash over/);
		expect(more.length).toBeGreaterThan(0);
		const column = first?.indexOf("ran bash") ?? 0;
		for (const row of more) expect(row).toMatch(new RegExp(`^ {${column}}\\S`));
	});

	test("--events off a terminal prints the same text lines without color, then the closing block's concert row on stderr", () => {
		expect(pipedLines.code).toBe(0);
		expect(pipedLines.writes.join("\n")).not.toContain(ESC);
		expect(pipedLines.writes).toContainEqual(
			expect.stringMatching(
				new RegExp(`^ *\\+\\S+ {2}echo/echo +tool {6}ran bash ${DETAIL}$`),
			),
		);
		expect(pipedLines.err).toMatch(closingOf(id, "ok"));
	});

	test.each([
		["NO_COLOR=1", [], { NO_COLOR: "1" }],
		["--no-color", ["--no-color"], {}],
	])("%s leaves color out on a terminal", async (_what, args, env) => {
		for (const mode of [[], ["--events"]]) {
			const plain = await watching([...mode, ...args], {
				terminal: TERMINAL,
				stderrTerminal: TERMINAL,
				env,
			});
			expect(plain.writes.join("\n")).not.toMatch(SGR);
			expect(plain.err).not.toMatch(SGR);
			expect(plain.err).toMatch(closingOf(id, "ok"));
		}
		const colored = await watching([], {
			terminal: TERMINAL,
			stderrTerminal: TERMINAL,
		});
		expect(colored.writes.join("\n")).toMatch(SGR);
		expect(colored.err).toMatch(SGR);
	});
});
