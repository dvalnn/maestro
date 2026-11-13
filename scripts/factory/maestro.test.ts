import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maestro } from "./maestro";

const dir = mkdtempSync(join(tmpdir(), "factory-maestro-"));
const bin = join(dir, "maestro");
writeFileSync(
	bin,
	`#!/bin/sh
case "$1 $2" in
	"ls c2"|"ls c3"|"ls c4"|"ls c6") echo '{"short":"c2","encoreOf":"c1","elapsedMs":90000,"metrics":{"tokens_in":100,"tokens_out":20,"tokens_cache_read":5000,"tokens_cache_write":300,"tokens_reasoning":7},"tokens":5420,"instances":[{"node":"build/test_first/tester","outputs":{"map":{"pinned":[{},{},{}],"deferred":[{}],"untestable":[]}}},{"node":"fixes/fix","expansion":"[0]"},{"node":"fix_until_clean/fixes/fix","expansion":"[1]"},{"node":"fix_until_clean/fixes/brief"},{"node":"fixes/reviewer"}],"reports":{"build":{"summary":"s","obstacles":["no rg"]},"reviewer":{"summary":"s","lessons":["run just fmt first"]}}}' ;;
	"ls c5") echo '{"instances":[{"node":"tester","outputs":{"map":{"pinned":[{}],"deferred":[],"untestable":[]}}}]}' ;;
	"ls --tour") echo '[{"id":"l'"$5"'","status":"ok","pack":"slice","composition":"slice","tour":"'"$3"'.i1"}]' ;;
	"wait c2") echo '{"status":"ok","artifacts":"${dir}","outputs":{"upheld":{"path":"upheld.md"},"draft":true,"delivered":2,"notice":{"path":"notice.md"},"pr":{"path":"pr.md"}}}' ;;
	"wait c4") echo '{"status":"rejected","artifacts":"${dir}","outputs":{"review":{"path":"review.md"},"upheld":[{"id":"F1","lens":"spec","where":"a.ts:3","issue":"A seam breaks","cites":"R1"}]}}' ;;
	"wait c6") echo '{"status":"ok","artifacts":"${dir}","outputs":{"upheld":{"path":"upheld.md"}}}' ;;
	"wait c3"|"wait c5") echo '{"status":"ok","artifacts":"${dir}","outputs":{"upheld":{"path":"missing.md"},"pr":{"path":"empty.md"}}}' ;;
	"ls d"*) echo '{}' ;;
	"wait d"*) echo '{"status":"ok","outputs":{"delivered":'"\${2#d}"'}}' ;;
	"wait c1") echo '{"id":"c1","status":"failed","reason":"boom"}'; exit 1 ;;
	"perform refused") echo "refused.ts does not compose" >&2; exit 2 ;;
	"perform diagnosed") echo '{"ok":false,"diagnostics":[{"code":"CFG.preset","severity":"error","message":"--preset x names no file","hint":"Create x.yaml"},{"code":"HOST.profile","severity":"error","message":"profile p is in no profile root"}]}'; exit 2 ;;
	"perform errored") printf '%s\n' '{"ok":false,"error":"no such file: x.ts\\nCheck the path","exit":2}'; exit 2 ;;
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

test("reads a concert's report: each agent's obstacles and lessons, the upheld findings, how many lenses delivered, the PR body, and a review's text and upheld findings", async () => {
	expect(await fake.report("c2")).toEqual({
		obstacles: ["no rg"],
		lessons: ["run just fmt first"],
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

test("lists a tour's concerts up to the limit, the tick's window by default", async () => {
	expect(await fake.concerts("v", 200)).toEqual([
		{
			id: "l200",
			status: "ok",
			pack: "slice",
			composition: "slice",
			tour: "v.i1",
		},
	]);
	expect((await fake.concerts("v")).map((c) => c.id)).toEqual(["l20"]);
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
