import { expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "..", "install.sh");

const stubCurl = `#!/bin/sh
printf '%s\\n' "$*" >>"$CURL_LOG"
case "$*" in
  *api.github.com*/releases/latest) [ -n "$STABLE_JSON" ] || exit 22; printf '%s\\n' "$STABLE_JSON" ;;
  *api.github.com*) printf '%s\\n' "$ANY_JSON" ;;
  *) exit 22 ;;
esac
`;

/** Runs install.sh against a stub curl, with only `vars` added to a bare env. */
function install(vars: Record<string, string> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "install-"));
	const bin = join(dir, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "curl"), stubCurl, { mode: 0o755 });
	const log = join(dir, "curl.log");
	const run = Bun.spawnSync(["/bin/sh", script], {
		cwd: dir,
		env: {
			HOME: dir,
			PATH: `${bin}:/usr/bin:/bin`,
			CURL_LOG: log,
			STABLE_JSON:
				'{\n  "id": 1,\n  "tag_name": "v0.1.0",\n  "prerelease": false\n}',
			ANY_JSON: '[{"id": 2, "tag_name": "v0.2.0-rc.1", "prerelease": true}]',
			...vars,
		},
	});
	const curls = existsSync(log)
		? readFileSync(log, "utf8").split("\n").filter(Boolean)
		: [];
	return { exitCode: run.exitCode, stderr: run.stderr.toString(), curls };
}

test("the default installs the newest stable release", () => {
	const run = install();
	expect(run.exitCode).toBe(1);
	expect(run.stderr).toContain(
		"cannot download SHA256SUMS from release v0.1.0",
	);
	expect(run.curls[0]).toContain(
		"https://api.github.com/repos/dvalnn/maestro/releases/latest",
	);
	expect(run.curls[1]).toContain(
		"https://github.com/dvalnn/maestro/releases/download/v0.1.0/SHA256SUMS",
	);
});

test("MAESTRO_CHANNEL=stable is the default", () => {
	const run = install({ MAESTRO_CHANNEL: "stable" });
	expect(run).toEqual(install());
});

test("MAESTRO_CHANNEL=rc installs the newest release of any kind", () => {
	const run = install({ MAESTRO_CHANNEL: "rc" });
	expect(run.stderr).toContain("from release v0.2.0-rc.1");
	const api = run.curls.find((line) => line.includes("api.github.com"));
	expect(api).toContain("/releases?per_page=1");
});

test("MAESTRO_VERSION wins over the channel", () => {
	const run = install({
		MAESTRO_VERSION: "v0.1.0-rc.2",
		MAESTRO_CHANNEL: "rc",
	});
	expect(run.stderr).toContain("from release v0.1.0-rc.2");
	expect(run.curls.some((line) => line.includes("api.github.com"))).toBe(false);
});

test("no stable release points at MAESTRO_CHANNEL=rc", () => {
	const run = install({ STABLE_JSON: "" });
	expect(run.exitCode).toBe(1);
	expect(run.stderr).toContain("cannot find a stable maestro release");
	expect(run.stderr).toContain("MAESTRO_CHANNEL=rc");
});

test("an unknown channel fails before calling curl", () => {
	const run = install({ MAESTRO_CHANNEL: "beta" });
	expect(run.exitCode).toBe(1);
	expect(run.stderr).toContain(
		"MAESTRO_CHANNEL is 'beta', which is not a channel",
	);
	expect(run.stderr).toContain("Set MAESTRO_CHANNEL to stable or rc");
	expect(run.curls).toEqual([]);
});

test("no release on the rc channel points at MAESTRO_VERSION", () => {
	const run = install({ MAESTRO_CHANNEL: "rc", ANY_JSON: "[]" });
	expect(run.exitCode).toBe(1);
	expect(run.stderr).toContain("cannot find the newest maestro release");
	expect(run.stderr).toContain("pin one with MAESTRO_VERSION=<tag>");
});

test("an unknown channel fails before checking for tools", () => {
	const run = install({ MAESTRO_CHANNEL: "beta", PATH: "/nonexistent" });
	expect(run.exitCode).toBe(1);
	expect(run.stderr).toContain(
		"MAESTRO_CHANNEL is 'beta', which is not a channel",
	);
	expect(run.stderr).not.toContain("is not installed");
});
