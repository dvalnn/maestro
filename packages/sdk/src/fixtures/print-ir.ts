// Prints the canonical IR of the fan-out example, for the two-process byte-stability test.
import { irJson } from "../index";
import { buildValid } from "./context";
import { fanout } from "./examples";

process.stdout.write(irJson(buildValid(fanout)));
