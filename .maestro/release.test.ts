import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type CodeContext, reject } from "@maestro/sdk";
import type { Forge, Issue } from "../scripts/factory/forge";
import {
	checkVersion,
	milestoneReady,
	requireMilestone,
	targetOf,
	tipOf,
} from "./release";
import {
	classics,
	detailed,
	maestro,
	scratch,
	stubOutputs,
} from "./testing/stub";

const issue = (number: number, milestone?: number): Issue => ({
	number,
	title: `issue ${number}`,
	body: "",
	labels: [],
	milestone,
});

/** A forge holding the milestone `v9.9.9` as id 3, and `open` as its open issues for any milestone asked. */
const forgeWith = (open: Issue[]): Pick<Forge, "milestone" | "open"> => ({
	milestone: async (title) => (title === "v9.9.9" ? 3 : undefined),
	open: async () => open,
});

// Seam: milestoneReady gates a stable on its milestone as the forge reads it, so no test reaches the network.
test("milestoneReady passes a milestone with no open issue, and ignores an open issue of another milestone", async () => {
	expect(await milestoneReady(forgeWith([issue(9, 4)]), "v9.9.9")).toEqual({});
});

test("milestoneReady rejects a milestone with open issues, naming each, and one the forge does not have", async () => {
	expect(
		await milestoneReady(forgeWith([issue(7, 3), issue(8, 3)]), "v9.9.9"),
	).toEqual(
		reject(
			"milestone v9.9.9 has 2 open issues:\n- #7 issue 7\n- #8 issue 8\nClose each, or move it to the next release's milestone",
		),
	);
	expect(await milestoneReady(forgeWith([]), "v0.6.0")).toEqual(
		reject("the forge has no milestone v0.6.0\nCreate it, or check --version"),
	);
});

/** A git repo whose `origin` is `owner/repo` on `forge.example`. */
function checkoutOnForge(): string {
	const dir = mkdtempSync(join(scratch, "checkout-"));
	Bun.spawnSync(["git", "init", "-q", dir]);
	Bun.spawnSync([
		"git",
		"-C",
		dir,
		"remote",
		"add",
		"origin",
		"https://forge.example/owner/repo.git",
	]);
	return dir;
}

test("requireMilestone reads the milestone v<version> from the target's forge, and names its one open issue", async () => {
	const urls: string[] = [];
	// Each list's second page is empty, which ends the forge client's paging.
	const answer = (url: string) => {
		if (url.includes("page=2")) return [];
		if (url.includes("/milestones")) return [{ id: 3, title: "v9.9.9" }];
		return [{ number: 7, title: "open one", milestone: { id: 3 } }];
	};
	const fetched = spyOn(globalThis, "fetch").mockImplementation((async (
		url: string,
	) => {
		urls.push(url);
		return new Response(JSON.stringify(answer(url)));
	}) as unknown as typeof fetch);
	process.env.MAESTRO_TM_TOKEN = "t";
	try {
		const ctx = {
			env: { repo: { target: checkoutOnForge() } },
			signal: new AbortController().signal,
		} as unknown as CodeContext;
		expect(await requireMilestone({ version: "9.9.9" }, ctx)).toEqual(
			reject(
				"milestone v9.9.9 has 1 open issue:\n- #7 open one\nClose each, or move it to the next release's milestone",
			),
		);
	} finally {
		fetched.mockRestore();
		delete process.env.MAESTRO_TM_TOKEN;
	}
	expect(urls[0]).toStartWith(
		"https://forge.example/api/v1/repos/owner/repo/milestones?",
	);
	expect(urls[0]).toContain("name=v9.9.9");
});

test("targetOf refuses a context whose repo host gives no target", () => {
	expect(() => targetOf({ env: {} } as unknown as CodeContext)).toThrow(
		"the repo host gave no target",
	);
});

test.each([
	["v9.9.9", false, "--version v9.9.9 is not a version maestro releases"],
	["9.9.9-rc.1", false, "--version 9.9.9-rc.1 is a pre-release"],
	["9.9.9", true, "--prerelease needs an -rc.<n> version, not 9.9.9"],
])(
	"checkVersion refuses --version %s with prerelease %p",
	(version, prerelease, message) => {
		expect(() => checkVersion(version, prerelease)).toThrow(message);
	},
);

type Edge = {
	from: { node: string; port: string };
	to: { node: string; port?: string };
};

/** The edges of the release composed with `flags`. */
const edgesOf = async (flags: string[]): Promise<Edge[]> =>
	JSON.parse(
		await maestro([
			"compose",
			".maestro/release.ts",
			"--preset",
			"stub",
			...flags,
			"--json",
			"-c",
			`packs=[${await classics}]`,
		]),
	).plan.ir.edges;

test.each([
	[[], [{ node: "milestone", port: "ok" }]],
	[["--version", "9.9.9-rc.1", "--prerelease"], []],
])(
	"with flags %j, the commits every agent reads wait on %j",
	async (flags, guards) => {
		const edges = await edgesOf(flags);
		expect(
			edges.filter((e) => e.to.node === "head").map((e) => e.from),
		).toEqual(guards);
	},
);

test("the result takes the notes the structure check passed, not the writer's own", async () => {
	const edges = await edgesOf([]);
	expect(
		edges
			.filter((e) => e.to.node === "result" && e.to.port === "notes")
			.map((e) => e.from),
	).toEqual([{ node: "notes_check", port: "notes" }]);
});

/** A `just release` that builds `dist/` from the bumped tree of `origin/main` only, so the check shows both reached it. */
const JUSTFILE = `release:
    grep -q '"version": "0.0.2-rc.1"' packages/cli/package.json
    test -f b.ts
    mkdir -p dist
    echo built > dist/maestro
    echo "smoke: passed"
`;

/**
 * A git repo with maestro's version files at 0.0.1, tagged `v0.0.1`, with `main` one commit past it and `origin/main`,
 * whose commit it returns, one more.
 */
function releaseTarget(): { target: string; origin: string } {
	const target = mkdtempSync(join(scratch, "release-"));
	const files: Record<string, string> = {
		"packages/cli/package.json": '{ "name": "cli", "version": "0.0.1" }\n',
		"packs/classics/package.json": '{ "name": "c", "version": "0.0.1" }\n',
		"bun.lock": '{ "cli": { "version": "0.0.1" } }\n',
		"INSTALL.md": "curl x | MAESTRO_VERSION=v0.0.1 sh\n",
		"skills/maestro/SKILL.md": "Checked against maestro 0.0.1. Trust --help.\n",
		justfile: JUSTFILE,
	};
	for (const [file, text] of Object.entries(files)) {
		mkdirSync(join(target, dirname(file)), { recursive: true });
		writeFileSync(join(target, file), text);
	}
	const git = (...args: string[]) =>
		Bun.spawnSync(["git", "-C", target, ...args], {
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@t",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@t",
			},
		});
	git("init", "-q", "-b", "main");
	git("add", ".");
	git("commit", "-qm", "init");
	git("tag", "v0.0.1");
	writeFileSync(join(target, "a.ts"), "a\n");
	git("add", ".");
	git("commit", "-qm", "feat: add a\n\nRefs: #1");
	writeFileSync(join(target, "b.ts"), "b\n");
	git("add", ".");
	git("commit", "-qm", "feat: add b\n\nRefs: #2");
	git("update-ref", "refs/remotes/origin/main", "HEAD");
	const origin = git("rev-parse", "HEAD").stdout.toString().trim();
	git("reset", "-q", "--hard", "HEAD~1");
	return { target, origin };
}

const NOTES = `The first candidate for v0.0.2.

## Install or upgrade

Pin \`v0.0.2-rc.1\`.

## Added

- \`a.ts\`. ([#1](https://git.amorimcasa.org/tiago/maestro/issues/1))
`;

type Instance = { node: string; outputs?: Record<string, unknown> };

test("a stub perform of a pre-release settles ok on origin/main ahead of main, leaving the checked notes, the bump changeset and the build's dist", async () => {
	const just = Bun.which("just");
	if (!just) throw new Error("just is not on PATH");
	const { target, origin } = releaseTarget();
	const data = mkdtempSync(join(scratch, "data-"));
	const concert = JSON.parse(
		await maestro(
			[
				"perform",
				".maestro/release.ts",
				"--preset",
				"stub",
				"--version",
				"0.0.2-rc.1",
				"--prev",
				"v0.0.1",
				"--prerelease",
				"--json",
				"-c",
				`packs=[${await classics}]`,
				"-c",
				`target.repo=${target}`,
				"-c",
				'target.prepare="true"',
				"-c",
				`sandbox.path=[${dirname(just)}]`,
			],
			data,
			{ MAESTRO_STUB_OUTPUTS: stubOutputs({ "notes/notes.md": NOTES }) },
		),
	);
	expect(concert.status).toBe("ok");
	const result = (await detailed<Instance>(concert.id, data)).find(
		(i) => i.node === "result",
	)?.outputs;
	const artifact = (path: string) =>
		readFileSync(
			join(data, "maestro/concerts", concert.id, "artifacts", path),
			"utf8",
		);
	expect(artifact(String(result?.notes))).toBe(NOTES);
	expect(artifact(`${result?.changeset}/base`)).toBe(`${origin}\n`);
	const patch = artifact(`${result?.changeset}/0001.patch`);
	expect(patch).toContain(
		"Subject: [PATCH] chore(release): bump to 0.0.2-rc.1",
	);
	for (const file of [
		"packages/cli/package.json",
		"packs/classics/package.json",
		"bun.lock",
		"INSTALL.md",
		"skills/maestro/SKILL.md",
	])
		expect(patch).toContain(`diff --git a/${file} b/${file}`);
	expect(artifact(`${result?.dist}/maestro`)).toBe("built\n");
});

test("tipOf names the commit the last patch of a changeset was made from, or its base when it holds none", () => {
	const dir = mkdtempSync(join(scratch, "changes-"));
	writeFileSync(join(dir, "base"), `${"a".repeat(40)}\n`);
	expect(tipOf(dir)).toBe("a".repeat(40));
	for (const [file, sha] of [
		["0002.patch", "c"],
		["0001.patch", "b"],
	] as const)
		writeFileSync(
			join(dir, file),
			`From ${sha.repeat(40)} Mon Sep 17 00:00:00 2001\nSubject: x\n`,
		);
	expect(tipOf(dir)).toBe("c".repeat(40));
});
