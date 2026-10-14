import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { bubblewrap } from "../sandbox/index";
import { type Lane, openLanes } from "./index";

const dirs: string[] = [];
const tmp = (name: string) => {
	const d = mkdtempSync(join(tmpdir(), `lane-${name}-`));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ENV = {
	PATH: process.env.PATH ?? "/usr/bin:/bin",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_AUTHOR_NAME: "op",
	GIT_AUTHOR_EMAIL: "op@x",
	GIT_COMMITTER_NAME: "op",
	GIT_COMMITTER_EMAIL: "op@x",
};

function git(cwd: string, ...args: string[]): string {
	const p = Bun.spawnSync(["git", ...args], { cwd, env: ENV });
	if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr}`);
	return p.stdout.toString().trim();
}

function toyTarget(): string {
	const t = tmp("target");
	git(t, "init", "-q", "-b", "main");
	writeFileSync(join(t, "a.txt"), "a\n");
	git(t, "add", "a.txt");
	git(t, "commit", "-qm", "one");
	writeFileSync(join(t, "b.txt"), "b\n");
	git(t, "add", "b.txt");
	git(t, "commit", "-qm", "two");
	return t;
}

function applyToBase(target: string, base: string, patches: string[]) {
	const c = tmp("apply");
	git(c, "clone", "-q", target, ".");
	git(c, "checkout", "-q", "--detach", base);
	const mbox = join(tmp("mbox"), "series.mbox");
	writeFileSync(mbox, patches.join(""));
	if (patches.length) git(c, "am", "-q", mbox);
	return c;
}

describe("fresh", () => {
	test("cuts a lane at the base, and its sealed version leaves a changeset that applies to the base", async () => {
		const target = toyTarget();
		const lanes = openLanes({ target, root: tmp("root") });
		const lane = await lanes.fresh("main~1", "c1.build");
		expect(readFileSync(join(lane.dir, "a.txt"), "utf8")).toBe("a\n");
		writeFileSync(join(lane.dir, "a.txt"), "a2\n");
		writeFileSync(join(lane.dir, "new.txt"), "new\n");

		expect(await lane.seal()).toBe("c1.build");
		const cs = await lanes.changeset("c1.build");

		expect(cs.base).toBe(git(target, "rev-parse", "main~1"));
		expect(cs.patches).toHaveLength(1);
		const applied = applyToBase(target, cs.base, cs.patches);
		expect(readFileSync(join(applied, "a.txt"), "utf8")).toBe("a2\n");
		expect(readFileSync(join(applied, "new.txt"), "utf8")).toBe("new\n");
	});

	test("a lane that changed nothing seals to a version with an empty changeset", async () => {
		const lanes = openLanes({ target: toyTarget(), root: tmp("root") });
		await (await lanes.fresh("main", "c1.noop")).seal();
		expect((await lanes.changeset("c1.noop")).patches).toEqual([]);
	});

	test("a base that is no commit of the target names the base and the target", async () => {
		const target = toyTarget();
		const lanes = openLanes({ target, root: tmp("root") });
		await expect(lanes.fresh("no-such-branch", "c1.a")).rejects.toThrow(
			`base 'no-such-branch' is not a commit in ${target}. Pass a branch, tag or commit id`,
		);
	});

	test("a node instance seals at most one version", async () => {
		const lanes = openLanes({ target: toyTarget(), root: tmp("root") });
		const lane = await lanes.fresh("main", "c1.a");
		await lane.seal();
		await expect(lane.seal()).rejects.toThrow(/already sealed/);
		await expect(lanes.fresh("main", "c1.a")).rejects.toThrow(
			/already has a lane/,
		);
	});
});

describe("fork and join", () => {
	async function sealed(lanes: ReturnType<typeof openLanes>, at: string) {
		const lane = await lanes.fresh("main", at);
		writeFileSync(join(lane.dir, "a.txt"), "v1\n");
		writeFileSync(join(lane.dir, "ignored.log"), "scratch\n");
		writeFileSync(join(lane.dir, ".gitignore"), "*.log\n");
		await lane.seal();
		return lane;
	}

	test("join continues the lane in place and yields the next version, chained in the changeset", async () => {
		const target = toyTarget();
		const lanes = openLanes({ target, root: tmp("root") });
		const first = await sealed(lanes, "c1.build");

		const next = await lanes.join("c1.build", "c1.fix");
		expect(readFileSync(join(next.dir, "a.txt"), "utf8")).toBe("v1\n");
		expect(existsSync(join(next.dir, "ignored.log"))).toBe(true); // the same working copy
		expect(existsSync(first.dir)).toBe(false);
		writeFileSync(join(next.dir, "a.txt"), "v2\n");
		await next.seal();

		const cs = await lanes.changeset("c1.fix");
		expect(cs.patches).toHaveLength(2);
		const applied = applyToBase(target, cs.base, cs.patches);
		expect(readFileSync(join(applied, "a.txt"), "utf8")).toBe("v2\n");
		expect(existsSync(join(applied, "ignored.log"))).toBe(false);
		// The joined version itself is unchanged.
		expect((await lanes.changeset("c1.build")).patches).toHaveLength(1);
	});

	test("an unchanged lane at the end of a join chain seals to its parent and adds no patch", async () => {
		const lanes = openLanes({ target: toyTarget(), root: tmp("root") });
		await sealed(lanes, "c1.build");
		await (await lanes.join("c1.build", "c1.check")).seal();
		expect((await lanes.changeset("c1.check")).patches).toHaveLength(1);
		const fork = await lanes.fork("c1.check", "c1.look");
		expect(readFileSync(join(fork.dir, "a.txt"), "utf8")).toBe("v1\n");
	});

	test("a join that cannot move the lane does not use up the version's one join", async () => {
		const root = tmp("root");
		const lanes = openLanes({ target: toyTarget(), root });
		const first = await sealed(lanes, "c1.build");
		const home = join(first.dir, "..");
		renameSync(home, `${home}.away`);
		await expect(lanes.join("c1.build", "c1.fix")).rejects.toThrow(
			/cannot be moved/,
		);
		renameSync(`${home}.away`, home);
		const next = await lanes.join("c1.build", "c1.fix");
		expect(readFileSync(join(next.dir, "a.txt"), "utf8")).toBe("v1\n");
	});

	test("a version is joined at most once", async () => {
		const lanes = openLanes({ target: toyTarget(), root: tmp("root") });
		await sealed(lanes, "c1.build");
		await lanes.join("c1.build", "c1.fix");
		await expect(lanes.join("c1.build", "c1.other")).rejects.toThrow(
			/already joined/,
		);
	});

	test("fork copies the version's content into a new lane, any number of times, independent of later joins", async () => {
		const lanes = openLanes({ target: toyTarget(), root: tmp("root") });
		await sealed(lanes, "c1.build");
		const a = await lanes.fork("c1.build", "c1.reviewA");
		const joined = await lanes.join("c1.build", "c1.fix");
		writeFileSync(join(joined.dir, "a.txt"), "v2\n");
		await joined.seal();
		const b = await lanes.fork("c1.build", "c1.reviewB");

		for (const lane of [a, b]) {
			expect(readFileSync(join(lane.dir, "a.txt"), "utf8")).toBe("v1\n");
			expect(existsSync(join(lane.dir, "ignored.log"))).toBe(false); // a version holds no ignored files
		}
		writeFileSync(join(a.dir, "r.txt"), "r\n");
		await a.seal();
		expect((await lanes.changeset("c1.reviewA")).patches).toHaveLength(2);
	});

	test("a later concert forks a lane left by an earlier one through its lane ref, and cannot join it", async () => {
		const target = toyTarget();
		const root = tmp("root");
		const earlier = openLanes({ target, root });
		await sealed(earlier, "c1.build");

		const later = openLanes({ target, root }); // a separate concert, as from another process
		await expect(later.join("c1.build", "c2.fix")).rejects.toThrow(
			/only versions of its own concert/,
		);
		const lane = await later.fork("c1.build", "c2.fix");
		expect(readFileSync(join(lane.dir, "a.txt"), "utf8")).toBe("v1\n");
		writeFileSync(join(lane.dir, "c.txt"), "c\n");
		await lane.seal();

		const cs = await later.changeset("c2.fix");
		const applied = applyToBase(target, cs.base, cs.patches);
		expect(readFileSync(join(applied, "a.txt"), "utf8")).toBe("v1\n");
		expect(readFileSync(join(applied, "c.txt"), "utf8")).toBe("c\n");
		// The earlier concert's lane is still there to be joined by its own concert.
		await earlier.join("c1.build", "c1.fix");
	});

	test("ids are checked: a version needs a concert id without `.` and a node instance id", async () => {
		const lanes = openLanes({ target: toyTarget(), root: tmp("root") });
		for (const bad of ["nodot", ".n", "c."])
			await expect(lanes.fresh("main", bad)).rejects.toThrow(/not a version/);
		const odd = await lanes.fresh("main", "c1.map[0]/fix..x ~*");
		await odd.seal();
		expect((await lanes.fork("c1.map[0]/fix..x ~*", "c1.n")).dir).toBeString();
	});

	test("an unknown or unsealed version cannot be forked or joined", async () => {
		const lanes = openLanes({ target: toyTarget(), root: tmp("root") });
		await lanes.fresh("main", "c1.open");
		await expect(lanes.fork("c1.open", "c1.x")).rejects.toThrow(/unknown/);
		await expect(lanes.join("c1.nope", "c1.y")).rejects.toThrow(/unknown/);
	});
});

/** Every entry under `dir`: path, type, mode, size, inode, mtime, ctime and content hash. Atime is left out. */
function snapshot(dir: string): string[] {
	const out: string[] = [];
	const walk = (p: string) => {
		const s = lstatSync(p, { bigint: true });
		const what = s.isSymbolicLink()
			? `link:${readlinkSync(p)}`
			: s.isFile()
				? `file:${new Bun.CryptoHasher("sha256").update(readFileSync(p)).digest("hex")}`
				: "dir";
		out.push(
			`${relative(dir, p)} ${what} ${s.mode} ${s.size} ${s.ino} ${s.mtimeNs} ${s.ctimeNs}`,
		);
		if (s.isDirectory())
			for (const e of readdirSync(p).sort()) walk(join(p, e));
	};
	walk(dir);
	return out;
}

describe("the target", () => {
	test("is byte-identical after lanes are cut, forked, joined, sealed, turned into changesets and pruned", async () => {
		const target = toyTarget();
		writeFileSync(join(target, "wip.txt"), "the operator's uncommitted work\n");
		const before = snapshot(target);
		expect(before.some((l) => l.startsWith(".git/objects/"))).toBe(true);

		const lanes = openLanes({ target, root: tmp("root") });
		const a = await lanes.fresh("main~1", "c1.a");
		writeFileSync(join(a.dir, "a.txt"), "changed\n");
		await a.seal();
		await (await lanes.fork("c1.a", "c1.b")).seal();
		const c = await lanes.join("c1.a", "c1.c");
		writeFileSync(join(c.dir, "z.txt"), "z\n");
		await c.seal();
		await lanes.fresh("main", "c2.d"); // a second base is fetched
		await lanes.changeset("c1.c");
		await lanes.prune("c1");

		expect(snapshot(target)).toEqual(before);
	});
});

async function inSandbox(lane: Lane, script: string) {
	const p = bubblewrap.start({
		lane: lane.dir,
		readOnly: lane.readOnly,
		argv: ["sh", "-c", script],
	});
	const out: string[] = [];
	for await (const l of p.stdout) out.push(l);
	return { out, code: (await p.exited).code };
}

describe("git inside a lane", () => {
	test.skipIf(!Bun.which("bwrap"))(
		"reads its own lane's history and diff, cannot write, and sees no other lane",
		async () => {
			const target = toyTarget();
			const lanes = openLanes({ target, root: tmp("root") });
			const first = await lanes.fresh("main", "c1.build");
			writeFileSync(join(first.dir, "a.txt"), "built\n");
			await first.seal();
			for (const other of ["c1.other", "c2.else"]) {
				const l = await lanes.fresh("main~1", other);
				writeFileSync(join(l.dir, "secret.txt"), other);
				await l.seal();
			}
			await (await lanes.fork("c1.build", "c1.sibling")).seal();
			const lane = await lanes.join("c1.build", "c1.fix");
			writeFileSync(join(lane.dir, "a.txt"), "fixed\n");

			const { out, code } = await inSandbox(
				lane,
				`git status --porcelain 2>&1; echo "status=$?"
				git status 2>&1 | head -1
				git diff | grep '^[-+][a-z]'
				git log --all --format='log %s'
				echo "refs=$(git for-each-ref | wc -l) reflog=$(git reflog 2>/dev/null | wc -l)"
				(git add a.txt) 2>/dev/null && echo "WROTE add" || echo "DENIED add"
				(git commit -qam x) 2>/dev/null && echo "WROTE commit" || echo "DENIED commit"
				(git update-ref refs/heads/x HEAD) 2>/dev/null && echo "WROTE ref" || echo "DENIED ref"
				(touch "$(git rev-parse --git-dir)/x") 2>/dev/null && echo "WROTE gitdir" || echo "DENIED gitdir"
				(touch "$(git rev-parse --git-path objects)/info/x") 2>/dev/null && echo "WROTE objects" || echo "DENIED objects"
				test -e "${dirname(lane.readOnly[1]?.src ?? "")}/refs" && echo "SEES store refs" || echo "no store refs"
				echo x > /lane/agent.txt`,
			);
			expect(code).toBe(0);
			expect(out).toEqual([
				" M a.txt",
				"status=0",
				"Not currently on any branch.", // plain `git status`: HEAD is detached and has no reflog
				"-built",
				"+fixed",
				"log c1.build",
				"log two",
				"log one",
				"refs=0 reflog=0",
				"DENIED add",
				"DENIED commit",
				"DENIED ref",
				"DENIED gitdir",
				"DENIED objects",
				"no store refs",
			]);

			// What the sandboxed process wrote is sealed; its git attempts left nothing behind.
			await lane.seal();
			const cs = await lanes.changeset("c1.fix");
			const applied = applyToBase(target, cs.base, cs.patches);
			expect(readFileSync(join(applied, "a.txt"), "utf8")).toBe("fixed\n");
			expect(readFileSync(join(applied, "agent.txt"), "utf8")).toBe("x\n");
			expect(cs.patches).toHaveLength(2);
		},
	);
});

describe("what the host seals", () => {
	test("a .git the agent plants or redirects is never run, never sealed, and is restored on join", async () => {
		const lanes = openLanes({ target: toyTarget(), root: tmp("root") });
		const marker = join(tmp("marker"), "ran");
		const evil = `[core]\n\tfsmonitor = touch ${marker}\n\thooksPath = hooks\n`;

		const planted = await lanes.fresh("main", "c1.planted");
		rmSync(join(planted.dir, ".git"));
		mkdirSync(join(planted.dir, ".git", "hooks"), { recursive: true });
		writeFileSync(join(planted.dir, ".git", "config"), evil);
		writeFileSync(join(planted.dir, ".git", "HEAD"), "ref: refs/heads/x\n");
		writeFileSync(join(planted.dir, "f.txt"), "f\n");
		await planted.seal();

		const redirected = await lanes.fresh("main", "c1.redirected");
		const fake = join(redirected.dir, "fake");
		mkdirSync(join(fake, "objects"), { recursive: true });
		mkdirSync(join(fake, "refs"));
		writeFileSync(join(fake, "HEAD"), "ref: refs/heads/x\n");
		writeFileSync(join(fake, "config"), evil);
		writeFileSync(join(redirected.dir, ".git"), `gitdir: ${fake}\n`);
		await redirected.seal();

		expect(existsSync(marker)).toBe(false);
		const planted_ = (await lanes.changeset("c1.planted")).patches.join("");
		expect(planted_).toContain("f.txt");
		expect(planted_).not.toContain(".git/");
		const next = await lanes.join("c1.redirected", "c1.next");
		expect(readFileSync(join(next.dir, ".git"), "utf8")).toBe(
			`gitdir: ${next.readOnly[0]?.src}\n`,
		);
	});

	test("the lane's .gitattributes cannot change the bytes sealed or checked out", async () => {
		const lanes = openLanes({ target: toyTarget(), root: tmp("root") });
		const lane = await lanes.fresh("main", "c1.attrs");
		writeFileSync(
			join(lane.dir, ".gitattributes"),
			"* text eol=crlf ident working-tree-encoding=UTF-16\n",
		);
		writeFileSync(join(lane.dir, "x.txt"), "$Id$\nline\n");
		await lane.seal();

		const patch = (await lanes.changeset("c1.attrs")).patches.join("");
		expect(patch).toContain("+$Id$\n+line\n");
		const fork = await lanes.fork("c1.attrs", "c1.copy");
		expect(readFileSync(join(fork.dir, "x.txt"), "utf8")).toBe("$Id$\nline\n");
	});

	test("a symlink is sealed as its path, never the content it points to", async () => {
		const lanes = openLanes({ target: toyTarget(), root: tmp("root") });
		const lane = await lanes.fresh("main", "c1.link");
		symlinkSync("/etc/passwd", join(lane.dir, "link"));
		await lane.seal();
		const patch = (await lanes.changeset("c1.link")).patches.join("");
		expect(patch).toContain("new file mode 120000");
		expect(patch).toContain("+/etc/passwd");
		expect(patch).not.toContain("root:");
	});

	test("a nested repository is refused, not silently dropped", async () => {
		const lanes = openLanes({ target: toyTarget(), root: tmp("root") });
		const lane = await lanes.fresh("main", "c1.nested");
		const sub = join(lane.dir, "sub");
		mkdirSync(sub);
		git(sub, "init", "-q");
		writeFileSync(join(sub, "s.txt"), "s\n");
		git(sub, "add", "s.txt");
		git(sub, "commit", "-qm", "s");
		await expect(lane.seal()).rejects.toThrow(/nested repository at sub/);
	});
});

describe("prune and disk use", () => {
	test("prune removes a concert's lanes and versions and reports the space freed; other concerts keep theirs", async () => {
		const target = toyTarget();
		const lanes = openLanes({ target, root: tmp("root") });
		const a = await lanes.fresh("main", "c1.a");
		writeFileSync(join(a.dir, "big.bin"), new Uint8Array(256 * 1024).fill(7));
		await a.seal();
		const b = await lanes.fork("c1.a", "c2.b");
		writeFileSync(join(b.dir, "b.txt"), "b\n");
		await b.seal();

		const used = await lanes.diskUse("c1");
		expect(used).toBeGreaterThan(256 * 1024);
		expect(await lanes.prune("c1")).toBe(used);

		expect(existsSync(a.dir)).toBe(false);
		expect(await lanes.diskUse("c1")).toBe(0);
		await expect(lanes.fork("c1.a", "c2.x")).rejects.toThrow(/unknown/);
		expect(await lanes.prune("c1")).toBe(0);
		// The later concert's lane and changeset survive, including what it forked from the pruned one.
		expect(existsSync(b.dir)).toBe(true);
		const cs = await lanes.changeset("c2.b");
		const applied = applyToBase(target, cs.base, cs.patches);
		expect(readFileSync(join(applied, "big.bin")).length).toBe(256 * 1024);
	});
});
