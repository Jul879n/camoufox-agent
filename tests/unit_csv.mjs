import assert from "node:assert/strict";
import { toCsv } from "../dist/extractors/structured.js";

const csv = toCsv([{ a: 'x,y', b: 'di "hola"', c: "l1\nl2", d: ["p", "q"], e: null }], ["a", "b", "c", "d", "e"]);
assert.equal(csv, 'a,b,c,d,e\r\n"x,y","di ""hola""","l1\nl2",p | q,\r\n');
console.log("unit_csv ok");
