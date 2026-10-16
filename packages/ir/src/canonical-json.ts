/** Whether `v` is an object whose prototype is `Object.prototype` or null. */
export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" &&
	v !== null &&
	[Object.prototype, null].includes(Object.getPrototypeOf(v));

/**
 * `value` as JSON with the keys of every plain object sorted, so equal values give equal bytes. `substitute` maps each
 * value before it is written, and returns it unchanged to keep it.
 */
export function canonicalJson(
	value: unknown,
	substitute: (value: unknown) => unknown = (v) => v,
): string {
	return JSON.stringify(value, (_key, v: unknown) => {
		const next = substitute(v);
		return isPlainObject(next)
			? Object.fromEntries(
					Object.keys(next)
						.toSorted()
						.map((k) => [k, next[k]]),
				)
			: next;
	});
}
