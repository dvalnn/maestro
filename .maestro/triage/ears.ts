import { readFileSync } from "node:fs";
import { earsFindings } from "./verdict";

/** The exit code of a check that ran and found its subject failing. */
const FAILED_EXIT = 3;
const USAGE_EXIT = 2;

/** The requirements of the plan JSON `text`, none when it holds no list of strings there. */
function requirementsOf(text: string): string[] | undefined {
	const plan: unknown = JSON.parse(text);
	const spec = (plan as { spec?: { requirements?: unknown } } | null)?.spec;
	const requirements = spec?.requirements;
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
	let requirements: string[] | undefined;
	try {
		requirements = requirementsOf(readFileSync(file, "utf8"));
	} catch (error) {
		console.error(`${file}: ${(error as Error).message}`);
		return USAGE_EXIT;
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
