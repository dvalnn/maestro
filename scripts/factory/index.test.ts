import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Forge, Issue, NewIssue } from "./forge";
import { HALT, lock, type Options, pass } from "./index";
import type { Concert, Maestro, Result } from "./maestro";
import { askOf, type Data, dataOf, type Triage, withBlock } from "./route";

const MILESTONE = "v0.1.0";
const MILESTONE_ID = 11;
const OTHER_MILESTONE_ID = 12;
const ASK = "Make greet.sh greet by name.";

type Stored = Issue & { open: boolean };

/**
 * A forge in memory that logs every write. Like Forgejo given a name it does not know, it ignores every query and
 * lists all open issues. `cut` names a write that fails once, as a pass cut short would.
 */
function fakeForge(issues: Stored[], cut?: string) {
	const writes: string[] = [];
	const depends = new Set<string>();
	let next = 100;
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
		milestone: async (title) =>
			title === MILESTONE ? MILESTONE_ID : undefined,
		issue: async (n) => find(n),
		open: async () => issues.filter((i) => i.open),
		closed: async () => [
			{ number: 1, title: "An old one", body: "", labels: [] },
		],
		pulls: async () => [
			{ number: 20, body: "Closes #6", additions: 3, deletions: 1, files: 2 },
		],
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
		file: async (issue: NewIssue) => {
			write(`file #${next} ${issue.title}: ${issue.labels.join(" ")}`);
			issues.push({ ...issue, number: next, open: true });
			return next++;
		},
		depend: async (n, blocker) => {
			if (depends.has(`${n}<${blocker}`)) return;
			write(`depend #${n} on #${blocker}`);
			depends.add(`${n}<${blocker}`);
		},
	};
	return { forge, writes, find };
}

function fakeMaestro(concerts: Concert[], results: Record<string, Result>) {
	const starts: string[][] = [];
	let refusal: string | undefined;
	const maestro: Maestro = {
		concerts: async () => concerts,
		result: async (id) => {
			const result = results[id];
			if (!result) throw new Error(`no result for ${id}`);
			return result;
		},
		start: async (args) => {
			if (refusal) throw new Error(refusal);
			starts.push(args);
			return "started";
		},
	};
	return { maestro, starts, refuse: (r: string) => (refusal = r) };
}

const issue = (
	number: number,
	state: string,
	data?: Data,
	title = "Greet by name",
): Stored => ({
	number,
	title,
	body: data ? withBlock(ASK, "needs-triage", data) : ASK,
	labels: ["kind/enhancement", `state/${state}`],
	milestone: MILESTONE_ID,
	open: true,
});

const triageConcert = (id: string, n: number, status = "ok"): Concert => ({
	id,
	status,
	pack: "triage",
	composition: "triage",
	tour: `${MILESTONE}.i${n}`,
});

const spec = {
	touches: ["greet.sh"],
	what: "Greet the first argument.",
	acceptance: ["bun test"],
	subject: "feat: greet by name",
};
const base = { reasons: ["one script --> two"], questions: [] };
const children = [
	{ title: "Parse the name", body: "a", dependsOn: [] },
	{ title: "Greet it", body: "b", dependsOn: [0] },
];

function setup(
	issues: Stored[],
	concerts: Concert[] = [],
	results: Record<string, Result> = {},
	cut?: string,
) {
	const forge = fakeForge(issues, cut);
	const maestro = fakeMaestro(concerts, results);
	const said: string[] = [];
	const options: Options = {
		milestone: MILESTONE,
		preset: "stub",
		dir: mkdtempSync(join(tmpdir(), "factory-")),
	};
	const run = (locked = true) =>
		pass(
			{
				forge: forge.forge,
				maestro: maestro.maestro,
				lock: () => locked,
				say: (l) => said.push(l),
			},
			options,
		);
	return { ...forge, ...maestro, said, options, run };
}

const settled = (triage: unknown, status = "ok"): Record<string, Result> => ({
	c1: { status, outputs: { triage } },
});

const ready: Triage = {
	...base,
	verdict: "ready-for-agent",
	risk: "low",
	area: "cli",
	spec,
};
const duplicate: Triage = {
	...base,
	verdict: "duplicate",
	risk: "low",
	duplicateOf: 3,
};

describe("a pass", () => {
	const verdicts: [string, Triage, string[], boolean, string][] = [
		[
			"ready-for-agent",
			ready,
			["state/ready-for-agent", "risk/low", "area/cli"],
			true,
			"- Subject: `feat: greet by name`",
		],
		[
			"needs-approval, dropping a stale area",
			{ ...base, verdict: "needs-approval", risk: "high", spec },
			["state/needs-approval", "risk/high"],
			true,
			"- Touches: `greet.sh`",
		],
		[
			"needs-info",
			{ ...base, verdict: "needs-info", risk: "medium", questions: ["Who?"] },
			["state/needs-info", "risk/medium"],
			true,
			"#### Questions\n\n- Who?",
		],
		[
			"split",
			{ ...base, verdict: "split", risk: "medium", children, related: [4] },
			["state/needs-approval", "risk/medium"],
			true,
			"1. Parse the name\n2. Greet it (after 1)",
		],
		[
			"duplicate",
			duplicate,
			["state/duplicate", "risk/low"],
			false,
			"- Duplicate of #3",
		],
	];
	test.each(verdicts)(
		"routes %s to its labels and block, and a second pass does nothing",
		async (_, triage, labels, open, shown) => {
			const triaged = issue(7, "needs-triage");
			triaged.labels.push("area/docs", "risk/low");
			const t = setup([triaged], [triageConcert("c1", 7)], settled(triage));
			await t.run();
			const routed = t.find(7);
			expect(routed.labels).toEqual(["kind/enhancement", ...labels]);
			expect(routed.open).toBe(open);
			expect(askOf(routed.body)).toBe(ASK);
			expect(routed.body).toContain(shown);
			const dataLine = routed.body.trimEnd().split("\n").at(-1) ?? "";
			expect(dataLine.match(/-->/g)).toHaveLength(1);
			expect(dataOf(routed.body)).toEqual({
				concert: "c1",
				triage: "c1",
				result: triage,
			});
			const writes = t.writes.length;
			await t.run();
			expect(t.writes).toHaveLength(writes);
			expect(t.starts).toEqual([]);
		},
	);

	test.each([
		["ready-for-agent", ready, true],
		["duplicate", duplicate, false],
	] as const)(
		"repairs a %s routing cut before its labels, without triaging again",
		async (_, triage, open) => {
			const t = setup(
				[issue(7, "needs-triage")],
				[triageConcert("c1", 7)],
				settled(triage),
				"labels #7",
			);
			await expect(t.run()).rejects.toThrow("cut at labels #7");
			expect(dataOf(t.find(7).body).pending).toBe(true);
			await t.run();
			const routed = t.find(7);
			expect(routed.labels).toContain(`state/${triage.verdict}`);
			expect(routed.open).toBe(open);
			expect(dataOf(routed.body).pending).toBeUndefined();
			expect(t.starts).toEqual([]);
		},
	);

	test("files an approved split's children once across a cut pass, ensuring a reused child's labels", async () => {
		const result: Triage = {
			...base,
			verdict: "split",
			risk: "medium",
			children,
		};
		const unlabelled = issue(50, "needs-triage", undefined, "Parse the name");
		unlabelled.body = "Part of #7\n\na";
		unlabelled.labels = [];
		const elsewhere = issue(51, "needs-triage", undefined, "Greet it");
		elsewhere.body = "Part of #70\n\nb";
		const t = setup(
			[
				issue(7, "ready-for-agent", { concert: "c1", triage: "c1", result }),
				unlabelled,
				elsewhere,
			],
			[],
			{},
			"depend",
		);
		await expect(t.run()).rejects.toThrow("cut at depend");
		await t.run();
		await t.run();
		expect(t.writes.filter((w) => !w.startsWith("edit"))).toEqual([
			"labels #50 state/needs-triage kind/enhancement",
			"file #100 Greet it: state/needs-triage kind/enhancement",
			"depend #100 on #50",
			"labels #7 state/in-progress kind/epic",
		]);
		expect(t.find(100).body).toBe("Part of #7\n\nb");
		expect(t.find(100).milestone).toBe(MILESTONE_ID);
		expect(dataOf(t.find(7).body).filed).toEqual([50, 100]);
	});

	test("starts triage of the oldest intake issue in the milestone, an encore when it was triaged before", async () => {
		const outside = {
			...issue(2, "needs-triage"),
			milestone: OTHER_MILESTONE_ID,
		};
		const t = setup([
			outside,
			issue(9, "needs-spec"),
			issue(8, "needs-triage", { concert: "c0", triage: "c0" }),
			issue(6, "in-progress"),
		]);
		await t.run();
		const backlog = join(t.options.dir, "backlog-i8.md");
		expect(t.starts).toEqual([
			[
				"perform",
				"--encore",
				"c0",
				"--issue",
				`#8 Greet by name\n\n${ASK}`,
				"--backlog",
				backlog,
				"--tour",
				"v0.1.0.i8",
				"--preset",
				"stub",
			],
		]);
		const snapshot = readFileSync(backlog, "utf8");
		expect(snapshot).toContain("### #9 Greet by name\n\nState: `needs-spec`");
		expect(snapshot).toContain(
			"### #6 Greet by name\n\nState: `in-progress`\nPR #20: +3 -1 in 2 files",
		);
		expect(snapshot).not.toContain("#8 ");
		expect(snapshot).not.toContain("#2 ");
		expect(snapshot).toContain("- #1 An old one");
		t.find(8).open = false;
		await t.run();
		expect(t.starts[1]?.slice(0, 2)).toEqual([
			"perform",
			expect.stringMatching(/\.maestro\/triage\.ts$/),
		]);
	});

	const faults: [string, Record<string, Result>, string, string][] = [
		[
			"a failed triage",
			{ c1: { status: "failed", reason: "boom: ```x```", outputs: {} } },
			"triage of #7 settled failed",
			"The triage concert `c1` of #7 settled failed:\n\n````text\nboom: ```x```\n````\n\nRead it with `maestro ls c1`.",
		],
		[
			"a malformed triage",
			settled({ verdict: "maybe" }),
			"triage of #7 gave a malformed triage",
			"The triage concert `c1` of #7 gave a malformed triage:\n\n```text\n",
		],
	];
	test.each(faults)(
		"halts on %s, then does nothing while halted",
		async (_, results, title, body) => {
			const t = setup(
				[issue(7, "needs-triage")],
				[triageConcert("c1", 7)],
				results,
			);
			await t.run();
			expect(t.writes).toEqual([
				`file #100 Factory halted: ${title}: ${HALT}`,
				"edit #7",
			]);
			expect(t.find(100).body).toStartWith(body);
			expect(t.find(7).labels).toContain("state/needs-triage");
			expect(dataOf(t.find(7).body).concert).toBe("c1");
			await t.run();
			expect(t.writes).toHaveLength(2);
			expect(t.starts).toEqual([]);
		},
	);

	test("halts naming the issue whose factory data it cannot read", async () => {
		const broken = issue(7, "needs-triage");
		broken.body = `${ASK}\n\n<!-- factory -->\n<!-- factory-data {nope -->\n`;
		const t = setup([broken]);
		await t.run();
		expect(t.writes).toEqual([
			`file #100 Factory halted: #7 has a malformed factory-data line: ${HALT}`,
		]);
		expect(t.starts).toEqual([]);
	});

	test("halts naming the issue when its triage does not start", async () => {
		const t = setup([issue(7, "needs-triage")]);
		t.refuse("maestro perform: triage.ts does not compose");
		await t.run();
		expect(t.writes).toEqual([
			`file #100 Factory halted: triage of #7 did not start: ${HALT}`,
		]);
		expect(t.find(100).body).toBe(
			"Triage of #7 did not start:\n\n```text\nmaestro perform: triage.ts does not compose\n```\n\nClose this issue to lift the halt.",
		);
	});

	test("fails without a halt when the forge is unreachable or the milestone missing", async () => {
		const t = setup([issue(7, "needs-triage")]);
		t.forge.open = async () => {
			throw new Error("forge: cannot reach https://forge/api");
		};
		await expect(t.run()).rejects.toThrow("cannot reach");
		const missing = setup([issue(7, "needs-triage")]);
		missing.options.milestone = "v9";
		await expect(missing.run()).rejects.toThrow("no milestone v9 on the forge");
		expect([...t.writes, ...missing.writes]).toEqual([]);
	});

	const idle: [string, boolean, Stored[], string, string][] = [
		["a held lock", false, [], "ok", "another pass holds the lock"],
		["a halt", true, [{ ...issue(5, "none"), labels: [HALT] }], "ok", "halted"],
		["a running concert", true, [], "running", "concert c1 is still running"],
	];
	test.each(idle)(
		"does nothing on %s",
		async (_, locked, extra, status, said) => {
			const t = setup(
				[issue(7, "needs-triage"), ...extra],
				[triageConcert("c1", 7, status)],
			);
			await t.run(locked);
			expect(t.writes).toEqual([]);
			expect(t.starts).toEqual([]);
			expect(t.said[0]).toStartWith(said);
		},
	);
});

test("a lock is held until its process exits", () => {
	const path = join(mkdtempSync(join(tmpdir(), "factory-")), "lock");
	expect(lock(path)).toBe(true);
	expect(lock(path)).toBe(false);
});
