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
	"wait c1") echo '{"id":"c1","status":"failed","reason":"boom"}'; exit 1 ;;
	"perform refused") echo "refused.ts does not compose" >&2; exit 2 ;;
	"perform diagnosed") echo '{"ok":false,"diagnostics":[{"code":"CFG.preset","severity":"error","message":"--preset x names no file","hint":"Create x.yaml"},{"code":"HOST.profile","severity":"error","message":"profile p is in no profile root"}]}'; exit 2 ;;
	"perform "*) echo "concert c9" >&2; sleep 1 ;;
esac
`,
);
chmodSync(bin, 0o755);
const fake = maestro(bin);

test("reads a settled concert's result whatever wait exits with", async () => {
	expect(await fake.result("c1")).toEqual({
		status: "failed",
		reason: "boom",
		outputs: {},
	});
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
])(
	"a perform that exits before announcing a concert throws %s",
	async (_, arg, thrown) => {
		await expect(
			fake.start(["perform", arg], join(dir, `${arg}.log`)),
		).rejects.toThrow(thrown);
	},
);
