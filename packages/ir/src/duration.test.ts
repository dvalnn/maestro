import { expect, test } from "bun:test";
import { durationMs } from "./duration";

test.each([
	["90s", 90_000],
	["15m", 900_000],
	["12h", 43_200_000],
	["7d", 604_800_000],
	["0s", undefined],
	["010s", undefined],
	["100ms", 100],
	["5ms", 5],
	["1.5m", undefined],
	["5", undefined],
	["5x", undefined],
	[" 5s", undefined],
])("durationMs(%j) is %p", (text, ms) => {
	expect(durationMs(text)).toBe(ms);
});
