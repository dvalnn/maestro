import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	busySlots,
	isMasterclass,
	isSlice,
	isStackReview,
	isTriage,
	listConcerts,
	startMasterclass,
	startSlice,
	startStackReview,
	startTriage,
} from "./concerts";
import type { Issue } from "./forge";
import { landing } from "./land";
import { type Concert, maestro } from "./maestro";
import {
	BOT,
	fakeForge,
	fakeLanding,
	fakeMaestro,
	MILESTONE,
	MILESTONE_ID,
	TREE_COMMIT,
} from "./test-support";
import type { Tick } from "./tick";

const MAIN = "main-sha";
const TREES = "/cache/trees";
const issue: Issue = {
	number: 7,
	title: "Greet by name",
	body: "",
	labels: [],
};

/** A tick on fakes whose `main` is `MAIN`, with the presets `stub` and `xscout` and `files` in the repo. */
function setup({
	files = [] as string[],
	treeFails = false,
	concerts = [] as Concert[],
} = {}) {
	const landing = fakeLanding(
		treeFails ? "tree" : undefined,
		"bun install exited 1",
	);
	const maestro = fakeMaestro(concerts, {}, {});
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

/** The path of `.maestro/<file>` in the tree of `commit`. */
const treeAt = (commit: string, file: string) =>
	join(TREES, commit, ".maestro", file);
/** `--preset` for each of `kinds`, then the tick's own, in order. */
const presets = (...kinds: string[]) =>
	[...kinds, "stub", "xscout"].flatMap((p) => ["--preset", p]);
const pinned = (cut: string) => ["-c", `target.base=${cut}`];
const NAMED = ["--tour", "v0.1.0.i7", "--title", "factory: Greet by name"];
const TRIAGE_INPUT = {
	text: "#7",
	backlog: "/run/backlog.md",
	sightings: "/run/sightings-i7.md",
	respec: true,
};
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
				treeAt(MAIN, "triage.ts"),
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
				treeAt(MAIN, "triage.ts"),
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
				treeAt(MAIN, "slice.ts"),
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
				treeAt(MAIN, "slice.ts"),
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
			"a slice revision, in main's tree, cut at and revising its base",
			(t) =>
				startSlice(t.tick, issue, { ...BUILD_INPUT, revisionBase: "rev1" }),
			MAIN,
			[
				"perform",
				treeAt(MAIN, "slice.ts"),
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
			"a stack review, in main's tree, its lane cut at the epic's base",
			kinds.review,
			MAIN,
			[
				"perform",
				treeAt(MAIN, "review.ts"),
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
				treeAt(MAIN, "masterclass.ts"),
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
	test.each(cases)("performs %s", async (_, start, commit, argv) => {
		const t = setup();
		expect(await start(t)).toBe("started");
		expect(t.trees).toEqual([commit]);
		expect(t.cwds).toEqual([join(TREES, commit)]);
		const starts = t.starts.map((args) => {
			if (!argv[1]?.endsWith("triage.ts")) return args;
			const at = args.indexOf("--sightings");
			expect(at).toBeGreaterThanOrEqual(0);
			expect(args[at + 1]).toBe("/run/sightings-i7.md");
			return [...args.slice(0, at), ...args.slice(at + 2)];
		});
		expect(starts).toEqual([argv]);
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

	test("an encore continues its concert in the tree of its commit, still pinning its cut", async () => {
		const t = setup();
		await startTriage(t.tick, issue, { ...TRIAGE_INPUT, encore: "c0" });
		await startSlice(t.tick, issue, {
			...BUILD_INPUT,
			encore: "c1",
			revisionBase: "rev1",
		});
		expect(t.trees).toEqual([TREE_COMMIT, TREE_COMMIT]);
		expect(t.cwds).toEqual([
			join(TREES, TREE_COMMIT),
			join(TREES, TREE_COMMIT),
		]);
		expect(t.starts.map((a) => a.slice(0, 2))).toEqual([
			["encore", "c0"],
			["encore", "c1"],
		]);
		expect(t.starts.map((a) => a.slice(-2))).toEqual([
			pinned(MAIN),
			pinned("rev1"),
		]);
		expect(t.starts.flat()).not.toContain("--preset");
	});

	// Seam: startTriage's arguments to the external maestro, not the composition's private params.
	test("a triage encore leaves sightings and presets to its recorded params and config", async () => {
		for (const input of [
			{ ...TRIAGE_INPUT, encore: "c0" },
			{ text: "#7", backlog: "/run/backlog.md", respec: true, encore: "c0" },
		]) {
			const t = setup();
			await startTriage(t.tick, issue, input);
			expect(t.starts).toEqual([
				["encore", "c0", ...triageFlags("--respec"), ...NAMED, ...pinned(MAIN)],
			]);
		}
	});

	test.each([
		["names no commit", "/cache/trees/not-a-commit/.maestro", "not-a-commit"],
		[
			"is at a commit the repository lacks",
			`/cache/trees/${TREE_COMMIT}/.maestro`,
			"does not have",
		],
	])("an encore whose tree %s halts without starting", async (_, dir, text) => {
		const t = setup();
		t.recorded.c0 = dir;
		t.unknown.add(TREE_COMMIT);
		expect(
			await startTriage(t.tick, issue, { ...TRIAGE_INPUT, encore: "c0" }),
		).toBeUndefined();
		expect(t.trees).toEqual([]);
		expect(t.starts).toEqual([]);
		expect(t.writes).toEqual([
			"file #100 Tour manager halted: triage of #7 did not start: maestro-tm:halt",
		]);
		expect(t.find(100).body).toContain(text);
		expect(t.find(100).body).toContain("Start a fresh concert");
	});

	test.each([
		["a fresh concert", TRIAGE_INPUT],
		["an encore", { ...TRIAGE_INPUT, encore: "c0" }],
	])(
		"%s whose tree cannot be made fails the tick, with no halt and no start",
		async (_, input) => {
			const t = setup({ treeFails: true });
			await expect(startTriage(t.tick, issue, input)).rejects.toThrow(
				"bun install exited 1",
			);
			expect(t.starts).toEqual([]);
			expect(t.writes).toEqual([]);
		},
	);

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

test("a start keeps the trees of the running concerts, of any kind, and not those of settled ones", async () => {
	const busy = "a".repeat(40);
	const done = "b".repeat(40);
	const t = setup({
		concerts: [
			{
				id: "run",
				tour: MILESTONE,
				status: "running",
				pack: "slice",
				composition: "slice",
			},
			{
				id: "old",
				tour: MILESTONE,
				status: "ok",
				pack: "triage",
				composition: "triage",
			},
		],
	});
	t.recorded.run = `/cache/trees/${busy}/.maestro`;
	t.recorded.old = `/cache/trees/${done}/.maestro`;
	await startTriage(t.tick, issue, TRIAGE_INPUT);
	t.recorded.c0 = `/cache/trees/${done}/.maestro`;
	await startTriage(t.tick, issue, { ...TRIAGE_INPUT, encore: "c0" });
	expect(t.kept).toEqual([[busy], [busy]]);
});

type RecordRow = Concert & { dir?: string; error?: string };

// The start seam uses the real reader and landing; only the maestro process and forge are external boundaries.
function treeFixture() {
	const home = mkdtempSync(join(tmpdir(), "factory-start-"));
	const repo = join(home, "repo");
	const cache = join(home, "cache");
	const root = join(cache, "trees");
	const bin = join(home, "maestro");
	const records = join(home, "records.json");
	const calls = join(home, "calls");
	const command = (cwd: string, ...args: string[]) => {
		const result = Bun.spawnSync(args, {
			cwd,
			env: {
				...process.env,
				JJ_USER: "Owner",
				JJ_EMAIL: "owner@example.com",
				JJ_CONFIG: "",
			},
		});
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
		return result.stdout.toString().trim();
	};
	command(home, "mkdir", repo);
	command(repo, "jj", "git", "init");
	writeFileSync(
		join(repo, "package.json"),
		'{"name":"fixture","private":true}\n',
	);
	command(repo, "bun", "install");
	const commits: string[] = [];
	for (let i = 0; i < 6; i++) {
		writeFileSync(join(repo, "version"), `${i}\n`);
		command(repo, "jj", "commit", "-m", `version ${i}`);
		commits.push(
			command(repo, "jj", "log", "-r", "@-", "--no-graph", "-T", "commit_id"),
		);
	}
	writeFileSync(
		bin,
		`#!${process.execPath}
const fs = require('node:fs');
const rows = JSON.parse(fs.readFileSync(${JSON.stringify(records)}, 'utf8'));
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
if (args[0] === 'ls') {
  if (rows === null) {
    if (args.includes('--tour')) { console.log('[]'); process.exit(0); }
    console.log(JSON.stringify({ok:false,error:'listing unavailable'})); process.exit(1);
  }
  let found = rows.filter(r => !args.includes('--tour') || r.tour === value('--tour') || r.tour?.startsWith(value('--tour') + '.'));
  if (args.includes('--status')) found = found.filter(r => r.status === value('--status'));
  if (args.includes('--composition')) found = found.filter(r => r.pack + '.' + r.composition === value('--composition'));
  if (!args.includes('--all')) found = found.slice(0, args.includes('--limit') ? Number(value('--limit')) : 20);
  console.log(JSON.stringify(found));
} else if (args[0] === 'config') {
  const row = rows?.find(r => r.id === args[1]);
  console.log(JSON.stringify(row?.error ? {ok:false,error:row.error} : {values:[],moduleDir:row?.dir}));
  if (row?.error) process.exit(1);
} else if (args[0] === 'perform') {
  fs.writeFileSync(${JSON.stringify(calls)}, JSON.stringify({cwd:process.cwd(),args}));
  console.log(JSON.stringify({id:'started'}));
}
`,
	);
	chmodSync(bin, 0o755);
	const t = setup();
	t.tick.cache = cache;
	t.tick.main = commits[5] ?? "";
	t.tick.maestro = maestro(bin);
	t.tick.landing = landing(repo, {
		login: BOT,
		name: BOT,
		email: "bot@example.com",
	});
	return { home, root, commits, records, calls, t };
}

async function existingTrees(f: ReturnType<typeof treeFixture>, count: number) {
	const kept: string[] = [];
	for (const commit of f.commits.slice(0, count)) {
		await f.t.tick.landing.tree(commit, f.root, kept);
		kept.push(commit);
	}
}

const row = (
	id: string,
	pack: string,
	dir: string,
	status = "running",
): RecordRow => ({
	id,
	pack,
	composition: pack,
	status,
	tour: "v0.2.0.i1",
	dir,
});

test("a start keeps every milestone's running factory trees and removes settled trees", async () => {
	const f = treeFixture();
	try {
		await existingTrees(f, 5);
		const dirs = f.commits.map((c) => join(f.root, c, ".maestro"));
		const rows = [
			...Array.from({ length: 21 }, (_, i) =>
				row(`slice${i}`, "slice", dirs[1] ?? ""),
			),
			row("last-slice", "slice", dirs[0] ?? ""),
			row("triage", "triage", dirs[1] ?? ""),
			row("review", "review", dirs[2] ?? ""),
			{
				...row("masterclass", "masterclass", dirs[3] ?? ""),
				tour: "v0.2.0.masterclass",
			},
			row("settled", "slice", dirs[4] ?? "", "ok"),
			{ ...row("unrelated", "other", ""), error: "unrelated record is broken" },
		];
		writeFileSync(f.records, JSON.stringify(rows));
		expect(
			await startTriage(f.t.tick, issue, TRIAGE_INPUT).catch(() => undefined),
		).toBe("started");
		expect(readdirSync(f.root).sort()).toEqual(
			[...f.commits.slice(0, 4), f.t.tick.main].sort(),
		);
	} finally {
		rmSync(f.home, { recursive: true, force: true });
	}
});

test("a running concert outside the root does not save a same-named tree", async () => {
	const f = treeFixture();
	try {
		await existingTrees(f, 1);
		const outside = join(f.home, "elsewhere", f.commits[0] ?? "", ".maestro");
		writeFileSync(
			f.records,
			JSON.stringify([
				{ ...row("manual", "slice", outside), tour: `${MILESTONE}.i1` },
			]),
		);
		expect(
			await startTriage(f.t.tick, issue, TRIAGE_INPUT).catch(() => undefined),
		).toBe("started");
		expect(readdirSync(f.root)).toEqual([f.t.tick.main]);
	} finally {
		rmSync(f.home, { recursive: true, force: true });
	}
});

test("an unreadable running concert leaves all trees, logs its reason and still starts", async () => {
	const f = treeFixture();
	try {
		await existingTrees(f, 2);
		const half = join(f.root, f.commits[5] ?? "", "half");
		mkdirSync(join(f.root, f.commits[5] ?? ""));
		writeFileSync(half, "unfinished");
		writeFileSync(
			f.records,
			JSON.stringify([
				{
					...row("broken", "slice", ""),
					tour: `${MILESTONE}.i1`,
					error: "snapshot does not compose",
				},
				{
					...row(
						"healthy",
						"triage",
						join(f.root, f.commits[0] ?? "", ".maestro"),
					),
					tour: `${MILESTONE}.i2`,
				},
			]),
		);
		expect(
			await startTriage(f.t.tick, issue, TRIAGE_INPUT).catch(() => undefined),
		).toBe("started");
		expect(readdirSync(f.root).sort()).toEqual(
			[...f.commits.slice(0, 2), f.t.tick.main].sort(),
		);
		const matching = f.t.said.filter(
			(line) =>
				line.includes("broken") && line.includes("snapshot does not compose"),
		);
		expect(matching).toHaveLength(1);
		expect(matching[0]).not.toContain("\n");
		expect(existsSync(half)).toBe(false);
		expect(existsSync(f.calls)).toBe(true);
		expect(JSON.parse(readFileSync(f.calls, "utf8")).cwd).toBe(
			join(f.root, f.commits[5] ?? ""),
		);
		expect(f.t.writes).toEqual([]);
	} finally {
		rmSync(f.home, { recursive: true, force: true });
	}
});

test("a multiline read failure is logged on one line", async () => {
	const f = treeFixture();
	try {
		writeFileSync(
			f.records,
			JSON.stringify([
				{ ...row("broken", "slice", ""), error: "first line\nsecond line" },
			]),
		);
		await startTriage(f.t.tick, issue, TRIAGE_INPUT).catch(() => undefined);
		const lines = f.t.said.filter((l) => l.includes("broken"));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("first line second line");
	} finally {
		rmSync(f.home, { recursive: true, force: true });
	}
});

test("a running concert recorded through a symlink to the cache, or deeper in its tree, keeps its tree", async () => {
	const f = treeFixture();
	try {
		await existingTrees(f, 3);
		const link = join(f.home, "link");
		symlinkSync(join(f.home, "cache"), link);
		writeFileSync(
			f.records,
			JSON.stringify([
				row(
					"linked",
					"slice",
					join(link, "trees", f.commits[0] ?? "", ".maestro"),
				),
				row("nested", "triage", join(f.root, f.commits[1] ?? "", "a", "b")),
			]),
		);
		await startTriage(f.t.tick, issue, TRIAGE_INPUT).catch(() => undefined);
		expect(readdirSync(f.root).sort()).toEqual(
			[...f.commits.slice(0, 2), f.t.tick.main].sort(),
		);
	} finally {
		rmSync(f.home, { recursive: true, force: true });
	}
});

test("a running concert recorded by its real path keeps its tree when the cache is reached through a symlink", async () => {
	const f = treeFixture();
	try {
		await existingTrees(f, 2);
		const link = join(f.home, "link");
		symlinkSync(join(f.home, "cache"), link);
		f.t.tick.cache = link;
		writeFileSync(
			f.records,
			JSON.stringify([
				row("real", "slice", join(f.root, f.commits[0] ?? "", ".maestro")),
			]),
		);
		await startTriage(f.t.tick, issue, TRIAGE_INPUT).catch(() => undefined);
		expect(readdirSync(f.root).sort()).toEqual(
			[f.commits[0] ?? "", f.t.tick.main].sort(),
		);
	} finally {
		rmSync(f.home, { recursive: true, force: true });
	}
});

test("a failed running concert listing makes no tree and files no halt", async () => {
	const f = treeFixture();
	try {
		writeFileSync(f.records, "null");
		await expect(startTriage(f.t.tick, issue, TRIAGE_INPUT)).rejects.toThrow(
			"listing unavailable",
		);
		expect(existsSync(f.root)).toBe(false);
		expect(existsSync(f.calls)).toBe(false);
		expect(f.t.writes).toEqual([]);
	} finally {
		rmSync(f.home, { recursive: true, force: true });
	}
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

describe("the busy slots", () => {
	const running = (pack: string): Concert => ({
		id: "c1",
		status: "running",
		pack,
		composition: pack,
	});

	test.each([
		["slice", { code: true, second: false }],
		["review", { code: true, second: false }],
		["triage", { code: false, second: true }],
		["masterclass", { code: false, second: true }],
	])("a running %s fills its slot", (pack, slots) => {
		expect(busySlots([running(pack)])).toEqual(slots);
	});

	test("a settled concert fills no slot", () => {
		expect(busySlots([{ ...running("slice"), status: "ok" }])).toEqual({
			code: false,
			second: false,
		});
	});
});

describe("listing a milestone's concerts", () => {
	test("orders concerts with the same start time by descending id, as maestro does", async () => {
		const slice: Concert = {
			id: "a1",
			status: "ok",
			pack: "slice",
			composition: "slice",
			tour: `${MILESTONE}.i7`,
			startedAt: 5,
		};
		const triage: Concert = {
			...slice,
			id: "b2",
			status: "running",
			pack: "triage",
			composition: "triage",
		};
		const { maestro } = fakeMaestro([slice, triage], {}, {});
		const listed = await listConcerts(maestro, MILESTONE);
		expect(listed.map((c) => c.id)).toEqual(["b2", "a1"]);
	});
});
