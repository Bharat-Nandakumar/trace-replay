import { z } from "zod";

const OutputValueSchema = z.union([
  z.string(),
  z.boolean(),
  z.strictObject({ amount: z.string().regex(/^-?\d+\.\d{2}$/), currency: z.string().regex(/^[A-Z]{3}$/) }),
]);

export const RunResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("success"),
    capabilityId: z.string().min(1),
    outputs: z.record(z.string(), OutputValueSchema),
  }),
  z.strictObject({
    status: z.literal("business_outcome"),
    capabilityId: z.string().min(1),
    code: z.string().min(1),
    stepId: z.string().optional(),
  }),
  z.strictObject({
    status: z.literal("failure"),
    capabilityId: z.string().min(1),
    code: z.string().min(1),
    stepId: z.string().optional(),
    expected: z.string().min(1),
    observed: z.string().min(1),
    evidenceRef: z.string().optional(),
  }),
  z.strictObject({
    status: z.literal("intervention_required"),
    capabilityId: z.string().min(1),
    requestId: z.string().min(1),
    stepId: z.string().optional(),
    reason: z.string().min(1),
    evidenceRef: z.string().optional(),
  }),
]);
export type RunResult = z.infer<typeof RunResultSchema>;

export type RecoveryEvent = {
  stepId: string;
  condition: string;
  attempt: number;
  action: string;
  at: string;
};
