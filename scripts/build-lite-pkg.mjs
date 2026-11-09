import { copyFileSync } from "node:fs";

copyFileSync("dist/lite.js", "lite-pkg/index.js");
