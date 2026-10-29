import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StubStep } from "../harness/index";
import {
	changed,
	cleanup,
	configOf,
	fresh,
	irOf,
	type NodeSpec,
	OK,
	performed,
	stubHost,
	toyTarget,
} from "./test-support";

afterEach(cleanup);

const builder = { profile: "builder", seat: "builder" };
const forkRoot = { ...builder, lane: { mode: "fork" } };

const writes = (files: Record<string, string>): StubStep[] =>
	Object.entries(files).map(([write, content]) => ({ write, content }));

/**
 * An empty root lane, two agents forking it to write `left` and `right`, and a changeset node over each. `first`
 * applies the left changeset to a fork of the root, and `merge` the right one to the lane `first` yields.
 */
function forksOf(strategy?: string, tail: NodeSpec[] = []): NodeSpec[] {
	const task = { prompt: "go" };
	return [
		{
			id: "root",
			kind: "agent",
			config: { ...builder, lane: fresh },
			literals: { prompt: "root" },
		},
		{
			id: "left",
			kind: "agent",
			config: forkRoot,
			literals: { prompt: "left" },
			lane: "root",
		},
		{
			id: "right",
			kind: "agent",
			config: forkRoot,
			literals: { prompt: "right" },
			lane: "root",
		},
		{ id: "csl", kind: "changeset", config: {}, lane: "left" },
		{ id: "csr", kind: "changeset", config: {}, lane: "right" },
		{
			id: "first",
			kind: "apply",
			config: { lane: { mode: "fork" } },
			lane: "root",
			wires: { changeset: "csl.changeset" },
		},
		{
			id: "merge",
			kind: "apply",
			config: {
				lane: { mode: "extend" },
				...(strategy && { strategy }),
			},
			lane: "first",
			wires: { changeset: "csr.changeset" },
		},
		...tail.map((n) => ({ ...n, literals: { ...task, ...n.literals } })),
	];
}

const edits = (left: Record<string, string>, right: Record<string, string>) =>
	stubHost((req) => {
		if (req.prompt.startsWith("left")) return [...writes(left), OK];
		if (req.prompt.startsWith("right")) return [...writes(right), OK];
		if (req.prompt.startsWith("resolve"))
			return [{ write: "a.txt", content: "resolved\n" }, OK];
		return [OK];
	});

const resolver: NodeSpec = {
	id: "resolver",
	kind: "agent",
	config: { ...builder, lane: { mode: "extend" } },
	literals: { prompt: "resolve" },
	lane: "merge",
	tolerates: "merge",
};

describe("apply", () => {
	test("two forks applied in turn hold both changes, and a changeset is its base and numbered patches", async () => {
		const target = toyTarget();
		const { host } = edits({ "l.txt": "l\n" }, { "r.txt": "r\n" });
		const config = configOf(target);
		const { id, result, instances, artifact } = await performed(
			host,
			irOf(host, forksOf(), "merge"),
			config,
		);

		expect(result).toMatchObject({ outcome: "ok", node: "merge" });
		const series = await changed(config, target, `${id}.merge`);
		expect(series).toContain("l.txt");
		expect(series).toContain("r.txt");
		const dir = artifact("csl", "changeset");
		expect(readdirSync(dir).sort()).toEqual(["0001.patch", "base"]);
		expect(readFileSync(join(dir, "0001.patch"), "utf8")).toContain("l.txt");
		expect(
			instances.find((i) => i.node === "merge")?.outputs?.lane,
		).toBeDefined();
	});

	test("a changeset's message input is written as its message file, and a changeset without one has none", async () => {
		const target = toyTarget();
		const { host } = edits({ "l.txt": "l\n" }, { "r.txt": "r\n" });
		const nodes = forksOf().map((n) =>
			n.id === "csl"
				? { ...n, message: true, literals: { message: "Add l\n" } }
				: n,
		);
		const { artifact } = await performed(
			host,
			irOf(host, nodes, "merge"),
			configOf(target),
		);
		const dir = artifact("csl", "changeset");
		expect(readdirSync(dir).sort()).toEqual(["0001.patch", "base", "message"]);
		expect(readFileSync(join(dir, "message"), "utf8")).toBe("Add l\n");
		expect(readdirSync(artifact("csr", "changeset"))).not.toContain("message");
	});

	test("a same-line conflict is rejected naming the file, and an agent extending that version resolves it", async () => {
		const target = toyTarget();
		const { host } = edits({ "a.txt": "left\n" }, { "a.txt": "right\n" });
		const config = configOf(target);
		const { id, result, instances } = await performed(
			host,
			irOf(host, forksOf(undefined, [resolver]), "resolver"),
			config,
		);

		expect(result).toMatchObject({ outcome: "ok", node: "resolver" });
		const merge = instances.find((i) => i.node === "merge");
		expect(merge).toMatchObject({ status: "rejected" });
		expect(merge?.reason).toContain("changeset conflicts in 'a.txt'");
		const series = await changed(config, target, `${id}.resolver`);
		expect(series).toContain("<<<<<<<");
		expect(series).toContain("resolved");
	});

	test("clean rejects a conflict naming the file and leaves the lane without markers", async () => {
		const target = toyTarget();
		const { host } = edits({ "a.txt": "left\n" }, { "a.txt": "right\n" });
		const config = configOf(target);
		const { id, result, instances } = await performed(
			host,
			irOf(host, forksOf("clean"), "merge"),
			config,
		);

		expect(result).toMatchObject({ outcome: "rejected", node: "merge" });
		expect(instances.find((i) => i.node === "merge")?.reason).toContain(
			"changeset does not apply cleanly to 'a.txt'",
		);
		expect(await changed(config, target, `${id}.merge`)).not.toContain(
			"<<<<<<<",
		);
	});

	test("an input that is not a changeset fails the apply, naming the port", async () => {
		const target = toyTarget();
		const { host } = edits({}, {});
		const specs: NodeSpec[] = [
			{
				id: "root",
				kind: "agent",
				config: { ...builder, lane: fresh },
				literals: { prompt: "root" },
			},
			{
				id: "merge",
				kind: "apply",
				config: { lane: { mode: "fork" } },
				lane: "root",
				wires: { changeset: "root.staged" },
			},
		];
		const { result } = await performed(
			host,
			irOf(host, specs, "merge"),
			configOf(target),
		);

		expect(result).toMatchObject({ outcome: "failed", node: "merge" });
		expect(JSON.stringify(result)).toContain(
			"input 'changeset' is not a changeset",
		);
	});
});
