import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CompilationError, compileCapability } from "../src/compiler/compile.js";
import { parseCompilationProfile } from "../src/compiler/profile.js";

const profile = parseCompilationProfile(JSON.parse(readFileSync(new URL("../config/lookup-savings-balance.compile.json", import.meta.url), "utf8")));
const successfulLog = readFileSync(new URL("../evidence/discovery-gpt-5-6-terra-2026-09-20-final.jsonl", import.meta.url), "utf8");
const failedLog = readFileSync(new URL("../evidence/discovery-gpt-5-6-terra-2026-09-20-failed.jsonl", import.meta.url), "utf8");

test("a verified discovery compiles into a parameterized capability", () => {
  const artifact = compileCapability({
    logContent: successfulLog,
    profile,
    sensitiveValues: ["10001", "1250.75"],
    compiledAt: "2026-09-20T22:00:00.000Z",
  });
  assert.deepEqual(artifact.steps.map((step) => step.action), ["fill", "click", "click", "click", "read"]);
  const fill = artifact.steps[0];
  assert.equal(fill.action === "fill" ? fill.value.inputRef : null, "member_id");
  assert.equal(artifact.provenance?.provider, "openai");
  assert.equal(artifact.provenance?.model, "gpt-5.6-terra");
  assert.match(artifact.provenance?.sourceLogSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(artifact), /10001|1250\.75|\[REDACTED\]/);
});

test("compiler rejects a discovery whose completion was not verified", () => {
  assert.throws(() => compileCapability({
    logContent: failedLog,
    profile,
    sensitiveValues: ["10001"],
    compiledAt: "2026-09-20T22:00:00.000Z",
  }), CompilationError);
});
