import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Host } from "@maestro/core/host";
import type { CodeEntry, LoadCode } from "@maestro/core/node";
import {
	type ConcertResult,
	openRecord,
	perform,
	type Records,
} from "@maestro/core/perform";
import {
	type CodeContext,
	type Ir,
	mapWorkers,
	type WorkerRef,
} from "@maestro/ir";
import { type FakeScript, fakeHost } from "./fake-host";

const DEFAULT_CONCURRENCY = 4;

/** A code node's or key function's stand-in, typed by whatever inputs it reads. */
type Stub = (inputs: never, context: CodeContext) => unknown;

/** What a stubbed concert takes. */
export type StubOptions = {
	/** The fake host's script. Ignored when `hosts` is given. */
	script?: FakeScript;
	/** The hosts to perform with, in place of the fake host. */
	hosts?: Host[];
	/** Config values by namespace, such as a host's, under the data root the concert is given. */
	config?: Readonly<Record<string, unknown>>;
	/** The code nodes' and key functions' stand-ins, by export name. */
	code?: Readonly<Record<string, Stub>>;
	/** The directory holding the record store and the concert directories. A new temporary directory by default. */
	dir?: string;
	/** Replaces `code` as the loader of worker references. */
	loadCode?: LoadCode;
	/** The `codeHash` each worker reference carries when performed. The IR's own by default. */
	codeHash?: (ref: WorkerRef) => string;
	/** The most instances executing at once. 4 by default. */
	concurrency?: number;
};

/** A concert performed to its end. */
export type StubConcert = {
	id: string;
	result: ConcertResult;
	/** The record store the concert was written to. */
	record: Records;
	dir: string;
	/** Closes the record store and, when the concert made its own directory, deletes it. */
	close(): Promise<void>;
};

/**
 * Performs `source` through the real executor, its nodes stubbed: host nodes by the fake host's script and code nodes by
 * `options.code`. A stub that is not given throws when called. `source` is one of:
 * - an IR, performed as a new concert;
 * - the id of a failed or rejected concert in the record of `options.dir`, which is resumed with its stored IR.
 */
export async function stubConcert(
	source: Ir | string,
	options: StubOptions = {},
): Promise<StubConcert> {
	const dir = options.dir ?? (await mkdtemp(join(tmpdir(), "maestro-stub-")));
	try {
		return await performIn(dir, source, options);
	} catch (error) {
		if (!options.dir) await rm(dir, { recursive: true, force: true });
		throw error;
	}
}

async function performIn(
	dir: string,
	source: Ir | string,
	options: StubOptions,
) {
	const recordPath = join(dir, "record.db");
	const loadCode: LoadCode =
		options.loadCode ??
		(async (ref) => {
			const stub = Object.hasOwn(options.code ?? {}, ref.export)
				? options.code?.[ref.export]
				: undefined;
			if (!stub) throw new Error(`no stub for code '${ref.export}'`);
			return stub as CodeEntry;
		});
	const ir = typeof source === "string" ? storedIr(recordPath, source) : source;
	const concert = await perform({
		ir: mapWorkers(ir, (ref) => ({
			...ref,
			codeHash: options.codeHash?.(ref) ?? ref.codeHash,
		})),
		...(typeof source === "string" && { resume: source }),
		config: { values: { ...options.config, dataRoot: dir }, sources: [] },
		hosts: options.hosts ?? [fakeHost(options.script)],
		loadCode,
		recordPath,
		dir,
		concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
	});
	const result = await concert.done;
	const record = openRecord(recordPath);
	return {
		id: concert.id,
		result,
		record,
		dir,
		close: async () => {
			record.close();
			if (!options.dir) await rm(dir, { recursive: true, force: true });
		},
	};
}

/** The IR stored for concert `id`. @throws Error when the record has no such concert. */
function storedIr(recordPath: string, id: string): Ir {
	const record = openRecord(recordPath);
	try {
		const found = record.find(id);
		if (!found) throw new Error(`no concert '${id}' in the record`);
		return found.ir;
	} finally {
		record.close();
	}
}
