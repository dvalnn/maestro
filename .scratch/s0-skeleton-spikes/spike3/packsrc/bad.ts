import { code } from "../src/sdk";
import leftPad from "left-pad";
export const nodes = [code("bad", (i) => leftPad(String(i), 5))];
