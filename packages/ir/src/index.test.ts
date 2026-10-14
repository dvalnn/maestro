import { expect, test } from "bun:test";
import * as ir from "./index";

test("ir entry point loads", () => {
	expect(ir).toBeDefined();
});
