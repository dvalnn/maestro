import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { CodeNode } from "./sdk";

const out = join(dirname(process.execPath), "pack");
const fails: string[] = [];
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${extra}`);
  if (!ok) fails.push(name);
};
// structural check, never instanceof across SDK copies (ADR 0002)
const isCode = (n: any) => n?.kind === "code" && typeof n.id === "string" && typeof n.run === "function";

async function load(dir: string) {
  const m = JSON.parse(readFileSync(join(dir, "maestro-pack.json"), "utf8"));
  return { m, mod: await import(join(dir, m.entry)) };
}

const packDir = process.argv[2] ?? out;
const { m, mod } = await load(packDir);
const node = mod.nodes.find(isCode);
check("a dynamic import of external entry", !!node, `pack=${m.name}@${m.version}`);
check("a code node runs", node.run("x") === "X", `out=${node.run("x")}`);
check("c node:path builtin inside pack", node.run("x") === "X");
check("b instanceof across copies is false", !(node instanceof CodeNode));
check("b structural check is true", isCode(node));

if (process.argv[2] === undefined) {
  // (d) un-bundled bare specifier
  try {
    await load(join(dirname(out), "pack-bad"));
    check("d bare specifier errors", false, "no error");
  } catch (e) {
    console.log(`captured: ${(e as Error).message}`);
    check("d bare specifier errors", true);
  }
  // (e) TS entry
  try {
    const t = await load(join(dirname(out), "pack-ts"));
    console.log(`INFO ts entry loads: ${t.mod.nodes[0].run("ts")}`);
  } catch (e) {
    console.log(`INFO ts entry fails: ${(e as Error).message}`);
  }
}
process.exit(fails.length ? 1 : 0);
