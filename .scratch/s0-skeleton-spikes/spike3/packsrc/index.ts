import { basename } from "node:path";
import { code } from "../src/sdk";
export const nodes = [code("shout", (i) => basename(`/a/b/${String(i)}`).toUpperCase())];
