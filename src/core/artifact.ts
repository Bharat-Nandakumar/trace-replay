import { z } from "zod";

const Identifier = z.string().regex(/^[a-z][a-z0-9_]*$/);
const OutcomeCode = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const Version = z.string().regex(/^\d+\.\d+\.\d+$/);
const NonEmpty = z.string().trim().min(1);

const RoleTarget = z.strictObject({
  kind: z.literal("role"),
  role: NonEmpty,
  name: NonEmpty,
  withinText: NonEmpty.optional(),
});
const LabelTarget = z.strictObject({ kind: z.literal("label"), text: NonEmpty });
const TextTarget = z.strictObject({
  kind: z.literal("text"),
  text: NonEmpty,
  withinText: NonEmpty.optional(),
});
const TableValueTarget = z.strictObject({
  kind: z.literal("table_value"),
  rowHeader: NonEmpty,
});

export const TargetSchema = z.strictObject({
  frame: z.strictObject({ title: NonEmpty }).optional(),
  candidates: z.array(z.discriminatedUnion("kind", [RoleTarget, LabelTarget, TextTarget, TableValueTarget])).min(1),
});
export type Target = z.infer<typeof TargetSchema>;

export const ConditionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("visible"), target: TargetSchema }),
  z.strictObject({ kind: z.literal("absent"), target: TargetSchema }),
]);
export type Condition = z.infer<typeof ConditionSchema>;

const RuntimeConditionBase = {
  code: OutcomeCode,
  description: NonEmpty,
  when: ConditionSchema,
};

export const RuntimeConditionSchema = z.discriminatedUnion("classification", [
  z.strictObject({
    ...RuntimeConditionBase,
    classification: z.literal("recoverable"),
    recovery: z.strictObject({
      action: z.literal("wait_until_absent"),
      timeoutMs: z.number().int().positive().max(60_000),
      maxAttempts: z.number().int().positive().max(3),
    }),
  }),
  z.strictObject({
    ...RuntimeConditionBase,
    classification: z.literal("failure"),
    failureCategory: z.literal("runtime"),
    captureScreenshot: z.boolean().optional(),
  }),
  z.strictObject({
    ...RuntimeConditionBase,
    classification: z.literal("intervention"),
  }),
]);
export type RuntimeCondition = z.infer<typeof RuntimeConditionSchema>;

const InputParameterSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("string"),
    description: NonEmpty,
    pattern: NonEmpty.optional(),
    sensitive: z.boolean(),
    invalidOutcomeCode: OutcomeCode.optional(),
  }),
  z.strictObject({
    type: z.literal("integer"),
    description: NonEmpty,
    minimum: z.number().int().optional(),
    maximum: z.number().int().optional(),
    sensitive: z.boolean(),
    invalidOutcomeCode: OutcomeCode.optional(),
  }),
  z.strictObject({
    type: z.literal("boolean"),
    description: NonEmpty,
    sensitive: z.boolean(),
    invalidOutcomeCode: OutcomeCode.optional(),
  }),
]);

const OutputParameterSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("string"), description: NonEmpty, sensitive: z.boolean() }),
  z.strictObject({ type: z.literal("boolean"), description: NonEmpty, sensitive: z.boolean() }),
  z.strictObject({ type: z.literal("money"), description: NonEmpty, currency: z.string().regex(/^[A-Z]{3}$/), sensitive: z.boolean() }),
]);

const StepBase = {
  id: Identifier,
  description: NonEmpty,
  risk: z.enum(["read_only", "reversible", "human_required"]),
};

export const StepSchema = z.discriminatedUnion("action", [
  z.strictObject({ ...StepBase, action: z.literal("navigate"), path: z.string().startsWith("/"), after: ConditionSchema.optional() }),
  z.strictObject({ ...StepBase, action: z.literal("fill"), target: TargetSchema, value: z.strictObject({ inputRef: Identifier }), after: ConditionSchema.optional() }),
  z.strictObject({ ...StepBase, action: z.literal("click"), target: TargetSchema, after: ConditionSchema.optional() }),
  z.strictObject({ ...StepBase, action: z.literal("read"), target: TargetSchema, output: Identifier, parser: z.enum(["text", "money", "boolean"]) }),
  z.strictObject({ ...StepBase, action: z.literal("assert"), condition: ConditionSchema }),
]);
export type CapabilityStep = z.infer<typeof StepSchema>;

export const CapabilityArtifactSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: Identifier,
  version: Version,
  name: NonEmpty,
  description: NonEmpty,
  compatibility: z.strictObject({
    appFamily: Identifier,
    appVersion: NonEmpty,
    entryPath: z.string().startsWith("/"),
    requiredMarkers: z.array(NonEmpty).min(1),
    tenantOverrideId: Identifier.optional(),
  }),
  inputs: z.record(Identifier, InputParameterSchema),
  outputs: z.record(Identifier, OutputParameterSchema),
  steps: z.array(StepSchema).min(1),
  success: ConditionSchema,
  businessOutcomes: z.array(z.strictObject({ code: OutcomeCode, description: NonEmpty, when: ConditionSchema })),
  runtimeConditions: z.array(RuntimeConditionSchema).optional(),
  provenance: z.strictObject({
    discoverySessionId: NonEmpty,
    provider: NonEmpty,
    model: NonEmpty,
    sourceLogSha256: z.string().regex(/^[a-f0-9]{64}$/),
    compiledAt: z.iso.datetime(),
  }).optional(),
});
export type CapabilityArtifact = z.infer<typeof CapabilityArtifactSchema>;

export class ArtifactSemanticError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactSemanticError";
  }
}

export function parseArtifact(value: unknown): CapabilityArtifact {
  const artifact = CapabilityArtifactSchema.parse(value);
  const inputNames = new Set(Object.keys(artifact.inputs));
  const outputNames = new Set(Object.keys(artifact.outputs));
  const stepIds = new Set<string>();
  const readOutputs = new Set<string>();

  if (inputNames.size === 0 || outputNames.size === 0) {
    throw new ArtifactSemanticError("A capability must declare at least one input and one output");
  }

  for (const [name, definition] of Object.entries(artifact.inputs)) {
    if (definition.type === "string" && definition.pattern) {
      try {
        new RegExp(definition.pattern);
      } catch {
        throw new ArtifactSemanticError(`Input ${name} has an invalid regular expression`);
      }
    }
    if (definition.type === "integer" && definition.minimum !== undefined && definition.maximum !== undefined && definition.minimum > definition.maximum) {
      throw new ArtifactSemanticError(`Input ${name} has minimum above maximum`);
    }
  }

  for (const step of artifact.steps) {
    if (stepIds.has(step.id)) throw new ArtifactSemanticError(`Duplicate step ID: ${step.id}`);
    stepIds.add(step.id);
    if (step.action === "fill" && !inputNames.has(step.value.inputRef)) {
      throw new ArtifactSemanticError(`Step ${step.id} references undeclared input ${step.value.inputRef}`);
    }
    if (step.action === "read") {
      const output = artifact.outputs[step.output];
      if (!output) throw new ArtifactSemanticError(`Step ${step.id} references undeclared output ${step.output}`);
      if (readOutputs.has(step.output)) throw new ArtifactSemanticError(`Output ${step.output} is read more than once`);
      if (step.parser !== output.type) {
        throw new ArtifactSemanticError(`Step ${step.id} parser does not match output ${step.output}`);
      }
      readOutputs.add(step.output);
    }
  }

  for (const name of outputNames) {
    if (!readOutputs.has(name)) throw new ArtifactSemanticError(`Output ${name} has no read step`);
  }

  const businessCodes = new Set<string>();
  for (const outcome of artifact.businessOutcomes) {
    if (businessCodes.has(outcome.code)) throw new ArtifactSemanticError(`Duplicate business outcome: ${outcome.code}`);
    businessCodes.add(outcome.code);
  }
  const runtimeCodes = new Set<string>();
  for (const condition of artifact.runtimeConditions ?? []) {
    if (runtimeCodes.has(condition.code) || businessCodes.has(condition.code)) {
      throw new ArtifactSemanticError(`Duplicate outcome or runtime condition: ${condition.code}`);
    }
    runtimeCodes.add(condition.code);
  }
  return artifact;
}

/** The compiler calls this with values seen during discovery before saving an artifact. */
export function assertNoSensitiveLiterals(artifact: CapabilityArtifact, sensitiveValues: readonly string[]): void {
  const serialized = JSON.stringify(artifact);
  for (const value of sensitiveValues) {
    if (value && serialized.includes(value)) {
      throw new ArtifactSemanticError("Artifact contains a discovery-time sensitive value");
    }
  }
}

export type InputValue = string | number | boolean;
export type InvocationInputs = Record<string, InputValue>;
export type InputValidationResult =
  | { ok: true; values: InvocationInputs }
  | { ok: false; code: string; field: string; message: string };

export function validateInvocationInputs(artifact: CapabilityArtifact, provided: Record<string, unknown>): InputValidationResult {
  for (const field of Object.keys(provided)) {
    if (!(field in artifact.inputs)) {
      return { ok: false, code: "INVALID_INPUT", field, message: "Input is not declared by this capability" };
    }
  }

  const values: InvocationInputs = {};
  for (const [field, definition] of Object.entries(artifact.inputs)) {
    const value = provided[field];
    let valid = false;
    if (definition.type === "string") {
      valid = typeof value === "string" && (!definition.pattern || new RegExp(definition.pattern).test(value));
    } else if (definition.type === "integer") {
      valid = typeof value === "number" && Number.isInteger(value)
        && (definition.minimum === undefined || value >= definition.minimum)
        && (definition.maximum === undefined || value <= definition.maximum);
    } else {
      valid = typeof value === "boolean";
    }
    if (!valid) {
      return { ok: false, code: definition.invalidOutcomeCode ?? "INVALID_INPUT", field, message: "Input has the wrong type or format" };
    }
    values[field] = value as InputValue;
  }
  return { ok: true, values };
}

export type MoneyValue = { amount: string; currency: string };
export type OutputValue = string | boolean | MoneyValue;

export function validateDeclaredOutputs(artifact: CapabilityArtifact, provided: Record<string, unknown>): Record<string, OutputValue> {
  const output: Record<string, OutputValue> = {};
  for (const field of Object.keys(provided)) {
    if (!(field in artifact.outputs)) throw new ArtifactSemanticError(`Undeclared output: ${field}`);
  }
  for (const [field, definition] of Object.entries(artifact.outputs)) {
    const value = provided[field];
    if (definition.type === "string" && typeof value === "string") {
      output[field] = value;
    } else if (definition.type === "boolean" && typeof value === "boolean") {
      output[field] = value;
    } else if (definition.type === "money" && typeof value === "object" && value !== null
      && "amount" in value && "currency" in value
      && typeof value.amount === "string" && /^-?\d+\.\d{2}$/.test(value.amount)
      && value.currency === definition.currency) {
      output[field] = { amount: value.amount, currency: value.currency };
    } else {
      throw new ArtifactSemanticError(`Output ${field} does not match its declared type`);
    }
  }
  return output;
}
