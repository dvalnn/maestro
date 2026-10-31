import { resolve } from "node:path";
import { isJson, type Json } from "./json";

const FORGE_PY = resolve(
	import.meta.dir,
	"../../.claude/skills/forgejo/scripts/forge.py",
);
/** The forge's largest page. */
const PAGE = 50;

export type Issue = {
	number: number;
	title: string;
	body: string;
	labels: string[];
	/** The milestone's id. */
	milestone?: number;
};
/** An open pull request and its diffstat. */
export type Pull = {
	number: number;
	body: string;
	additions: number;
	deletions: number;
	files: number;
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
	/** The id of the milestone titled `title`, if there is one. */
	milestone(title: string): Promise<number | undefined>;
	issue(number: number): Promise<Issue>;
	open(query: IssueQuery): Promise<Issue[]>;
	/** The `count` most recently updated closed issues. */
	closed(count: number): Promise<Issue[]>;
	pulls(): Promise<Pull[]>;
	setLabels(issue: number, labels: string[]): Promise<void>;
	edit(issue: number, change: { body?: string; closed?: true }): Promise<void>;
	/** Files an issue with its labels and milestone in one call, and returns its number. */
	file(issue: NewIssue): Promise<number>;
	/** Marks `issue` blocked by `blocker`, unless it already is. */
	depend(issue: number, blocker: number): Promise<void>;
};

/**
 * The decoded response of one forge.py call.
 * @throws Error with forge.py's message when the call fails.
 */
async function api(method: string, path: string, body?: unknown) {
	const child = Bun.spawn(
		["python3", FORGE_PY, "api", method, path, ...(body ? ["-"] : [])],
		{
			stdin: body ? new TextEncoder().encode(JSON.stringify(body)) : "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, FJ_USE_BOT: "1" },
		},
	);
	const [out, err, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`forge: ${err.trim() || `exit ${code}`}`);
	const decoded: unknown = out.trim() ? JSON.parse(out) : undefined;
	return decoded;
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

const pullOf = (o: Json): Pull => ({
	number: num(o, "number"),
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
		setLabels: async (issue, labels) => {
			await api("PUT", `/issues/${issue}/labels`, { labels });
		},
		edit: async (issue, { body, closed }) => {
			await api("PATCH", `/issues/${issue}`, {
				...(body !== undefined && { body }),
				...(closed && { state: "closed" }),
			});
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
	};
}
