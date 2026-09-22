import assert from "node:assert/strict";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { app } from "../src/mock-bank/app.js";
import { parsePolicy } from "../src/core/policy.js";
import { readFileSync } from "node:fs";
import { parseDecision } from "../src/discovery/decision.js";
import type { DecisionSource } from "../src/discovery/model.js";
import { runDiscovery } from "../src/discovery/run.js";

const policy = parsePolicy(JSON.parse(readFileSync(new URL("../config/mock-bank-policy.json", import.meta.url), "utf8")));

function proposal(action: string, target: Record<string, unknown> | null = null, inputRef: string | null = null) {
  return parseDecision({ action, reason: `Visible UI supports ${action}`, target: target ? {
    kind: target.kind, role: target.role ?? null, name: target.name ?? null,
    withinText: null, frameTitle: target.frameTitle ?? null, rowHeader: target.rowHeader ?? null,
  } : null, inputRef, url: null, waitMs: null });
}

const flow = [
  proposal("fill", { kind: "role", role: "textbox", name: "Member ID" }, "member_id"),
  proposal("click", { kind: "role", role: "button", name: "Search" }),
  proposal("click", { kind: "role", role: "link", name: "Open member" }),
  proposal("click", { kind: "role", role: "link", name: "Open savings account" }),
  proposal("finish"),
  proposal("read", { kind: "table_value", rowHeader: "Current savings balance", frameTitle: "Savings account details" }),
];

test("discovery runner drives the UI through its policy gate and writes redacted events", async () => {
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const path = join(await mkdtemp(join(tmpdir(), "trace-replay-discovery-")), "run.jsonl");
    let index = 0;
    const model: DecisionSource = {
      provider: "scripted-test",
      model: "fixed-flow",
      decide: async () => {
        const decisionIndex = index++;
        return {
          decision: flow[decisionIndex] ?? proposal("finish"),
          responseId: `test-response-${decisionIndex}`,
          usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        };
      },
    };
    const result = await runDiscovery({
      goal: "Look up member {member_id} and return savings balance",
      entryUrl: `${baseUrl}/start`,
      inputs: { member_id: "10001" }, policy: { ...policy, allowedOrigins: [baseUrl] }, model, logPath: path,
      executablePath: process.env.CHROME_PATH || undefined,
      verifyCompletion: async (surface, readings) => {
        const heading = await surface.resolve({ frame: { title: "Savings account details" }, candidates: [{ kind: "role", role: "heading", name: "Account Balance" }] });
        return heading.status === "unique" && readings.includes("$1250.75 USD");
      },
    });
    assert.equal(result.status, "success", JSON.stringify(result));
    assert.equal(result.actions, 5);
    const log = await readFile(path, "utf8");
    assert.match(log, /model_decision/);
    assert.match(log, /target_resolved/);
    assert.match(log, /"provider":"scripted-test","id":"fixed-flow"/);
    assert.match(log, /"responseId":"test-response-0"/);
    assert.match(log, /"inputTokens":100,"outputTokens":20,"totalTokens":120/);
    assert.doesNotMatch(log, /10001|1250\.75|data:image/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("discovery policy stops a model-proposed Close Account click before activation", async () => {
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const path = join(await mkdtemp(join(tmpdir(), "trace-replay-risk-")), "run.jsonl");
    const decisions = [...flow.slice(0, 4), proposal("click", { kind: "role", role: "button", name: "Close Account" })];
    let index = 0;
    const model: DecisionSource = { provider: "scripted-test", model: "risky-flow", decide: async () => ({ decision: decisions[index++] }) };
    const result = await runDiscovery({
      goal: "Attempt a risky control",
      entryUrl: `${baseUrl}/start`, inputs: { member_id: "10001" },
      policy: { ...policy, allowedOrigins: [baseUrl] }, model, logPath: path,
      executablePath: process.env.CHROME_PATH || undefined,
      verifyCompletion: async () => false,
    });
    assert.equal(result.status, "intervention_required", JSON.stringify(result));
    const log = await readFile(path, "utf8");
    assert.match(log, /RISKY_CONTROL/);
    assert.doesNotMatch(log, /accounts\/savings\/close\/review/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
