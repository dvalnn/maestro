import { expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forge, loadEnvFile, type Send } from "./forge";

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

test.each([
	["already armed", "Pull request is already scheduled to auto merge", true],
	["refused otherwise", "merge failed because of conflict", false],
])(
	"arming a PR the forge answers 409 as %s throws only when not armed",
	async (_, refusal, passes) => {
		const { send } = recording(() => [409, { message: refusal }]);
		const armed = withShims(() => forge(signedIn, send).arm(30));
		if (passes) await armed;
		else await expect(armed).rejects.toThrow(refusal);
	},
);

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
		if (url.includes("/reviews?")) return [200, JSON.parse(reviews)];
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
