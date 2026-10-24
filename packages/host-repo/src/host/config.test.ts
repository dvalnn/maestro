import { afterEach, expect, test } from "bun:test";
import { compose } from "@maestro/core/compose";
import {
	CORE_CONFIG,
	type Layer,
	layered,
	parseLayer,
} from "@maestro/core/config";
import { hostSetup } from "@maestro/core/host";
import { repoSetup, resolveRole } from "./config";
import {
	cleanup,
	configOf,
	fresh,
	irOf,
	noCode,
	OK,
	stubHost,
	toyTarget,
} from "./test-support";

afterEach(cleanup);

const layer = (text: string, name: "workspace" | "flag" | "profile") =>
	parseLayer(text, { file: "/w/c.yaml", layer: name });

/** The role `x` resolves to for an agent that pins `inline`, under config `layers` lowest first. */
function resolved(layers: Layer[], inline: object) {
	const config = layered([
		parseLayer("dataRoot: /d\n", { file: "/d.yaml", layer: "default" }),
		...layers,
	]);
	const host = { name: "repo", config: { roles: {} } } as never;
	return resolveRole(
		{ name: "x", ...inline },
		repoSetup(hostSetup(host, config)),
	);
}

const FILE = layer("roles: {x: {harness: claude, model: opus}}", "workspace");

test("a command-line !replace of a role drops its inline fields, and a later -c still merges into it", () => {
	const replace = layer("roles: {x: !replace {harness: pi, model: m}}", "flag");
	expect(resolved([FILE, replace], { thinking: "max" })).toEqual({
		harness: "pi",
		model: "m",
	});
	const merge = layer('roles: {x: {model: "n"}}', "flag");
	expect(resolved([FILE, replace, merge], { thinking: "max" })).toEqual({
		harness: "pi",
		model: "n",
	});
	expect(resolved([FILE, merge], { thinking: "max" })).toEqual({
		harness: "claude",
		model: "n",
		thinking: "max",
	});
});

test("a !replace in a config file leaves the inline fields in force", () => {
	const file = layer(
		"roles: {x: !replace {harness: pi, model: m}}",
		"workspace",
	);
	expect(resolved([FILE, file], { thinking: "max" })).toEqual({
		harness: "pi",
		model: "m",
		thinking: "max",
	});
});

test.each([
	["relative", "tools", "is not an absolute path. Give an absolute path"],
	["missing", "/no/such/dir", "does not exist. Create it, or drop the bind"],
])(
	"a %s sandbox.path directory is refused, naming the key",
	async (_, dir, why) => {
		const { host } = stubHost(() => [OK]);
		const repo = toyTarget();
		const composed = await compose({
			ir: irOf(
				host,
				[{ id: "x", kind: "check", config: { lane: fresh, check: "hello" } }],
				"x",
			),
			config: configOf(repo, { sandbox: { path: [dir] } }),
			core: CORE_CONFIG,
			packs: {},
			hosts: [host],
			loadCode: noCode,
			caps: {},
		});
		expect(
			composed.ok
				? []
				: composed.diagnostics.map((d) => `${d.message}. ${d.hint}`),
		).toEqual([`sandbox.path directory '${dir}' ${why}`]);
	},
);
