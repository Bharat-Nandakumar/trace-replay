import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ArtifactSemanticError,
  assertNoSensitiveLiterals,
  parseArtifact,
  validateDeclaredOutputs,
  validateInvocationInputs,
} from "../src/core/artifact.js";
import { ControlStateError, SessionControl } from "../src/core/control.js";
import {
  evaluateAction,
  evaluateUrl,
  executeWithPolicy,
  parsePolicy,
  PolicyBlockError,
} from "../src/core/policy.js";
import { redactCapabilityEvent, redactForEvidence } from "../src/core/redaction.js";
import { RunResultSchema } from "../src/core/results.js";
import { requireUniqueTarget, TargetResolutionError } from "../src/core/surface.js";

const examplePath = new URL("../examples/hand-authored-savings-balance.json", import.meta.url);
const policyPath = new URL("../config/mock-bank-policy.json", import.meta.url);
const exampleJson = readFileSync(examplePath, "utf8");
const policy = parsePolicy(JSON.parse(readFileSync(policyPath, "utf8")));
const appUrl = "http://127.0.0.1:3000/members/10001/accounts/savings";

function mutableExample(): Record<string, any> {
  return JSON.parse(exampleJson) as Record<string, any>;
}

test("the hand-authored JSON example is a typed, parameterized capability", () => {
  const artifact = parseArtifact(mutableExample());
  assert.equal(artifact.schemaVersion, 1);
  assert.equal(artifact.inputs.member_id.type, "string");
  assert.equal(artifact.outputs.balance.type, "money");
  assert.equal(artifact.steps[0].action, "fill");
  assert.doesNotMatch(exampleJson, /10001|1250\.75/);
  assert.equal(artifact.steps.at(-1)?.action, "read");
});

test("artifact validation rejects malformed or unreviewable steps", () => {
  const wrongVersion = mutableExample();
  wrongVersion.schemaVersion = 99;
  assert.throws(() => parseArtifact(wrongVersion));

  const undeclaredInput = mutableExample();
  undeclaredInput.steps[0].value.inputRef = "unlisted_id";
  assert.throws(() => parseArtifact(undeclaredInput), ArtifactSemanticError);

  const duplicateStep = mutableExample();
  duplicateStep.steps[1].id = duplicateStep.steps[0].id;
  assert.throws(() => parseArtifact(duplicateStep), ArtifactSemanticError);

  const literalValue = mutableExample();
  literalValue.steps[0].value = { literal: "10001" };
  assert.throws(() => parseArtifact(literalValue));

  const unknownField = mutableExample();
  unknownField.modelTranscript = "raw model output";
  assert.throws(() => parseArtifact(unknownField));

  const valid = parseArtifact(mutableExample());
  assert.doesNotThrow(() => assertNoSensitiveLiterals(valid, ["10001", "1250.75"]));
  const contaminated = mutableExample();
  contaminated.steps[2].description = "Open member 10001";
  assert.throws(() => assertNoSensitiveLiterals(parseArtifact(contaminated), ["10001"]), ArtifactSemanticError);
});

test("invocation inputs and declared outputs are checked against the artifact", () => {
  const artifact = parseArtifact(mutableExample());
  assert.deepEqual(validateInvocationInputs(artifact, { member_id: "10002" }), {
    ok: true,
    values: { member_id: "10002" },
  });
  assert.deepEqual(validateInvocationInputs(artifact, { member_id: "abc" }), {
    ok: false,
    code: "INVALID_MEMBER_ID",
    field: "member_id",
    message: "Input has the wrong type or format",
  });
  assert.equal(validateInvocationInputs(artifact, { member_id: "10002", extra: "x" }).ok, false);
  assert.deepEqual(validateDeclaredOutputs(artifact, { balance: { amount: "842.10", currency: "USD" } }), {
    balance: { amount: "842.10", currency: "USD" },
  });
  assert.throws(() => validateDeclaredOutputs(artifact, { balance: { amount: "842.1", currency: "USD" } }));
});

test("policy allows only configured routes and origin", () => {
  assert.deepEqual(evaluateUrl(policy, "http://127.0.0.1:3000/start?scenario=slow_load"), { kind: "allow" });
  assert.equal(evaluateUrl(policy, "https://example.com/members/search").kind, "deny");
  assert.equal(evaluateUrl(policy, "http://127.0.0.1:3000/admin").kind, "deny");
  assert.equal(evaluateUrl(policy, "http://127.0.0.1:3000/members/10001/accounts/savings/close/confirm").kind, "deny");
  assert.throws(() => parsePolicy({ ...policy, allowedPathPatterns: ["members"] }));
});

test("the same policy gate blocks risky and external actions in discovery and replay", async () => {
  for (const mode of ["discovery", "replay"] as const) {
    const session = new SessionControl(`session-${mode}`);
    let executed = false;
    const closeAccount = {
      mode,
      type: "click" as const,
      currentUrl: appUrl,
      control: { role: "button", name: "Close Account" },
      declaredRisk: "read_only" as const,
    };
    assert.equal(evaluateAction(policy, closeAccount).kind, "human_required");
    await assert.rejects(
      executeWithPolicy(policy, session, closeAccount, async () => { executed = true; }),
      PolicyBlockError,
    );
    assert.equal(executed, false);

    await assert.rejects(
      executeWithPolicy(policy, session, {
        mode,
        type: "navigate",
        currentUrl: appUrl,
        destinationUrl: "https://example.com/",
      }, async () => { executed = true; }),
      PolicyBlockError,
    );
    assert.equal(executed, false);

    await executeWithPolicy(policy, session, {
      mode,
      type: "read",
      currentUrl: appUrl,
      control: { role: "cell", name: "Current savings balance" },
      declaredRisk: "read_only",
    }, async () => { executed = true; });
    assert.equal(executed, true);
  }
});

test("control ownership prevents automation actions during human takeover", async () => {
  const session = new SessionControl("live-browser-1");
  session.pause("unexpected dialog");
  assert.throws(() => session.assertAutomationControl(), ControlStateError);
  session.takeHumanControl("operator-7");
  assert.throws(() => session.assertAutomationControl(), ControlStateError);
  await assert.rejects(executeWithPolicy(policy, session, {
    mode: "replay",
    type: "click",
    currentUrl: appUrl,
    control: { role: "button", name: "Search" },
  }, async () => {}), ControlStateError);
  session.resume("operator-7");
  session.assertAutomationControl();
  assert.deepEqual(session.events.map((event) => event.to), ["paused", "human", "automation"]);
});

test("target resolution requires exactly one match", async () => {
  const artifact = parseArtifact(mutableExample());
  const target = artifact.steps[0].action === "fill" ? artifact.steps[0].target : null;
  assert.ok(target);
  const unique = { resolve: async () => ({ status: "unique" as const, handle: "handle", identity: { role: "textbox", name: "Member ID" }, strategyIndex: 0 }) };
  assert.equal((await requireUniqueTarget(unique, target)).handle, "handle");
  const missing = { resolve: async () => ({ status: "missing" as const, observed: "no textbox" }) };
  await assert.rejects(requireUniqueTarget(missing, target), TargetResolutionError);
  const ambiguous = { resolve: async () => ({ status: "ambiguous" as const, matches: 2, observed: "two search boxes" }) };
  await assert.rejects(requireUniqueTarget(ambiguous, target), TargetResolutionError);
});

test("evidence redaction masks nested runtime values and secret fields", () => {
  const redacted = redactForEvidence({
    memberId: "10001",
    url: "http://localhost/members/10001",
    outputs: { balance: "1250.75" },
    apiKey: "sk-example",
    token: "bearer-example",
    inputTokens: 1234,
    outputTokens: 56,
    count: 10001,
  }, ["10001", "1250.75"]);
  assert.deepEqual(redacted, {
    memberId: "[REDACTED]",
    url: "http://localhost/members/[REDACTED]",
    outputs: { balance: "[REDACTED]" },
    apiKey: "[REDACTED]",
    token: "[REDACTED]",
    inputTokens: 1234,
    outputTokens: 56,
    count: "[REDACTED]",
  });
  const artifact = parseArtifact(mutableExample());
  assert.deepEqual(redactCapabilityEvent(
    artifact,
    { member_id: "10002" },
    { balance: { amount: "842.10", currency: "USD" } },
    { step: "read_balance", member: "10002", result: "$842.10 USD" },
  ), { step: "read_balance", member: "[REDACTED]", result: "$[REDACTED] USD" });
});

test("run results have distinct success, business, failure, and intervention shapes", () => {
  assert.equal(RunResultSchema.parse({
    status: "success", capabilityId: "lookup_savings_balance", outputs: { balance: { amount: "842.10", currency: "USD" } },
  }).status, "success");
  assert.equal(RunResultSchema.parse({
    status: "business_outcome", capabilityId: "lookup_savings_balance", code: "MEMBER_NOT_FOUND",
  }).status, "business_outcome");
  assert.equal(RunResultSchema.parse({
    status: "failure", capabilityId: "lookup_savings_balance", code: "PERMISSION_DENIED", stepId: "open_savings",
    expected: "Savings Account", observed: "Access Denied", category: "runtime",
  }).status, "failure");
  assert.equal(RunResultSchema.parse({
    status: "intervention_required", capabilityId: "lookup_savings_balance", requestId: "request-1",
    reason: "Unexpected dialog",
  }).status, "intervention_required");
});
