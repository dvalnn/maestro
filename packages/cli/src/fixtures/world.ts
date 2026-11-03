import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Host } from "@maestro/core/host";
import { shortId } from "@maestro/render-text/live";
import { fakeHost } from "@maestro/testkit";
import { main } from "../cli";
import type { Deps } from "../command";
import { DEMO, packOf, scratch } from "./packs";

const MAESTRO = join(import.meta.dir, "../maestro.ts");
const FINAL_NEWLINE = /\n$/;

export type Outcome = { code: number; out: string; err: string };

/** A workspace with the `demo` pack installed, and the data and config homes beside it. */
export async function world() {
	const root = await scratch();
	const pack = join(root, "pack");
	await mkdir(pack);
	await packOf(join(DEMO, "index.ts"), pack);
	const cwd = join(root, "ws");
	await mkdir(join(cwd, ".maestro"), { recursive: true });
	await Bun.write(join(cwd, ".maestro/config.yaml"), `packs:\n  - ${pack}\n`);
	const env = {
		XDG_DATA_HOME: join(root, "data"),
		XDG_CONFIG_HOME: join(root, "config"),
	};
	const call = async (
		args: string[],
		over: Partial<Deps> & { env?: Record<string, string> } = {},
	): Promise<Outcome> => {
		const out: string[] = [];
		const err: string[] = [];
		const code = await main(args, {
			hosts: [fakeHost()],
			cwd,
			stdout: (line) => out.push(`${line}\n`),
			stdoutBytes: (bytes) => out.push(new TextDecoder().decode(bytes)),
			stderr: (line) => err.push(line),
			self: [process.execPath, MAESTRO],
			...over,
			env: { ...env, ...over.env },
		});
		const written = out.join("");
		return {
			code,
			out: written.replace(FINAL_NEWLINE, ""),
			err: err.join("\n"),
		};
	};
	/** Starts `script`, the real `maestro.ts` by default, as its own process in this world. */
	const spawn = (args: string[], script = MAESTRO) =>
		Bun.spawn([process.execPath, script, ...args], {
			cwd,
			env: { ...process.env, ...env },
			stdout: "pipe",
			stderr: "pipe",
		});
	return { root, pack, cwd, env, call, spawn };
}

/** The id a perform announces on stderr, as its own `concert <id>` line. */
export const idOf = ({ err }: Outcome) =>
	/^concert (\S+)$/m.exec(err)?.[1] ?? "";
export const json = (outcome: Outcome) => JSON.parse(outcome.out);

/** How many letters of a short id a listing shows. */
const SHOWN = 8;
/** Concert `id`'s short id as a listing shows it. */
export const shortOf = (id: string) => shortId(id).slice(0, SHOWN);
/** The closing block's label column. */
const LABEL = 11;

/**
 * The plain closing block of concert `id` settled `outcome`, at the end of a stream: its `concert` row with any time
 * and tokens, then a `label  value` line per row of `rows`.
 */
export const closingOf = (
	id: string,
	outcome: string,
	...rows: (readonly [label: string, value: string])[]
) =>
	new RegExp(
		`(?:^|\n)concert {4}${shortOf(id)}  ${outcome}  \\S+(?: · \\S+ tok)?${rows
			.map(
				([label, value]) => `\\n${RegExp.escape(label.padEnd(LABEL) + value)}`,
			)
			.join("")}$`,
	);

export const FIRST = { outcome: "ok", outputs: { text: "hi" } } as const;
export const ECHO = { outcome: "ok", outputs: { text: "done" } } as const;

/** A host whose nodes `first` and `echo/echo` settle as given, `ok` by default. */
export const hostOf = (echo: object = ECHO, over: object = {}): Host =>
	fakeHost({
		steps: { first: [FIRST], "echo/echo": [echo as never] },
		...over,
	});

/**
 * Arguments performing the demo pack's `greet`. With no host given, `world().call` uses `fakeHost()`, whose nodes have
 * no scripted steps, so `perform GREET` settles `failed`. A test that overrides `hosts` to read profiles, as with
 * `builtinHosts`, needs `hostOf()` beside it to register the nodes' `fake.task` kind.
 */
export const GREET = ["demo.greet", "--name", "x"];
