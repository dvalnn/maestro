// The test fakes of the tick's ports: the forge, maestro and the landing, in memory.
import { join } from "node:path";
import type {
	Comment,
	Forge,
	Issue,
	NewIssue,
	NewPull,
	Pull,
	Review,
} from "./forge";
import type { Landing } from "./land";
import type { Concert, Maestro, Report, Result, Spend } from "./maestro";

export const MILESTONE = "v0.1.0";
export const MILESTONE_ID = 11;
export const FIRST_PULL = 30;
export const BOT = "forge-bot";

export type Stored = Issue & { open: boolean; comments: Comment[] };

/**
 * A forge in memory that logs every write. Like Forgejo given a name it does not know, it ignores every query and
 * lists all open issues. `cut` names a write that fails once, as a tick cut short would.
 */
export function fakeForge(
	issues: Stored[],
	cut?: string,
	events: string[] = [],
) {
	const writes: string[] = [];
	const depends = new Set<string>();
	const opened: NewPull[] = [];
	const blocking: Record<number, number[]> = {};
	const heads: Record<string, string> = {};
	const pins: number[] = [];
	const closedPulls = new Set<number>();
	const reviews: Record<number, Review[]> = {};
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
			title === MILESTONE ? MILESTONE_ID : undefined,
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
			find(n).comments.push({ id: nextComment, body, author: BOT });
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
		arm: async (n) => write(`arm #${n}`),
		reviews: async (n) => reviews[n] ?? [],
		head: async (branch) => {
			events.push(`head ${branch}`);
			return heads[branch] ?? `sha-${branch}`;
		},
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

export function fakeMaestro(
	concerts: Concert[],
	results: Record<string, Result>,
	reports: Record<string, Report>,
	events: string[] = [],
) {
	const starts: string[][] = [];
	const logs: (string | undefined)[] = [];
	const applied: string[] = [];
	let refusal: string | undefined;
	const maestro: Maestro = {
		concerts: async (tour, limit = 20) =>
			concerts
				.filter((c) => c.tour === tour || c.tour?.startsWith(`${tour}.`))
				.slice(0, limit),
		result: async (id) => {
			const result = results[id];
			if (!result) throw new Error(`no result for ${id}`);
			return result;
		},
		start: async (args, log) => {
			logs.push(log);
			if (refusal) throw new Error(refusal);
			starts.push(args);
			events.push("start");
			return "started";
		},
		report: async (id) => reports[id] ?? NO_REPORT,
		spend: async (id) => spendOf(id),
		apply: async (id, dir) => {
			applied.push(`${id} in ${dir}`);
		},
	};
	return {
		maestro,
		starts,
		logs,
		applied,
		refuse: (r: string) => (refusal = r),
	};
}

/**
 * A landing that logs each step, and fails at the step named `failAt` with `output` until it is healed. `differs` is
 * what each export says of the checkout, and `exported` lists the revisions exported.
 */
export function fakeLanding(
	failAt?: keyof Landing,
	output = "",
	differs = false,
) {
	const steps: string[] = [];
	const exported: string[] = [];
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
		export: async (revision, root) => {
			exported.push(revision);
			return { commit: revision, dir: join(root, revision), differs };
		},
	};
	return {
		landing,
		steps,
		events,
		exported,
		heal: () => (failing = undefined),
	};
}
