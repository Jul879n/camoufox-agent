import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { insideRoot } from "../dist/files.js";

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "files-")));
const root = path.join(base, "root");
fs.mkdirSync(root);
fs.writeFileSync(path.join(root, "a.pdf"), "x");
fs.writeFileSync(path.join(base, "x"), "x");
fs.symlinkSync(path.join(base, "x"), path.join(root, "link"));

assert.equal(insideRoot(root, path.join(root, "a.pdf")), path.join(root, "a.pdf"));
assert.throws(() => insideRoot(root, path.join(root, "..", "x")), /outside CAMOUFOX_MCP_FILES_DIR/);
assert.throws(() => insideRoot(root, path.join(root, "link")), /outside CAMOUFOX_MCP_FILES_DIR/);
assert.throws(() => insideRoot(root, path.join(root, "nope")), /ENOENT/);
fs.rmSync(base, { recursive: true });
console.log("unit_files ok");
