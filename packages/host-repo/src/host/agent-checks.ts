import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MS_PER_UNIT } from "@maestro/ir";
import { shellQuote as quote } from "../harness/stub";
import { type Bind, LANE_DST } from "../sandbox/index";
import { FAILED_EXITS, USAGE_EXIT } from "./check";
import { type CheckSpec, listed } from "./config";
import { pathBinds } from "./lane-input";

/** Where an agent's sandbox sees the staged checks, and so its `check` command on PATH. */
const ROOT = "/maestro/checks";
const SANDBOX_PATH = `${ROOT}/bin:/usr/bin:/bin`;
const SCRIPT_MODE = 0o755;
/** How many trailing lines of a check's output the `check` command prints. */
const TAIL_LINES = 40;
/** Seconds a line gets after `timeout(1)` asks it to stop, before it is killed. */
const KILL_GRACE_S = 2;
/** What `timeout(1)` exits with when it had to kill a line that ignored its request to stop. */
const TIMEOUT_KILLED_EXIT = 137;

/** What an agent that can run checks needs beyond its role. */
export type AgentChecks = {
	readOnly: Bind[];
	writable: Bind[];
	/** The agent's `PATH`, with the `check` command first. */
	env: Record<string, string>;
	/** What the staged prompt tells the agent about its checks. */
	note: string;
};

/** The script of one check: its env, then each line echoed and run, the first that does not exit 0 ending it. */
function body(name: string, spec: CheckSpec): string {
	const env = Object.entries(spec.env).map(
		([k, v]) => `export ${k}=${quote(v)}`,
	);
	const lines = spec.lines.flatMap((line, i) => [
		`printf '%s\\n' ${quote(`$ ${line}`)}`,
		`sh -c ${quote(line)} || { c=$?; printf '[check %s line %s exited %s]\\n' ${quote(name)} ${i + 1} "$c"; exit "$c"; }`,
	]);
	return [...env, ...lines, ""].join("\n");
}

/** The `check` command: runs the named check under its timeout, prints its output's tail and its verdict. */
function command(checks: [string, CheckSpec][]): string {
	const cases = checks.map(
		([name, spec], i) =>
			`${quote(name)}) script=${ROOT}/${i}.sh secs=${spec.timeout / MS_PER_UNIT.s};;`,
	);
	return `#!/bin/sh
case "$1" in
${cases.join("\n")}
*) printf "check: '%s' is not one of: %s\\n" "$1" ${quote(listed(checks.map(([name]) => name)))} >&2; exit ${USAGE_EXIT};;
esac
cd ${LANE_DST} || exit ${USAGE_EXIT}
log=$(mktemp) || exit ${USAGE_EXIT}
timeout -k ${KILL_GRACE_S}s "\${secs}s" sh "$script" >"$log" 2>&1
code=$?
tail -n ${TAIL_LINES} "$log"
rm -f "$log"
case $code in
0) verdict=ok;;
${[...FAILED_EXITS, TIMEOUT_KILLED_EXIT].join("|")}) verdict=failed;;
*) verdict=rejected;;
esac
printf "check '%s': %s\\n" "$1" "$verdict"
[ "$verdict" = ok ]
`;
}

const note = (checks: [string, CheckSpec][]) =>
	[
		"",
		"",
		"Run the target's checks with `check <name>`, and do not write your own. Each prints the tail of its output, then ok, rejected or failed:",
		...checks.map(
			([name, spec]) => `- check ${name}: ${spec.lines.join(" && ")}`,
		),
	].join("\n");

const NONE: AgentChecks = { readOnly: [], writable: [], env: {}, note: "" };

/**
 * Writes the `check` command and the scripts of `checks` under `dir/checks`, and the binds, environment and prompt
 * note an agent that runs them needs. The scripts hold the checks' env values, so `dir` is never an artifact. The command runs a check as the host's own check node would, with its timeout
 * and its exit classification, but in the agent's sandbox: the binds of every check apply to all of it.
 */
export function stageChecks(
	dir: string,
	checks: [string, CheckSpec][],
): AgentChecks {
	if (!checks.length) return NONE;
	const root = join(dir, "checks");
	const specs = checks.map(([, spec]) => spec);
	mkdirSync(join(root, "bin"), { recursive: true });
	for (const [i, [name, spec]] of checks.entries())
		writeFileSync(join(root, `${i}.sh`), body(name, spec));
	writeFileSync(join(root, "bin", "check"), command(checks), {
		mode: SCRIPT_MODE,
	});
	return {
		readOnly: [
			{ src: root, dst: ROOT },
			...pathBinds(...specs.map((s) => s.readOnly)),
		],
		writable: pathBinds(...specs.map((s) => s.writable)),
		env: { PATH: SANDBOX_PATH },
		note: note(checks),
	};
}
