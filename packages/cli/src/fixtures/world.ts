import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Host } from "@maestro/core/host";
import { fakeHost } from "@maestro/testkit";
import { main } from "../cli";
import type { Deps } from "../command";
import { DEMO, packOf, scratch } from "./packs";

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
			stdout: (line) => out.push(line),
			stderr: (line) => err.push(line),
			...over,
			env: { ...env, ...over.env },
		});
		return { code, out: out.join("\n"), err: err.join("\n") };
	};
	return { root, pack, cwd, env, call };
}

/** The id a perform announces on stderr, as its own `concert <id>` line. */
export const idOf = ({ err }: Outcome) =>
	/^concert (\S+)$/m.exec(err)?.[1] ?? "";
export const json = (outcome: Outcome) => JSON.parse(outcome.out);

export const FIRST = { outcome: "ok", outputs: { text: "hi" } } as const;
export const ECHO = { outcome: "ok", outputs: { text: "done" } } as const;

/** A host whose nodes `first` and `echo/echo` settle as given, `ok` by default. */
export const hostOf = (echo: object = ECHO, over: object = {}): Host =>
	fakeHost({
		steps: { first: [FIRST], "echo/echo": [echo as never] },
		...over,
	});

export const GREET = ["demo.greet", "--name", "x"];
