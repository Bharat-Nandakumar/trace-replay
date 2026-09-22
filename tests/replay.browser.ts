import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { app } from "../src/mock-bank/app.js";
import { compileCapability } from "../src/compiler/compile.js";
import { parseCompilationProfile } from "../src/compiler/profile.js";
import { parsePolicy } from "../src/core/policy.js";
import { runReplay } from "../src/replay/run.js";

const profile = parseCompilationProfile(JSON.parse(readFileSync(new URL("../config/lookup-savings-balance.compile.json", import.meta.url), "utf8")));
const logContent = readFileSync(new URL("../evidence/discovery-gpt-5-6-terra-2026-09-20-final.jsonl", import.meta.url), "utf8");
const policy = parsePolicy(JSON.parse(readFileSync(new URL("../config/mock-bank-policy.json", import.meta.url), "utf8")));

test("generated capability replays with a new input and no model decisions", async () => {
  const artifact = compileCapability({
    logContent,
    profile,
    sensitiveValues: ["10001", "1250.75"],
    compiledAt: "2026-09-20T22:00:00.000Z",
  });
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const baseOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const path = join(await mkdtemp(join(tmpdir(), "trace-replay-replay-")), "run.jsonl");
    const artifactContent = `${JSON.stringify(artifact, null, 2)}\n`;
    const execution = await runReplay({
      artifact,
      artifactSha256: createHash("sha256").update(artifactContent).digest("hex"),
      inputs: { member_id: "10002" },
      baseOrigin,
      policy: { ...policy, allowedOrigins: [baseOrigin] },
      logPath: path,
      executablePath: process.env.CHROME_PATH || undefined,
    });
    assert.equal(execution.result.status, "success", JSON.stringify(execution.result));
    if (execution.result.status === "success") {
      assert.deepEqual(execution.result.outputs.balance, { amount: "842.10", currency: "USD" });
    }
    const evidence = await readFile(path, "utf8");
    assert.match(evidence, /"decisionSource":"artifact","modelCalls":0/);
    assert.doesNotMatch(evidence, /model_decision|10002|842\.10/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
