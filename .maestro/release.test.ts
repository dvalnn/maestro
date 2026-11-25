import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type ArtifactRef, type CodeContext, reject } from "@maestro/sdk";
import type { Forge, Issue } from "../scripts/factory/forge";
import {
	bump,
	checkVersion,
	closeMilestone,
	milestoneReady,
	publishRelease,
	pushBump,
	requireMilestone,
	targetOf,
	tipOf,
	verifyRelease,
} from "./release";
import {
	call,
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

test.each([
	[[], true],
	[["--version", "9.9.9-rc.1", "--prerelease"], false],
])("with flags %j, a node closes the milestone: %p", async (flags, closes) => {
	const edges = await edgesOf(flags);
	expect(edges.some((e) => e.to.node === "close")).toBe(closes);
});

test.each([
	["candidate", "notes", { node: "notes_check", port: "notes" }],
	["candidate", "review", { node: "panel/upheld", port: "review" }],
	["publish", "notes", { node: "candidate", port: "notes" }],
	["publish", "review", { node: "candidate", port: "review" }],
])(
	"%s takes its %s from %j, so an upheld finding stops the candidate before the approval",
	async (node, port, from) => {
		const edges = await edgesOf([]);
		expect(
			edges
				.filter((e) => e.to.node === node && e.to.port === port)
				.map((e) => e.from),
		).toEqual([from]);
	},
);

/** A `just release` that builds `dist/` from the bumped tree of `origin/main` only, so the check shows both reached it. */
const JUSTFILE = `release:
    grep -q '"version": "0.0.2-rc.1"' packages/cli/package.json
    test -f b.ts
    mkdir -p dist
    echo built > dist/maestro
    cd dist && sha256sum maestro > SHA256SUMS
    echo "smoke: passed"
`;

/** The target's `origin` remote, where the forge's API is and where git pushes. */
const ORIGIN = "https://forge.example/owner/repo.git";

/**
 * A git repo with maestro's version files at 0.0.1, tagged `v0.0.1`, with `main` one commit past it and `origin/main`,
 * whose commit it returns, one more. Its `origin` is `ORIGIN`, and the git config file `config` sends a push there to
 * the bare repo `remote` instead, whose `main` is at `origin/main`.
 */
function releaseTarget(): {
	target: string;
	origin: string;
	remote: string;
	config: string;
} {
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
	git("remote", "add", "origin", ORIGIN);
	const remote = join(target, "..", `${basename(target)}.git`);
	Bun.spawnSync(["git", "init", "-q", "--bare", remote]);
	git("push", "-q", remote, "origin/main:refs/heads/main");
	const config = join(target, "..", `${basename(target)}.gitconfig`);
	writeFileSync(config, `[url "${remote}"]\n\tpushInsteadOf = ${ORIGIN}\n`);
	return { target, origin, remote, config };
}

/** The commit `rev` names in the git repo `repo`. */
const revOf = (repo: string, rev: string) =>
	Bun.spawnSync(["git", "-C", repo, "rev-parse", rev]).stdout.toString().trim();

const NOTES = `The first candidate for v0.0.2.

## Install or upgrade

Pin \`v0.0.2-rc.1\`.

## Added

- \`a.ts\`. ([#1](https://git.amorimcasa.org/tiago/maestro/issues/1))
`;

type Instance = {
	node: string;
	status: string;
	outputs?: Record<string, unknown>;
};

/**
 * Performs the pre-release 0.0.2-rc.1 of a `releaseTarget` on stubs with `--dry-run`, as `MAESTRO_TM_TOKEN` and with
 * `env`, and gives `ruling` at its approval through `maestro approval` once it holds there.
 */
async function performRuled(ruling: string[], env: Record<string, string>) {
	const just = Bun.which("just");
	if (!just) throw new Error("just is not on PATH");
	const toy = releaseTarget();
	const data = mkdtempSync(join(scratch, "data-"));
	const performing = call(
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
			"--dry-run",
			"--json",
			"-c",
			`packs=[${await classics}]`,
			"-c",
			`target.repo=${toy.target}`,
			"-c",
			'target.prepare="true"',
			"-c",
			`sandbox.path=[${dirname(just)}]`,
		],
		data,
		{
			MAESTRO_STUB_OUTPUTS: stubOutputs({ "notes/notes.md": NOTES }),
			MAESTRO_TM_TOKEN: "t",
			GIT_CONFIG_GLOBAL: toy.config,
			...env,
		},
	);
	let open: { concert: string }[] = [];
	for (let tries = 0; !open.length && tries < 1500; tries++) {
		await Bun.sleep(20);
		open = JSON.parse((await call(["approval", "--json"], data)).out);
	}
	await maestro(["approval", open[0]?.concert ?? "", ...ruling], data);
	const concert: { id: string; status: string } = JSON.parse(
		(await performing).out,
	);
	return { ...toy, data, concert };
}

test("a stub dry run of a pre-release holds at the approval, and once ruled ok settles ok with main and the forge untouched", async () => {
	// Every forge call would go through this proxy, which counts and drops each connection.
	let connections = 0;
	const proxy = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			open: (socket) => {
				connections++;
				socket.end();
			},
			data: () => {},
		},
	});
	const proxied = `http://127.0.0.1:${proxy.port}`;
	const { concert, data, remote, origin } = await performRuled(["ok"], {
		HTTPS_PROXY: proxied,
		https_proxy: proxied,
	});
	proxy.stop(true);
	expect(concert.status).toBe("ok");
	expect(connections).toBe(0);
	expect(revOf(remote, "main")).toBe(origin);
	const instances = await detailed<Instance>(concert.id, data);
	const result = instances.find((i) => i.node === "candidate")?.outputs;
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
	expect(
		instances
			.filter((i) => PUBLISH.includes(i.node))
			.map((i) => [i.node, i.status]),
	).toEqual(PUBLISH.map((node) => [node, "ok"]));
});

/** The publish nodes of a pre-release, in graph order. */
const PUBLISH = ["push", "forge_release", "verify"];

test("a rejected ruling settles the concert rejected and publishes nothing", async () => {
	const { concert, data, remote, origin } = await performRuled(
		["reject", "not this one"],
		{},
	);
	expect(concert.status).toBe("rejected");
	expect(revOf(remote, "main")).toBe(origin);
	const instances = await detailed<Instance>(concert.id, data);
	expect(
		instances
			.filter((i) => PUBLISH.includes(i.node))
			.map((i) => [i.node, i.status]),
	).toEqual(PUBLISH.map((node) => [node, "skipped"]));
});

/** A code node's context on `target`, with a fresh scratch directory, whose artifact refs hold absolute paths. */
const contextOn = (target: string) =>
	({
		env: { repo: { target } },
		signal: new AbortController().signal,
		scratch: mkdtempSync(join(scratch, "node-")),
		path: (ref: ArtifactRef) => ref.path,
		log: () => {},
	}) as unknown as CodeContext;

const refTo = (path: string): ArtifactRef => ({ path, contentHash: "" });

/** A ref to a changeset of no patch whose base is `commit`, the commits a panel reviewed ending there. */
function changesAt(commit: string): ArtifactRef {
	const dir = mkdtempSync(join(scratch, "changes-"));
	writeFileSync(join(dir, "base"), `${commit}\n`);
	return refTo(dir);
}

/** A `dist/` of two assets and their `SHA256SUMS`, the hashes as `sha256sum` prints them. */
function distDir(): string {
	const dist = mkdtempSync(join(scratch, "dist-"));
	writeFileSync(join(dist, "maestro-linux-x64.gz"), "binary");
	writeFileSync(join(dist, "harnesses"), "pi 1\n");
	writeFileSync(
		join(dist, "SHA256SUMS"),
		[
			"9a3a45d01531a20e89ac6ae10b0b0beb0492acd7216a368aa062d1a5fecaf9cd  maestro-linux-x64.gz",
			"0aab6906107b925ade3b5db88830d5aeeeb921934c22164dd5446b67410314ab  harnesses",
			"",
		].join("\n"),
	);
	return dist;
}

type Stored = {
	tag_name: string;
	target_commitish: string;
	body: string;
	prerelease: boolean;
	assets: File[];
};

/**
 * `fetch` as the forge of `ORIGIN` answers it, in memory: the toy `remote`'s `main`, its releases, and the milestone
 * `v0.0.2` (id 3). Each request is logged as `METHOD path`.
 */
function forgeOver(remote: string) {
	const requests: string[] = [];
	const state = {
		releases: new Map<string, Stored>(),
		milestone: "open",
	};
	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), { status });
	const releaseJson = (r: Stored) => ({
		id: 1,
		assets: r.assets.map((a) => ({
			name: a.name,
			browser_download_url: `https://forge.example/owner/repo/releases/download/${r.tag_name}/${a.name}`,
		})),
	});
	const created = (init: RequestInit) => {
		const release: Stored = { ...JSON.parse(String(init.body)), assets: [] };
		state.releases.set(release.tag_name, release);
		return json(releaseJson(release), 201);
	};
	const uploaded = (init: RequestInit) => {
		const file = (init.body as FormData).get("attachment") as File;
		[...state.releases.values()][0]?.assets.push(file);
		return json({}, 201);
	};
	const milestone = (method: string, init: RequestInit) => {
		if (method === "PATCH")
			state.milestone = JSON.parse(String(init.body)).state ?? state.milestone;
		return json({ id: 3, state: state.milestone });
	};
	type Route = (match: string[], method: string, init: RequestInit) => Response;
	const routes: [RegExp, Route][] = [
		[
			/^\/owner\/repo\/releases\/download\/([^/]+)\/(.+)$/,
			([, tag = "", name]) =>
				new Response(
					state.releases.get(tag)?.assets.find((a) => a.name === name),
				),
		],
		[/page=2/, () => json([])],
		[
			/\/branches\/main$/,
			() => json({ commit: { id: revOf(remote, "main") } }),
		],
		[
			/\/releases\/tags\/(.+)$/,
			([, tag = ""]) => {
				const release = state.releases.get(tag);
				return release ? json(releaseJson(release)) : json({}, 404);
			},
		],
		[/\/releases$/, (_, __, init) => created(init)],
		[/\/releases\/1\/assets\?/, (_, __, init) => uploaded(init)],
		[
			/\/milestones\?/,
			() => json([{ id: 3, title: "v0.0.2", state: state.milestone }]),
		],
		[/\/milestones\/3$/, (_, method, init) => milestone(method, init)],
	];
	const send = (async (url: string, init: RequestInit = {}) => {
		const { pathname, search } = new URL(url);
		const method = init.method ?? "GET";
		const path = `${pathname}${search}`;
		requests.push(`${method} ${path}`);
		for (const [pattern, route] of routes) {
			const match = pattern.exec(path);
			if (match) return route([...match], method, init);
		}
		return json({ message: `no route ${method} ${path}` }, 500);
	}) as unknown as typeof fetch;
	return { requests, state, send };
}

/** Runs `body` with `send` as `fetch`, `MAESTRO_TM_TOKEN` set and git reading the config file `config`. */
async function onForge<T>(
	send: typeof fetch,
	config: string,
	body: () => Promise<T>,
) {
	const fetched = spyOn(globalThis, "fetch").mockImplementation(send);
	process.env.MAESTRO_TM_TOKEN = "t";
	process.env.GIT_CONFIG_GLOBAL = config;
	try {
		return await body();
	} finally {
		fetched.mockRestore();
		delete process.env.MAESTRO_TM_TOKEN;
		delete process.env.GIT_CONFIG_GLOBAL;
	}
}

test("publishing pushes the bump to the toy main, creates the release with every dist asset, checks one, and closes the milestone; a resume writes nothing", async () => {
	const { target, origin, remote, config } = releaseTarget();
	const { changeset } = (await bump(
		{ version: "0.0.2", changes: changesAt(origin) },
		contextOn(target),
	)) as { changeset: string };
	const dist = distDir();
	const notes = join(dist, "..", `${basename(dist)}.md`);
	writeFileSync(notes, NOTES);
	const fake = forgeOver(remote);
	const publish = () =>
		onForge(fake.send, config, async () => {
			const { commit } = await pushBump(
				{ changeset: refTo(changeset), dry: false },
				contextOn(target),
			);
			const common = { version: "0.0.2", dist: refTo(dist), dry: false };
			const settled = [
				await publishRelease(
					{ ...common, prerelease: false, commit, notes: refTo(notes) },
					contextOn(target),
				),
				await verifyRelease(common, contextOn(target)),
				await closeMilestone(common, contextOn(target)),
			];
			return { commit, settled };
		});
	const { commit, settled } = await publish();
	expect(settled).toEqual([{}, {}, {}]);
	expect(revOf(remote, "main")).toBe(commit);
	expect(revOf(remote, "main~1")).toBe(origin);
	const release = fake.state.releases.get("v0.0.2");
	expect(release).toMatchObject({
		target_commitish: commit,
		body: NOTES,
		prerelease: false,
	});
	expect(release?.assets.map((a) => a.name)).toEqual([
		"SHA256SUMS",
		"harnesses",
		"maestro-linux-x64.gz",
	]);
	expect(fake.state.milestone).toBe("closed");

	// Every effect now exists, and main has moved past the bump. A push would fail, so a resume that pushed would throw.
	const moved = commitOn(target, remote, commit);
	writeFileSync(
		config,
		`[url "${join(scratch, "missing")}"]\n\tpushInsteadOf = ${ORIGIN}\n`,
	);
	fake.requests.length = 0;
	expect((await publish()).commit).toBe(commit);
	expect(fake.requests.filter((r) => !r.startsWith("GET "))).toEqual([]);
	expect(revOf(remote, "main")).toBe(moved);
});

/**
 * Makes a commit on top of `parent` in the git repo `target`, fetching `parent` from the bare `remote` first, points the
 * remote's `main` at it, and returns it.
 */
function commitOn(target: string, remote: string, parent: string): string {
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
	git("fetch", "-q", remote, "main");
	const made = git(
		"commit-tree",
		`${parent}^{tree}`,
		"-p",
		parent,
		"-m",
		"next",
	)
		.stdout.toString()
		.trim();
	git("push", "-q", "-f", remote, `${made}:refs/heads/main`);
	return made;
}

test("a push onto a main that moved off the bump's base fails as a non-fast-forward and leaves main as it is", async () => {
	const { target, origin, remote, config } = releaseTarget();
	const { changeset } = (await bump(
		{ version: "0.0.2", changes: changesAt(origin) },
		contextOn(target),
	)) as { changeset: string };
	const diverged = commitOn(target, remote, origin);
	const fake = forgeOver(remote);
	const pushed = onForge(fake.send, config, () =>
		pushBump({ changeset: refTo(changeset), dry: false }, contextOn(target)),
	);
	await expect(pushed).rejects.toThrow("forge:");
	expect(revOf(remote, "main")).toBe(diverged);
});

test("the bump commits with the patch's own date, so every run makes the same commit", async () => {
	const { target, origin } = releaseTarget();
	const { changeset } = (await bump(
		{ version: "0.0.2", changes: changesAt(origin) },
		contextOn(target),
	)) as { changeset: string };
	const patch = join(changeset, "0001.patch");
	writeFileSync(
		patch,
		readFileSync(patch, "utf8").replace(
			/^Date: .*$/m,
			"Date: Mon, 1 Jan 2001 00:00:00 +0000",
		),
	);
	const ctx = contextOn(target);
	const { commit } = await pushBump(
		{ changeset: refTo(changeset), dry: true },
		ctx,
	);
	const dates = Bun.spawnSync([
		"git",
		"-C",
		join(ctx.scratch, "tree"),
		"log",
		"-1",
		"--format=%at %ct",
		commit,
	]).stdout.toString();
	expect(dates).toBe("978307200 978307200\n");
});

test("a pre-release is created with the pre-release flag", async () => {
	const { target, remote } = releaseTarget();
	const dist = distDir();
	const fake = forgeOver(remote);
	await onForge(fake.send, "/dev/null", () =>
		publishRelease(
			{
				version: "0.0.2-rc.1",
				prerelease: true,
				commit: "abc123",
				notes: refTo(join(dist, "harnesses")),
				dist: refTo(dist),
				dry: false,
			},
			contextOn(target),
		),
	);
	expect(fake.state.releases.get("v0.0.2-rc.1")?.prerelease).toBe(true);
});

test("a dry run of closeMilestone sends no request", async () => {
	const { target, remote } = releaseTarget();
	const fake = forgeOver(remote);
	const settled = await onForge(fake.send, "/dev/null", () =>
		closeMilestone({ version: "0.0.2", dry: true }, contextOn(target)),
	);
	expect(settled).toEqual({});
	expect(fake.requests).toEqual([]);
});

test("verifyRelease rejects an asset the release serves with another hash than SHA256SUMS holds", async () => {
	const { target, remote } = releaseTarget();
	const dist = distDir();
	const fake = forgeOver(remote);
	fake.state.releases.set("v0.0.2", {
		tag_name: "v0.0.2",
		target_commitish: "",
		body: "",
		prerelease: false,
		assets: [new File(["tampered"], "maestro-linux-x64.gz")],
	});
	const settled = await onForge(fake.send, "/dev/null", () =>
		verifyRelease(
			{ version: "0.0.2", dist: refTo(dist), dry: false },
			contextOn(target),
		),
	);
	expect(settled).toMatchObject({ outcome: "rejected" });
	expect(String((settled as { reason: string }).reason)).toStartWith(
		"the release v0.0.2 serves maestro-linux-x64.gz with sha256",
	);
});

test("publishRelease attaches to a release that exists only the dist files it lacks", async () => {
	const { target, remote } = releaseTarget();
	const dist = distDir();
	const fake = forgeOver(remote);
	fake.state.releases.set("v0.0.2", {
		tag_name: "v0.0.2",
		target_commitish: "abc123",
		body: NOTES,
		prerelease: false,
		assets: [new File(["pi 1\n"], "harnesses")],
	});
	await onForge(fake.send, "/dev/null", () =>
		publishRelease(
			{
				version: "0.0.2",
				prerelease: false,
				commit: "abc123",
				notes: refTo(join(dist, "harnesses")),
				dist: refTo(dist),
				dry: false,
			},
			contextOn(target),
		),
	);
	expect(fake.requests.filter((r) => !r.startsWith("GET "))).toEqual([
		"POST /api/v1/repos/owner/repo/releases/1/assets?name=SHA256SUMS",
		"POST /api/v1/repos/owner/repo/releases/1/assets?name=maestro-linux-x64.gz",
	]);
	expect(
		fake.state.releases
			.get("v0.0.2")
			?.assets.map((a) => a.name)
			.sort(),
	).toEqual(["SHA256SUMS", "harnesses", "maestro-linux-x64.gz"]);
});

test.each([
	["SHA256SUMS lists no asset", "", false, "dist/SHA256SUMS lists no asset"],
	[
		"the release lacks the listed asset",
		undefined,
		true,
		"the release v0.0.2 has no asset maestro-linux-x64.gz",
	],
])("verifyRelease rejects when %s", async (_, sums, released, reason) => {
	const { target, remote } = releaseTarget();
	const dist = distDir();
	if (sums !== undefined) writeFileSync(join(dist, "SHA256SUMS"), sums);
	const fake = forgeOver(remote);
	if (released)
		fake.state.releases.set("v0.0.2", {
			tag_name: "v0.0.2",
			target_commitish: "",
			body: "",
			prerelease: false,
			assets: [],
		});
	const settled = await onForge(fake.send, "/dev/null", () =>
		verifyRelease(
			{ version: "0.0.2", dist: refTo(dist), dry: false },
			contextOn(target),
		),
	);
	expect(settled).toEqual(reject(reason));
});

test("closeMilestone rejects a version the forge has no milestone for, and changes none", async () => {
	const { target, remote } = releaseTarget();
	const fake = forgeOver(remote);
	const settled = await onForge(fake.send, "/dev/null", () =>
		closeMilestone({ version: "0.0.3", dry: false }, contextOn(target)),
	);
	expect(settled).toEqual(
		reject("the forge has no milestone v0.0.3\nCreate it, or check --version"),
	);
	expect(fake.requests.filter((r) => !r.startsWith("GET "))).toEqual([]);
	expect(fake.state.milestone).toBe("open");
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

test("bump cuts the version commit on the reviewed commits, not on a main@origin that has moved since", async () => {
	const { target } = releaseTarget();
	const reviewed = revOf(target, "HEAD");
	const { changeset } = (await bump(
		{ version: "0.0.2", changes: changesAt(reviewed) },
		contextOn(target),
	)) as { changeset: string };
	expect(readFileSync(join(changeset, "base"), "utf8")).toBe(`${reviewed}\n`);
});
