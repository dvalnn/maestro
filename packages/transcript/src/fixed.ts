import { setSystemTime, spyOn } from "bun:test";

/**
 * Fixes what varies between runs, in this process, until `restore`: the clock stands at `start` and moves only by
 * `at`, and each new concert id is the next of a fixed sequence. A process the code under test starts is not reached.
 */
export function fixedRun(start: number) {
	let made = 0;
	const ids = spyOn(Bun, "randomUUIDv7").mockImplementation((() => {
		made += 1;
		const tail = Bun.hash(`concert ${made}`).toString(16).padStart(16, "0");
		return `01a154df-b99f-7${tail.slice(0, 3)}-8${tail.slice(3, 6)}-${tail.slice(4, 16)}`;
	}) as never);
	setSystemTime(new Date(start));
	return {
		/** Moves the clock to `ms` after the start. */
		at(ms: number) {
			setSystemTime(new Date(start + ms));
		},
		restore() {
			ids.mockRestore();
			setSystemTime();
		},
	};
}

/** Waits until `seen` holds, looking every few milliseconds; throws when it does not within `limit` ms. */
export async function until(seen: () => boolean, limit = 2000) {
	const start = performance.now();
	while (!seen()) {
		if (performance.now() - start > limit)
			throw new Error(`not seen within ${limit} ms: ${seen}`);
		await Bun.sleep(2);
	}
}
