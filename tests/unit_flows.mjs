import assert from "node:assert/strict";
import fs from "node:fs";
import { flowSchema } from "../dist/schema/tools.js";

const ok = JSON.parse(fs.readFileSync(new URL("./fixtures/flows/heroku-login.json", import.meta.url), "utf8"));
assert.ok(flowSchema.safeParse(ok).success);
assert.equal(flowSchema.safeParse({ ...ok, startUrl: "file:///etc/passwd" }).success, false);
assert.equal(flowSchema.safeParse({ ...ok, actions: [{ type: "explode" }] }).success, false);
assert.equal(flowSchema.safeParse({ ...ok, profile: "Bad Name" }).success, false);
console.log("unit_flows ok");
