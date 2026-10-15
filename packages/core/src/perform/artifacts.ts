import type { Dirent } from "node:fs";
import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readlink,
	realpath,
	rename,
} from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import {
	type ArtifactRef,
	CORE_TYPES,
	findMarked,
	type Ports,
} from "@maestro/ir";
import type { NodeInstance, Outputs } from "../worker";
import { isRecord } from "./ts-worker";

/** The `x-maestro-type` names whose runtime value is an `ArtifactRef` (ADR 0007). */
export const ARTIFACT_TYPES: ReadonlySet<string> = new Set(
	Object.values(CORE_TYPES),
);

/** A concert's artifact area and the directory its instances' scratch directories go in, both absolute. */
export type ConcertDirs = { artifacts: string; scratch: string };

/** The directories of concert `concert` under the absolute directory `root`. */
export const concertDirs = (root: string, concert: string): ConcertDirs => ({
	artifacts: join(root, concert, "artifacts"),
	scratch: join(root, concert, "scratch"),
});

export async function makeDirs(dirs: ConcertDirs): Promise<void> {
	await mkdir(dirs.artifacts, { recursive: true });
	await mkdir(dirs.scratch, { recursive: true });
}

/** Creates an instance's scratch directory. Its name is opaque: expansion keys may be `.` or `..`. */
export const scratchDir = (dirs: ConcertDirs) =>
	mkdtemp(join(dirs.scratch, "i"));

/**
 * `outputs` with each plain path at an artifact position of `ports` moved from `scratch` into `area` and replaced by
 * its `ArtifactRef`, and the references made (ADR 0007). A reference passed on stays as it is. Every path is checked
 * before any is moved.
 * @throws Error when such a path is not absolute, does not exist, lies outside `scratch`, or is not the kind of entry
 * its type names.
 */
export async function collectArtifacts(
	ports: Ports | undefined,
	outputs: Outputs,
	scratch: string,
	area: string,
	producer: NodeInstance,
): Promise<{ outputs: Outputs; artifacts: ArtifactRef[] }> {
	const moved: Record<string, unknown> = structuredClone(outputs);
	const written: { port: string; pointer: string; path: string }[] = [];
	for (const [port, schema] of Object.entries(ports ?? {}))
		for (const { type, pointer, value } of findMarked(schema, moved[port]))
			if (ARTIFACT_TYPES.has(type) && typeof value === "string") {
				const path = await ownPath(value, type, `output '${port}'`, scratch);
				written.push({ port, pointer, path });
			}
	const artifacts: ArtifactRef[] = [];
	for (const { port, pointer, path } of written) {
		const ref = await moveInto(area, path, producer);
		moved[port] = replaceAt(moved[port], pointer, ref);
		artifacts.push(ref);
	}
	return { outputs: moved, artifacts };
}

async function ownPath(
	path: string,
	type: string,
	where: string,
	scratch: string,
): Promise<string> {
	const fix = "Write it under ctx.scratch and return its absolute path";
	if (!isAbsolute(path))
		throw new Error(`${where} is '${path}', not an absolute path. ${fix}`);
	const real = await realpath(path).catch(() => undefined);
	if (real === undefined)
		throw new Error(`${where} names '${path}', which does not exist. ${fix}`);
	if (!real.startsWith(`${await realpath(scratch)}${sep}`))
		throw new Error(
			`${where} names '${path}', outside the instance's scratch directory. ${fix}`,
		);
	const dir = type === CORE_TYPES.dir;
	const stats = await lstat(real);
	if (dir ? !stats.isDirectory() : !stats.isFile())
		throw new Error(
			`${where} names '${path}', which is not a ${dir ? "directory" : "file"}, as its type '${type}' needs`,
		);
	return real;
}

async function moveInto(
	area: string,
	path: string,
	producer: NodeInstance,
): Promise<ArtifactRef> {
	const dir = await mkdtemp(join(area, "a"));
	const target = join(dir, basename(path));
	await rename(path, target);
	return {
		path: `${basename(dir)}/${basename(path)}`,
		contentHash: `sha256:${await digest(target)}`,
		producer,
	};
}

function child(at: unknown, key: string): unknown {
	if (Array.isArray(at)) return at[Number(key)];
	if (isRecord(at)) return at[key];
}

/** `root` with the value at the JSON Pointer `pointer` replaced. */
function replaceAt(root: unknown, pointer: string, value: unknown): unknown {
	if (pointer === "") return value;
	const keys = pointer
		.slice(1)
		.split("/")
		.map((k) => k.replaceAll("~1", "/").replaceAll("~0", "~"));
	const last = keys.pop() ?? "";
	let at = root;
	for (const key of keys) at = child(at, key);
	if (Array.isArray(at)) at[Number(last)] = value;
	else if (isRecord(at)) at[last] = value;
	else throw new Error(`no value at '${pointer}'`);
	return root;
}

/**
 * The SHA-256 of a file's bytes, or of a directory's sorted entry list: each entry's relative path, its kind, and
 * its file digest or link target, each field NUL-terminated.
 */
async function digest(path: string): Promise<string> {
	if (!(await lstat(path)).isDirectory()) return fileDigest(path);
	const entries = await readdir(path, { recursive: true, withFileTypes: true });
	const lines = await Promise.all(entries.map((e) => entryLine(path, e)));
	return new Bun.CryptoHasher("sha256")
		.update(lines.sort().join(""))
		.digest("hex");
}

async function fileDigest(path: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
	return hasher.digest("hex");
}

async function entryLine(root: string, entry: Dirent): Promise<string> {
	const path = join(entry.parentPath, entry.name);
	const name = relative(root, path);
	if (entry.isFile()) return `${name}\0file\0${await fileDigest(path)}\0`;
	if (entry.isDirectory()) return `${name}\0dir\0\0`;
	if (entry.isSymbolicLink()) return `${name}\0link\0${await readlink(path)}\0`;
	throw new Error(`'${path}' is not a file, directory or symbolic link`);
}
