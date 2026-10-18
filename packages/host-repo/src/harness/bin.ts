import { realpathSync } from "node:fs";
import { basename } from "node:path";

const MISE = "mise";

/**
 * The real executable of harness `name`: `bin` when given, else `name` on PATH. A version-manager shim resolves to
 * the manager, so mise, when installed, is asked where the tool lives.
 * @throws if `name` is not on PATH and no `bin` is given.
 */
export function resolveBin(name: string, bin?: string): string {
	const found = bin ?? Bun.which(name);
	if (!found)
		throw new Error(
			`${name} is not on PATH. Install ${name} or pass its path as \`bin\``,
		);
	const real = realpathSync(found);
	if (bin || basename(real) === name || !Bun.which(MISE)) return real;
	const asked = Bun.spawnSync([MISE, "which", name]).stdout.toString().trim();
	return asked ? realpathSync(asked) : real;
}
