import type { CapabilityStep, Target } from "./artifact.js";
import type { ControlIdentity } from "./policy.js";

export type SurfaceObservation = {
  location: string;
  visibleText: string;
  accessibilitySummary?: string;
  screenshotRef?: string;
};

export type TargetResolution<Handle> =
  | { status: "unique"; handle: Handle; identity: ControlIdentity; strategyIndex: number }
  | { status: "missing"; observed: string }
  | { status: "ambiguous"; matches: number; observed: string };

/** The handle remains private to a surface implementation (Playwright locator, OS element, etc.). */
export interface SurfaceAdapter<Handle> {
  observe(): Promise<SurfaceObservation>;
  resolve(target: Target): Promise<TargetResolution<Handle>>;
  perform(step: CapabilityStep, handle?: Handle, inputValue?: string | number | boolean): Promise<void>;
  read(handle: Handle): Promise<string>;
  captureFailureEvidence(): Promise<string>;
}

export class TargetResolutionError extends Error {
  readonly code: "TARGET_NOT_FOUND" | "TARGET_AMBIGUOUS";
  readonly observed: string;

  constructor(code: "TARGET_NOT_FOUND" | "TARGET_AMBIGUOUS", observed: string) {
    super(code);
    this.name = "TargetResolutionError";
    this.code = code;
    this.observed = observed;
  }
}

export async function requireUniqueTarget<Handle>(surface: Pick<SurfaceAdapter<Handle>, "resolve">, target: Target): Promise<{
  handle: Handle;
  identity: ControlIdentity;
  strategyIndex: number;
}> {
  const resolution = await surface.resolve(target);
  if (resolution.status === "missing") throw new TargetResolutionError("TARGET_NOT_FOUND", resolution.observed);
  if (resolution.status === "ambiguous") throw new TargetResolutionError("TARGET_AMBIGUOUS", resolution.observed);
  return resolution;
}
