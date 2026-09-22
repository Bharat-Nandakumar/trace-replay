import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compileCapability } from "../src/compiler/compile.js";
import { parseCompilationProfile } from "../src/compiler/profile.js";
import { parseArtifact, type CapabilityArtifact } from "../src/core/artifact.js";
import { parsePolicy } from "../src/core/policy.js";
import { app } from "../src/mock-bank/app.js";
import { runReplay } from "../src/replay/run.js";
import type { HandoffHandler } from "../src/handoff/types.js";

const profile = parseCompilationProfile(JSON.parse(readFileSync(new URL("../config/lookup-savings-balance.compile.json", import.meta.url), "utf8")));
const logContent = readFileSync(new URL("../evidence/discovery-gpt-5-6-terra-2026-09-20-final.jsonl", import.meta.url), "utf8");
const policy = parsePolicy(JSON.parse(readFileSync(new URL("../config/mock-bank-policy.json", import.meta.url), "utf8")));
const artifact = compileCapability({ logContent, profile, sensitiveValues: ["10001", "1250.75"], compiledAt: "2026-09-20T22:00:00.000Z" });

async function replay(
  selectedArtifact: CapabilityArtifact,
  input: string,
  scenario?: string,
  handoff?: HandoffHandler,
  logPathOverride?: string,
): Promise<{ result: Awaited<ReturnType<typeof runReplay>>["result"]; evidence: string }> {
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const baseOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const path = logPathOverride ?? join(await mkdtemp(join(tmpdir(), "trace-replay-replay-")), "run.jsonl");
    const content = `${JSON.stringify(selectedArtifact, null, 2)}\n`;
    const execution = await runReplay({
      artifact: selectedArtifact,
      artifactSha256: createHash("sha256").update(content).digest("hex"),
      inputs: { member_id: input },
      baseOrigin,
      entryUrl: scenario ? `${baseOrigin}/start?scenario=${scenario}` : undefined,
      policy: { ...policy, allowedOrigins: [baseOrigin] },
      logPath: path,
      executablePath: process.env.CHROME_PATH || undefined,
      handoff,
      headed: false,
    });
    return { result: execution.result, evidence: await readFile(path, "utf8") };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("generated capability replays with a new input and no model decisions", async () => {
  const execution = await replay(artifact, "10002");
  assert.equal(execution.result.status, "success", JSON.stringify(execution.result));
  if (execution.result.status === "success") assert.deepEqual(execution.result.outputs.balance, { amount: "842.10", currency: "USD" });
  assert.match(execution.evidence, /"decisionSource":"artifact","modelCalls":0/);
  assert.doesNotMatch(execution.evidence, /model_decision|10002|842\.10/);
});

test("invalid input ends before Chrome starts", async () => {
  const execution = await replay(artifact, "abc");
  assert.deepEqual(execution.result, { status: "business_outcome", capabilityId: artifact.id, code: "INVALID_MEMBER_ID" });
  assert.doesNotMatch(execution.evidence, /"event":"step_started"/);
});

test("well-formed unknown member returns the declared business outcome", async () => {
  const execution = await replay(artifact, "99999");
  assert.equal(execution.result.status, "business_outcome");
  if (execution.result.status === "business_outcome") assert.equal(execution.result.code, "MEMBER_NOT_FOUND");
});

test("slow loading uses exactly one declared recovery and succeeds", async () => {
  const execution = await replay(artifact, "10002", "slow_load");
  assert.equal(execution.result.status, "success", JSON.stringify(execution.result));
  assert.equal((execution.evidence.match(/"event":"recovery_started"/g) ?? []).length, 1);
  assert.match(execution.evidence, /"code":"SLOW_LOAD".*"recovered":true/);
});

test("permission denial is a hard runtime failure", async () => {
  const execution = await replay(artifact, "10002", "permission_denied");
  assert.equal(execution.result.status, "failure");
  if (execution.result.status === "failure") assert.deepEqual([execution.result.code, execution.result.category], ["PERMISSION_DENIED", "runtime"]);
});

test("session expiry is a hard runtime failure with screenshot evidence", async () => {
  const execution = await replay(artifact, "10002", "session_expired");
  assert.equal(execution.result.status, "failure");
  if (execution.result.status === "failure") assert.deepEqual([execution.result.code, execution.result.category], ["SESSION_EXPIRED", "runtime"]);
  assert.match(execution.evidence, /session_expired\.png/);
});

test("unexpected dialog requests intervention without acting on it", async () => {
  const execution = await replay(artifact, "10002", "unexpected_dialog");
  assert.equal(execution.result.status, "intervention_required");
  assert.match(execution.evidence, /"event":"intervention_requested"/);
});

test("operator resolves a dialog in the same page and replay resumes to success", async () => {
  const handoff: HandoffHandler = {
    operatorId: "automated-test-operator",
    timeoutMs: 5_000,
    handle: async (request) => {
      await request.accept();
      await request.page.getByRole("button", { name: "Dismiss notice" }).click();
      return "resume";
    },
  };
  const evidenceArtifact = process.env.HANDOFF_EVIDENCE_PATH
    ? parseArtifact(JSON.parse(readFileSync(new URL("../capabilities/lookup-savings-balance.json", import.meta.url), "utf8")))
    : artifact;
  const execution = await replay(evidenceArtifact, "10002", "unexpected_dialog", handoff, process.env.HANDOFF_EVIDENCE_PATH);
  assert.equal(execution.result.status, "success", JSON.stringify(execution.result));
  assert.match(execution.evidence, /"event":"intervention_accepted"/);
  assert.match(execution.evidence, /"event":"human_action".*"name":"Dismiss notice"/);
  assert.match(execution.evidence, /"event":"human_action".*"operatorId":"automated-test-operator"/);
  assert.match(execution.evidence, /"event":"human_action".*"method":"POST".*"source":"browser_request"/);
  assert.match(execution.evidence, /"event":"handoff_resumed"/);
  assert.match(execution.evidence, /"event":"handoff_revalidated".*"verified":true/);
  assert.match(execution.evidence, /"from":"automation","to":"paused"/);
  assert.match(execution.evidence, /"from":"paused","to":"human"/);
  assert.match(execution.evidence, /"from":"human","to":"automation"/);
});

test("resume without resolving the dialog stops clearly", async () => {
  const execution = await replay(artifact, "10002", "unexpected_dialog", {
    operatorId: "operator-test", timeoutMs: 5_000,
    handle: async (request) => { await request.accept(); return "resume"; },
  });
  assert.equal(execution.result.status, "failure");
  if (execution.result.status === "failure") {
    assert.deepEqual([execution.result.category, execution.result.code], ["intervention", "INTERVENTION_UNRESOLVED"]);
  }
});

test("operator abort is a structured intervention failure", async () => {
  const execution = await replay(artifact, "10002", "unexpected_dialog", {
    operatorId: "operator-test", timeoutMs: 5_000,
    handle: async (request) => { await request.accept(); return "abort"; },
  });
  assert.equal(execution.result.status, "failure");
  if (execution.result.status === "failure") {
    assert.deepEqual([execution.result.category, execution.result.code], ["intervention", "OPERATOR_ABORTED"]);
  }
});

test("handoff timeout is bounded and structured", async () => {
  const execution = await replay(artifact, "10002", "unexpected_dialog", {
    operatorId: "operator-test", timeoutMs: 25,
    handle: async () => new Promise(() => {}),
  });
  assert.equal(execution.result.status, "failure");
  if (execution.result.status === "failure") {
    assert.deepEqual([execution.result.category, execution.result.code], ["intervention", "HANDOFF_TIMEOUT"]);
  }
});

test("denied routes remain blocked while the operator owns the browser", async () => {
  const execution = await replay(artifact, "10002", "unexpected_dialog", {
    operatorId: "operator-test", timeoutMs: 5_000,
    handle: async (request) => {
      await request.accept();
      await request.page.getByRole("button", { name: "Dismiss notice" }).click();
      await request.page.getByRole("button", { name: "Close Account" }).click().catch(() => {});
      await request.page.waitForTimeout(100);
      return "abort";
    },
  });
  assert.equal(execution.result.status, "failure");
  if (execution.result.status === "failure") assert.equal(execution.result.code, "OPERATOR_ABORTED");
  assert.match(execution.evidence, /"event":"human_request_blocked"/);
  assert.match(execution.evidence, /ROUTE_DENIED/);
});

test("an unknown missing target is classified as possible drift", async () => {
  const changed = structuredClone(artifact) as unknown as Record<string, unknown>;
  const steps = changed.steps as Array<Record<string, unknown>>;
  const target = steps[2].target as { candidates: Array<Record<string, unknown>> };
  target.candidates[0].name = "Open changed member";
  const execution = await replay(parseArtifact(changed), "10002");
  assert.equal(execution.result.status, "failure");
  if (execution.result.status === "failure") assert.equal(execution.result.category, "possible_drift");
});
