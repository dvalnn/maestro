import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, posix } from "node:path";
import type { Bind, Mount, SandboxSpec } from "./types";

export const LANE_DST = "/lane";
const SYSTEM_DIRS = ["/usr", "/bin", "/lib", "/lib64", "/sbin"];
const SYSTEM_ETC = [
	"/etc/resolv.conf",
	"/etc/hosts",
	"/etc/nsswitch.conf",
	"/etc/ssl",
	"/etc/pki",
	"/etc/ca-certificates",
	"/etc/passwd",
	"/etc/group",
];

const inLane = (p: string) => p === LANE_DST || p.startsWith(`${LANE_DST}/`);

function resolveBind(b: Bind, what: string): { src: string; dst: string } {
	const dst = posix.resolve(b.dst ?? b.src);
	if (!isAbsolute(b.src) || !isAbsolute(b.dst ?? b.src))
		throw new Error(`${what} bind must be absolute: ${b.src}`);
	if (!existsSync(b.src))
		throw new Error(`${what} bind source does not exist: ${b.src}`);
	if (dst === "/" || inLane(dst))
		throw new Error(
			`${what} bind may not land at ${dst}: it is the lane's area`,
		);
	return { src: b.src, dst };
}

/**
 * The full set of mounts for a spec, in the order they are applied. This is the whole confinement policy: the
 * writable mounts are exactly the `bind` and `tmpfs` entries.
 */
export function mountPlan(spec: SandboxSpec): Mount[] {
	const plan: Mount[] = [
		{ kind: "proc", dst: "/proc", origin: "system" },
		{ kind: "dev", dst: "/dev", origin: "system" },
		{ kind: "tmpfs", dst: "/tmp", origin: "system" },
	];
	for (const p of [...SYSTEM_DIRS, ...SYSTEM_ETC]) {
		if (existsSync(p))
			plan.push({ kind: "ro-bind", src: p, dst: p, origin: "system" });
	}
	const laneReal = realpathSync(spec.lane);
	for (const b of spec.readOnly ?? []) {
		const bind = resolveBind(b, "read-only");
		const real = realpathSync(bind.src); // follows symlinks, so a link into the lane is caught too
		if (real === laneReal || real.startsWith(`${laneReal}/`))
			throw new Error(`read-only bind source is inside the lane: ${b.src}`);
		plan.push({ kind: "ro-bind", ...bind, origin: "declared" });
	}
	for (const b of spec.writable ?? [])
		plan.push({
			kind: "bind",
			...resolveBind(b, "writable"),
			origin: "adapter",
		});
	plan.push({ kind: "bind", src: spec.lane, dst: LANE_DST, origin: "lane" });
	return plan;
}

/** bwrap arguments for a plan. Carries no environment values: argv is world-readable in /proc. */
export function bwrapArgs(plan: Mount[], argv: string[]): string[] {
	const a = [
		"--unshare-all",
		"--share-net",
		"--die-with-parent",
		"--new-session",
	];
	for (const m of plan) {
		if (m.kind === "ro-bind") a.push("--ro-bind", m.src as string, m.dst);
		else if (m.kind === "bind") a.push("--bind", m.src as string, m.dst);
		else a.push(`--${m.kind}`, m.dst);
	}
	// The root is a tmpfs bwrap builds, writable by default. Only after the last bind: binds keep their own flags.
	a.push("--remount-ro", "/", "--chdir", LANE_DST, "--", ...argv);
	return a;
}
