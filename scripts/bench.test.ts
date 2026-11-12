import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classics, root, scratch, targetRepo } from "../.maestro/testing/stub";

const BENCH = join(root, "scripts/bench.ts");
const CLI = join(root, "packages/cli/src/maestro.ts");
const TICKETS = [246, 334, 336, 360, 335];
const RISKY = 335;
const ARM = "main-abc1234";
const SETTLE_MS = 100;
const ATTEMPTS = 100;
const REPLAY_MS = 30_000;

const checks = ["format", "lint", "types", "test", "fmt"].flatMap((name) => [
	"-c",
	`target.checks.${name}={run: "true", hint: ${name}}`,
]);

const bench = async (env: Record<string, string>, ...args: string[]) => {
	const run = Bun.spawn(["bun", BENCH, ...args], {
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err] = await Promise.all([
		new Response(run.stdout).text(),
		new Response(run.stderr).text(),
		run.exited,
	]);
	return { code: await run.exited, out, err };
};

test(
	"start replays the five tickets detached on stubs, and table prints a row for each",
	async () => {
		const bin = mkdtempSync(join(scratch, "bin-"));
		writeFileSync(
			join(bin, "maestro"),
			`#!/bin/sh\nexec ${process.execPath} ${CLI} "$@"\n`,
		);
		chmodSync(join(bin, "maestro"), 0o755);
		const recorded = mkdtempSync(join(scratch, "recorded-"));
		for (const n of TICKETS) {
			writeFileSync(join(recorded, `${n}.md`), `# #${n} ticket\n`);
			writeFileSync(join(recorded, `${n}.base`), "main\n");
			writeFileSync(
				join(recorded, `${n}.presets`),
				`${n === RISKY ? "risky" : "ordinary"}\nstub\n`,
			);
		}
		const env = {
			PATH: `${bin}:${process.env.PATH}`,
			XDG_DATA_HOME: mkdtempSync(join(scratch, "data-")),
			XDG_CONFIG_HOME: join(scratch, "config"),
		};
		const started = await bench(
			env,
			"start",
			ARM,
			recorded,
			"--",
			"-c",
			`packs=[${await classics}]`,
			"-c",
			`target.repo=${targetRepo()}`,
			"-c",
			'target.prepare="true"',
			"-c",
			'target.checks.all={run: "echo x > b.ts", hint: all}',
			...checks,
		);
		expect(started.code).toBe(0);
		const ids = started.out.trim().split("\n");
		expect(ids).toHaveLength(TICKETS.length);
		const first = await Bun.spawn(
			["maestro", "ls", ids[0]?.split(" ")[1] ?? "", "--json"],
			{ env: { ...process.env, ...env }, stdout: "pipe" },
		);
		const origin = JSON.parse(await new Response(first.stdout).text());
		expect(origin.presets).toEqual(["ordinary", "stub"]);
		expect(origin.config).toContain("target.base=main");
		expect(origin.params.request).toBe("# #246 ticket");

		let rows: { ticket: number; status: string; converged: boolean | null }[] =
			[];
		for (let i = 0; i < ATTEMPTS; i++) {
			rows = JSON.parse((await bench(env, "table", "--json")).out);
			if (
				rows.length === TICKETS.length &&
				rows.every((r) => r.converged !== null)
			)
				break;
			await Bun.sleep(SETTLE_MS);
		}
		expect(rows.map((r) => [r.ticket, r.status, r.converged])).toEqual(
			[...TICKETS].sort((a, b) => a - b).map((n) => [n, "ok", true]),
		);
		const table = (await bench(env, "table")).out.split("\n");
		expect(table[0]).toMatch(
			/^arm\s+ticket\s+status\s+fixes\s+converged\s+pinned\s+deferred\s+untestable\s+in\s+out/,
		);
		expect(table[1]).toMatch(/^main-abc1234\s+#246\s+ok/);
	},
	REPLAY_MS,
);

test("start without a recorded file exits 1 naming it, and a bad verb exits 2", async () => {
	const empty = mkdtempSync(join(scratch, "empty-"));
	const missing = await bench({}, "start", ARM, empty);
	expect([missing.code, missing.err]).toEqual([
		1,
		expect.stringContaining(join(empty, "246.presets")),
	]);
	expect((await bench({}, "nope")).code).toBe(2);
	const dotted = await bench({}, "start", "a.b", empty);
	expect([dotted.code, dotted.err]).toEqual([
		1,
		expect.stringContaining("arm 'a.b' holds a dot"),
	]);
	expect((await bench({}, "start", ARM, empty, "999")).code).toBe(2);
});
