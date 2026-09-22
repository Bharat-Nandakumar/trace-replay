import type { Page } from "playwright";
import { SessionControl } from "../core/control.js";
import type { HandoffHandler, HandoffResolution } from "./types.js";

type Emit = (event: Record<string, unknown>) => Promise<void>;

export async function conductHandoff(options: {
  session: SessionControl;
  handler?: HandoffHandler;
  page: Page;
  requestId: string;
  reason: string;
  stepId?: string;
  code: string;
  emit: Emit;
  revalidate: () => Promise<boolean>;
}): Promise<HandoffResolution> {
  options.session.pause(options.reason);
  await options.emit({ event: "intervention_requested", requestId: options.requestId, stepId: options.stepId,
    code: options.code, reason: options.reason });
  if (!options.handler) return "unavailable";

  let accepted = false;
  const accept = async (): Promise<void> => {
    if (accepted) throw new Error("Intervention was already accepted");
    options.session.takeHumanControl(options.handler!.operatorId);
    accepted = true;
    await options.emit({ event: "intervention_accepted", requestId: options.requestId,
      stepId: options.stepId, operatorId: options.handler!.operatorId });
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), options.handler!.timeoutMs);
  });
  let outcome: "resume" | "abort" | "timeout";
  try {
    outcome = await Promise.race([
      options.handler.handle({ requestId: options.requestId, reason: options.reason,
        stepId: options.stepId, page: options.page, accept }),
      timeout,
    ]);
  } catch (error) {
    await options.emit({ event: "handoff_handler_failed", requestId: options.requestId,
      reason: error instanceof Error ? error.message : String(error) });
    return "invalid";
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (outcome === "timeout") {
    await options.emit({ event: "handoff_timed_out", requestId: options.requestId,
      timeoutMs: options.handler.timeoutMs, accepted });
    return "timeout";
  }
  if (outcome === "abort") {
    await options.emit({ event: "handoff_aborted", requestId: options.requestId,
      operatorId: options.handler.operatorId, accepted });
    return "aborted";
  }
  if (!accepted || options.session.owner !== "human") {
    await options.emit({ event: "handoff_invalid", requestId: options.requestId,
      reason: "Resume was requested before the operator accepted control" });
    return "invalid";
  }

  options.session.resume(options.handler.operatorId);
  await options.emit({ event: "handoff_resumed", requestId: options.requestId,
    stepId: options.stepId, operatorId: options.handler.operatorId });
  const valid = await options.revalidate();
  await options.emit({ event: "handoff_revalidated", requestId: options.requestId,
    stepId: options.stepId, verified: valid });
  return valid ? "resumed" : "unresolved";
}
