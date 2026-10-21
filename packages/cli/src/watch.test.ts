import { describe, expect, setSystemTime, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Host, HostNodeResult } from "@maestro/core/host";
import { fakeHost } from "@maestro/testkit";
import type { Screen } from "./command";
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
/** A terminal whose viewport holds fewer rows than the greet concert's tree. */
const SHORT = () => ({ columns: 120, rows: 10 });
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

/** Ctrl-C as raw mode delivers it. */
const CTRL_C = "\u0003";
/** The cursor row of a frame drawn without color. */
const CURSOR = /^>/;

/**
 * A screen that keeps what it is asked, drawn lines plain, and after each draw `ready` holds for presses the next of
 * `keys`, if any; `press` sends more input once the keys are spent.
 */
function fakeScreen(
	keys: readonly string[] = [],
	ready: (lines: readonly string[]) => boolean = () => true,
) {
	const calls: string[] = [];
	const draws: string[][] = [];
	const left = [...keys];
	let onKey: ((chunk: string) => void) | undefined;
	const press = (chunk: string) => setTimeout(() => onKey?.(chunk));
	const screen: Screen = {
		enter(handler) {
			calls.push("enter");
			onKey = handler;
		},
		draw(lines) {
			const plain = lines.map(stripVTControlCharacters);
			draws.push(plain);
			if (!ready(plain)) return;
			const next = left.shift();
			if (next !== undefined) press(next);
		},
		leave() {
			calls.push("leave");
		},
	};
	return { screen, calls, draws, press };
}

/** A `ready` for `fakeScreen` that holds once a draw meets each of `steps` in turn. */
function inTurn(...steps: ((lines: readonly string[]) => boolean)[]) {
	let at = 0;
	return (lines: readonly string[]) => {
		const met = steps[at]?.(lines) ?? false;
		if (met) at++;
		return met;
	};
}

/** Whether a draw is the inspector's. */
const inspecting = (lines: readonly string[]) =>
	lines.some((l) => l.startsWith("◆ inspect "));

/** Where the cursor row is among a frame's lines. */
const cursorAt = (lines: readonly string[] = []) =>
	lines.findIndex((l) => CURSOR.test(l));

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

describe("watch --frames", () => {
	test("prints the browsed graph, then again after each key up to q, exits with the concert's code, and is left out of --help", async () => {
		const w = await world();
		const failed = {
			outcome: "failed",
			reason: "flaky",
			metrics: { tokens_in: 1_200 },
		} as const;
		const id = idOf(await w.call(["p", ...GREET], { hosts: [hostOf(failed)] }));
		const framed = await w.call(["watch", id, "--frames", "g down q j"]);
		expect(framed.code).toBe(1);
		const frames = framed.out.split(/^── (?=[a-z])/m);
		expect(frames.map((f) => f.split("\n")[0])).toEqual([
			expect.stringMatching(/^! demo\.greet /),
			"first",
			"down",
		]);
		const cursors = frames.map((f) =>
			f.split("\n").find((l) => CURSOR.test(l)),
		);
		expect(cursors).toEqual([
			expect.stringMatching(/^> +! echo +fake\.task/),
			expect.stringMatching(/^> +✓ first /),
			expect.stringMatching(/^> +✓ helpers_exclaim /),
		]);
		const unknown = await w.call(["watch", id, "--frames", "zz"]);
		expect(unknown.code).toBe(2);
		expect(unknown.err).toStartWith("--frames names no key: 'zz'");
		expect((await w.call(["watch", "--help"])).out).not.toContain("--frames");
	});

	test("enter inspects the cursor row, its events drawn, and q or esc goes back to the tree", async () => {
		const w = await world();
		const failed = {
			outcome: "failed",
			reason: "flaky",
			metrics: { tokens_in: 1_200 },
		} as const;
		const id = idOf(await w.call(["p", ...GREET], { hosts: [hostOf(failed)] }));
		const framed = await w.call(["watch", id, "--frames", "enter q enter esc"]);
		const [, opened = "", ...rest] = framed.out.split(/^── (?=[a-z])/m);
		expect(opened).toMatch(/^◆ inspect {2}echo\/echo +fake\.task +failed /m);
		expect(opened).toMatch(/^ {2}metrics {5}tokens_in 1\.2k$/m);
		expect(opened).toMatch(/^ +\S+ {2}echo\/echo +failed +flaky$/m);
		expect(rest.map((f) => f.split("\n")[0])).toEqual(["quit", "enter", "esc"]);
		const [quit = "", again = "", back = ""] = rest;
		expect(again).toMatch(/^◆ inspect /m);
		for (const tree of [quit, back])
			expect(tree.split("\n").find((l) => CURSOR.test(l))).toMatch(
				/^> +! echo +fake\.task/,
			);
	});
});

describe("watch with a screen", () => {
	test.each([
		["ok", ECHO, 0, SHORT, /^> +✓ first /],
		[
			"failed",
			{ outcome: "failed", reason: "flaky" },
			1,
			TERMINAL,
			/^> +! echo +fake\.task/,
		],
		[
			"rejected",
			{ outcome: "rejected", reason: "not today" },
			3,
			TERMINAL,
			/^> +✓ first /,
		],
	])(
		"browses a settled %s concert until q, the cursor first on its failure, keys moving it, then prints every row and the closing block and exits with its code",
		async (status, echo, code, terminal, cursor) => {
			const w = await world();
			const id = idOf(await w.call(["p", ...GREET], { hosts: [hostOf(echo)] }));
			const { screen, calls, draws, press } = fakeScreen(["gj"]);
			let ended = false;
			const watched = w
				.call(["watch", id, "--no-color"], { terminal, screen })
				.finally(() => {
					ended = true;
				});
			await Bun.sleep(HOLD_MS);
			expect(ended).toBe(false);
			expect(calls).toEqual(["enter"]);
			const [first, moved] = draws;
			expect(first).toHaveLength(terminal().rows);
			expect(first?.[cursorAt(first)]).toMatch(cursor);
			expect(first?.at(-1)).toStartWith("■ settled ");
			expect(moved?.[cursorAt(moved)]).toMatch(/^> +✓ helpers_exclaim /);
			press("q");
			const outcome = await watched;
			expect(outcome.code).toBe(code);
			expect(calls).toEqual(["enter", "leave"]);
			expect(outcome.out).toMatch(/^[✓!✗] demo\.greet {2}\S+ +\w+/);
			expect(outcome.out).toMatch(/^[▸▾] [✓!✗] echo +scope/m);
			expect(outcome.out).not.toMatch(/^>/m);
			expect(outcome.err).toMatch(
				new RegExp(`^${closingOf(id, status).source.replace(/\$$/, "")}`),
			);
		},
	);

	test("presses each key of a chunk on the view the one before it drew", async () => {
		const w = await world();
		const id = idOf(await w.call(["p", ...GREET], { hosts: [hostOf()] }));
		const lastDrawn = async (keys: string[]) => {
			const { screen, draws } = fakeScreen([...keys, "q"]);
			await w.call(["watch", id, "--no-color"], { terminal: TERMINAL, screen });
			return draws.at(-1) ?? [];
		};
		const apart = await lastDrawn(["G", "l", "l"]);
		expect(apart[cursorAt(apart)]).toMatch(/^> +✓ echo +fake\.task/);
		expect(await lastDrawn(["G", "ll"])).toEqual(apart);
	});

	test("gives the terminal back once when the poll throws", async () => {
		const w = await world();
		const id = idOf(await w.call(["p", ...GREET], { hosts: [hostOf()] }));
		const { screen, calls } = fakeScreen();
		const gone = () => {
			throw new Error("terminal gone");
		};
		const outcome = await w.call(["watch", id], { terminal: gone, screen });
		expect(outcome.code).toBe(1);
		expect(outcome.err).toContain("terminal gone");
		expect(calls).toEqual(["enter", "leave"]);
	});

	test("--events and --json print lines, leaving the screen untouched", async () => {
		const w = await world();
		const id = idOf(await w.call(["p", ...GREET], { hosts: [hostOf()] }));
		for (const args of [["--events"], ["--json"]]) {
			const { screen, calls } = fakeScreen();
			const outcome = await w.call(["watch", id, ...args], {
				terminal: TERMINAL,
				screen,
			});
			expect(outcome.code).toBe(0);
			expect(calls).toEqual([]);
		}
	});
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
	/** Whether the cursor row shows `echo` running. */
	const onEcho = (lines: readonly string[]) =>
		/^> +● echo .* running /.test(lines[cursorAt(lines)] ?? "");
	const quitter = fakeScreen([CTRL_C], onEcho);
	const quitted = watching(["--no-color"], {
		terminal: TERMINAL,
		screen: quitter.screen,
	});
	/** An inspector draw that shows `echo` settled `ok`. */
	const echoSettled = (lines: readonly string[]) =>
		inspecting(lines) && lines.some((l) => /echo\/echo +ok$/.test(l));
	const inspector = fakeScreen(
		["\r", ESC, "q"],
		inTurn(
			onEcho,
			echoSettled,
			(lines) => !inspecting(lines) && /^■ settled /.test(lines.at(-1) ?? ""),
		),
	);
	const inspected = watching(["--no-color"], {
		terminal: TERMINAL,
		screen: inspector.screen,
	});
	const piped = watching([]);
	const pipedEvents = watching(["--events"]);
	const [
		drawn,
		streamed,
		listed,
		changes,
		pipedLines,
		wrapping,
		interrupted,
		browsedThrough,
	] = await Promise.all([
		graph,
		json,
		lines,
		piped,
		pipedEvents,
		narrow,
		quitted,
		inspected,
	]);
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
		expect(last).toMatch(/^▸ ✓ echo +scope +ok .*echo · 1 ok$/m);
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

	test("on a screen, follows the running instance, and Ctrl-C before the concert settles leaves it and exits 130 with every row printed", () => {
		expect(interrupted.code).toBe(130);
		expect(quitter.calls).toEqual(["enter", "leave"]);
		const lines = quitter.draws.at(-1) ?? [];
		expect(onEcho(lines)).toBe(true);
		expect(lines.at(-1)).toStartWith("● follow ");
		const printed = stripVTControlCharacters(interrupted.writes.join("\n"));
		expect(printed).toMatch(/^● demo\.greet {2}\S+ +running/);
		expect(printed).toMatch(/^ +● echo .*running/m);
		expect(interrupted.err).not.toMatch(/^concert /m);
	});

	test("on a screen, Enter on the running instance draws its events, tailing the new ones, and Esc redraws the tree", () => {
		expect(browsedThrough.code).toBe(0);
		const { draws } = inspector;
		const opened = draws.findIndex(inspecting);
		const first = draws[opened] ?? [];
		expect(first[3]).toMatch(/^◆ inspect {2}echo\/echo +fake\.task +running /);
		expect(first).toContainEqual(expect.stringMatching(/echo\/echo +running$/));
		expect(first).toContainEqual(
			expect.stringMatching(/echo\/echo +tool +ran bash /),
		);
		expect(first.some((l) => /echo\/echo +ok$/.test(l))).toBe(false);
		const settled = draws.findIndex(echoSettled);
		expect(settled).toBeGreaterThan(opened);
		expect(draws[settled]?.at(-1)).toStartWith("◆ tail ");
		const back = draws.slice(settled + 1).find((l) => !inspecting(l)) ?? [];
		expect(back[cursorAt(back)]).toMatch(/^> +✓ echo /);
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
