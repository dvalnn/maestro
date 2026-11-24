import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resultsOf, sorted } from "./guards";

const report = `<testsuite name="a.test.ts">
<testsuite name="outer &amp; co"><testsuite name="inner">
<testcase name="t &quot;1&quot;" classname="inner &gt; outer &amp; co" file="/r/a.test.ts" />
<testcase name="bad" classname="inner &gt; outer &amp; co" file="/r/a.test.ts"><failure type="x" message="m">x</failure></testcase>
<testcase name="off" classname="" file="/r/a.test.ts"><skipped /></testcase>
</testsuite></testsuite></testsuite>`;

test("a junit report gives each test its file, full name and status", () => {
	expect(resultsOf(report, "/r")).toEqual([
		{ file: "a.test.ts", name: 'outer & co > inner > t "1"', status: "pass" },
		{ file: "a.test.ts", name: "outer & co > inner > bad", status: "fail" },
		{ file: "a.test.ts", name: "off", status: "skip" },
	]);
});

test("a duplicate name takes its worst result, and a file the base's own run never reached claims no green", () => {
	const t = (name: string, status: "pass" | "fail", file = "a.test.ts") => ({
		file,
		name,
		status,
	});
	const here = [t("dup", "pass"), t("dup", "pass"), t("fresh", "pass")];
	// "dup" passes once on the base and fails once, and the base's own run produced nothing for a.test.ts.
	const onBase = [t("dup", "pass"), t("dup", "fail"), t("fresh", "pass")];
	// "env" fails on the base's source and in the base's own run alike: no evidence, so it is left out.
	here.push(t("env", "pass", "b.test.ts"));
	onBase.push(t("env", "fail", "b.test.ts"));
	expect(sorted(here, onBase, [t("env", "fail", "b.test.ts")])).toEqual({
		red: [{ file: "a.test.ts", name: "dup" }],
		unloaded: [],
		green: [],
	});
});

test("the command sorts the tests of an edited tree against its base commit", async () => {
	const repo = mkdtempSync(join(tmpdir(), "guards-repo-"));
	const sh = (...command: string[]) => {
		const ran = Bun.spawnSync(command, { cwd: repo });
		if (ran.exitCode !== 0) throw new Error(ran.stderr.toString());
	};
	const write = (path: string, text: string) =>
		writeFileSync(join(repo, path), text);
	write("package.json", '{"name":"guarded","private":true}');
	write(".gitignore", "node_modules\n");
	write("lib.ts", "export const f = () => 1;\n");
	const head = (n: number) =>
		`import { expect, test } from "bun:test";\nimport { f } from "./lib";\n` +
		`test("edited", () => expect(f()).toBe(${n}));\ntest("stable", () => {});\n`;
	write("x.test.ts", head(1));
	sh("bun", "install");
	sh("git", "init", "-q");
	sh("git", "add", "-A");
	sh(
		"git",
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@t",
		"commit",
		"-q",
		"-m",
		"b",
	);
	write("lib.ts", "export const f = () => 2;\n");
	write("x.test.ts", `${head(2)}test("brand new", () => {});\n`);
	write("only-here.ts", "export const g = () => 1;\n");
	write(
		"y.test.ts",
		'import { expect, test } from "bun:test";\nimport { g } from "./only-here";\ntest("needs only-here", () => expect(g()).toBe(1));\n',
	);
	const out = join(repo, "out");
	const ran = Bun.spawnSync(
		["bun", join(import.meta.dir, "guards.ts"), out, "HEAD"],
		{ cwd: repo },
	);
	expect(ran.stderr.toString()).toBe("");
	expect(await Bun.file(join(out, "guards.json")).json()).toEqual({
		red: [{ file: "x.test.ts", name: "edited" }],
		unloaded: [{ file: "y.test.ts", name: "needs only-here" }],
		green: [{ file: "x.test.ts", name: "brand new" }],
	});
	rmSync(repo, { recursive: true, force: true });
}, 60_000);
