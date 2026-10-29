import { expect, test } from "bun:test";
import { type Layer, layered, parseLayer } from "@maestro/core/config";
import { hostSetup } from "@maestro/core/host";
import { repoSetup, resolveRole } from "./config";

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
		repoSetup(hostSetup(host, config, { user: "/nonexistent", packs: {} })),
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
