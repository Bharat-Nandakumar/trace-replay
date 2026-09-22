import { createHash } from "node:crypto";
import {
  assertNoSensitiveLiterals,
  parseArtifact,
  TargetSchema,
  type CapabilityArtifact,
  type CapabilityStep,
  type Target,
} from "../core/artifact.js";
import type { CompilationProfile } from "./profile.js";

type JsonObject = Record<string, unknown>;
type TraceAction =
  | { action: "navigate"; url: string }
  | { action: "fill"; target: Target; inputRef: string }
  | { action: "click" | "read"; target: Target };

export class CompilationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompilationError";
  }
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CompilationError(`${label} must be an object`);
  return value as JsonObject;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new CompilationError(`${label} must be a non-empty string`);
  return value;
}

function parseJsonl(content: string): JsonObject[] {
  const lines = content.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) throw new CompilationError("Discovery log is empty");
  return lines.map((line, index) => {
    try {
      return object(JSON.parse(line), `Log line ${index + 1}`);
    } catch (error) {
      if (error instanceof CompilationError) throw error;
      throw new CompilationError(`Log line ${index + 1} is not valid JSON`);
    }
  });
}

function parseTraceAction(value: unknown): TraceAction | null {
  const decision = object(value, "Model decision");
  const action = string(decision.action, "Model decision action");
  if (["finish", "wait"].includes(action)) return null;
  if (action === "request_human") throw new CompilationError("A human-intervention decision cannot be compiled into unattended replay");
  if (action === "navigate") return { action, url: string(decision.url, "Navigation URL") };
  if (action === "fill") {
    return {
      action,
      target: TargetSchema.parse(decision.target),
      inputRef: string(decision.inputRef, "Fill inputRef"),
    };
  }
  if (action === "click" || action === "read") return { action, target: TargetSchema.parse(decision.target) };
  throw new CompilationError(`Unsupported discovery action: ${action}`);
}

function extractSuccessfulActions(events: JsonObject[]): TraceAction[] {
  const final = events.at(-1);
  if (final?.event !== "run_finished" || object(final.result, "Final result").status !== "success") {
    throw new CompilationError("Only a successful discovery run can be compiled");
  }
  if (!events.some((event) => event.event === "completion_check" && event.verified === true)) {
    throw new CompilationError("Discovery has no verified successful completion");
  }

  const actions: TraceAction[] = [];
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (event.event !== "model_decision") continue;
    const action = parseTraceAction(object(event.decision, "Model decision"));
    if (!action) continue;
    const nextDecision = events.findIndex((candidate, candidateIndex) => candidateIndex > index && candidate.event === "model_decision");
    const end = nextDecision === -1 ? events.length : nextDecision;
    const segment = events.slice(index + 1, end);
    if (!segment.some((candidate) => candidate.event === "policy_decision" && object(candidate.decision, "Policy decision").kind === "allow")) {
      throw new CompilationError(`Discovery action ${actions.length + 1} has no allowed policy decision`);
    }
    if (!segment.some((candidate) => candidate.event === "action_result")) {
      throw new CompilationError(`Discovery action ${actions.length + 1} has no successful action result`);
    }
    if ("target" in action && !segment.some((candidate) => candidate.event === "target_resolved")) {
      throw new CompilationError(`Discovery action ${actions.length + 1} has no unique target resolution`);
    }
    if (segment.some((candidate) => candidate.event === "action_failed")) {
      throw new CompilationError(`Discovery action ${actions.length + 1} failed and cannot be compiled`);
    }
    actions.push(action);
  }
  if (!actions.length) throw new CompilationError("Discovery contains no successfully executed actions");
  return actions;
}

export type CompileCapabilityOptions = {
  logContent: string;
  profile: CompilationProfile;
  sensitiveValues: readonly string[];
  compiledAt?: string;
};

export function compileCapability(options: CompileCapabilityOptions): CapabilityArtifact {
  const events = parseJsonl(options.logContent);
  const actions = extractSuccessfulActions(events);
  if (actions.length !== options.profile.stepReviews.length) {
    throw new CompilationError(`Profile reviews ${options.profile.stepReviews.length} steps but discovery executed ${actions.length}`);
  }
  const started = events.find((event) => event.event === "run_started");
  if (!started) throw new CompilationError("Discovery has no run_started event");
  const model = object(started.model, "Discovery model metadata");
  const compiledAt = options.compiledAt ?? new Date().toISOString();

  const steps: CapabilityStep[] = actions.map((action, index) => {
    const review = options.profile.stepReviews[index];
    const base = { id: review.id, description: review.description, risk: review.risk };
    if (action.action === "fill") {
      if (review.output || review.parser) throw new CompilationError(`Non-read step ${review.id} cannot declare an output`);
      return { ...base, action: "fill", target: action.target, value: { inputRef: action.inputRef }, ...(review.after ? { after: review.after } : {}) };
    }
    if (action.action === "click") {
      if (review.output || review.parser) throw new CompilationError(`Non-read step ${review.id} cannot declare an output`);
      return { ...base, action: "click", target: action.target, ...(review.after ? { after: review.after } : {}) };
    }
    if (action.action === "read") {
      if (review.after) throw new CompilationError(`Read step ${review.id} cannot declare an after checkpoint`);
      if (!review.output || !review.parser) throw new CompilationError(`Read step ${review.id} requires output and parser review`);
      return { ...base, action: "read", target: action.target, output: review.output, parser: review.parser };
    }
    if (action.action !== "navigate") throw new CompilationError(`Unsupported compiled action for ${review.id}`);
    if (review.output || review.parser) throw new CompilationError(`Navigation step ${review.id} cannot declare an output`);
    const url = new URL(action.url);
    return { ...base, action: "navigate", path: `${url.pathname}${url.search}`, ...(review.after ? { after: review.after } : {}) };
  });

  const candidate = {
    schemaVersion: options.profile.schemaVersion,
    id: options.profile.id,
    version: options.profile.version,
    name: options.profile.name,
    description: options.profile.description,
    compatibility: options.profile.compatibility,
    inputs: options.profile.inputs,
    outputs: options.profile.outputs,
    steps,
    success: options.profile.success,
    businessOutcomes: options.profile.businessOutcomes,
    ...(options.profile.runtimeConditions ? { runtimeConditions: options.profile.runtimeConditions } : {}),
    provenance: {
      discoverySessionId: string(started.sessionId, "Discovery session ID"),
      provider: string(model.provider, "Discovery provider"),
      model: string(model.id, "Discovery model ID"),
      sourceLogSha256: createHash("sha256").update(options.logContent).digest("hex"),
      compiledAt,
    },
  };
  const serialized = JSON.stringify(candidate);
  if (serialized.includes("[REDACTED]")) throw new CompilationError("Generated artifact contains an unresolved redaction marker");
  const artifact = parseArtifact(candidate);
  assertNoSensitiveLiterals(artifact, options.sensitiveValues);
  return artifact;
}
