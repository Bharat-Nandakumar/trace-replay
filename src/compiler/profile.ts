import { z } from "zod";
import { CapabilityArtifactSchema, ConditionSchema } from "../core/artifact.js";

const Identifier = z.string().regex(/^[a-z][a-z0-9_]*$/);
const NonEmpty = z.string().trim().min(1);

export const CompilationProfileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: Identifier,
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  name: NonEmpty,
  description: NonEmpty,
  compatibility: CapabilityArtifactSchema.shape.compatibility,
  inputs: CapabilityArtifactSchema.shape.inputs,
  outputs: CapabilityArtifactSchema.shape.outputs,
  stepReviews: z.array(z.strictObject({
    id: Identifier,
    description: NonEmpty,
    risk: z.enum(["read_only", "reversible", "human_required"]),
    after: ConditionSchema.optional(),
    output: Identifier.optional(),
    parser: z.enum(["text", "money", "boolean"]).optional(),
  })).min(1),
  success: ConditionSchema,
  businessOutcomes: CapabilityArtifactSchema.shape.businessOutcomes,
  runtimeConditions: CapabilityArtifactSchema.shape.runtimeConditions,
});

export type CompilationProfile = z.infer<typeof CompilationProfileSchema>;

export function parseCompilationProfile(value: unknown): CompilationProfile {
  return CompilationProfileSchema.parse(value);
}
