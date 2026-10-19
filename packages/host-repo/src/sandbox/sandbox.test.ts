import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bubblewrap, runProcesses } from "./bubblewrap";
import { mountPlan, type SandboxSpec } from "./index";
import { bwrapArgs } from "./plan";

const dirs: string[] = [];
const tmp = (name: string) => {
	const d = mkdtempSync(join(tmpdir(), `sbx-${name}-`));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function sh(script: string, extra: Partial<SandboxSpec> = {}) {
	const lane = extra.lane ?? tmp("lane");
	const p = bubblewrap.start({ lane, argv: ["sh", "-c", script], ...extra });
	const out: string[] = [];
	for await (const l of p.stdout) out.push(l);
	return { out, exit: await p.exited, lane };
}

describe("confinement", () => {
	test("writes inside the lane succeed, writes outside fail", async () => {
		const { out, lane } = await sh(
			`echo x > /lane/in.txt && echo IN=ok
			for p in /usr/x /etc/x /x /lane/../x /home/x; do (echo x > $p) 2>/dev/null && echo "WROTE $p" || echo "DENIED $p"; done`,
		);
		expect(out).toContain("IN=ok");
		expect(readFileSync(join(lane, "in.txt"), "utf8")).toBe("x\n");
		expect(out.filter((l) => l.startsWith("WROTE"))).toEqual([]);
		for (const p of ["/usr/x", "/etc/x", "/x", "/lane/../x", "/home/x"])
			expect(out).toContain(`DENIED ${p}`);
	});

	test("a read-only bind is readable and cannot be written", async () => {
		const ro = tmp("ro");
		writeFileSync(join(ro, "f.txt"), "hello");
		const { out, exit } = await sh(
			`cat /ro/f.txt; (echo x > /ro/f.txt) 2>/dev/null && echo WROTE || echo DENIED; (echo x > /ro/new) 2>/dev/null && echo WROTE || echo DENIED`,
			{ readOnly: [{ src: ro, dst: "/ro" }] },
		);
		expect(exit.code).toBe(0);
		expect(out).toEqual(["helloDENIED", "DENIED"]); // hello has no trailing newline
		expect(readFileSync(join(ro, "f.txt"), "utf8")).toBe("hello");
	});

	test("a read-only bind inside the lane's writable area is rejected", () => {
		const lane = tmp("lane");
		for (const dst of ["/lane", "/lane/sub", "/lane/../lane/x", "/"]) {
			expect(() =>
				bubblewrap.start({
					lane,
					argv: ["true"],
					readOnly: [{ src: "/usr", dst }],
				}),
			).toThrow(/lane's area/);
		}
	});

	test("a read-only bind whose source is inside the lane (directly or by symlink) is rejected", () => {
		const lane = tmp("lane");
		mkdirSync(join(lane, "sub"));
		symlinkSync(join(lane, "sub"), join(tmp("links"), "l"));
		const link = join(dirs[dirs.length - 1] as string, "l");
		for (const src of [lane, join(lane, "sub"), link])
			expect(() =>
				bubblewrap.start({
					lane,
					argv: ["true"],
					readOnly: [{ src, dst: "/ro" }],
				}),
			).toThrow(/inside the lane/);
	});

	test("the mount plan names every writable mount, adapter paths included", () => {
		const lane = tmp("lane");
		const cfg = tmp("cfg");
		const plan = mountPlan({
			lane,
			argv: [],
			readOnly: [{ src: "/usr/share" }],
			writable: [{ src: cfg, dst: "/cfg" }],
		});
		const writable = plan
			.filter((m) => m.kind === "bind" || m.kind === "tmpfs")
			.map((m) => `${m.origin}:${m.dst}`);
		expect(writable).toEqual(["system:/tmp", "adapter:/cfg", "lane:/lane"]);
		expect(plan.find((m) => m.dst === "/usr/share")).toMatchObject({
			kind: "ro-bind",
			origin: "declared",
		});
	});

	test("an adapter-declared writable path outside the lane is writable", async () => {
		const cfg = tmp("cfg");
		const { out } = await sh("echo x > /cfg/a && echo ok", {
			writable: [{ src: cfg, dst: "/cfg" }],
		});
		expect(out).toEqual(["ok"]);
		expect(readFileSync(join(cfg, "a"), "utf8")).toBe("x\n");
	});

	test("the host environment is not inherited, the explicit one is", async () => {
		process.env.HOST_ONLY_VAR = "leak";
		const { out } = await sh("env | sort", { env: { FOO: "bar" } });
		delete process.env.HOST_ONLY_VAR;
		expect(out.some((l) => l.startsWith("HOST_ONLY_VAR"))).toBe(false);
		expect(out).toContain("FOO=bar");
	});
});

const SECRET = "sk-live-12345";

describe("secrets", () => {
	test("secret values never appear in returned lines or stderr, nor in the bwrap argv", async () => {
		const secret = 'sk-live-"abc"123';
		const lane = tmp("lane");
		const p = bubblewrap.start({
			lane,
			argv: [
				"sh",
				"-c",
				`echo "key=$API_KEY"; echo "{\\"k\\":\\"$API_KEY\\"}"; echo "err $API_KEY" >&2; sleep 1`,
			],
			secrets: { API_KEY: secret },
		});
		for (const pid of runProcesses(p.id))
			expect(readFileSync(`/proc/${pid}/cmdline`, "latin1")).not.toContain(
				"sk-live",
			);
		const out: string[] = [];
		for await (const l of p.stdout) out.push(l);
		const exit = await p.exited;
		const logs = JSON.stringify([out, exit.stderr]);
		expect(logs).not.toContain("sk-live");
		expect(out[0]).toBe("key=[redacted]");
		expect(exit.stderr).toContain("err [redacted]");
	});

	test.each<[string, Partial<SandboxSpec>, string, string]>([
		[
			"a secret",
			{ secrets: { API_KEY: SECRET } },
			"[redacted]",
			"env=[redacted]",
		],
		["a masked value", { masked: [SECRET] }, "[redacted]", "env=none"],
		["a value too short to mask", { masked: ["abc"] }, "abc", "env=none"],
	])(
		"%s is masked in the output, and only a secret reaches the environment",
		async (_, spec, shown, env) => {
			const p = bubblewrap.start({
				lane: tmp("lane"),
				argv: [
					"sh",
					"-c",
					`echo "${spec.masked?.[0] ?? SECRET}"; echo "env=\${API_KEY:-none}"`,
				],
				...spec,
			});
			const out: string[] = [];
			for await (const l of p.stdout) out.push(l);
			await p.exited;
			expect(out).toEqual([shown, env]);
		},
	);
});

describe("process tree", () => {
	test("kill leaves zero survivors, including a setsid escapee", async () => {
		const lane = tmp("lane");
		mkdirSync(lane, { recursive: true });
		const p = bubblewrap.start({
			lane,
			argv: [
				"sh",
				"-c",
				"sleep 300 & ( sleep 301 & wait ) & setsid sleep 302 & echo up; while :; do sleep 1; done",
			],
		});
		const it = p.stdout[Symbol.asyncIterator]();
		expect((await it.next()).value).toBe("up");
		await Bun.sleep(200);
		expect(runProcesses(p.id).length).toBeGreaterThanOrEqual(5);
		await p.kill();
		expect(runProcesses(p.id)).toEqual([]);
		expect((await p.exited).signal).toBe("SIGKILL");
	});

	test("a 300 KB stdin reaches the process intact", async () => {
		const big = "a".repeat(300 * 1024);
		const { out } = await sh("wc -c", { stdin: big });
		expect(Number(out[0])).toBe(big.length);
	});
});

describe("policy", () => {
	test("bwrap args pin die-with-parent, new-session and a final remount-ro", () => {
		const args = bwrapArgs(mountPlan({ lane: tmp("lane"), argv: [] }), [
			"true",
		]);
		expect(args).toContain("--die-with-parent");
		expect(args).toContain("--new-session");
		const lastBind = Math.max(
			args.lastIndexOf("--bind"),
			args.lastIndexOf("--ro-bind"),
		);
		expect(args.indexOf("--remount-ro")).toBeGreaterThan(lastBind);
		expect(args.slice(args.indexOf("--remount-ro"))).toEqual([
			"--remount-ro",
			"/",
			"--chdir",
			"/lane",
			"--",
			"true",
		]);
	});

	test("an adapter writable bind targeting the lane is rejected", () => {
		expect(() =>
			mountPlan({
				lane: tmp("lane"),
				argv: [],
				writable: [{ src: "/tmp", dst: "/lane/x" }],
			}),
		).toThrow(/lane's area/);
	});
});
