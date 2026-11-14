import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	isMasterclass,
	isSlice,
	isStackReview,
	isTriage,
	startMasterclass,
	startSlice,
	startStackReview,
	startTriage,
} from "./concerts";
import type { Issue } from "./forge";
import {
	BOT,
	fakeForge,
	fakeLanding,
	fakeMaestro,
	MILESTONE,
	MILESTONE_ID,
} from "./test-support";
import type { Tick } from "./tick";

const MAIN = "main-sha";
const COMPOSITIONS = "/cache/compositions";
const issue: Issue = {
	number: 7,
	title: "Greet by name",
	body: "",
	labels: [],
};

/** A tick on fakes whose `main` is `MAIN`, with the presets `stub` and `xscout` and `files` in the repo. */
function setup({ differs = false, files = [] as string[] } = {}) {
	const landing = fakeLanding(undefined, "", differs);
	const maestro = fakeMaestro([], {}, {});
	const forge = fakeForge([]);
	const said: string[] = [];
	const tick: Tick = {
		forge: forge.forge,
		maestro: maestro.maestro,
		landing: landing.landing,
		lock: () => true,
		say: (line) => said.push(line),
		has: (path) => files.includes(path),
		milestone: MILESTONE,
		milestoneId: MILESTONE_ID,
		presets: ["stub", "xscout"],
		dir: "/run",
		cache: "/cache",
		concerts: [],
		login: BOT,
		main: MAIN,
		closed: async () => [],
	};
	return { tick, said, ...landing, ...maestro, ...forge };
}
type Setup = ReturnType<typeof setup>;

/** The path of `.maestro/<file>` as exported at `commit`. */
const exportedAt = (commit: string, file: string) =>
	join(COMPOSITIONS, commit, ".maestro", file);
/** `--preset` for each of `kinds`, then the tick's own, in order. */
const presets = (...kinds: string[]) =>
	[...kinds, "stub", "xscout"].flatMap((p) => ["--preset", p]);
const pinned = (cut: string) => ["-c", `target.base=${cut}`];
const NAMED = ["--tour", "v0.1.0.i7", "--title", "factory: Greet by name"];
const TRIAGE_INPUT = { text: "#7", backlog: "/run/backlog.md", respec: true };
const triageFlags = (respec: string) => [
	"--issue",
	"#7",
	"--backlog",
	"/run/backlog.md",
	respec,
];
const FILES = { lessons: "l.md", reports: "r.md", backlog: "b.md" };
const REVIEW_INPUT = { request: "review it", base: "base0", head: "sha7" };
const BUILD_INPUT = { request: "build it", risk: "low" } as const;

type Start = (t: Setup) => Promise<string | undefined>;
const kinds = {
	triage: (t) => startTriage(t.tick, issue, TRIAGE_INPUT),
	slice: (t) => startSlice(t.tick, issue, BUILD_INPUT),
	review: (t) => startStackReview(t.tick, issue, REVIEW_INPUT),
	masterclass: (t) => startMasterclass(t.tick, FILES),
} satisfies Record<string, Start>;
/** What a halt names, by kind. */
const WHAT = {
	triage: "triage of #7",
	slice: "build of #7",
	review: "stack review of #7",
	masterclass: "masterclass",
};

describe("starting a concert", () => {
	const cases: [string, Start, string, string[]][] = [
		[
			"a fresh triage on main, under its preset",
			kinds.triage,
			MAIN,
			[
				"perform",
				exportedAt(MAIN, "triage.ts"),
				...triageFlags("--respec"),
				...presets("triage"),
				...NAMED,
				...pinned(MAIN),
			],
		],
		[
			"a triage with nothing to respec",
			(t) => startTriage(t.tick, issue, { ...TRIAGE_INPUT, respec: false }),
			MAIN,
			[
				"perform",
				exportedAt(MAIN, "triage.ts"),
				...triageFlags("--no-respec"),
				...presets("triage"),
				...NAMED,
				...pinned(MAIN),
			],
		],
		[
			"a fresh slice on main, under its triaged risk",
			kinds.slice,
			MAIN,
			[
				"perform",
				exportedAt(MAIN, "slice.ts"),
				"--request",
				"build it",
				"--revises",
				"",
				...presets("low"),
				...NAMED,
				...pinned(MAIN),
			],
		],
		[
			"a slice whose risk label overrides the triaged risk",
			(t) =>
				startSlice(t.tick, { ...issue, labels: ["risk/high"] }, BUILD_INPUT),
			MAIN,
			[
				"perform",
				exportedAt(MAIN, "slice.ts"),
				"--request",
				"build it",
				"--revises",
				"",
				...presets("high"),
				...NAMED,
				...pinned(MAIN),
			],
		],
		[
			"a slice revision, cut at and revising its base",
			(t) =>
				startSlice(t.tick, issue, { ...BUILD_INPUT, revisionBase: "rev1" }),
			"rev1",
			[
				"perform",
				exportedAt("rev1", "slice.ts"),
				"--request",
				"build it",
				"--revises",
				"rev1^!",
				...presets("low"),
				...NAMED,
				...pinned("rev1"),
			],
		],
		[
			"a stack review, its composition and lane cut at the epic's base",
			kinds.review,
			"base0",
			[
				"perform",
				exportedAt("base0", "review.ts"),
				"--request",
				"review it",
				"--revs",
				"base0..sha7",
				...presets("high"),
				...NAMED,
				...pinned("base0"),
			],
		],
		[
			"a masterclass on main, under the triage preset",
			kinds.masterclass,
			MAIN,
			[
				"perform",
				exportedAt(MAIN, "masterclass.ts"),
				"--lessons",
				"l.md",
				"--reports",
				"r.md",
				"--backlog",
				"b.md",
				...presets("triage"),
				"--tour",
				"v0.1.0.masterclass",
				"--title",
				"factory: masterclass",
				...pinned(MAIN),
			],
		],
	];
	test.each(cases)("performs %s", async (_, start, exported, argv) => {
		const t = setup();
		expect(await start(t)).toBe("started");
		expect(t.exported).toEqual([exported]);
		expect(t.starts).toEqual([argv]);
	});

	test("adds the area preset between the risk's and the tick's, only when the repo has its file", async () => {
		const labelled = { ...issue, labels: ["area/cli"] };
		const t = setup({ files: [".maestro/presets/area-cli.yaml"] });
		await startSlice(t.tick, labelled, BUILD_INPUT);
		expect(t.starts[0]?.slice(6, 14)).toEqual(presets("low", "area-cli"));
		const bare = setup();
		await startSlice(bare.tick, labelled, BUILD_INPUT);
		expect(bare.starts[0]?.slice(6, 12)).toEqual(presets("low"));
	});

	test("a masterclass keeps what maestro printed in the tick's directory", async () => {
		const t = setup();
		await startMasterclass(t.tick, FILES);
		expect(t.logs).toEqual(["/run/masterclass.log"]);
	});

	test("an encore continues its concert without exporting a composition, still pinning its cut", async () => {
		const t = setup();
		await startTriage(t.tick, issue, { ...TRIAGE_INPUT, encore: "c0" });
		await startSlice(t.tick, issue, {
			...BUILD_INPUT,
			encore: "c1",
			revisionBase: "rev1",
		});
		expect(t.exported).toEqual([]);
		expect(t.starts.map((a) => a.slice(0, 2))).toEqual([
			["encore", "c0"],
			["encore", "c1"],
		]);
		expect(t.starts.map((a) => a.slice(-2))).toEqual([
			pinned(MAIN),
			pinned("rev1"),
		]);
	});

	test("compositionsAt moves only the commit the composition is exported at", async () => {
		const t = setup();
		t.tick.compositionsAt = "@";
		await startStackReview(t.tick, issue, REVIEW_INPUT);
		expect(t.exported).toEqual(["@"]);
		expect(t.starts[0]?.slice(-2)).toEqual(pinned("base0"));
	});

	test("says once that the exported .maestro/ differs from the checkout's, naming the commit", async () => {
		const differing = setup({ differs: true });
		await startTriage(differing.tick, issue, TRIAGE_INPUT);
		expect(differing.said).toEqual([
			`performing .maestro/ at ${MAIN}, which differs from the checkout's; config, presets and profiles still come from the checkout's .maestro/config.yaml`,
		]);
		const same = setup();
		await startTriage(same.tick, issue, TRIAGE_INPUT);
		expect(same.said).toEqual([]);
	});

	test.each(Object.entries(kinds))(
		"a refused %s files a halt issue and returns no id",
		async (kind, start) => {
			const t = setup();
			t.refuse("maestro: no such preset");
			expect(await start(t)).toBeUndefined();
			expect(t.starts).toEqual([]);
			const title = `Tour manager halted: ${WHAT[kind as keyof typeof WHAT]} did not start`;
			expect(t.writes).toEqual([`file #100 ${title}: maestro-tm:halt`]);
			expect(t.find(100).body).toContain("maestro: no such preset");
		},
	);
});

describe("recognising a concert", () => {
	const concert = (pack: string, tour?: string) => ({
		id: "c",
		status: "ok",
		pack,
		composition: pack,
		tour,
	});

	test("tells each kind by its pack and composition", () => {
		const kinds = [
			["triage", isTriage],
			["slice", isSlice],
			["review", isStackReview],
		] as const;
		for (const [pack, is] of kinds) {
			expect(kinds.map(([p]) => is(concert(p)))).toEqual(
				kinds.map(([p]) => p === pack),
			);
			expect(is({ ...concert(pack), composition: "other" })).toBe(false);
		}
	});

	test("takes a masterclass only on its milestone's tour", () => {
		const mine = concert("masterclass", `${MILESTONE}.masterclass`);
		expect(isMasterclass(mine, MILESTONE)).toBe(true);
		expect(isMasterclass(mine, "v0.2.0")).toBe(false);
		expect(isMasterclass(concert("triage", mine.tour), MILESTONE)).toBe(false);
	});
});
