// Prints the canonical IR of the fan-out example, for the two-process byte-stability test.
import { canonicalJson } from "@maestro/ir";
import { buildValid } from "./context";
import { fanout } from "./examples";

process.stdout.write(canonicalJson(buildValid(fanout)));
