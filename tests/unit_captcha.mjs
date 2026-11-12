import assert from "node:assert/strict";
import { isStrongChallenge } from "../dist/captcha.js";

assert.equal(isStrongChallenge({ captchaDetected: true, challengeSignals: ["input:challenge"] }), false);
assert.equal(isStrongChallenge({ captchaDetected: true, challengeSignals: ["markup:challenge-provider", "status:403"] }), false);
assert.equal(isStrongChallenge({ captchaDetected: true, challengeSignals: ["iframe:captcha"] }), true);
assert.equal(isStrongChallenge({ captchaDetected: true, challengeSignals: ["input:challenge", "title:challenge"] }), true);
assert.equal(isStrongChallenge({ captchaDetected: false, challengeSignals: ["iframe:captcha"] }), false);
assert.equal(isStrongChallenge({}), false);
console.log("unit_captcha ok");
