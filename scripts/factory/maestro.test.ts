import { expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as maestroModule from "./maestro";
import { checkMaestroVersion, maestro } from "./maestro";

// Seam: the exported floor and the minimum version stated to a maintainer in the README.
test("the README states the exported maestro floor", () => {
	const floor: unknown = Reflect.get(maestroModule, "MAESTRO_FLOOR");
	expect(floor).toBe("0.4.0-rc.2");
	expect(readFileSync(join(import.meta.dir, "README.md"), "utf8")).toContain(
		String(floor),
	);
});

// Seam: checkMaestroVersion against executable stubs, which answer only `--version`.
function versionStub(stdout: string, stderr = "", exit = 0) {
	const stubDir = mkdtempSync(join(tmpdir(), "factory-version-stub-"));
	const stub = join(stubDir, "maestro");
	writeFileSync(
		stub,
		`#!/bin/sh\n[ "$1" = "--version" ] || exit 64\nprintf '%s\\n' '${stdout}'\nprintf '%s\\n' '${stderr}' >&2\nexit ${exit}\n`,
	);
	chmodSync(stub, 0o755);
	return stub;
}

test("checkMaestroVersion refuses a stub older than the floor", async () => {
	await expect(
		checkMaestroVersion(versionStub("maestro 0.4.0-rc.1 (sdk 0.4.0-rc.1)")),
	).rejects.toThrow(
		"maestro 0.4.0-rc.1 is older than 0.4.0-rc.2, which the tour manager needs; install a newer maestro",
	);
});

test("checkMaestroVersion accepts a stub at the floor and later", async () => {
	for (const v of ["0.4.0-rc.2", "0.4.0", "0.10.0-rc.1", "0.4.0+build.1"]) {
		await checkMaestroVersion(versionStub(`maestro ${v} (sdk x)`));
	}
});

test("checkMaestroVersion quotes both streams of a failed version command", async () => {
	await expect(
		checkMaestroVersion(versionStub("maestro 0.4.0-rc.2", "boom", 3)),
	).rejects.toThrow(/"maestro 0\.4\.0-rc\.2"[\s\S]*"boom"/);
});

test("checkMaestroVersion accepts a version whose number exceeds 64 bits", async () => {
	await checkMaestroVersion(versionStub("maestro 18446744073709551616.0.0"));
});

test("checkMaestroVersion names the fix when maestro cannot run", async () => {
	await expect(checkMaestroVersion("/nonexistent/maestro")).rejects.toThrow(
		/PATH/,
	);
});

const dir = mkdtempSync(join(tmpdir(), "factory-maestro-"));
const bin = join(dir, "maestro");
writeFileSync(
	bin,
	`#!/bin/sh
case "$1 $2 $3" in
	"ls c"?" build/tester") echo '{"name":"build/tester","node":"build/tester","harness":"stub","outputs":{"map":{"pinned":[{},{},{}],"deferred":[{}],"untestable":[]}}}' ;;
	"ls c"?" build/lens") echo '{"name":"build/lens","node":"build/lens","harness":"stub","report":{"summary":"s","obstacles":["not read"]}}' ;;
	"ls c"?" build") echo '{"name":"build","node":"build","harness":"stub","report":{"summary":"s","obstacles":["no rg"],"sightings":[{"path":"a.ts","cites":"R1","text":"drops x"},{"path":"b.ts","text":"no cites"}]}}' ;;
	"ls c"?" fixes/reviewer") echo '{"name":"fixes/reviewer","node":"fixes/reviewer","harness":"stub","report":{"summary":"s","lessons":["run just fmt first"]}}' ;;
	"ls c5 tester") echo '{"name":"tester","node":"tester","harness":"stub","outputs":{"map":{"pinned":[{}],"deferred":[],"untestable":[]}}}' ;;
	"ls c2 --json"|"ls c3 --json"|"ls c4 --json"|"ls c6 --json") echo '{"short":"c2","encoreOf":"c1","elapsedMs":90000,"metrics":{"tokens_in":100,"tokens_out":20,"tokens_cache_read":5000,"tokens_cache_write":300,"tokens_reasoning":7},"tokens":5420,"instances":[{"name":"build/tester","node":"build/tester","harness":"stub"},{"name":"build","node":"build","harness":"stub","notes":{"Obstacles":["no rg"]}},{"name":"build/lens","node":"build/lens","harness":"stub"},{"name":"fixes[0]/fix","node":"fixes/fix","expansion":"[0]"},{"name":"fix_until_clean/fixes[1]/fix","node":"fix_until_clean/fixes/fix","expansion":"[1]"},{"name":"fix_until_clean/fixes/brief","node":"fix_until_clean/fixes/brief"},{"name":"fixes/reviewer","node":"fixes/reviewer","harness":"stub","notes":{"Lessons":["run just fmt first"]}}]}' ;;
	"config tree --json") echo '{"values":[],"presets":[],"flags":[],"params":{},"moduleDir":"/cache/trees/abc/.maestro","file":"slice.ts"}' ;;
	"config d"*) echo '{"values":[],"presets":[],"flags":[],"params":{}}' ;;
	"config gone --json") echo '{"ok":false,"error":"no concert gone in the record"}' ;;
	"config l200 --json") echo '{"values":[{"key":"x","value":1,"layer":"file"},{"key":"target.base","value":"abc","layer":"file"}],"presets":[],"flags":[],"params":{}}' ;;
	"config l20 --json"|"config l20-triage.triage --json") echo '{"values":[],"presets":[],"flags":[],"params":{}}' ;;
	"config l201 --json") echo '{"values":[{"key":"target.base","value":null,"layer":"unset"}],"presets":[],"flags":[],"params":{}}' ;;
	"config l202 --json") echo "no record" >&2; exit 1 ;;
	"config l203 --json") echo '{"ok":false,"error":"no concert l203 in the record"}' ;;
	"config l204 --json") echo '{"values":[{"key":"target.base","value":"","layer":"file"}],"presets":[],"flags":[],"params":{}}' ;;
	"ls c5 --json") echo '{"instances":[{"name":"tester","node":"tester","harness":"stub"}]}' ;;
esac
case "$1 $2" in
	"ls --status") echo '[{"id":"r1","status":"running","pack":"slice","composition":"slice","tour":"v1.i1"},{"id":"r2","status":"running","pack":"triage","composition":"triage","tour":"v2.i3"}]' ;;
	"ls --tour") [ "$6" = "--composition" ] && by="-$7"; echo '[{"id":"l'"$5$by"'","status":"ok","pack":"slice","composition":"slice","tour":"'"$3"'.i1","startedAt":10,"settledAt":25}]' ;;
	"wait c2") echo '{"status":"ok","artifacts":"${dir}","outputs":{"upheld":{"path":"upheld.md"},"draft":true,"delivered":2,"notice":{"path":"notice.md"},"pr":{"path":"pr.md"}}}' ;;
	"wait c4") echo '{"status":"rejected","artifacts":"${dir}","outputs":{"review":{"path":"review.md"},"upheld":[{"id":"F1","lens":"spec","where":"a.ts:3","issue":"A seam breaks","cites":"R1"}]}}' ;;
	"wait c6") echo '{"status":"ok","artifacts":"${dir}","outputs":{"upheld":{"path":"upheld.md"}}}' ;;
	"wait c3"|"wait c5") echo '{"status":"ok","artifacts":"${dir}","outputs":{"upheld":{"path":"missing.md"},"pr":{"path":"empty.md"}}}' ;;
	"ls gone") echo '{"ok":false,"error":"no concert gone in the record"}' ;;
	"ls d"*) echo '{}' ;;
	"wait d"*) echo '{"status":"ok","outputs":{"delivered":'"\${2#d}"'}}' ;;
	"wait c1") echo '{"id":"c1","status":"failed","reason":"boom"}'; exit 1 ;;
	"perform refused") echo "refused.ts does not compose" >&2; exit 2 ;;
	"perform diagnosed") echo '{"ok":false,"diagnostics":[{"code":"CFG.preset","severity":"error","message":"--preset x names no file","hint":"Create x.yaml"},{"code":"HOST.profile","severity":"error","message":"profile p is in no profile root"}]}'; exit 2 ;;
	"perform errored") printf '%s\n' '{"ok":false,"error":"no such file: x.ts\\nCheck the path","exit":2}'; exit 2 ;;
	"perform where") echo '{"id":"'"$(pwd -P)"'"}' ;;
	"perform "*) echo '{"id":"c9","status":"running"}' ;;
esac
`,
);
chmodSync(bin, 0o755);
writeFileSync(
	join(dir, "upheld.md"),
	"# Upheld findings\n\n- F1, a.ts:3: too wide\n",
);
writeFileSync(join(dir, "notice.md"), "Draft: x\n");
writeFileSync(join(dir, "pr.md"), "## Summary\n\nx\n");
writeFileSync(join(dir, "review.md"), "# Review\n\nA seam breaks.\n");
writeFileSync(join(dir, "empty.md"), "");
const fake = maestro(bin);

test("reads a settled concert's result whatever wait exits with", async () => {
	expect(await fake.result("c1")).toEqual({
		status: "failed",
		reason: "boom",
		outputs: {},
	});
});

test("reads a concert's report: each agent's obstacles, lessons and well-formed sightings, the upheld findings, how many lenses delivered, the PR body, and a review's text and upheld findings", async () => {
	expect(await fake.report("c2")).toEqual({
		obstacles: ["no rg"],
		lessons: ["run just fmt first"],
		sightings: [{ path: "a.ts", cites: "R1", text: "drops x" }],
		upheld: "- F1, a.ts:3: too wide",
		draft: true,
		delivered: 2,
		notice: "Draft: x",
		pr: "## Summary\n\nx",
		tests: { pinned: 3, deferred: 1, untestable: 0 },
	});
	expect(await fake.report("c4")).toMatchObject({
		review: "# Review\n\nA seam breaks.",
		blocking: ["a.ts:3: A seam breaks"],
	});
});

test("reads the test map of a concert whose tester node has the earlier id", async () => {
	expect((await fake.report("c5")).tests).toEqual({
		pinned: 1,
		deferred: 0,
		untestable: 0,
	});
});

test("reads the .maestro/ directory an encore of a concert reruns", async () => {
	expect(await fake.tree("tree")).toBe("/cache/trees/abc/.maestro");
	await expect(fake.tree("d1")).rejects.toThrow("names no tree");
	await expect(fake.tree("gone")).rejects.toThrow(
		"no concert gone in the record",
	);
});

test("reads a concert's spend: its time, tokens by kind and fix rounds", async () => {
	expect(await fake.spend("c2")).toEqual({
		short: "c2",
		elapsedMs: 90_000,
		input: 100,
		output: 20,
		cacheRead: 5_000,
		cacheWrite: 300,
		fixes: 2,
		encore: true,
	});
});

test("lists a tour's concerts up to the limit, the tick's window by default, each with its cut, an encore's last", async () => {
	expect(await fake.concerts("v", 200)).toEqual([
		{
			id: "l200",
			status: "ok",
			pack: "slice",
			composition: "slice",
			tour: "v.i1",
			base: "abc",
			startedAt: 10,
			settledAt: 25,
		},
	]);
	expect((await fake.concerts("v")).map((c) => c.id)).toEqual(["l20"]);
	const kind = { pack: "triage", composition: "triage" };
	expect((await fake.concerts("v", 20, kind)).map((c) => c.id)).toEqual([
		"l20-triage.triage",
	]);
});

test("running lists every running concert on every tour", async () => {
	expect((await fake.running()).map((c) => [c.id, c.tour])).toEqual([
		["r1", "v1.i1"],
		["r2", "v2.i3"],
	]);
});

test("a concert's base is its target.base config value, and undefined when that value is empty or its config cannot be read", async () => {
	const baseOf = async (limit: number) =>
		(await fake.concerts("v", limit))[0]?.base;
	expect(await Promise.all([200, 20, 201, 202, 203, 204].map(baseOf))).toEqual([
		"abc",
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
	]);
});

test("a concert with no draft output is a draft when it upheld findings", async () => {
	expect((await fake.report("c6")).draft).toBe(true);
});

test("a report whose upheld file is gone has no upheld findings, one whose PR body is empty has none, and one whose delivered is not a whole number has no count", async () => {
	const report = await fake.report("c3");
	expect([
		report.upheld,
		report.pr,
		report.draft,
		report.notice,
		report.delivered,
	]).toEqual([undefined, undefined, false, undefined, undefined]);
	const delivered = async (value: string) =>
		(await fake.report(`d${value}`)).delivered;
	expect(await Promise.all(["0", "1.5", '"2"'].map(delivered))).toEqual([
		0,
		undefined,
		undefined,
	]);
});

test("a perform started in the background returns its concert", async () => {
	expect(await fake.start(["perform", "x.ts"])).toBe("c9");
});

test("a perform started in a directory runs there", async () => {
	expect(await fake.start(["perform", "where"], undefined, dir)).toBe(
		realpathSync(dir),
	);
});

test("a perform started with a log writes what it printed there", async () => {
	const log = join(dir, "perform.log");
	await expect(fake.start(["perform", "refused"], log)).rejects.toThrow();
	expect(readFileSync(log, "utf8")).toBe("refused.ts does not compose\n");
});

test.each([
	["its stderr", "refused", "maestro perform: refused.ts does not compose"],
	[
		"its diagnostics, one per line",
		"diagnosed",
		"maestro perform:\nCFG.preset: --preset x names no file\n  Create x.yaml\nHOST.profile: profile p is in no profile root",
	],
	[
		"its error",
		"errored",
		"maestro perform:\nno such file: x.ts\nCheck the path",
	],
])("a perform that starts no concert throws %s", async (_, arg, thrown) => {
	await expect(fake.start(["perform", arg])).rejects.toThrow(thrown);
});

/** The checkout's real CLI entry, which the test performs one concert with. */
const CLI = join(import.meta.dir, "../../packages/cli/src/maestro.ts");
/** The code-only fixture the real CLI performs: its default name is "you", and `exclaim` adds a "!". */
const HELLO = join(import.meta.dir, "../../packages/cli/src/fixtures/hello.ts");
/** The directory the CLI reports as the fixture's `moduleDir`. */
const FIXTURES = join(import.meta.dir, "../../packages/cli/src/fixtures");
/** An id no record holds: the readers' "not in the record" case. */
const ABSENT = "00000000-0000-0000-0000-000000000000";
const BASE = "abc123";
const TOUR = "v.i1";

/** Single-quotes a path for a POSIX shell. */
const quote = (path: string) => `'${path.replaceAll("'", "'\\''")}'`;

test("reads each field the factory's maestro readers need from a concert the real CLI performs offline", async () => {
	const root = mkdtempSync(join(tmpdir(), "factory-real-"));
	try {
		const repo = join(root, "repo");
		mkdirSync(repo);
		// The CLI runs in `root`, which is also its home and XDG directory, so it writes nothing beyond `root`. The
		// wrapper sits in `bin/`, since the CLI keeps its own `maestro/` directory under `root`.
		// `TMPDIR` too: a detached perform writes its output under the system temp directory.
		mkdirSync(join(root, "bin"));
		mkdirSync(join(root, "tmp"));
		const cli = join(root, "bin", "maestro");
		writeFileSync(
			cli,
			`#!/bin/sh\ncd ${quote(root)} || exit 1\nexec env HOME=${quote(root)} XDG_CONFIG_HOME=${quote(root)} XDG_DATA_HOME=${quote(root)} TMPDIR=${quote(join(root, "tmp"))} ${quote(process.execPath)} ${quote(CLI)} "$@"\n`,
		);
		chmodSync(cli, 0o755);
		const run = async (args: string[]) => {
			const child = Bun.spawn([cli, ...args], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const [out] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			return JSON.parse(out);
		};
		// The raw `--json` document, for the keys a reader hides when they are absent.
		const document = (args: string[]) => run([...args, "--json"]);
		const reader = maestro(cli);

		const { id } = await run([
			"perform",
			HELLO,
			"--tour",
			TOUR,
			"-c",
			`target.repo=${repo}`,
			"-c",
			`target.base=${BASE}`,
			"--detach",
			"--json",
		]);

		// `wait` blocks until the concert settles, so every reader below reads a settled record.
		const settled = await reader.result(id);
		expect(settled.status).toBe("ok");
		expect(settled.outputs).toEqual({ text: "you!" });
		expect(await document(["wait", id])).toEqual(
			expect.objectContaining({
				status: "ok",
				outputs: { text: "you!" },
				artifacts: expect.any(String),
			}),
		);

		expect(await reader.concerts("v")).toEqual([
			{
				id,
				status: "ok",
				pack: "hello",
				composition: "hello",
				tour: TOUR,
				base: BASE,
				startedAt: expect.any(Number),
				settledAt: expect.any(Number),
			},
		]);
		// The reader drops a missing time or tour without a sign, so the list's raw rows are read too.
		expect(await document(["ls", "--tour", "v"])).toEqual([
			expect.objectContaining({
				tour: TOUR,
				startedAt: expect.any(Number),
				settledAt: expect.any(Number),
			}),
		]);

		expect(await document(["config", id])).toEqual(
			expect.objectContaining({
				values: expect.arrayContaining([
					expect.objectContaining({ key: "target.base", value: BASE }),
				]),
			}),
		);
		expect(await reader.tree(id)).toBe(realpathSync(FIXTURES));

		expect(await document(["ls", id])).toEqual(
			expect.objectContaining({
				short: expect.any(String),
				elapsedMs: expect.any(Number),
				instances: expect.any(Array),
			}),
		);
		expect(await reader.spend(id)).toEqual({
			short: expect.any(String),
			elapsedMs: expect.any(Number),
			// hello spends no tokens, runs no fix round and is no encore
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			fixes: 0,
			encore: false,
		});
		expect(await reader.report(id)).toMatchObject({
			obstacles: [],
			lessons: [],
			sightings: [],
		});

		expect(await reader.has(id)).toBe(true);
		expect(await reader.has(ABSENT)).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
