import { readFileSync } from "node:fs";
import { earsFindings } from "./verdict";

/** The exit code of a check that ran and found its subject failing. */
const FAILED_EXIT = 3;
const USAGE_EXIT = 2;

/**
 * The requirements of the plan JSON `text`:
 *
 * - `"split"` for a plan whose verdict is `split`, which holds no spec;
 * - `undefined` when it holds no list of strings at `spec.requirements`.
 */
function requirementsOf(text: string): string[] | "split" | undefined {
	const plan = JSON.parse(text) as {
		verdict?: unknown;
		spec?: { requirements?: unknown };
	} | null;
	if (plan?.verdict === "split") return "split";
	const requirements = plan?.spec?.requirements;
	return Array.isArray(requirements) &&
		requirements.every((r) => typeof r === "string")
		? requirements
		: undefined;
}

/** Prints each requirement of the plan file named by the first argument that breaks the EARS shape, and exits 3 if any. */
function main(file: string | undefined): number {
	if (!file) {
		console.error("usage: bun .maestro/triage/ears.ts <plan.json>");
		return USAGE_EXIT;
	}
	let requirements: ReturnType<typeof requirementsOf>;
	try {
		requirements = requirementsOf(readFileSync(file, "utf8"));
	} catch (error) {
		console.error(`${file}: ${(error as Error).message}`);
		return USAGE_EXIT;
	}
	if (requirements === "split") {
		console.log("split: no requirements to check");
		return 0;
	}
	if (!requirements) {
		console.error(`${file}: no spec.requirements list. Write plan.json first`);
		return USAGE_EXIT;
	}
	const findings = earsFindings(requirements);
	for (const finding of findings) console.log(finding);
	return findings.length ? FAILED_EXIT : 0;
}

if (import.meta.main) process.exit(main(process.argv[2]));
