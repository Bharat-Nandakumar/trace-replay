import { z } from "zod";
import { type SessionControl } from "./control.js";

export const ActionTypeSchema = z.enum(["navigate", "fill", "click", "read", "assert"]);
export type ActionType = z.infer<typeof ActionTypeSchema>;
export type ExecutionMode = "discovery" | "replay";

export const PolicySchema = z.strictObject({
  version: z.literal(1),
  allowedOrigins: z.array(z.url()).min(1),
  allowedPathPatterns: z.array(z.string().min(1)).min(1),
  deniedPathPatterns: z.array(z.string().min(1)),
  allowedActions: z.array(ActionTypeSchema).min(1),
  humanRequiredControls: z.array(z.strictObject({ role: z.string().min(1), name: z.string().min(1) })),
});
export type Policy = z.infer<typeof PolicySchema>;

export type ControlIdentity = {
  role: string;
  name: string;
  frameTitle?: string;
};

export type ActionIntent = {
  mode: ExecutionMode;
  type: ActionType;
  currentUrl: string;
  destinationUrl?: string;
  control?: ControlIdentity;
  declaredRisk?: "read_only" | "reversible" | "human_required";
};

export type PolicyDecision =
  | { kind: "allow" }
  | { kind: "deny"; code: string; reason: string }
  | { kind: "human_required"; code: string; reason: string };

export class PolicyBlockError extends Error {
  readonly decision: Exclude<PolicyDecision, { kind: "allow" }>;

  constructor(decision: Exclude<PolicyDecision, { kind: "allow" }>) {
    super(`${decision.kind}: ${decision.code}`);
    this.name = "PolicyBlockError";
    this.decision = decision;
  }
}

function compilePathPattern(pattern: string): RegExp {
  if (!pattern.startsWith("^") || !pattern.endsWith("$")) {
    throw new Error("Policy path patterns must be anchored with ^ and $");
  }
  return new RegExp(pattern);
}

export function parsePolicy(value: unknown): Policy {
  const policy = PolicySchema.parse(value);
  for (const origin of policy.allowedOrigins) {
    const parsed = new URL(origin);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== origin) {
      throw new Error("Allowed origins must be exact HTTP(S) origins without a path");
    }
  }
  for (const pattern of [...policy.allowedPathPatterns, ...policy.deniedPathPatterns]) {
    compilePathPattern(pattern);
  }
  return policy;
}

export function evaluateUrl(policy: Policy, rawUrl: string): PolicyDecision {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { kind: "deny", code: "INVALID_URL", reason: "The URL cannot be parsed" };
  }
  if (!policy.allowedOrigins.includes(url.origin)) {
    return { kind: "deny", code: "ORIGIN_NOT_ALLOWED", reason: "Destination origin is outside the allowlist" };
  }
  if (policy.deniedPathPatterns.some((pattern) => compilePathPattern(pattern).test(url.pathname))) {
    return { kind: "deny", code: "ROUTE_DENIED", reason: "Destination route is explicitly denied" };
  }
  if (!policy.allowedPathPatterns.some((pattern) => compilePathPattern(pattern).test(url.pathname))) {
    return { kind: "deny", code: "ROUTE_NOT_ALLOWED", reason: "Destination route is outside the allowlist" };
  }
  return { kind: "allow" };
}

export function evaluateAction(policy: Policy, intent: ActionIntent): PolicyDecision {
  if (!policy.allowedActions.includes(intent.type)) {
    return { kind: "deny", code: "ACTION_NOT_ALLOWED", reason: "Action type is outside the allowlist" };
  }
  if (intent.type !== "navigate" || intent.currentUrl !== "about:blank") {
    const current = evaluateUrl(policy, intent.currentUrl);
    if (current.kind !== "allow") return current;
  }
  if (["click", "fill", "read"].includes(intent.type) && !intent.control) {
    return { kind: "deny", code: "UNVERIFIED_TARGET", reason: "Action requires a resolved control identity" };
  }
  if (intent.declaredRisk === "human_required") {
    return { kind: "human_required", code: "RISKY_ACTION", reason: "This action requires human operation" };
  }
  if (intent.control && policy.humanRequiredControls.some(
    (rule) => rule.role === intent.control?.role && rule.name === intent.control?.name,
  )) {
    return { kind: "human_required", code: "RISKY_CONTROL", reason: "This control requires human operation" };
  }
  if (intent.type === "navigate" && !intent.destinationUrl) {
    return { kind: "deny", code: "MISSING_DESTINATION", reason: "Navigation requires a destination" };
  }
  if (intent.destinationUrl) {
    let destinationUrl: string;
    try {
      destinationUrl = new URL(intent.destinationUrl, intent.currentUrl).toString();
    } catch {
      return { kind: "deny", code: "INVALID_URL", reason: "Destination URL cannot be parsed" };
    }
    const destination = evaluateUrl(policy, destinationUrl);
    if (destination.kind !== "allow") return destination;
  }
  return { kind: "allow" };
}

export function requireAllowedAction(policy: Policy, session: SessionControl, intent: ActionIntent): void {
  session.assertAutomationControl();
  const decision = evaluateAction(policy, intent);
  if (decision.kind !== "allow") throw new PolicyBlockError(decision);
}

export function requireAllowedRequest(policy: Policy, url: string): void {
  const decision = evaluateUrl(policy, url);
  if (decision.kind !== "allow") throw new PolicyBlockError(decision);
}

/** Both discovery and replay call this before handing an action to a surface adapter. */
export async function executeWithPolicy<T>(
  policy: Policy,
  session: SessionControl,
  intent: ActionIntent,
  perform: () => Promise<T>,
): Promise<T> {
  requireAllowedAction(policy, session, intent);
  return perform();
}
