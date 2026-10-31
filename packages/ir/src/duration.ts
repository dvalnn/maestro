/** Milliseconds in one of each duration unit. */
export const MS_PER_UNIT = {
	ms: 1,
	s: 1000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};

/** The longest `timeout` in milliseconds: the largest delay a JavaScript timer holds. */
export const MAX_TIMEOUT = 2_147_483_647;

/** Durations written out, for the message that asks for one. */
export const DURATION_EXAMPLE = "500ms, 90s, 15m, 12h or 7d";

const DURATION = /^([1-9]\d*)(ms|s|m|h|d)$/;

/**
 * `text` as milliseconds: a positive whole number and one unit of `ms`, `s`, `m`, `h` or `d`, such as `500ms` or `7d`.
 * @returns `undefined` when `text` is not a duration.
 */
export function durationMs(text: string): number | undefined {
	const [, amount, unit] = DURATION.exec(text) ?? [];
	if (!amount || !unit) return undefined;
	return Number(amount) * MS_PER_UNIT[unit as keyof typeof MS_PER_UNIT];
}

/**
 * What is wrong with `text` as a timeout, and its fix:
 * - not a duration;
 * - longer than `MAX_TIMEOUT`.
 * @returns `undefined` when `text` is a duration a timer holds.
 */
export function timeoutProblem(
	text: string,
): { problem: string; fix: string } | undefined {
	const ms = durationMs(text);
	if (ms === undefined)
		return {
			problem: "is not a duration",
			fix: `Write it as ${DURATION_EXAMPLE}`,
		};
	return ms > MAX_TIMEOUT
		? { problem: `is longer than ${MAX_TIMEOUT}ms`, fix: "Shorten it" }
		: undefined;
}

/** `ms` in the largest unit that holds it whole, such as `45m`. */
export function durationText(ms: number): string {
	const units = Object.entries(MS_PER_UNIT).reverse();
	const [unit, per] = units.find(([, per]) => ms % per === 0) ?? ["ms", 1];
	return `${ms / per}${unit}`;
}
