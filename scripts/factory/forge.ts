import { dirname, resolve } from "node:path";
import { isJson, type Json } from "./json";

const FORGE_PY = resolve(
	import.meta.dir,
	"../../.claude/skills/forgejo/scripts/forge.py",
);
/**
 * Prints the `origin` forge's host, owner, repo and forge-bot token on one line, through forge.py's own lookup, so the
 * token is read one way only.
 */
const CREDENTIALS = [
	"import sys",
	"sys.path.insert(0, sys.argv[1])",
	"import forge",
	"host, owner, repo = forge.origin()",
	"print(host, owner, repo, forge.token(host))",
].join("; ");
const CREDENTIAL_FIELDS = 4;
/** The forge's largest page. */
const PAGE = 50;
/** How the forge refuses to arm auto-merge on a PR that is already armed. */
const ARMED = /^forge: 409 from .*already scheduled/is;
const MERGE_STYLE = "rebase";

export type Issue = {
	number: number;
	title: string;
	body: string;
	labels: string[];
	/** The milestone's id. */
	milestone?: number;
};
export type Comment = { id: number; body: string; author: string };
/** A pull request and its diffstat. */
export type Pull = {
	number: number;
	/** The branch it merges. */
	head: string;
	/** The commit `head` points at. */
	sha: string;
	/** The branch it merges into. */
	base: string;
	merged: boolean;
	body: string;
	additions: number;
	deletions: number;
	files: number;
};
export type NewPull = {
	title: string;
	body: string;
	head: string;
	base: string;
};
export type NewIssue = {
	title: string;
	body: string;
	milestone?: number;
	labels: string[];
};
/**
 * Narrows a list of open issues to a milestone's or a label's. The forge ignores a name it does not know and lists
 * every issue, so callers check each issue again.
 */
export type IssueQuery = { milestone?: string; label?: string };

/** The forge as the tick sees it, every call made as forge-bot. Labels are named, never given by id. */
export type Forge = {
	/** The login of the account the tick acts as. */
	login(): Promise<string>;
	/** The id of the milestone titled `title`, if there is one. */
	milestone(title: string): Promise<number | undefined>;
	issue(number: number): Promise<Issue>;
	open(query: IssueQuery): Promise<Issue[]>;
	/** The `count` most recently updated closed issues. */
	closed(count: number): Promise<Issue[]>;
	/** The open pull requests. */
	pulls(): Promise<Pull[]>;
	/** Pull request `number`, open or not. */
	pull(number: number): Promise<Pull>;
	setLabels(issue: number, labels: string[]): Promise<void>;
	edit(issue: number, change: { body?: string; closed?: true }): Promise<void>;
	/** The comments on `issue`, oldest first. */
	comments(issue: number): Promise<Comment[]>;
	/** Comments `body` on `issue`, and returns the comment's id. */
	comment(issue: number, body: string): Promise<number>;
	editComment(id: number, body: string): Promise<void>;
	/** Files an issue with its labels and milestone in one call, and returns its number. */
	file(issue: NewIssue): Promise<number>;
	/** Marks `issue` blocked by `blocker`, unless it already is. */
	depend(issue: number, blocker: number): Promise<void>;
	/** The open issues `issue` depends on. */
	blockers(issue: number): Promise<number[]>;
	/** Pushes `commit` of the checkout at `dir` as `branch` over HTTPS, replacing what the branch held. */
	push(dir: string, commit: string, branch: string): Promise<void>;
	/** Opens a pull request and returns its number. */
	openPull(pull: NewPull): Promise<number>;
	/** Changes the branch `pull` merges into to `base`. */
	retarget(pull: number, base: string): Promise<void>;
	/** Has the forge merge `pull` by rebase once its required checks pass, unless that is already armed. */
	arm(pull: number): Promise<void>;
};

/**
 * The stdout of `command`, run as forge-bot.
 * @throws Error with its stderr when it fails.
 */
async function run(
	command: string[],
	{
		stdin,
		cwd,
		env,
	}: { stdin?: string; cwd?: string; env?: Record<string, string> } = {},
) {
	const child = Bun.spawn(command, {
		cwd,
		stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, FJ_USE_BOT: "1", ...env },
	});
	const [out, err, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`forge: ${err.trim() || `exit ${code}`}`);
	return out;
}

/**
 * The decoded response of one forge.py call.
 * @throws Error with forge.py's message when the call fails.
 */
async function api(method: string, path: string, body?: unknown) {
	const out = await run(
		["python3", FORGE_PY, "api", method, path, ...(body ? ["-"] : [])],
		{ stdin: body ? JSON.stringify(body) : undefined },
	);
	const decoded: unknown = out.trim() ? JSON.parse(out) : undefined;
	return decoded;
}

/**
 * The `origin` forge's host, owner, repo and forge-bot token.
 * @throws Error when forge.py gives none.
 */
async function credentials() {
	const fields = (
		await run(["python3", "-I", "-c", CREDENTIALS, dirname(FORGE_PY)])
	)
		.trim()
		.split(" ");
	const [host = "", owner = "", repo = "", token] = fields;
	if (fields.length !== CREDENTIAL_FIELDS || !token)
		throw new Error("forge: forge.py gave no credentials");
	return { host, owner, repo, token };
}

/**
 * The login of the account the token belongs to, from `GET /user`, which forge.py's repo-scoped calls cannot reach.
 * @throws Error naming the status when the forge refuses.
 */
async function login() {
	const { host, token } = await credentials();
	const response = await fetch(`https://${host}/api/v1/user`, {
		headers: { Authorization: `token ${token}`, Accept: "application/json" },
	});
	if (!response.ok) throw new Error(`forge: ${response.status} from GET /user`);
	const login = text(object(await response.json(), "user"), "login");
	if (!login) throw new Error("forge: GET /user gave no login");
	return login;
}

/**
 * Pushes `refspec` from the checkout at `dir` to the `origin` forge over HTTPS as forge-bot.
 * @throws Error with git's message when the push fails.
 */
async function push(dir: string, refspec: string) {
	const { host, owner, repo, token } = await credentials();
	const basic = Buffer.from(`${token}:`).toString("base64");
	// The header goes through git's environment, so the token reaches no argv, config file or remote URL.
	await run(
		["git", "push", `https://${host}/${owner}/${repo}.git`, `+${refspec}`],
		{
			cwd: dir,
			env: {
				GIT_TERMINAL_PROMPT: "0",
				GIT_CONFIG_COUNT: "1",
				GIT_CONFIG_KEY_0: "http.extraHeader",
				GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
			},
		},
	);
}

function object(value: unknown, what: string): Json {
	if (!isJson(value)) throw new Error(`forge: ${what} is not an object`);
	return value;
}

function objects(value: unknown, what: string): Json[] {
	if (!Array.isArray(value)) throw new Error(`forge: ${what} is not a list`);
	return value.map((v) => object(v, what));
}

function num(o: Json, key: string): number {
	const v = o[key];
	if (typeof v !== "number" || !Number.isInteger(v))
		throw new Error(`forge: ${key} is not a number`);
	return v;
}

const text = (o: Json, key: string) =>
	typeof o[key] === "string" ? o[key] : "";

function issueOf(o: Json): Issue {
	const labels = objects(o.labels ?? [], "labels").map((l) => text(l, "name"));
	const milestone = o.milestone ? object(o.milestone, "milestone") : undefined;
	return {
		number: num(o, "number"),
		title: text(o, "title"),
		body: text(o, "body"),
		labels,
		milestone: milestone ? num(milestone, "id") : undefined,
	};
}

const commentOf = (o: Json): Comment => ({
	id: num(o, "id"),
	body: text(o, "body"),
	author: text(object(o.user, "user"), "login"),
});

const pullOf = (o: Json): Pull => ({
	number: num(o, "number"),
	head: text(object(o.head, "head"), "ref"),
	sha: text(object(o.head, "head"), "sha"),
	base: text(object(o.base, "base"), "ref"),
	merged: o.merged === true,
	body: text(o, "body"),
	additions: num(o, "additions"),
	deletions: num(o, "deletions"),
	files: num(o, "changed_files"),
});

const query = (params: Record<string, string | number | undefined>) =>
	new URLSearchParams(
		Object.entries(params).flatMap(([k, v]) =>
			v === undefined ? [] : [[k, String(v)]],
		),
	).toString();

async function all(path: string, params: Record<string, string | undefined>) {
	const items: Json[] = [];
	for (let page = 1; ; page++) {
		const got = objects(
			await api("GET", `${path}?${query({ ...params, limit: PAGE, page })}`),
			path,
		);
		items.push(...got);
		if (got.length < PAGE) return items;
	}
}

/** The forge of the `origin` remote, through forge.py. */
export function forge(): Forge {
	let repo: Promise<Json> | undefined;
	let labelIds: Promise<Map<string, number>> | undefined;
	const idOf = async (name: string) => {
		labelIds ??= all("/labels", {}).then(
			(ls) => new Map(ls.map((l) => [text(l, "name"), num(l, "id")])),
		);
		const id = (await labelIds).get(name);
		if (id === undefined)
			throw new Error(`forge: no label ${name}\nCreate it on the forge`);
		return id;
	};
	return {
		login,
		milestone: async (title) => {
			const found = await all("/milestones", { state: "all", name: title });
			const milestone = found.find((m) => text(m, "title") === title);
			return milestone ? num(milestone, "id") : undefined;
		},
		issue: async (number) =>
			issueOf(object(await api("GET", `/issues/${number}`), "issue")),
		open: async ({ milestone, label }) =>
			(
				await all("/issues", {
					state: "open",
					type: "issues",
					milestones: milestone,
					labels: label,
				})
			).map(issueOf),
		closed: async (count) =>
			objects(
				await api(
					"GET",
					`/issues?${query({ state: "closed", type: "issues", sort: "recentupdate", limit: count })}`,
				),
				"/issues",
			).map(issueOf),
		pulls: async () => (await all("/pulls", { state: "open" })).map(pullOf),
		pull: async (number) =>
			pullOf(object(await api("GET", `/pulls/${number}`), "pull")),
		setLabels: async (issue, labels) => {
			await api("PUT", `/issues/${issue}/labels`, { labels });
		},
		edit: async (issue, { body, closed }) => {
			await api("PATCH", `/issues/${issue}`, {
				...(body !== undefined && { body }),
				...(closed && { state: "closed" }),
			});
		},
		comments: async (issue) => {
			// The endpoint is not paged: it lists every comment at once.
			const path = `/issues/${issue}/comments`;
			return objects(await api("GET", path), path).map(commentOf);
		},
		comment: async (issue, body) =>
			num(
				object(
					await api("POST", `/issues/${issue}/comments`, { body }),
					"comment",
				),
				"id",
			),
		editComment: async (id, body) => {
			await api("PATCH", `/issues/comments/${id}`, { body });
		},
		file: async ({ labels, ...issue }) =>
			num(
				object(
					await api("POST", "/issues", {
						...issue,
						labels: await Promise.all(labels.map(idOf)),
					}),
					"issue",
				),
				"number",
			),
		depend: async (issue, blocker) => {
			const path = `/issues/${issue}/dependencies`;
			const blockers = objects(await api("GET", path), path);
			if (blockers.some((b) => num(b, "number") === blocker)) return;
			repo ??= api("GET", "").then((r) => object(r, "repo"));
			const found = await repo;
			await api("POST", path, {
				owner: text(object(found.owner, "owner"), "login"),
				repo: text(found, "name"),
				index: blocker,
			});
		},
		blockers: async (issue) => {
			const path = `/issues/${issue}/dependencies`;
			return objects(await api("GET", path), path)
				.filter((b) => text(b, "state") === "open")
				.map((b) => num(b, "number"));
		},
		push: (dir, commit, branch) => push(dir, `${commit}:refs/heads/${branch}`),
		openPull: async (pull) =>
			num(object(await api("POST", "/pulls", pull), "pull"), "number"),
		retarget: async (pull, base) => {
			await api("PATCH", `/pulls/${pull}`, { base });
		},
		arm: async (pull) => {
			try {
				await api("POST", `/pulls/${pull}/merge`, {
					Do: MERGE_STYLE,
					merge_when_checks_succeed: true,
				});
			} catch (error) {
				if (!(error instanceof Error && ARMED.test(error.message))) throw error;
			}
		},
	};
}
