import { basename, dirname } from "node:path";
import type { Diagnostic, SourceLocation } from "@maestro/ir";

/**
 * A build error, carrying its diagnostic. `code` is `<prefix>.<case>`, and the prefix is sdk-spec 13.3's:
 * - `REF`: a Ref used as a plain value (`REF.value`), fed to a param (`REF.param`), used outside the body or build
 *   that made it (`REF.escape`), or not a `Ref<Bool>` where a guard, a condition or an `assert` needs one (`REF.bool`).
 * - `SCOPE`: a duplicate id (`SCOPE.duplicate`), a duplicate item key (`SCOPE.key`), a function the loader cannot
 *   name (`SCOPE.export`), a bad name or label (`SCOPE.name`), a composition with ports built alone (`SCOPE.ports`),
 *   a constructor called outside a build (`SCOPE.build`).
 * - `BUILD`: an ambient read during build (`BUILD.ambient`), two builds that differ (`BUILD.unstable`).
 * - `BOUND`: a group bound that is missing or not a whole number of at least 1 (`BOUND.max`), an agent's token limit
 *   that is not (`BOUND.tokens`), a code node or agent timeout that is no duration or out of range (`BOUND.timeout`).
 * - `TYPE`: a literal that is not JSON, a body or step that returns the wrong thing, a build that returns no node
 *   (`TYPE.result`), a bad get path (`TYPE.path`), an `or` with a Ref fallback or over a group's results
 *   (`TYPE.or`), a string key into an array table (`TYPE.key`), a `readJson` of an artifact that is not a JSON file
 *   (`TYPE.artifact`), ports or reducer inputs that do not fit.
 * - `CFG.examples`: a composition without ports and without an example input set.
 * - `CFG.param`: params a build refuses together, such as two of which exactly one must be given.
 * - `ASSERT.failed`: an `assert` on a plain value that is false.
 * - `IR`: emitted IR that `parseIr` rejects.
 */
export class BuildError extends Error {
	override readonly name = "BuildError";
	readonly diagnostic: Diagnostic;

	constructor(diagnostic: Omit<Diagnostic, "severity" | "source">) {
		super(diagnostic.message);
		const source = callSite(this.stack ?? "");
		this.diagnostic = { ...diagnostic, severity: "error", source };
	}
}

const SDK_DIR = import.meta.dirname;
const FRAME = /^\s*at (?:.*? \()?(.+?):(\d+):(\d+)\)?$/;

// The SDK's modules sit directly in its src directory, and its tests and fixtures stand in for author code. In a
// bundle every frame is the bundle's, so the first one is taken; it is no file path, and the loader drops it.
const isSdkFrame = (file: string) =>
	dirname(file) === SDK_DIR && !basename(file).includes(".test.");

function callSite(stack: string): SourceLocation | undefined {
	for (const line of stack.split("\n")) {
		const match = FRAME.exec(line);
		if (match?.[1] && !isSdkFrame(match[1]))
			return {
				file: match[1],
				line: Number(match[2]),
				column: Number(match[3]),
			};
	}
}
