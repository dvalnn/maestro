import { basename, dirname } from "node:path";
import type { Diagnostic, SourceLocation } from "@maestro/ir";

/**
 * A build error, carrying its diagnostic. `code` is `<prefix>.<case>`, and the prefix is sdk-spec 13.3's:
 * - `REF`: a Ref used as a plain value (`REF.value`), fed to a param (`REF.param`), used outside the body or build
 *   that made it (`REF.escape`), or not a `Ref<Bool>` where a guard, an `until` or an `assert` needs one (`REF.bool`).
 * - `SCOPE`: a duplicate id (`SCOPE.duplicate`), a duplicate map item key (`SCOPE.key`), a function the loader cannot
 *   name (`SCOPE.export`), a bad name or label (`SCOPE.name`), a composition with ports built alone (`SCOPE.ports`),
 *   a constructor called outside a build (`SCOPE.build`).
 * - `PURE`: an ambient read during build (`PURE.ambient`), two builds that differ (`PURE.unstable`).
 * - `BOUND`: a group bound that is missing or not a whole number of at least 1 (`BOUND.max`).
 * - `TYPE`: a literal that is not JSON, a body or step that returns the wrong thing, a build that returns no node
 *   (`TYPE.result`), a bad pick path, ports or reducer inputs that do not fit.
 * - `CFG.examples`: a composition without ports and without an example input set.
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
// bundle every frame is the bundle's, so no frame qualifies and the location is left out.
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
