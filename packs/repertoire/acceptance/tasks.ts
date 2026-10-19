// The two toy tasks of the comparison against the predecessor (D-28), both on the greeter tree.

type Task = {
	request: string;
	/** The target's named checks, which live in config, outside any lane. */
	checks: Record<string, string | string[]>;
	maxRepairs: number;
};

const REQUEST =
	"Make greet.sh greet the name given as its first argument, and the world when none is given.";

const MAX_REPAIRS = 2;

/** No output equals both strings, so no lane content passes this line. */
const UNSATISFIABLE =
	'out="$(sh greet.sh Ada)"; test "$out" = "Hello, Ada!" && test "$out" = "Hi, Ada!"';

export const TASKS = {
	/** Fixable: accepted after at most one repair. */
	t1: {
		request: REQUEST,
		checks: { test: "sh test.sh" },
		maxRepairs: MAX_REPAIRS,
	},
	/** Unfixable by construction: rejected after exactly `maxRepairs` repairs. */
	t2: {
		request: REQUEST,
		checks: { test: ["sh test.sh", UNSATISFIABLE] },
		maxRepairs: MAX_REPAIRS,
	},
} satisfies Record<string, Task>;

export type TaskName = keyof typeof TASKS;

export const isTaskName = (name: string): name is TaskName =>
	Object.hasOwn(TASKS, name);
