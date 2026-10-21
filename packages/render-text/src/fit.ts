import type { Row, Shown } from "./tree";

/** A line of fitted rows: a row as it is, or a stretch of rows left out, by their states, at the stretch's least depth. */
export type Fitted<R extends Row = Row> =
	| { type: "row"; row: R }
	| { type: "hidden"; depth: number; states: Shown[] };

const isPending = (row: Row) => row.shown === "pending";

/** The rows fitting may hide, in the order it hides them: settled ones from the top, then pending ones from the bottom. */
function hideOrder(rows: readonly Row[]): number[] {
	const free = [...rows.entries()].filter(([, row]) => !row.pinned);
	return [
		...free.filter(([, row]) => !isPending(row)),
		...free.filter(([, row]) => isPending(row)).reverse(),
	].map(([i]) => i);
}

/** How many lines `count` rows take once each stretch of `hidden` ones is one line. */
function heightOf(count: number, hidden: ReadonlySet<number>): number {
	let lines = 0;
	for (let i = 0; i < count; i++)
		if (!hidden.has(i) || !hidden.has(i - 1)) lines++;
	return lines;
}

function linesOf<R extends Row>(
	rows: readonly R[],
	hidden: ReadonlySet<number>,
): Fitted<R>[] {
	const lines: Fitted<R>[] = [];
	for (const [i, row] of rows.entries()) {
		const last = lines.at(-1);
		if (!hidden.has(i)) lines.push({ type: "row", row });
		else if (hidden.has(i - 1) && last?.type === "hidden") {
			last.states.push(row.shown);
			last.depth = Math.min(last.depth, row.depth);
		} else
			lines.push({ type: "hidden", depth: row.depth, states: [row.shown] });
	}
	return lines;
}

/** The fewest lines fitted rows take: one counting them all, however small the budget. */
const MIN_LINES = 1;

const counted = (rows: readonly Row[]): Fitted<never> => ({
	type: "hidden",
	depth: 0,
	states: rows.map((row) => row.shown),
});

/**
 * The pinned rows when stretches between them overflow `budget`, and a line counting the rest when one is left:
 * - every pinned row while they fit;
 * - else the deepest ones, the leaf and its nearest ancestors first.
 */
function cut<R extends Row>(rows: readonly R[], budget: number): Fitted<R>[] {
	const pinned = rows.filter((row) => row.pinned);
	const deepest = [...pinned].sort((a, b) => b.depth - a.depth);
	const room = pinned.length <= budget ? pinned.length : budget - MIN_LINES;
	const kept = new Set(deepest.slice(0, room));
	const rest = rows.filter((row) => !kept.has(row));
	return [
		...rows.flatMap((row): Fitted<R>[] =>
			kept.has(row) ? [{ type: "row", row }] : [],
		),
		...(rest.length > 0 && kept.size < budget ? [counted(rest)] : []),
	];
}

/**
 * `rows` fitted to `budget` lines, at least one, as they are when they fit:
 * 1. rows are hidden, settled ones from the top, then pending ones from the bottom, each stretch one line;
 * 2. each hidden row that fits again is shown, in the same order, so a stretch of one shows its row;
 * 3. pinned rows are never hidden; when they and the stretches still overflow, `cut` keeps the pinned rows it can and
 *    one line counts the rest.
 */
export function fitted<R extends Row>(
	rows: readonly R[],
	budget: number,
): Fitted<R>[] {
	if (rows.length === 0) return [];
	const room = Math.max(budget, MIN_LINES);
	const hidden = new Set<number>();
	for (const i of hideOrder(rows)) {
		if (heightOf(rows.length, hidden) <= room) break;
		hidden.add(i);
	}
	for (const i of [...hidden]) {
		hidden.delete(i);
		if (heightOf(rows.length, hidden) > room) hidden.add(i);
	}
	const lines = linesOf(rows, hidden);
	return lines.length <= room ? lines : cut(rows, room);
}
