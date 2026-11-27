import { expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forge, loadEnvFile, type Send, signingKeyOf } from "./forge";

const TOKEN = "s3cret-token";
const dir = mkdtempSync(join(tmpdir(), "factory-forge-"));
const argv = join(dir, "argv");
const environment = join(dir, "env");
const shim = (name: string, body: string) => {
	writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
	chmodSync(join(dir, name), 0o755);
};
const remote = join(dir, "remote");
const setRemote = (url: string) => writeFileSync(remote, `${url}\n`);
setRemote("git@forge.example:owner/repo.git");
shim(
	"git",
	`if [ "$1" = remote ]; then cat ${remote}; exit 0; fi\nprintf '%s\\n' "$@" > ${argv}\nenv > ${environment}`,
);

const withShims = async <T>(run: () => Promise<T>) => {
	const path = process.env.PATH;
	process.env.PATH = `${dir}:${path}`;
	try {
		return await run();
	} finally {
		process.env.PATH = path;
	}
};

type Call = { url: string; init: RequestInit };
/** A `send` that records its calls and answers each with the `answer` of its path. */
const recording = (answer: (url: string) => [number, unknown]) => {
	const calls: Call[] = [];
	const send: Send = async (url, init) => {
		calls.push({ url, init });
		const [status, body] = answer(url);
		return new Response(JSON.stringify(body), { status });
	};
	return { calls, send };
};
const signedIn = { MAESTRO_TM_TOKEN: TOKEN };

test("a push gives git the token through its environment config only", async () => {
	await withShims(() => forge(signedIn).push(dir, "abc123", "maestro-tm/i7"));
	const basic = Buffer.from(`${TOKEN}:`).toString("base64");
	const args = readFileSync(argv, "utf8");
	expect(args).toBe(
		"push\nhttps://forge.example/owner/repo.git\n+abc123:refs/heads/maestro-tm/i7\n",
	);
	const holders = readFileSync(environment, "utf8")
		.split("\n")
		.filter((line) => line.includes(basic) || line.includes(TOKEN));
	expect(holders).toEqual([`GIT_CONFIG_VALUE_0=Authorization: Basic ${basic}`]);
});

test("a push that may not force gives git a refspec without the +, so only a fast-forward lands", async () => {
	await withShims(() => forge(signedIn).push(dir, "abc123", "main", false));
	expect(readFileSync(argv, "utf8")).toBe(
		"push\nhttps://forge.example/owner/repo.git\nabc123:refs/heads/main\n",
	);
});

test("a push its signal kills before git sends the update pushes nothing", async () => {
	const slow = mkdtempSync(join(tmpdir(), "factory-forge-slow-"));
	const pushed = join(slow, "pushed");
	writeFileSync(
		join(slow, "git"),
		`#!/bin/sh\nif [ "$1" = remote ]; then cat ${remote}; exit 0; fi\nsleep 1\ntouch ${pushed}\n`,
	);
	chmodSync(join(slow, "git"), 0o755);
	const path = process.env.PATH;
	process.env.PATH = `${slow}:${path}`;
	const kill = new AbortController();
	try {
		const pushing = forge(signedIn).push(
			dir,
			"abc123",
			"main",
			false,
			kill.signal,
		);
		setTimeout(() => kill.abort(), 200);
		await expect(pushing).rejects.toThrow();
	} finally {
		process.env.PATH = path;
	}
	await Bun.sleep(1200);
	expect(existsSync(pushed)).toBe(false);
});

test("a release the forge does not have is none, and one it has gives its id and assets", async () => {
	const { send } = recording((url) =>
		url.endsWith("/v1.0.0")
			? [200, { id: 4, assets: [{ name: "a.gz", browser_download_url: "u" }] }]
			: [404, { message: "not found" }],
	);
	const api = forge(signedIn, send);
	await withShims(async () => {
		expect(await api.release("v0.9.0")).toBeUndefined();
		expect(await api.release("v1.0.0")).toEqual({
			id: 4,
			assets: [{ name: "a.gz", url: "u" }],
		});
	});
});

test("a release read the forge refuses otherwise than 404 throws", async () => {
	const { send } = recording(() => [500, { message: "broken" }]);
	const read = withShims(() => forge(signedIn, send).release("v1.0.0"));
	await expect(read).rejects.toThrow(
		"forge: 500 from GET /releases/tags/v1.0.0",
	);
});

test("creating a release posts its tag, the commit to tag, the body and the pre-release flag", async () => {
	const { calls, send } = recording(() => [201, { id: 4 }]);
	const created = await withShims(() =>
		forge(signedIn, send).createRelease({
			tag: "v1.0.0-rc.1",
			target: "abc123",
			body: "Notes.",
			prerelease: true,
		}),
	);
	expect(created).toEqual({ id: 4, assets: [] });
	expect(calls[0]?.url).toEndWith("/repos/owner/repo/releases");
	expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
		tag_name: "v1.0.0-rc.1",
		target_commitish: "abc123",
		name: "v1.0.0-rc.1",
		body: "Notes.",
		prerelease: true,
	});
});

test("uploading posts the file as the attachment field of a release's assets, named", async () => {
	const gz = join(dir, "a.gz");
	writeFileSync(gz, "zipped");
	const { calls, send } = recording(() => [201, {}]);
	await withShims(() => forge(signedIn, send).upload(4, gz));
	expect(calls[0]?.url).toEndWith(
		"/repos/owner/repo/releases/4/assets?name=a.gz",
	);
	const form = calls[0]?.init.body as FormData;
	const file = form.get("attachment") as File;
	expect([file.name, await file.text()]).toEqual(["a.gz", "zipped"]);
});

test("a download sends the token to the forge's host only", async () => {
	const { calls, send } = recording(() => [200, "bytes"]);
	const api = forge(signedIn, send);
	const got = await withShims(() =>
		api.download("https://forge.example/owner/repo/releases/download/v1/a.gz"),
	);
	expect(new TextDecoder().decode(got)).toBe('"bytes"');
	expect(calls[0]?.init.headers).toMatchObject({
		Authorization: `token ${TOKEN}`,
	});
	await expect(
		withShims(() => api.download("https://elsewhere.example/a.gz")),
	).rejects.toThrow("is not on forge.example");
	expect(calls).toHaveLength(1);
});

test.each([
	["open", 1],
	["closed", 0],
])(
	"closing a milestone that is %s leaves it closed, with %p writes",
	async (before, writes) => {
		const milestone = { id: 3, state: before };
		let written = 0;
		const send: Send = async (_, init) => {
			if (init.method === "PATCH") {
				written++;
				Object.assign(milestone, JSON.parse(String(init.body)));
			}
			return new Response(JSON.stringify(milestone));
		};
		await withShims(() => forge(signedIn, send).closeMilestone(3));
		expect(milestone.state).toBe("closed");
		expect(written).toBe(writes);
	},
);

test("an API call carries the token in its header and reaches the origin's host and repo", async () => {
	const { calls, send } = recording(() => [200, { id: 5 }]);
	const id = await withShims(() => forge(signedIn, send).comment(9, "hi"));
	expect(id).toBe(5);
	expect(calls).toHaveLength(1);
	expect(calls[0]?.url).toBe(
		"https://forge.example/api/v1/repos/owner/repo/issues/9/comments",
	);
	expect(calls[0]?.init.method).toBe("POST");
	expect(calls[0]?.init.headers).toMatchObject({
		Authorization: `token ${TOKEN}`,
	});
});

test("a forge given a checkout reads the origin of that checkout, not this repository's", async () => {
	const checkout = mkdtempSync(join(tmpdir(), "factory-checkout-"));
	Bun.spawnSync(["git", "init", "-q", checkout]);
	Bun.spawnSync([
		"git",
		"-C",
		checkout,
		"remote",
		"add",
		"origin",
		"https://other.example/them/theirs.git",
	]);
	const { calls, send } = recording(() => [200, { id: 5 }]);
	await forge(signedIn, send, checkout).comment(9, "hi");
	expect(calls[0]?.url).toBe(
		"https://other.example/api/v1/repos/them/theirs/issues/9/comments",
	);
});

test("the account comes from one GET /user, with a fallback name and email", async () => {
	const { calls, send } = recording(() => [200, { login: "maestro-tm" }]);
	const api = forge(signedIn, send);
	const account = await withShims(async () => {
		await api.login();
		return api.account();
	});
	expect(account).toEqual({
		login: "maestro-tm",
		name: "maestro-tm",
		email: "maestro-tm@noreply.forge.example",
	});
	expect(calls.map((c) => c.url)).toEqual([
		"https://forge.example/api/v1/user",
	]);
});

test("attaching a file posts it as the attachment field of a multipart form, named, and returns its download URL", async () => {
	const png = join(dir, "a.png");
	writeFileSync(png, "pixels");
	const { calls, send } = recording(() => [
		201,
		{ browser_download_url: "https://forge.example/attachments/u" },
	]);
	const url = await withShims(() => forge(signedIn, send).attach(30, png));
	expect(url).toBe("https://forge.example/attachments/u");
	expect(calls[0]?.url).toEndWith(
		"/repos/owner/repo/issues/30/assets?name=a.png",
	);
	expect(calls[0]?.init.method).toBe("POST");
	const headers = calls[0]?.init.headers as Record<string, string>;
	expect(headers["Content-Type"]).toBeUndefined();
	const form = calls[0]?.init.body as FormData;
	const file = form.get("attachment") as File;
	expect([file.name, await file.text()]).toEqual(["a.png", "pixels"]);
});

test.each([
	"git@forge.example:owner/repo.git",
	"ssh://git@forge.example:2222/owner/repo.git",
	"https://forge.example/owner/repo.git",
	"https://forge.example/owner/repo",
])("the origin %s gives the forge's host, owner and repo", async (url) => {
	setRemote(url);
	const { calls, send } = recording(() => [200, { id: 5 }]);
	try {
		await withShims(() => forge(signedIn, send).comment(9, "hi"));
	} finally {
		setRemote("git@forge.example:owner/repo.git");
	}
	expect(calls[0]?.url).toBe(
		"https://forge.example/api/v1/repos/owner/repo/issues/9/comments",
	);
});

test("the .env under XDG_CONFIG_HOME is loaded, and a variable already set wins", () => {
	const config = mkdtempSync(join(tmpdir(), "factory-config-"));
	mkdirSync(join(config, "maestro"));
	writeFileSync(
		join(config, "maestro", ".env"),
		"FACTORY_TEST_LOADED=from-file\nFACTORY_TEST_SET=from-file\n",
	);
	process.env.FACTORY_TEST_SET = "from-env";
	try {
		loadEnvFile({ XDG_CONFIG_HOME: config });
		expect(process.env.FACTORY_TEST_LOADED).toBe("from-file");
		expect(process.env.FACTORY_TEST_SET).toBe("from-env");
	} finally {
		delete process.env.FACTORY_TEST_LOADED;
		delete process.env.FACTORY_TEST_SET;
	}
});

test("a missing .env is no error", () => {
	expect(() =>
		loadEnvFile({ XDG_CONFIG_HOME: join(tmpdir(), "factory-no-config") }),
	).not.toThrow();
});

test("a token that is unset is refused by name", async () => {
	const { send } = recording(() => [200, {}]);
	await expect(
		withShims(() => forge({ HOME: "/home/x" }, send).login()),
	).rejects.toThrow(/MAESTRO_TM_TOKEN.*\/home\/x\/\.config\/maestro\/\.env/s);
});

test("arming a PR asks the forge to fast-forward, so signed commits stay signed", async () => {
	const { calls, send } = recording(() => [200, {}]);
	await withShims(() => forge(signedIn, send).arm(30));
	expect(JSON.parse(String(calls[0]?.init.body)).Do).toBe("fast-forward-only");
});

test("asking for a review again posts the reviewers to the PR's requested reviewers", async () => {
	const { calls, send } = recording(() => [201, []]);
	await withShims(() => forge(signedIn, send).requestReview(30, ["ann"]));
	expect(calls[0]?.url).toEndWith(
		"/repos/owner/repo/pulls/30/requested_reviewers",
	);
	expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
		reviewers: ["ann"],
	});
});

test("arming a PR the forge answers 409 as already armed is not an error", async () => {
	const { send } = recording(() => [
		409,
		{ message: "Pull request is already scheduled to auto merge" },
	]);
	await withShims(() => forge(signedIn, send).arm(30));
});

test("arming a PR the forge answers 409 as refused otherwise throws", async () => {
	const refusal = "merge failed because of conflict";
	const { send } = recording(() => [409, { message: refusal }]);
	const armed = withShims(() => forge(signedIn, send).arm(30));
	await expect(armed).rejects.toThrow(refusal);
});

test("reviews read the inline comments of an official review requesting changes above the bound, on the old line when it has no new one, and name a deleted account Ghost", async () => {
	const reviews = JSON.stringify([
		{
			id: 4,
			state: "REQUEST_CHANGES",
			official: true,
			body: "Older.",
			user: { login: "ann" },
		},
		{
			id: 5,
			state: "REQUEST_CHANGES",
			official: true,
			body: "Rename it.",
			user: { login: "ann" },
		},
		{
			id: 6,
			state: "APPROVED",
			official: false,
			dismissed: true,
			body: "",
			user: { login: "bo" },
		},
		{
			id: 7,
			state: "REQUEST_CHANGES",
			official: false,
			body: "Unofficial.",
			user: null,
		},
	]);
	const comments = JSON.stringify([
		{ path: "a.ts", position: 3, original_position: 2, body: "wide" },
		{ path: "b.ts", position: 0, original_position: 7, body: "gone" },
		{ path: "c.ts", position: 0, original_position: 0, body: "loose" },
	]);
	const thread = JSON.stringify([
		{ id: 1, body: "Gone.", user: null },
		{ id: 2, body: "Here.", user: { login: "ann" } },
	]);
	const { send } = recording((url) => {
		if (url.includes("/reviews/5/comments")) return [200, JSON.parse(comments)];
		if (url.includes("/issues/9/comments")) return [200, JSON.parse(thread)];
		if (url.includes("/reviews?"))
			return [
				200,
				new URL(url).searchParams.get("page") === "1"
					? JSON.parse(reviews)
					: [],
			];
		return [404, {}];
	});
	const path = process.env.PATH;
	process.env.PATH = `${dir}:${path}`;
	try {
		const api = forge(signedIn, send);
		expect(await api.comments(9)).toEqual([
			{ id: 1, body: "Gone.", author: "Ghost" },
			{ id: 2, body: "Here.", author: "ann" },
		]);
		expect(await api.reviews(30, 4)).toEqual([
			{
				id: 4,
				state: "REQUEST_CHANGES",
				official: true,
				dismissed: false,
				author: "ann",
				body: "Older.",
				comments: [],
			},
			{
				id: 5,
				state: "REQUEST_CHANGES",
				official: true,
				dismissed: false,
				author: "ann",
				body: "Rename it.",
				comments: [
					{ path: "a.ts", line: 3, body: "wide" },
					{ path: "b.ts", line: 7, body: "gone" },
					{ path: "c.ts", body: "loose" },
				],
			},
			{
				id: 6,
				state: "APPROVED",
				official: false,
				dismissed: true,
				author: "bo",
				body: "",
				comments: [],
			},
			{
				id: 7,
				state: "REQUEST_CHANGES",
				official: false,
				dismissed: false,
				author: "Ghost",
				body: "Unofficial.",
				comments: [],
			},
		]);
	} finally {
		process.env.PATH = path;
	}
});

test("open reads every issue when the forge caps pages at 20", async () => {
	const numbers = [
		1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
		22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40,
		41, 42, 43, 44, 45,
	];
	const issues = numbers.map((number) => ({ number }));
	const { calls, send } = recording((url) => {
		const page = Number(new URL(url).searchParams.get("page"));
		return [200, issues.slice((page - 1) * 20, page * 20)];
	});
	const result = await withShims(() => forge(signedIn, send).open({}));
	expect(result.map((issue) => issue.number)).toEqual(numbers);
	expect(
		calls.map((call) => new URL(call.url).searchParams.get("page")),
	).toEqual(["1", "2", "3", "4"]);
	expect(
		calls.map((call) => new URL(call.url).searchParams.get("limit")),
	).toEqual(["50", "50", "50", "50"]);
});

test("pinned reads the numbers in the order the API lists them", async () => {
	const { calls, send } = recording(() => [
		200,
		[{ number: 9 }, { number: 3 }, { number: 5 }],
	]);
	expect(await withShims(() => forge(signedIn, send).pinned())).toEqual([
		9, 3, 5,
	]);
	expect(calls[0]?.url).toEndWith("/issues/pinned");
});

test("head reads the commit a branch points at", async () => {
	const { calls, send } = recording(() => [
		200,
		{ name: "main", commit: { id: "abc123" } },
	]);
	expect(await withShims(() => forge(signedIn, send).head("main"))).toBe(
		"abc123",
	);
	expect(calls[0]?.url).toEndWith("/branches/main");
});

test("status reads the check push context and ignores the pull request one", async () => {
	const { calls, send } = recording(() => [
		200,
		{
			state: "success",
			statuses: [
				{ context: "check / check (pull_request)", status: "success" },
				{ context: "check / check (push)", status: "failure" },
			],
		},
	]);
	expect(await withShims(() => forge(signedIn, send).status("abc"))).toBe(
		"failure",
	);
	expect(calls[0]?.url).toContain("/commits/abc/status?");
});

test("status is none while only the pull request context exists", async () => {
	const { calls, send } = recording((url) => [
		200,
		{
			state: "failure",
			statuses:
				new URL(url).searchParams.get("page") === "1"
					? [{ context: "check / check (pull_request)", status: "failure" }]
					: [],
		},
	]);
	expect(
		await withShims(() => forge(signedIn, send).status("abc")),
	).toBeUndefined();
	expect(
		calls.map((call) => new URL(call.url).searchParams.get("page")),
	).toEqual(["1", "2"]);
});

test("closed reads when each issue closed, none for an open one", async () => {
	const { send } = recording(() => [
		200,
		[
			{ number: 4, closed_at: "2026-11-03T11:00:00Z" },
			{ number: 5, closed_at: null },
		],
	]);
	const issues = await withShims(() => forge(signedIn, send).closed(2));
	expect(issues.map((i) => i.closed)).toEqual([
		Date.parse("2026-11-03T11:00:00Z"),
		undefined,
	]);
});

test("status finds the push context after a short page", async () => {
	const { calls, send } = recording((url) => [
		200,
		{
			statuses:
				new URL(url).searchParams.get("page") === "1"
					? [{ context: "check / check (pull_request)", status: "success" }]
					: [{ context: "check / check (push)", status: "failure" }],
		},
	]);
	expect(await withShims(() => forge(signedIn, send).status("abc"))).toBe(
		"failure",
	);
	expect(
		calls.map((call) => new URL(call.url).searchParams.get("page")),
	).toEqual(["1", "2"]);
});

test("status finds the push context on a later page", async () => {
	const filler = Array.from({ length: 50 }, (_, i) => ({
		context: `other-${i}`,
		status: "success",
	}));
	const { calls, send } = recording((url) => [
		200,
		{
			statuses: url.includes("page=2")
				? [{ context: "check / check (push)", status: "error" }]
				: filler,
		},
	]);
	expect(await withShims(() => forge(signedIn, send).status("abc"))).toBe(
		"error",
	);
	expect(calls).toHaveLength(2);
});

test("status refuses a push context whose state is not text", async () => {
	const { send } = recording(() => [
		200,
		{ statuses: [{ context: "check / check (push)", status: 42 }] },
	]);
	await expect(
		withShims(() => forge(signedIn, send).status("abc")),
	).rejects.toThrow();
});

test("status is none when the commit has no statuses list", async () => {
	const { send } = recording(() => [200, { state: "pending", statuses: null }]);
	expect(
		await withShims(() => forge(signedIn, send).status("abc")),
	).toBeUndefined();
});

test("a signing key at a missing path is refused by name", () => {
	expect(() => signingKeyOf({ MAESTRO_TM_SIGNING_KEY: "/nope/key" })).toThrow(
		/MAESTRO_TM_SIGNING_KEY.*\/nope\/key/s,
	);
});
