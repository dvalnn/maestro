import { readFileSync } from "node:fs";

/** The most words in one requirement. */
export const MAX_REQUIREMENT_WORDS = 30;
/** The words an EARS requirement opens with, one per pattern. */
const EARS_OPENERS = ["The", "When", "While", "If", "Where"];
const SHALL = /\bshall\b/gi;
/** A word that starts a condition, which belongs before the `shall`. */
const CONDITION = /\b(when|if|unless)\b/i;
const CODE_SPAN = /`[^`]*`/g;

/** Each way `requirement` breaks the EARS shape: its opening word, one `shall`, no condition after it, its length. */
function earsFaults(requirement: string): string[] {
	const words = requirement.trim().split(/\s+/);
	const [opener = ""] = words;
	const shalls = requirement.match(SHALL)?.length ?? 0;
	const afterShall = requirement
		.replace(CODE_SPAN, "")
		.split(SHALL)
		.slice(1)
		.join(" ");
	const faults: string[] = [];
	if (!EARS_OPENERS.includes(opener))
		faults.push(`it opens with "${opener}", not ${EARS_OPENERS.join(", ")}`);
	if (shalls !== 1) faults.push(`it has ${shalls} "shall", not one`);
	if (CONDITION.test(afterShall))
		faults.push('it has a condition after "shall"');
	if (words.length > MAX_REQUIREMENT_WORDS)
		faults.push(`it runs ${words.length} words, over ${MAX_REQUIREMENT_WORDS}`);
	return faults;
}

/** A finding for each of `requirements` that breaks the EARS shape, naming it `R1` on by position. */
export const earsFindings = (requirements: string[]) =>
	requirements.flatMap((requirement, i) => {
		const faults = earsFaults(requirement);
		return faults.length
			? [
					`R${i + 1} breaks the EARS shape: ${faults.join("; ")}. Rewrite it as one behaviour per requirement.`,
				]
			: [];
	});

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
