// Spike 4: Bun spawns bubblewrap + a child (stand-in, or real pi behind --pi) and streams JSON lines.
// No args: sandbox probe, streaming, prompt staging and cancel matrix against a stand-in. Exit 0 on pass.
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const t0 = performance.now();
const ms = () => String(Math.round(performance.now() - t0)).padStart(6);
const log = (s: string) => console.log(`[${ms()}ms] ${s}`);
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failed++;
};
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));

// ---- mount plan ----
const ETC = ["/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/ssl", "/etc/pki", "/etc/ca-certificates", "/etc/passwd", "/etc/group"];
type Opts = { lane: string; marker: string; cmd: string[]; die?: boolean; net?: boolean; tmpfs?: string[]; ro?: [string, string][]; env?: Record<string, string> };

function bwrapArgv(o: Opts): string[] {
  const a = ["--unshare-all"];
  if (o.net ?? true) a.push("--share-net"); // --unshare-all drops the net ns; the model API needs it back
  if (o.die ?? true) a.push("--die-with-parent");
  a.push("--new-session"); // setsid: blocks TIOCSTI terminal injection
  for (const d of ["/usr", "/bin", "/lib", "/lib64", "/sbin"]) if (existsSync(d)) a.push("--ro-bind", d, d);
  for (const p of ETC) if (existsSync(p)) a.push("--ro-bind", p, p);
  for (const d of o.tmpfs ?? []) a.push("--tmpfs", d);
  for (const [src, dst] of o.ro ?? []) a.push("--ro-bind", src, dst);
  a.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
  a.push("--bind", o.lane, "/lane", "--chdir", "/lane"); // the ONE writable dir
  a.push("--remount-ro", "/"); // the root is a tmpfs and writable by default; only the lane bind and /tmp stays rw
  a.push("--clearenv", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", "/tmp", "--setenv", "MAESTRO_SPIKE_MARK", o.marker);
  for (const [k, v] of Object.entries(o.env ?? {})) a.push("--setenv", k, v);
  return ["bwrap", ...a, "--", ...o.cmd];
}

type Proc = ReturnType<typeof Bun.spawn>;
function start(o: Opts, x: { stdin?: "pipe" | "ignore"; detached?: boolean; viaSh?: boolean } = {}): Proc {
  const argv = bwrapArgv(o);
  return Bun.spawn(x.viaSh ? ["sh", "-c", '"$@"; true', "sh", ...argv] : argv, {
    stdin: x.stdin ?? "ignore", stdout: "pipe", stderr: "pipe", detached: x.detached,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", MAESTRO_SPIKE_MARK: o.marker },
  });
}

async function readLines(s: ReadableStream<Uint8Array>, on: (l: string) => void) {
  const d = new TextDecoder();
  let buf = "";
  for await (const c of s as any) {
    buf += d.decode(c, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) { on(buf.slice(0, i).replace(/\r$/, "")); buf = buf.slice(i + 1); }
  }
  if (buf) on(buf);
}

// Every live process carrying the marker in its environ: bwrap, its init, the child and all descendants.
function marked(marker: string) {
  const out: { pid: number; ppid: number; comm: string }[] = [];
  for (const p of readdirSync("/proc")) {
    if (!/^\d+$/.test(p) || +p === process.pid) continue;
    try {
      if (!readFileSync(`/proc/${p}/environ`, "latin1").includes(`MAESTRO_SPIKE_MARK=${marker}`)) continue;
      const m = readFileSync(`/proc/${p}/stat`, "utf8").match(/\((.*)\) (\S) (\d+)/)!;
      if (m[2] !== "Z") out.push({ pid: +p, ppid: +m[3], comm: m[1] });
    } catch {}
  }
  return out;
}
const fmt = (l: { pid: number; ppid: number; comm: string }[]) => l.map((p) => `${p.comm}(${p.pid}<${p.ppid})`).join(" ") || "none";
async function survivors(marker: string, waitMs = 2500) {
  const end = performance.now() + waitMs;
  let l = marked(marker);
  while (l.length && performance.now() < end) { await sleep(100); l = marked(marker); }
  for (const p of l) try { process.kill(p.pid, "SIGKILL"); } catch {} // cleanup only
  return l;
}

// ---- stand-in child: JSON lines, stderr noise, grandchildren (incl. one that escapes via setsid) ----
const STANDIN = `echo '{"type":"session","version":3}'
sleep 300 &
( sleep 301 & wait ) &
setsid sleep 302 &
i=0
while [ $i -lt \${N:-5} ]; do echo "{\\"type\\":\\"tick\\",\\"i\\":$i}"; echo "noise $i" >&2; sleep \${D:-0.3}; i=$((i+1)); done
echo '{"type":"agent_end"}'
`;

async function main() {
  const lane = mkdtempSync(join(tmpdir(), "spike4-lane-"));
  const bwrapOk = Bun.which("bwrap");
  check("bwrap on PATH", !!bwrapOk, String(bwrapOk));
  if (!bwrapOk) { console.log("FAIL cannot continue"); process.exit(1); }
  writeFileSync(join(lane, "stand-in.sh"), STANDIN);
  const base = (cmd: string[], extra: Partial<Opts> = {}): Opts => ({ lane, marker: crypto.randomUUID(), cmd, ...extra });
  const text = async (p: Proc) => (await new Response(p.stdout as ReadableStream).text()).trim();

  // 1. sandbox probe
  console.log("\n== 1. mount plan probe ==");
  const probe = `echo x > /lane/in.txt && echo IN_LANE=ok || echo IN_LANE=FAIL
for p in /usr/x /etc/x /x /lane/../x; do (echo x > $p) 2>/dev/null && echo "WROTE $p" || echo "DENIED $p"; done
(echo x > /tmp/x) 2>/dev/null && echo "WROTE /tmp/x (tmpfs, ephemeral)"
ls /home 2>&1 | head -1
echo "net_ifaces=$(tail -n +3 /proc/net/dev | wc -l) procs=$(ls /proc | grep -c '^[0-9]')"`;
  const pr = start(base(["sh", "-c", probe]));
  const out = await text(pr);
  await pr.exited;
  console.log(out);
  check("write inside lane succeeds", out.includes("IN_LANE=ok") && existsSync(join(lane, "in.txt")));
  check("writes outside lane fail", /DENIED \/usr\/x/.test(out) && /DENIED \/etc\/x/.test(out) && /DENIED \/x/.test(out) && !out.includes("WROTE /usr") && !out.includes("WROTE /etc") && !out.includes("WROTE /x") && !out.includes("WROTE /lane/../x"));
  check("host / untouched", !existsSync("/x") && !existsSync("/usr/x"));
  const nr = start(base(["sh", "-c", "tail -n +3 /proc/net/dev | wc -l"], { net: false }));
  const ifacesNoNet = +(await text(nr));
  const shared = +(out.match(/net_ifaces=(\d+)/)?.[1] ?? 0);
  check("--share-net restores host interfaces", shared > ifacesNoNet, `shared=${shared} unshared=${ifacesNoNet}`);

  // 2. streaming
  console.log("\n== 2. streaming ==");
  const so = base(["sh", "/lane/stand-in.sh"], { env: { N: "5", D: "0.4" } });
  const sp = start(so);
  const arrivals: number[] = [];
  let nonJson = 0, stderrBytes = 0;
  const rd = readLines(sp.stdout as ReadableStream<Uint8Array>, (l) => {
    try { const e = JSON.parse(l); arrivals.push(performance.now()); log(`event ${e.type}`); } catch { nonJson++; }
  });
  const er = (async () => { for await (const c of sp.stderr as any) stderrBytes += c.length; })();
  await sp.exited; const exitAt = performance.now(); await rd; await er;
  check("events arrive incrementally", arrivals.length >= 7 && arrivals[0] < exitAt - 1500 && arrivals.at(-2)! - arrivals[0] > 1500, `n=${arrivals.length} first=${Math.round(exitAt - arrivals[0])}ms before exit, stderrBytes=${stderrBytes}, nonJson=${nonJson}`);
  await survivors(so.marker, 100);

  // 3. prompt staging (300 KB)
  console.log("\n== 3. prompt staging ==");
  const big = "a".repeat(300 * 1024);
  let argvErr = "";
  try { const p = start(base(["sh", "-c", "echo $#", "_", big])); await p.exited; argvErr = p.exitCode ? `exit ${p.exitCode}` : ""; } catch (e: any) { argvErr = String(e.code ?? e.message); }
  check("300 KB as one argv entry is refused (E2BIG)", argvErr !== "", argvErr);
  const sin = start(base(["sh", "-c", "wc -c"]), { stdin: "pipe" });
  (sin.stdin as any).write(big); (sin.stdin as any).end();
  const sinOut = await text(sin);
  check("300 KB via stdin", +sinOut === big.length, `wc -c=${sinOut}`);
  writeFileSync(join(lane, "prompt.md"), big);
  const sf = start(base(["sh", "-c", "wc -c < /lane/prompt.md"]));
  const sfOut = await text(sf);
  check("300 KB via file in lane (pi @prompt.md)", +sfOut === big.length, `wc -c=${sfOut}`);

  // 4. cancel matrix
  console.log("\n== 4. cancel matrix (tree = bwrap, init, sh, sleeps, setsid-escapee) ==");
  const rows: { name: string; die: boolean; how: string; detached?: boolean; viaSh?: boolean }[] = [
    { name: "SIGKILL bwrap pid", die: false, how: "kill" },
    { name: "SIGTERM bwrap pid", die: false, how: "term" },
    { name: "SIGKILL process group", die: false, how: "pg", detached: true },
    { name: "SIGKILL bwrap pid", die: true, how: "kill" },
    { name: "SIGTERM bwrap pid", die: true, how: "term" },
    { name: "SIGKILL process group", die: true, how: "pg", detached: true },
    { name: "SIGKILL parent (sh) only", die: false, how: "parent", viaSh: true },
    { name: "SIGKILL parent (sh) only", die: true, how: "parent", viaSh: true },
  ];
  const res: Record<string, number> = {};
  for (const r of rows) {
    const o = base(["sh", "/lane/stand-in.sh"], { die: r.die, env: { N: "1000", D: "0.2" } });
    const p = start(o, { detached: r.detached, viaSh: r.viaSh });
    await new Promise<void>((ok) => readLines(p.stdout as ReadableStream<Uint8Array>, (l) => { if (l.includes("tick")) ok(); }));
    await sleep(200);
    const before = marked(o.marker);
    if (r.how === "kill") p.kill("SIGKILL");
    else if (r.how === "term") p.kill("SIGTERM");
    else if (r.how === "pg") process.kill(-p.pid, "SIGKILL");
    else p.kill("SIGKILL");
    const left = await survivors(o.marker);
    const key = `${r.name} die-with-parent=${r.die}`;
    res[key] = left.length;
    console.log(`${key.padEnd(52)} before=${before.length} survivors=${left.length} [${fmt(left)}]`);
  }
  // Recommended: --die-with-parent makes SIGKILL on bwrap (or the death of maestro itself) reap everything via the pid ns.
  check("--die-with-parent + SIGKILL bwrap reaps tree", res["SIGKILL bwrap pid die-with-parent=true"] === 0);
  check("--die-with-parent reaps tree when parent dies", res["SIGKILL parent (sh) only die-with-parent=true"] === 0);

  rmSync(lane, { recursive: true, force: true });
  console.log(failed ? `\nFAILED ${failed}` : "\nALL PASS");
  process.exit(failed ? 1 : 0);
}

// ---- --pi: real pi runs (spend model tokens) ----
async function pi() {
  const piBin = Bun.which("pi");
  if (!piBin) { console.log("FAIL pi not on PATH"); process.exit(1); }
  const piReal = realpathSync(piBin);
  const piDir = dirname(piReal);
  const cfg = join(homedir(), ".pi/agent");
  const lane = mkdtempSync(join(tmpdir(), "spike4-pilane-"));
  const stamp = join(lane, "..", `spike4-stamp-${process.pid}`);
  writeFileSync(stamp, "");
  // pi locks settings.json via a sibling .lock dir, so its config dir must be writable: tmpfs, with the real files bound read-only on top
  const ro: [string, string][] = [[piDir, piDir], ...["auth.json", "settings.json", "models-store.json"].map((f): [string, string] => [join(cfg, f), `/pi-agent/${f}`])];
  const env = { PI_CODING_AGENT_DIR: "/pi-agent" };
  console.log(`pi=${piBin} ro-binds: ${piDir}; ${cfg}/{auth,settings,models-store}.json -> /pi-agent/ (tmpfs dir)`);
  let bad = 0;
  const schema = new Map<string, { keys: Set<string>; sample: string }>();
  const redact = (_k: string, v: any) => (typeof v === "string" && v.length > 40 ? v.slice(0, 40) + `…(${v.length})` : v);

  async function run(label: string, args: string[], x: { stdin?: string; killOn?: (e: any) => boolean } = {}) {
    console.log(`\n== ${label} ==  pi ${args.join(" ")}${x.stdin ? "  (prompt on stdin)" : ""}`);
    const o: Opts = { lane, marker: crypto.randomUUID(), cmd: [piReal, ...args], tmpfs: ["/pi-agent"], ro, env };
    const p = start(o, { stdin: x.stdin ? "pipe" : "ignore" });
    if (x.stdin) { (p.stdin as any).write(x.stdin); (p.stdin as any).end(); }
    let nonJson = 0, stderr = "", n = 0, killed = false, usage: string[] = [], cost = 0, tokens = 0;
    const rd = readLines(p.stdout as ReadableStream<Uint8Array>, (l) => {
      let e: any;
      try { e = JSON.parse(l); } catch { nonJson++; log(`NON-JSON stdout line (${l.length} bytes)`); return; }
      n++;
      const sub = e.assistantMessageEvent?.type ?? e.message?.role ?? e.toolName ?? "";
      log(`${e.type}${sub ? "/" + sub : ""}`);
      const sk = `${e.type}${sub ? "/" + sub : ""}`;
      const s = schema.get(sk) ?? { keys: new Set(), sample: JSON.stringify(e, redact).slice(0, 700) };
      Object.keys(e).forEach((k) => s.keys.add(k));
      schema.set(sk, s);
      if (e.type === "message_end" && e.message?.role === "assistant" && e.message.usage) { usage = Object.keys(e.message.usage); cost += e.message.usage.cost?.total ?? 0; tokens += e.message.usage.totalTokens ?? 0; }
      if (!killed && x.killOn?.(e)) {
        killed = true;
        (async () => { // wait until the bash tool's child (sleep) exists, so the kill has a real tree to reap
          for (let i = 0; i < 100 && !marked(o.marker).some((q) => q.comm === "sleep"); i++) await sleep(20);
          const before = marked(o.marker);
        console.log(`   tree before kill: ${fmt(before)}`);
          p.kill("SIGKILL");
          const l = await survivors(o.marker);
          console.log(`   after SIGKILL bwrap (die-with-parent): survivors=${l.length} [${fmt(l)}]`);
          if (l.length) bad++;
        })();
      }
    });
    const er = (async () => { for await (const c of p.stderr as any) stderr += new TextDecoder().decode(c); })();
    await p.exited; await rd; await er;
    await sleep(x.killOn ? 3500 : 0);
    console.log(`exit=${p.exitCode} signal=${p.signalCode} events=${n} nonJson=${nonJson} stderrBytes=${stderr.length} usageKeys=[${usage}] tokens=${tokens} cost=${cost.toFixed(4)}`);
    if (stderr) console.log("stderr head: " + stderr.slice(0, 300).replace(/\n/g, " | "));
    return p.exitCode;
  }
  const ran = async (...a: Parameters<typeof run>) => { if ((await run(...a)) !== 0) bad++; };

  await ran("pi A: streaming, prompt via stdin", ["-p", "--mode", "json", "--no-session", "--no-tools"], { stdin: "reply with the word ok" });
  writeFileSync(join(lane, "prompt.md"), "create file hello.txt containing hi in the current directory. Then reply done.");
  await ran("pi B: tool use, prompt via @file", ["-p", "--mode", "json", "--no-session", "@prompt.md"]);
  console.log(`lane files: ${readdirSync(lane).join(", ")}; hello.txt=${existsSync(join(lane, "hello.txt")) ? JSON.stringify(readFileSync(join(lane, "hello.txt"), "utf8")) : "MISSING"}`);
  const f = Bun.spawnSync(["find", "/home", "/tmp", "/var/tmp", "/root", "-name", "hello.txt", "-newer", stamp, "-not", "-path", `${lane}/*`], { stderr: "ignore" });
  console.log(`hello.txt elsewhere on host: [${f.stdout.toString().trim() || "none"}]`);
  await run("pi C: cancel while a bash tool child runs", ["-p", "--mode", "json", "--no-session", "--tools", "bash", "Run the bash command `sleep 4711` with a timeout of 600 seconds. Do nothing else."], { killOn: (e) => e.type === "tool_execution_start" });

  console.log("\n== event schema (type: top-level keys) ==");
  for (const [k, v] of schema) console.log(`${k}: ${[...v.keys].join(",")}\n   e.g. ${v.sample}`);
  rmSync(lane, { recursive: true, force: true }); rmSync(stamp, { force: true });
  process.exit(bad ? 1 : 0); // pi C is killed on purpose, so its exit code is not judged
}

if (process.argv.includes("--pi")) await pi(); else await main();
