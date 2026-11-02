import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maestro } from "./maestro";

const dir = mkdtempSync(join(tmpdir(), "factory-maestro-"));
const bin = join(dir, "maestro");
writeFileSync(
	bin,
	`#!/bin/sh
case "$1 $2" in
	"ls c2"|"ls c3") echo '{"metrics":{"tokens_input":100,"tokens_output":20,"tokens_reasoning":5,"cost":3},"reports":{"build":{"summary":"s","obstacles":["no rg"]},"reviewer":{"summary":"s","gaps":["no Windows run"]}}}' ;;
	"art ls") case "$3" in c2) echo '[{"instance":"upheld","port":"upheld","path":"${dir}/old.md"},{"instance":"fixes/loop[0]/upheld","port":"upheld","path":"${dir}/new.md"},{"instance":"fixes/loop[1]/upheld","port":"upheld","path":"${dir}/stale.md","stale":true}]' ;; *) echo '[{"instance":"upheld","port":"upheld","path":"${dir}/missing.md"}]' ;; esac ;;
	"wait c1") echo '{"id":"c1","status":"failed","reason":"boom"}'; exit 1 ;;
	"perform refused") echo "refused.ts does not compose" >&2; exit 2 ;;
	"perform diagnosed") echo '{"ok":false,"diagnostics":[{"code":"CFG.preset","severity":"error","message":"--preset x names no file","hint":"Create x.yaml"},{"code":"HOST.profile","severity":"error","message":"profile p is in no profile root"}]}'; exit 2 ;;
	"perform errored") printf '%s\n' '{"ok":false,"error":"no such file: x.ts\\nCheck the path","exit":2}'; exit 2 ;;
	"perform "*) echo "concert c9" >&2; sleep 1 ;;
esac
`,
);
chmodSync(bin, 0o755);
writeFileSync(
	join(dir, "new.md"),
	"# Upheld findings\n\n- F1, a.ts:3: too wide\n",
);
const fake = maestro(bin);

test("reads a settled concert's result whatever wait exits with", async () => {
	expect(await fake.result("c1")).toEqual({
		status: "failed",
		reason: "boom",
		outputs: {},
	});
});

test("reads a concert's report: tokens but reasoning, each agent's obstacles and gaps, the last fresh upheld findings", async () => {
	expect(await fake.report("c2")).toEqual({
		tokens: 120,
		obstacles: ["no rg"],
		gaps: ["no Windows run"],
		upheld: "- F1, a.ts:3: too wide",
	});
});

test("a report whose upheld file is gone has no upheld findings", async () => {
	expect((await fake.report("c3")).upheld).toBeUndefined();
});

test("a detached perform returns the concert it announces", async () => {
	expect(await fake.start(["perform", "x.ts"], join(dir, "ok.log"))).toBe("c9");
});

test.each([
	["its output", "refused", "maestro perform:\nrefused.ts does not compose"],
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
])(
	"a perform that exits before announcing a concert throws %s",
	async (_, arg, thrown) => {
		await expect(
			fake.start(["perform", arg], join(dir, `${arg}.log`)),
		).rejects.toThrow(thrown);
	},
);
