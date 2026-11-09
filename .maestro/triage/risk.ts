import { basename, posix } from "node:path";
import type { Tier } from "../shared";

export const RISKS = ["low", "medium", "high"] as const;
export type Risk = (typeof RISKS)[number];

/** The areas, in the order that breaks a tie (triage-labels.md). */
export const AREAS = [
	"core",
	"cli",
	"host",
	"packs",
	"docs",
	"factory",
] as const;
type Area = (typeof AREAS)[number];

const AREA_PATHS: Record<Area, readonly string[]> = {
	core: [
		"packages/ir/",
		"packages/core/",
		"packages/sdk/",
		"packages/testkit/",
	],
	cli: ["packages/cli/", "packages/render-text/"],
	host: ["packages/host-repo/", "packages/host-repo-sdk/", "packages/harness-"],
	packs: ["packs/"],
	docs: ["docs/"],
	factory: ["scripts/factory/", ".maestro/"],
};

/** Markdown that sets a contract: a path ending in `/` is a directory holding every path under it, any other a file. */
const CONTRACT_DOCS = [
	"docs/requirements.md",
	"docs/sdk-spec.md",
	"docs/adr/",
	"GLOSSARY.md",
];
/** Paths besides Markdown that set a contract, read as `CONTRACT_DOCS` is. */
const CONTRACT_PATHS = [
	"packages/ir/",
	"packages/sdk/",
	".forgejo/",
	"justfile",
	"mise.toml",
	".maestro/config.yaml",
	".maestro/presets/",
	"scripts/factory/transitions.ts",
];
/** File names that set a contract in any directory. */
const MANIFESTS = ["package.json", "bun.lock"];
/** The fewest paths besides docs and tests that make a change wide. */
const WIDE = 8;
/** The most paths of a narrow change: a low-risk one, or a direct ruling's. */
export const NARROW = 3;
const TEST_FILE = /\.test\.ts$/;
const MARKDOWN = /\.md$/;

/** Whether `path` is the directory `dir`, which ends in `/`, or under it. */
const under = (path: string, dir: string) =>
	path.startsWith(dir) || path === dir.slice(0, -1);

/**
 * Each of `touches` normalised to a repo-relative path, and those that are not one: absolute, or climbing out of the
 * repo, or the repo itself.
 */
export function scopeOf(touches: string[]): {
	paths: string[];
	outside: string[];
} {
	const normal = touches.map((t) => posix.normalize(t.trim()));
	const isOutside = (p: string) =>
		posix.isAbsolute(p) || p === "." || p === ".." || p.startsWith("../");
	return {
		paths: normal.filter((p) => !isOutside(p)),
		outside: normal.filter(isOutside),
	};
}

const setsContract = (path: string) =>
	!TEST_FILE.test(path) &&
	(MANIFESTS.includes(basename(path)) ||
		(MARKDOWN.test(path) ? CONTRACT_DOCS : CONTRACT_PATHS).some((p) =>
			p.endsWith("/") ? under(path, p) : path === p,
		));

const isDocOrTest = (path: string) =>
	under(path, "docs/") || MARKDOWN.test(path) || TEST_FILE.test(path);

/** The risk and review tier of touching `touches`, and each rule that fired. */
function riskOf(
	touches: string[],
	contract: string,
): { risk: Risk; tier: Tier; reasons: string[] } {
	const reasons: string[] = [];
	const setting = touches.filter(setsContract);
	if (setting.length)
		reasons.push(`touches ${setting.join(", ")}, which set a contract`);
	const code = touches.filter((t) => !isDocOrTest(t));
	const wide = code.length >= WIDE;
	if (wide)
		reasons.push(
			`touches ${code.length} paths besides docs and tests, ${WIDE} or more`,
		);
	if (contract) reasons.push(`the planner names a contract: ${contract}`);
	if (reasons.length)
		return { risk: "high", tier: wide ? "risky" : "ordinary", reasons };
	// An empty list proves nothing about its paths, so it is not low.
	if (touches.length && touches.length <= NARROW && touches.every(isDocOrTest))
		return {
			risk: "low",
			tier: "small",
			reasons: [`touches only docs and tests, ${NARROW} paths or fewer`],
		};
	return { risk: "medium", tier: "ordinary", reasons };
}

/** The area holding most of `touches`, a tie going to the area first in `AREAS`, or none when no path is in one. */
function areaOf(touches: string[]): { area?: Area } {
	const inArea = (t: string, p: string) =>
		p.endsWith("/") ? under(t, p) : t.startsWith(p);
	const held = (area: Area) =>
		touches.filter((t) => AREA_PATHS[area].some((p) => inArea(t, p))).length;
	const best = AREAS.reduce((a, b) => (held(b) > held(a) ? b : a));
	return held(best) ? { area: best } : {};
}

/**
 * The risk, review tier and area of a change that touches `touches`, each normalised and those outside the repo left
 * out, and each risk rule that fired:
 * - high, when a path other than a test sets a contract, `WIDE` paths or more are neither docs nor tests, or the trimmed
 *   `contract` is not empty; its tier is `risky` when that width fired, else `ordinary`;
 * - low, when one to `NARROW` paths are all docs or tests, at tier `small`;
 * - medium, otherwise, at tier `ordinary`.
 */
export function classify(
	touches: string[],
	contract: string,
): { risk: Risk; tier: Tier; area?: Area; reasons: string[] } {
	const { paths } = scopeOf(touches);
	return { ...riskOf(paths, contract), ...areaOf(paths) };
}
