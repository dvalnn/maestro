/** Milliseconds in one of each duration unit. */
export const MS_PER_UNIT = {
	ms: 1,
	s: 1000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};

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

/** `ms` in the largest unit that holds it whole, such as `45m`. */
export function durationText(ms: number): string {
	const units = Object.entries(MS_PER_UNIT).reverse();
	const [unit, per] = units.find(([, per]) => ms % per === 0) ?? ["ms", 1];
	return `${ms / per}${unit}`;
}
