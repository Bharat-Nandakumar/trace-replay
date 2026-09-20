import assert from "node:assert/strict";
import { test } from "node:test";
import { decisionTool, parseDecision } from "../src/discovery/decision.js";

const target = {
  kind: "role", role: "textbox", name: "Member ID", withinText: null,
  frameTitle: null, rowHeader: null,
};

test("model decisions require named inputs and bounded waits", () => {
  const fill = parseDecision({ action: "fill", reason: "Member ID field is visible", target, inputRef: "member_id", url: null, waitMs: null });
  assert.equal(fill.action, "fill");
  if (fill.action === "fill") assert.equal(fill.inputRef, "member_id");
  assert.throws(() => parseDecision({ action: "fill", reason: "fill", target, inputRef: null, url: null, waitMs: null }));
  assert.throws(() => parseDecision({ action: "wait", reason: "loading", target: null, inputRef: null, url: null, waitMs: 60_000 }));
  assert.equal(decisionTool.strict, true);
});
