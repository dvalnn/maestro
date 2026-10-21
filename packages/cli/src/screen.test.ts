import { describe, expect, test } from "bun:test";
import { fullScreen } from "./screen";

const ESC = "\u001b";
const TAKE = `${ESC}[?1049h`;
const GIVE = `${ESC}[?1049l`;

/** A fake terminal and process recording what the screen does to them; `kill` makes its writes throw. */
function fake({ rawThrows = false } = {}) {
	const calls: string[] = [];
	const listeners = new Map<string, (error: Error) => void>();
	let data: ((chunk: Buffer) => void) | undefined;
	let dead = false;
	const keys: string[] = [];
	const screen = fullScreen({
		stdin: {
			setRawMode(raw) {
				calls.push(`raw ${raw}`);
				if (raw && rawThrows) throw new Error("not a tty");
			},
			on(_event, listener) {
				data = listener;
			},
			off() {
				data = undefined;
			},
			resume() {},
			pause() {},
		},
		write(text) {
			if (dead) throw new Error("EIO");
			if (text.includes(TAKE)) calls.push("take");
			else if (text.includes(GIVE)) calls.push("give");
			else calls.push("draw");
		},
		process: {
			pid: 7,
			on(event, listener) {
				listeners.set(event, listener);
			},
			off(event) {
				listeners.delete(event);
			},
			kill(_pid, signal) {
				calls.push(`kill ${signal}`);
			},
			exit(code) {
				calls.push(`exit ${code}`);
			},
		},
		stderr(line) {
			calls.push(`stderr ${line}`);
		},
	});
	return {
		screen,
		calls,
		keys,
		listeners,
		enter: () => screen.enter((chunk) => keys.push(chunk)),
		emit: (event: string) => listeners.get(event)?.(new Error("boom")),
		type: (text: string) => data?.(Buffer.from(text)),
		kill: () => {
			dead = true;
		},
	};
}

describe("fullScreen", () => {
	test("enter takes the terminal once, leave gives it back once and drops every handler", () => {
		const t = fake();
		t.enter();
		t.enter();
		t.screen.draw(["a"]);
		t.screen.leave();
		t.screen.leave();
		t.screen.draw(["b"]);
		expect(t.calls).toEqual(["take", "raw true", "draw", "raw false", "give"]);
		expect(t.listeners.size).toBe(0);
	});

	test.each([
		["SIGTERM", 143],
		["SIGHUP", 129],
		["SIGINT", 130],
	])(
		"%s gives the terminal back and exits %d, a dead terminal too",
		(signal, code) => {
			for (const dead of [false, true]) {
				const t = fake();
				t.enter();
				if (dead) t.kill();
				t.emit(signal);
				expect(t.calls.slice(2)).toEqual([
					"raw false",
					...(dead ? [] : ["give"]),
					`exit ${code}`,
				]);
			}
		},
	);

	test("Ctrl-Z and SIGTSTP give the terminal back and stop; SIGCONT takes it again and redraws", () => {
		const t = fake();
		t.enter();
		t.type("\u001a");
		t.emit("SIGCONT");
		t.emit("SIGTSTP");
		expect(t.calls.slice(2)).toEqual([
			"raw false",
			"give",
			"kill SIGSTOP",
			"take",
			"raw true",
			"raw false",
			"give",
			"kill SIGSTOP",
		]);
		expect(t.keys).toEqual([""]);
	});

	test("SIGCONT on a screen still held, as a hang-up sends it, draws nothing", () => {
		const t = fake();
		t.enter();
		t.kill();
		t.emit("SIGCONT");
		expect(t.calls).toEqual(["take", "raw true"]);
		expect(t.keys).toEqual([]);
	});

	test("passes typed keys on, and a resize as an empty chunk", () => {
		const t = fake();
		t.enter();
		t.type("j");
		t.emit("SIGWINCH");
		expect(t.keys).toEqual(["j", ""]);
	});

	test("an uncaught error gives the terminal back, prints it and exits 1; the process exiting gives it back", () => {
		const crashed = fake();
		crashed.enter();
		crashed.emit("uncaughtException");
		expect(crashed.calls.slice(2)).toEqual([
			"raw false",
			"give",
			"stderr boom",
			"exit 1",
		]);
		const exited = fake();
		exited.enter();
		exited.emit("exit");
		expect(exited.calls.slice(2)).toEqual(["raw false", "give"]);
	});

	test("a terminal that refuses raw mode is given back and the error thrown", () => {
		const t = fake({ rawThrows: true });
		expect(t.enter).toThrow("not a tty");
		expect(t.calls).toEqual(["take", "raw true", "raw false", "give"]);
	});
});
