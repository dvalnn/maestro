// The test fakes of the tick's ports: the forge, maestro and the landing, in memory.
import { basename, join } from "node:path";
import type {
	Comment,
	Forge,
	Issue,
	NewIssue,
	NewPull,
	Pull,
	Review,
} from "./forge";
import type { Conflicts, Landing } from "./land";
import type { Concert, Maestro, Report, Result, Spend } from "./maestro";

export const MILESTONE = "v0.1.0";
export const MILESTONE_ID = 11;
export const FIRST_PULL = 30;
export const BOT = "forge-bot";

export type Stored = Issue & { open: boolean; comments: Comment[] };

/** A forge call the factory never makes. */
const unused = async (): Promise<never> => {
	throw new Error("forge: the factory makes no release call");
};

/**
 * A forge in memory that logs every write. Like Forgejo given a name it does not know, it ignores every query and
 * lists all open issues. `cut` names a write that fails once, as a tick cut short would.
 */
export function fakeForge(
	issues: Stored[],
	cut?: string,
	events: string[] = [],
	milestone = MILESTONE,
) {
	const writes: string[] = [];
	let uploading = false;
	const depends = new Set<string>();
	const opened: NewPull[] = [];
	const blocking: Record<number, number[]> = {};
	const heads: Record<string, string> = {};
	const pins: number[] = [];
	const closedPulls = new Set<number>();
	const reviews: Record<number, Review[]> = {};
	/** `#<n>: <body>` of each comment on a PR, which is no stored issue. */
	const pullComments: string[] = [];
	const closed: Issue[] = [
		{ number: 1, title: "An old one", body: "", labels: [] },
	];
	const pulls: Pull[] = [
		{
			number: 20,
			head: "maestro-tm/i6",
			sha: "sha20",
			base: "main",
			body: "Closes #6",
			additions: 3,
			deletions: 1,
			files: 2,
		},
	];
	let next = 100;
	let nextComment = 1000;
	let failing = cut;
	const write = (line: string) => {
		if (failing && line.startsWith(failing)) {
			failing = undefined;
			throw new Error(`forge: cut at ${line}`);
		}
		writes.push(line);
	};
	const find = (n: number) => {
		const issue = issues.find((i) => i.number === n);
		if (!issue) throw new Error(`no issue #${n}`);
		return issue;
	};
	const forge: Forge = {
		account: async () => ({ login: BOT, name: BOT, email: `${BOT}@x` }),
		login: async () => BOT,
		milestone: async (title) =>
			title === milestone ? MILESTONE_ID : undefined,
		issue: async (n) => {
			const issue = issues.find((i) => i.number === n);
			if (!issue) throw new Error(`forge: 404 from GET /issues/${n}: {}`);
			return issue;
		},
		open: async () => issues.filter((i) => i.open),
		closed: async () => [
			...closed,
			...issues.filter((i) => !i.open && i.closed !== undefined),
		],
		pinned: async () => pins,
		pulls: async () =>
			pulls
				.filter((p) => !closedPulls.has(p.number))
				.map((p) => ({ ...p, sha: heads[p.head] ?? p.sha })),
		setLabels: async (n, labels) => {
			write(`labels #${n} ${labels.join(" ")}`);
			find(n).labels = labels;
		},
		edit: async (n, { body, closed }) => {
			write(`edit #${n}${closed ? " closed" : ""}`);
			const issue = find(n);
			if (body !== undefined) issue.body = body;
			if (closed) issue.open = false;
		},
		comments: async (n) => find(n).comments,
		comment: async (n, body) => {
			write(`comment #${n}`);
			const issue = issues.find((i) => i.number === n);
			if (issue) issue.comments.push({ id: nextComment, body, author: BOT });
			else pullComments.push(`#${n}: ${body}`);
			return nextComment++;
		},
		editComment: async (id, body) => {
			write(`edit comment ${id}`);
			const comment = issues
				.flatMap((i) => i.comments)
				.find((c) => c.id === id);
			if (!comment) throw new Error(`no comment ${id}`);
			comment.body = body;
		},
		file: async (issue: NewIssue) => {
			write(`file #${next} ${issue.title}: ${issue.labels.join(" ")}`);
			issues.push({ ...issue, number: next, open: true, comments: [] });
			return next++;
		},
		depend: async (n, blocker) => {
			if (depends.has(`${n}<${blocker}`)) return;
			write(`depend #${n} on #${blocker}`);
			depends.add(`${n}<${blocker}`);
			blocking[n] = [...(blocking[n] ?? []), blocker];
		},
		blockers: async (n) =>
			(blocking[n] ?? []).filter(
				(b) => issues.find((i) => i.number === b)?.open ?? true,
			),
		push: async (dir, commit, branch) => {
			write(`push ${commit} as ${branch} from ${dir}`);
			heads[branch] = commit;
		},
		openPull: async (pull) => {
			write(`pull ${pull.head} to ${pull.base}: ${pull.title}`);
			const number = FIRST_PULL + opened.length;
			opened.push(pull);
			pulls.push({
				...pull,
				number,
				sha: "",
				additions: 0,
				deletions: 0,
				files: 0,
			});
			return number;
		},
		editPull: async (n, title, body) => {
			write(`rewrite #${n}: ${title}`);
			const pull = pulls.find((p) => p.number === n);
			if (pull) Object.assign(pull, { title, body });
		},
		attach: async (n, path) => {
			write(`attach #${n} ${basename(path)}`);
			// The forge answers 500 to two uploads to one PR at once.
			if (uploading) throw new Error("forge: two uploads at once");
			uploading = true;
			await Promise.resolve();
			uploading = false;
			return `https://forge.example/attachments/${basename(path)}`;
		},
		arm: async (n) => write(`arm #${n}`),
		reviews: async (n) => reviews[n] ?? [],
		requestReview: async (n, reviewers) =>
			write(`request review of #${n} from ${reviewers.join(", ")}`),
		head: async (branch) => {
			events.push(`head ${branch}`);
			return heads[branch] ?? `sha-${branch}`;
		},
		status: async () => "success",
		release: unused,
		createRelease: unused,
		upload: unused,
		download: unused,
		closeMilestone: unused,
	};
	return {
		forge,
		writes,
		find,
		opened,
		blocking,
		pins,
		pulls,
		closedPulls,
		reviews,
		pullComments,
		closed,
	};
}

export const NO_REPORT: Report = { obstacles: [], lessons: [], sightings: [] };
/** The slice concerts that continue another. */
const ENCORES = ["s2"];
const spendOf = (short: string): Spend => ({
	short,
	encore: ENCORES.includes(short),
	elapsedMs: 720_000,
	input: 100,
	output: 14_000,
	cacheRead: 812_000,
	cacheWrite: 131_000,
	fixes: 0,
});

/** The commit the tree of every concert in `fakeMaestro` holds, until its `recorded` says otherwise. */
export const TREE_COMMIT = "e".repeat(40);

export function fakeMaestro(
	concerts: Concert[],
	results: Record<string, Result>,
	reports: Record<string, Report>,
	events: string[] = [],
) {
	const starts: string[][] = [];
	const logs: (string | undefined)[] = [];
	const cwds: (string | undefined)[] = [];
	/** The `.maestro/` directory each concert id was recorded with, by id. */
	const recorded: Record<string, string> = {};
	const applied: string[] = [];
	/** The concert ids the record no longer holds. */
	const pruned = new Set<string>();
	let refusal: string | undefined;
	const maestro: Maestro = {
		// Real maestro stamps every concert; a list with no times takes its place in `concerts`, newest first.
		concerts: async (tour, limit = 20, kind) =>
			concerts
				// maestro writes a settle time for every settled concert; a fixture without one settled as it started,
				// and one without either times its place in the record, newest first
				.map((c, i) => ({
					...c,
					startedAt: c.startedAt ?? concerts.length - i,
					settledAt:
						c.status === "running"
							? undefined
							: (c.settledAt ?? c.startedAt ?? concerts.length - i),
				}))
				.filter(
					(c) =>
						(c.tour === tour || c.tour?.startsWith(`${tour}.`)) &&
						(!kind ||
							(c.pack === kind.pack && c.composition === kind.composition)),
				)
				.slice(0, limit),
		running: async () => concerts.filter((c) => c.status === "running"),
		result: async (id) => {
			const result = results[id];
			if (!result) throw new Error(`no result for ${id}`);
			return result;
		},
		start: async (args, log, cwd) => {
			logs.push(log);
			cwds.push(cwd);
			if (refusal) throw new Error(refusal);
			starts.push(args);
			events.push("start");
			return "started";
		},
		report: async (id) => reports[id] ?? NO_REPORT,
		spend: async (id) => spendOf(id),
		has: async (id) => !pruned.has(id),
		tree: async (id) => recorded[id] ?? `/cache/trees/${TREE_COMMIT}/.maestro`,
		apply: async (id, dir) => {
			applied.push(`${id} in ${dir}`);
		},
	};
	return {
		maestro,
		starts,
		logs,
		cwds,
		recorded,
		pruned,
		applied,
		refuse: (r: string) => (refusal = r),
	};
}

/**
 * A landing that logs each step, and fails at the step named `failAt` with `output` until it is healed. `changed` holds
 * the paths main changed since any spec's base, and `compared` each `from..to` asked. `conflicting` maps a PR head to
 * its conflicts with `main`, whose merge is `merged-<head>`.
 */
export function fakeLanding(failAt?: keyof Landing, output = "") {
	const changed: string[] = [];
	const compared: string[] = [];
	const steps: string[] = [];
	const trees: string[] = [];
	const kept: (string[] | "all")[] = [];
	const conflicting: Record<
		string,
		Omit<Conflicts, "commit"> | { untold: string[] }
	> = {};
	/** The revisions the repository does not have. */
	const unknown = new Set<string>();
	/** The shared trace of each forge head read, the fetch and each start, in order. */
	const events: string[] = [];
	let failing = failAt;
	const step = (name: keyof Landing, line: string) => {
		if (name === failing) throw new Error(output);
		steps.push(line);
	};
	const landing: Landing = {
		fetch: async () => {
			if (failing === "fetch") throw new Error(output);
			events.push("fetch");
		},
		open: async (dir, name, base) =>
			step("open", `open ${name} at ${dir} on ${base}`),
		describe: async (dir, message) => {
			step("describe", `describe ${dir}: ${message}`);
			return "abc123";
		},
		squash: async (dir, message) => {
			step("squash", `squash ${dir}: ${message}`);
			return "abc123";
		},
		close: async (dir, name) => step("close", `close ${name} at ${dir}`),
		commit: async (revision) => {
			if (unknown.has(revision)) throw new Error(`${revision} names 0 commits`);
			return revision;
		},
		changed: async (from, to, paths) => {
			compared.push(`${from}..${to}`);
			return paths.filter((p) => changed.includes(p));
		},
		tree: async (revision, root, keep) => {
			kept.push(keep === "all" ? keep : [...keep]);
			if (failing === "tree") throw new Error(output);
			trees.push(revision);
			return join(root, revision);
		},
		conflicts: async (head) => {
			const found = conflicting[head];
			return found && "untold" in found
				? found
				: found && { commit: `merged-${head}`, ...found };
		},
	};
	return {
		landing,
		steps,
		events,
		trees,
		kept,
		unknown,
		changed,
		compared,
		conflicting,
		heal: () => (failing = undefined),
	};
}
