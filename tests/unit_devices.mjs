import assert from "node:assert/strict";
import { browserContextOptions } from "../dist/browser-options.js";

const iphone = browserContextOptions({ emulation: { device: "iphone-15" } });
assert.deepEqual(iphone.viewport, { width: 390, height: 844 });
assert.equal(iphone.deviceScaleFactor, 3);
assert.equal(iphone.hasTouch, true);

const explicit = browserContextOptions({ viewport: { width: 800, height: 600 }, emulation: { device: "iphone-15", hasTouch: false } });
assert.deepEqual(explicit.viewport, { width: 800, height: 600 });
assert.equal(explicit.hasTouch, false);

const colors = browserContextOptions({ emulation: { forcedColors: "active", contrast: "more", javaScriptEnabled: false } });
assert.equal(colors.forcedColors, "active");
assert.equal(colors.contrast, "more");
assert.equal(colors.javaScriptEnabled, false);
assert.equal("isMobile" in iphone, false);
assert.equal("userAgent" in iphone, false);
console.log("unit_devices ok");
