import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forge } from "./forge";

const TOKEN = "s3cret-token";
const dir = mkdtempSync(join(tmpdir(), "factory-forge-"));
const argv = join(dir, "argv");
const environment = join(dir, "env");
const shim = (name: string, body: string) => {
	writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
	chmodSync(join(dir, name), 0o755);
};
shim("python3", `echo "forge.example owner repo ${TOKEN}"`);
shim("git", `printf '%s\\n' "$@" > ${argv}\nenv > ${environment}`);

test("a push gives git the token through its environment config only", async () => {
	const path = process.env.PATH;
	process.env.PATH = `${dir}:${path}`;
	try {
		await forge().push(dir, "abc123", "maestro-tm/i7");
	} finally {
		process.env.PATH = path;
	}
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

test.each([
	["already armed", "Pull request is already scheduled to auto merge", true],
	["refused otherwise", "merge failed because of conflict", false],
])(
	"arming a PR the forge answers 409 as %s throws only when not armed",
	async (_, refusal, passes) => {
		const refusing = mkdtempSync(join(tmpdir(), "factory-forge-"));
		writeFileSync(
			join(refusing, "python3"),
			`#!/bin/sh\necho '409 from POST /pulls/30/merge: {"message":"${refusal}"}' >&2\nexit 1\n`,
		);
		chmodSync(join(refusing, "python3"), 0o755);
		const path = process.env.PATH;
		process.env.PATH = `${refusing}:${path}`;
		try {
			const armed = forge().arm(30);
			if (passes) await armed;
			else await expect(armed).rejects.toThrow(refusal);
		} finally {
			process.env.PATH = path;
		}
	},
);

test("reviews read the inline comments of an official review requesting changes above the bound, on the old line when it has no new one, and name a deleted account Ghost", async () => {
	const answering = mkdtempSync(join(tmpdir(), "factory-forge-"));
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
	writeFileSync(
		join(answering, "python3"),
		`#!/bin/sh\ncase "$4" in\n*/reviews/5/comments) echo '${comments}' ;;\n*/issues/9/comments) echo '${thread}' ;;\n*/reviews\\?*) echo '${reviews}' ;;\n*) exit 1 ;;\nesac\n`,
	);
	chmodSync(join(answering, "python3"), 0o755);
	const path = process.env.PATH;
	process.env.PATH = `${answering}:${path}`;
	try {
		const api = forge();
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
