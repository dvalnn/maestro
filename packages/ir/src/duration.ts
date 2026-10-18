/** Milliseconds in one of each duration unit. */
export const MS_PER_UNIT = {
	ms: 1,
	s: 1000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};

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
