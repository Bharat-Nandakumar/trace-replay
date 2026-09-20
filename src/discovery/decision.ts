import { z } from "zod";
import type { FunctionTool } from "openai/resources/responses/responses";
import { TargetSchema, type Target } from "../core/artifact.js";

const TargetProposal = z.strictObject({
  kind: z.enum(["role", "label", "text", "table_value"]),
  role: z.string().nullable(),
  name: z.string().nullable(),
  withinText: z.string().nullable(),
  frameTitle: z.string().nullable(),
  rowHeader: z.string().nullable(),
});

const RawDecision = z.strictObject({
  action: z.enum(["navigate", "click", "fill", "read", "wait", "finish", "request_human"]),
  reason: z.string().trim().min(1).max(300),
  target: TargetProposal.nullable(),
  inputRef: z.string().nullable(),
  url: z.string().nullable(),
  waitMs: z.number().int().nullable(),
});

export type DiscoveryDecision =
  | { action: "navigate"; reason: string; url: string }
  | { action: "click" | "read"; reason: string; target: Target }
  | { action: "fill"; reason: string; target: Target; inputRef: string }
  | { action: "wait"; reason: string; waitMs: number }
  | { action: "finish" | "request_human"; reason: string };

function nonEmpty(value: string | null, field: string): string {
  if (!value?.trim()) throw new Error(`${field} is required for this action`);
  return value.trim();
}

function targetFromProposal(value: z.infer<typeof TargetProposal> | null): Target {
  if (!value) throw new Error("A target is required for this action");
  const frame = value.frameTitle?.trim() ? { title: value.frameTitle.trim() } : undefined;
  let candidate: Target["candidates"][number];
  switch (value.kind) {
    case "role":
      candidate = { kind: "role", role: nonEmpty(value.role, "target.role"), name: nonEmpty(value.name, "target.name"),
        ...(value.withinText?.trim() ? { withinText: value.withinText.trim() } : {}) };
      break;
    case "label":
      candidate = { kind: "label", text: nonEmpty(value.name, "target.name") };
      break;
    case "text":
      candidate = { kind: "text", text: nonEmpty(value.name, "target.name"),
        ...(value.withinText?.trim() ? { withinText: value.withinText.trim() } : {}) };
      break;
    case "table_value":
      candidate = { kind: "table_value", rowHeader: nonEmpty(value.rowHeader, "target.rowHeader") };
  }
  return TargetSchema.parse({ ...(frame ? { frame } : {}), candidates: [candidate] });
}

export function parseDecision(value: unknown): DiscoveryDecision {
  const raw = RawDecision.parse(value);
  switch (raw.action) {
    case "navigate": return { action: raw.action, reason: raw.reason, url: nonEmpty(raw.url, "url") };
    case "click":
    case "read": return { action: raw.action, reason: raw.reason, target: targetFromProposal(raw.target) };
    case "fill": return { action: raw.action, reason: raw.reason, target: targetFromProposal(raw.target), inputRef: nonEmpty(raw.inputRef, "inputRef") };
    case "wait":
      if (raw.waitMs === null || raw.waitMs < 100 || raw.waitMs > 5000) throw new Error("waitMs must be 100–5000");
      return { action: raw.action, reason: raw.reason, waitMs: raw.waitMs };
    case "finish":
    case "request_human": return { action: raw.action, reason: raw.reason };
  }
}

export const decisionTool: FunctionTool = {
  type: "function",
  name: "propose_action",
  description: "Propose exactly one UI action for the current observed browser state. All unused fields must be null. Give a short observable reason, not private reasoning.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["action", "reason", "target", "inputRef", "url", "waitMs"],
    properties: {
      action: { type: "string", enum: ["navigate", "click", "fill", "read", "wait", "finish", "request_human"] },
      reason: { type: "string" },
      target: {
        anyOf: [
          { type: "object", additionalProperties: false, required: ["kind", "role", "name", "withinText", "frameTitle", "rowHeader"], properties: {
            kind: { type: "string", enum: ["role", "label", "text", "table_value"] },
            role: { type: ["string", "null"] }, name: { type: ["string", "null"] },
            withinText: { type: ["string", "null"] }, frameTitle: { type: ["string", "null"] },
            rowHeader: { type: ["string", "null"] },
          } },
          { type: "null" },
        ],
      },
      inputRef: { type: ["string", "null"] }, url: { type: ["string", "null"] },
      waitMs: { type: ["integer", "null"] },
    },
  },
};
