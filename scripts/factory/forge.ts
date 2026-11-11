import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { isJson, type Json } from "./json";

const REPO = resolve(import.meta.dir, "../..");
const DOTENV = "maestro/.env";
export const TOKEN_KEY = "MAESTRO_TM_TOKEN";
/** The forge's largest page. */
const PAGE = 50;
/** How the forge refuses to arm auto-merge on a PR that is already armed. */
const ARMED = /^forge: 409 from .*already scheduled/is;
const MERGE_STYLE = "fast-forward-only";

export type Issue = {
	number: number;
	title: string;
	body: string;
	labels: string[];
	/** The milestone's id. */
	milestone?: number;
	/** When it closed, in ms since the epoch; absent while open. */
	closed?: number;
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
	body: string;
	additions: number;
	deletions: number;
	files: number;
};
/** An inline comment of a review, on `line` of `path` when it has one. */
export type ReviewComment = { path: string; line?: number; body: string };
/**
 * A review of a pull request. `official` marks a reviewer whose review counts toward approval; `comments` holds its
 * inline comments when it is official, not dismissed, requests changes and is newer than the `after` it was read with,
 * else none.
 */
export type Review = {
	id: number;
	state: string;
	official: boolean;
	dismissed: boolean;
	author: string;
	body: string;
	comments: ReviewComment[];
};
export const REQUEST_CHANGES = "REQUEST_CHANGES";
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

/** The forge account the tick acts as, whose name and email every commit it makes carries. */
export type Account = { login: string; name: string; email: string };

/** The forge as the tick sees it, every call made as the tick's own account. Labels are named, never given by id. */
export type Forge = {
	/** The account the tick acts as, read once from `GET /user`. */
	account(): Promise<Account>;
	/** The login of that account. */
	login(): Promise<string>;
	/** The id of the milestone titled `title`, if there is one. */
	milestone(title: string): Promise<number | undefined>;
	issue(number: number): Promise<Issue>;
	open(query: IssueQuery): Promise<Issue[]>;
	/** The `count` most recently updated closed issues. */
	closed(count: number): Promise<Issue[]>;
	/** The numbers of the repo's pinned issues, in pinned order. */
	pinned(): Promise<number[]>;
	/** The open pull requests. */
	pulls(): Promise<Pull[]>;
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
	/** Sets `pull`'s body. */
	editPull(pull: number, body: string): Promise<void>;
	/** Has the forge fast-forward `main` to `pull` once its required checks pass, unless that is already armed. */
	arm(pull: number): Promise<void>;
	/** The reviews of `pull`, oldest first. */
	reviews(pull: number, after: number): Promise<Review[]>;
	/** The commit `branch` points at. */
	head(branch: string): Promise<string>;
};

/** Sends one HTTP request; the forge's seam for tests. */
export type Send = (url: string, init: RequestInit) => Promise<Response>;

/** The file `loadEnvFile` reads, `$XDG_CONFIG_HOME/maestro/.env` as maestro reads it. */
export function dotenvPath(env: NodeJS.ProcessEnv) {
	const set = env.XDG_CONFIG_HOME;
	const config =
		set && isAbsolute(set) ? set : join(env.HOME || homedir(), ".config");
	return join(config, DOTENV);
}

/**
 * Loads `dotenvPath` into the process environment when it exists, never overriding a variable already set.
 * @throws Error naming the file when it exists and cannot be read.
 */
export function loadEnvFile(env: NodeJS.ProcessEnv = process.env) {
	const file = dotenvPath(env);
	try {
		process.loadEnvFile(file);
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return;
		throw new Error(
			`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}\nMake it readable, or remove it`,
		);
	}
}

/**
 * The stdout of `command`.
 * @throws Error with its stderr when it fails.
 */
async function run(
	command: string[],
	{ cwd, env }: { cwd?: string; env?: Record<string, string> } = {},
) {
	const child = Bun.spawn(command, {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...env },
	});
	const [out, err, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`forge: ${err.trim() || `exit ${code}`}`);
	return out;
}

/** The host, owner and repo of an ssh or https remote URL, `.git` or not. */
const REMOTE =
	/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?(?<host>[^:/]+)(?::\d*)?[:/](?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?\/?$/i;

/**
 * The `origin` forge's host, owner and repo, and the tick's token.
 * @throws Error naming `MAESTRO_TM_TOKEN` and its file when the token is unset, or the remote when it is unreadable.
 */
async function credentials(env: NodeJS.ProcessEnv) {
	const token = env[TOKEN_KEY];
	if (!token)
		throw new Error(
			`forge: ${TOKEN_KEY} is not set\nSet it in ${dotenvPath(env)}`,
		);
	const url = (
		await run(["git", "remote", "get-url", "origin"], { cwd: REPO })
	).trim();
	const { host, owner, repo } = REMOTE.exec(url)?.groups ?? {};
	if (!host || !owner || !repo)
		throw new Error(
			`forge: cannot read a forge from the origin remote ${url}\nSet origin to the forge's ssh or https URL`,
		);
	return { host, owner, repo, token };
}

type Credentials = Awaited<ReturnType<typeof credentials>>;

/**
 * The decoded response of one call to the origin repo's REST API, or to `GET /user` when `repoScoped` is false.
 * @throws Error naming the status, method and path when the forge refuses.
 */
async function call(
	creds: () => Promise<Credentials>,
	send: Send,
	method: string,
	path: string,
	body?: unknown,
	repoScoped = true,
) {
	const { host, owner, repo, token } = await creds();
	const base = `https://${host}/api/v1`;
	const response = await send(
		`${base}${repoScoped ? `/repos/${owner}/${repo}` : ""}${path}`,
		{
			method,
			headers: {
				Authorization: `token ${token}`,
				Accept: "application/json",
				...(body ? { "Content-Type": "application/json" } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
		},
	);
	const out = await response.text();
	if (!response.ok)
		throw new Error(
			`forge: ${response.status} from ${method} ${path}: ${out.trim()}`,
		);
	const decoded: unknown = out.trim() ? JSON.parse(out) : undefined;
	return { decoded, host };
}

/**
 * Pushes `refspec` from the checkout at `dir` to the `origin` forge over HTTPS as the tick's account.
 * @throws Error with git's message when the push fails.
 */
async function push(
	creds: () => Promise<Credentials>,
	dir: string,
	refspec: string,
) {
	const { host, owner, repo, token } = await creds();
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

/** The time `o[key]` holds, in ms since the epoch, when it holds one. */
function time(o: Json, key: string): number | undefined {
	const v = o[key];
	if (typeof v !== "string") return undefined;
	const at = Date.parse(v);
	if (Number.isNaN(at)) throw new Error(`forge: ${key} is not a time`);
	return at;
}

function issueOf(o: Json): Issue {
	const labels = objects(o.labels ?? [], "labels").map((l) => text(l, "name"));
	const milestone = o.milestone ? object(o.milestone, "milestone") : undefined;
	return {
		number: num(o, "number"),
		title: text(o, "title"),
		body: text(o, "body"),
		labels,
		milestone: milestone ? num(milestone, "id") : undefined,
		closed: time(o, "closed_at"),
	};
}

/** What Forgejo calls the author of a deleted account. */
const GHOST = "Ghost";

const authorOf = (o: Json) =>
	o.user ? text(object(o.user, "user"), "login") : GHOST;

const commentOf = (o: Json): Comment => ({
	id: num(o, "id"),
	body: text(o, "body"),
	author: authorOf(o),
});

const pullOf = (o: Json): Pull => ({
	number: num(o, "number"),
	head: text(object(o.head, "head"), "ref"),
	sha: text(object(o.head, "head"), "sha"),
	base: text(object(o.base, "base"), "ref"),
	body: text(o, "body"),
	additions: num(o, "additions"),
	deletions: num(o, "deletions"),
	files: num(o, "changed_files"),
});

type Api = (method: string, path: string, body?: unknown) => Promise<unknown>;

/** An inline comment on its `position`, else its `original_position`, none when it has neither. */
function reviewCommentOf(o: Json): ReviewComment {
	for (const line of [o.position, o.original_position])
		if (typeof line === "number" && line > 0)
			return { path: text(o, "path"), line, body: text(o, "body") };
	return { path: text(o, "path"), body: text(o, "body") };
}

/** Review `o` of `pull`, with its inline comments read when it is official, not dismissed, requests changes and has an id above `after`. */
async function reviewOf(
	api: Api,
	pull: number,
	after: number,
	o: Json,
): Promise<Review> {
	const id = num(o, "id");
	const state = text(o, "state");
	const official = o.official === true;
	const dismissed = o.dismissed === true;
	const path = `/pulls/${pull}/reviews/${id}/comments`;
	const fed = official && !dismissed && state === REQUEST_CHANGES && id > after;
	return {
		id,
		state,
		official,
		dismissed,
		author: authorOf(o),
		body: text(o, "body"),
		comments: fed
			? objects(await api("GET", path), path).map(reviewCommentOf)
			: [],
	};
}

const query = (params: Record<string, string | number | undefined>) =>
	new URLSearchParams(
		Object.entries(params).flatMap(([k, v]) =>
			v === undefined ? [] : [[k, String(v)]],
		),
	).toString();

async function all(
	api: Api,
	path: string,
	params: Record<string, string | undefined>,
) {
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

/**
 * The forge of the `origin` remote, called directly with the token `env` holds as `MAESTRO_TM_TOKEN`; `send` is
 * `fetch` unless a test replaces it.
 */
export function forge(
	env: NodeJS.ProcessEnv = process.env,
	send: Send = fetch,
): Forge {
	let credentialsOnce: Promise<Credentials> | undefined;
	const creds = () => {
		credentialsOnce ??= credentials(env);
		return credentialsOnce;
	};
	const api: Api = async (method, path, body) =>
		(await call(creds, send, method, path, body)).decoded;
	let account: Promise<Account> | undefined;
	const whoami = async (): Promise<Account> => {
		const { decoded, host } = await call(
			creds,
			send,
			"GET",
			"/user",
			undefined,
			false,
		);
		const user = object(decoded, "user");
		const login = text(user, "login");
		if (!login) throw new Error("forge: GET /user gave no login");
		return {
			login,
			name: text(user, "full_name") || login,
			email: text(user, "email") || `${login}@noreply.${host}`,
		};
	};
	let repo: Promise<Json> | undefined;
	let labelIds: Promise<Map<string, number>> | undefined;
	const idOf = async (name: string) => {
		labelIds ??= all(api, "/labels", {}).then(
			(ls) => new Map(ls.map((l) => [text(l, "name"), num(l, "id")])),
		);
		const id = (await labelIds).get(name);
		if (id === undefined)
			throw new Error(`forge: no label ${name}\nCreate it on the forge`);
		return id;
	};
	const cached = () => {
		account ??= whoami();
		return account;
	};
	return {
		account: cached,
		login: async () => (await cached()).login,
		milestone: async (title) => {
			const found = await all(api, "/milestones", {
				state: "all",
				name: title,
			});
			const milestone = found.find((m) => text(m, "title") === title);
			return milestone ? num(milestone, "id") : undefined;
		},
		issue: async (number) =>
			issueOf(object(await api("GET", `/issues/${number}`), "issue")),
		open: async ({ milestone, label }) =>
			(
				await all(api, "/issues", {
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
		pinned: async () =>
			objects(await api("GET", "/issues/pinned"), "/issues/pinned").map((i) =>
				num(i, "number"),
			),
		pulls: async () =>
			(await all(api, "/pulls", { state: "open" })).map(pullOf),
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
		push: (dir, commit, branch) =>
			push(creds, dir, `${commit}:refs/heads/${branch}`),
		openPull: async (pull) =>
			num(object(await api("POST", "/pulls", pull), "pull"), "number"),
		editPull: async (pull, body) => {
			await api("PATCH", `/pulls/${pull}`, { body });
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
		reviews: async (pull, after) => {
			const reviews = await all(api, `/pulls/${pull}/reviews`, {});
			return Promise.all(reviews.map((r) => reviewOf(api, pull, after, r)));
		},
		head: async (branch) => {
			const found = object(await api("GET", `/branches/${branch}`), "branch");
			return text(object(found.commit, "commit"), "id");
		},
	};
}
