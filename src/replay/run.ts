import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import {
  validateDeclaredOutputs,
  validateInvocationInputs,
  type CapabilityArtifact,
  type Condition,
  type OutputValue,
} from "../core/artifact.js";
import { SessionControl } from "../core/control.js";
import {
  evaluateAction,
  evaluateUrl,
  executeWithPolicy,
  PolicyBlockError,
  requireAllowedRequest,
  type ActionIntent,
  type Policy,
} from "../core/policy.js";
import { redactForEvidence } from "../core/redaction.js";
import type { RunResult } from "../core/results.js";
import { requireUniqueTarget, TargetResolutionError } from "../core/surface.js";
import { PlaywrightSurface } from "../surfaces/playwright.js";

export type ReplayOptions = {
  artifact: CapabilityArtifact;
  artifactSha256: string;
  inputs: Record<string, unknown>;
  baseOrigin: string;
  policy: Policy;
  logPath: string;
  executablePath?: string;
  checkpointTimeoutMs?: number;
};

export type ReplayExecution = { result: RunResult; logPath: string };

function scrubEvidence(value: unknown, sensitiveValues: readonly string[]): unknown {
  function scrub(item: unknown): unknown {
    if (typeof item === "string") {
      return item
        .replace(/\$\s*-?\d[\d,]*\.\d{2}\s*USD/gi, "[REDACTED MONEY]")
        .replace(/\bSAV-\d+\b/g, "[REDACTED ACCOUNT]");
    }
    if (Array.isArray(item)) return item.map(scrub);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, scrub(entry)]));
    return item;
  }
  return scrub(redactForEvidence(value, sensitiveValues));
}

async function conditionSatisfied(surface: PlaywrightSurface, condition: Condition): Promise<boolean> {
  const resolution = await surface.resolve(condition.target);
  if (condition.kind === "absent") return resolution.status === "missing";
  if (resolution.status === "ambiguous") throw new TargetResolutionError("TARGET_AMBIGUOUS", resolution.observed);
  return resolution.status === "unique" && await resolution.handle.isVisible().catch(() => false);
}

async function waitForCondition(surface: PlaywrightSurface, condition: Condition, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await conditionSatisfied(surface, condition)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  return false;
}

function parseOutput(raw: string, parser: "text" | "money" | "boolean"): OutputValue {
  if (parser === "text") return raw.trim();
  if (parser === "boolean") {
    if (/^true$/i.test(raw.trim())) return true;
    if (/^false$/i.test(raw.trim())) return false;
    throw new Error(`Cannot parse boolean output from ${JSON.stringify(raw)}`);
  }
  const match = /^\$\s*(-?\d[\d,]*\.\d{2})\s+([A-Z]{3})$/.exec(raw.trim());
  if (!match) throw new Error("Money output does not match '$0.00 USD'");
  return { amount: match[1].replaceAll(",", ""), currency: match[2] };
}

export async function runReplay(options: ReplayOptions): Promise<ReplayExecution> {
  const checkpointTimeoutMs = options.checkpointTimeoutMs ?? 10_000;
  const session = new SessionControl(randomUUID());
  const sensitiveValues = Object.values(options.inputs).filter((value): value is string => typeof value === "string" && Boolean(value));
  const outputs: Record<string, OutputValue> = {};
  const observedMarkers = new Set<string>();
  let browser: Browser | undefined;
  let page: Page | undefined;
  let surface: PlaywrightSurface | undefined;
  let requestViolation: string | undefined;
  let dialogViolation: string | undefined;
  let currentStepId: string | undefined;
  await mkdir(dirname(options.logPath), { recursive: true });
  await (await open(options.logPath, "wx", 0o600)).close();
  const emit = async (value: unknown): Promise<void> => {
    await appendFile(options.logPath, `${JSON.stringify(scrubEvidence({ at: new Date().toISOString(), ...value as object }, sensitiveValues))}\n`, { mode: 0o600 });
  };
  const terminal = async (result: RunResult): Promise<ReplayExecution> => {
    session.finish("automation", result.status);
    await emit({ event: "run_finished", result, controlEvents: session.events, modelCalls: 0 });
    return { result, logPath: options.logPath };
  };
  const observeMarkers = async (): Promise<void> => {
    if (!surface) return;
    const observation = await surface.observe();
    for (const marker of options.artifact.compatibility.requiredMarkers) {
      if (`${observation.visibleText}\n${observation.accessibilitySummary ?? ""}`.includes(marker)) observedMarkers.add(marker);
    }
  };
  const detectBusinessOutcome = async (): Promise<string | undefined> => {
    if (!surface) return undefined;
    for (const outcome of options.artifact.businessOutcomes) {
      if (await conditionSatisfied(surface, outcome.when)) return outcome.code;
    }
    return undefined;
  };

  try {
    const validation = validateInvocationInputs(options.artifact, options.inputs);
    await emit({ event: "run_started", mode: "replay", decisionSource: "artifact", modelCalls: 0,
      capabilityId: options.artifact.id, capabilityVersion: options.artifact.version,
      artifactSha256: options.artifactSha256, inputNames: Object.keys(options.inputs) });
    await emit({ event: "input_validation", valid: validation.ok, code: validation.ok ? undefined : validation.code, field: validation.ok ? undefined : validation.field });
    if (!validation.ok) {
      return terminal({ status: "business_outcome", capabilityId: options.artifact.id, code: validation.code });
    }

    const base = new URL(options.baseOrigin);
    if (base.origin !== base.toString().replace(/\/$/, "")) throw new Error("Replay base origin must not include a path");
    const entryUrl = new URL(options.artifact.compatibility.entryPath, base).toString();
    const entryDecision = evaluateUrl(options.policy, entryUrl);
    if (entryDecision.kind !== "allow") throw new PolicyBlockError(entryDecision);
    browser = await chromium.launch({ headless: true, executablePath: options.executablePath });
    const context = await browser.newContext({ viewport: { width: 1100, height: 800 }, serviceWorkers: "block" });
    page = await context.newPage();
    const livePage = page;
    surface = new PlaywrightSurface(livePage);
    await context.route("**/*", async (route) => {
      try {
        requireAllowedRequest(options.policy, route.request().url());
        await route.continue();
      } catch (error) {
        requestViolation = error instanceof Error ? error.message : String(error);
        await route.abort("blockedbyclient").catch(() => {});
      }
    });
    livePage.on("popup", (popup) => { requestViolation = "Unexpected popup"; void popup.close(); });
    livePage.on("dialog", (dialog) => { dialogViolation = `Unexpected browser dialog: ${dialog.type()}`; void dialog.dismiss(); });

    const entryIntent: ActionIntent = { mode: "replay", type: "navigate", currentUrl: "about:blank", destinationUrl: entryUrl };
    await emit({ event: "policy_decision", stepId: "entry", decision: evaluateAction(options.policy, entryIntent) });
    await executeWithPolicy(options.policy, session, entryIntent, () => livePage.goto(entryUrl, { waitUntil: "domcontentloaded", timeout: 15_000 }));
    if (requestViolation) throw new Error(requestViolation);
    await observeMarkers();

    for (const step of options.artifact.steps) {
      currentStepId = step.id;
      await emit({ event: "step_started", stepId: step.id, action: step.action, description: step.description });
      if (step.action === "navigate") {
        const destinationUrl = new URL(step.path, livePage.url()).toString();
        const intent: ActionIntent = { mode: "replay", type: "navigate", currentUrl: livePage.url(), destinationUrl, declaredRisk: step.risk };
        await emit({ event: "policy_decision", stepId: step.id, decision: evaluateAction(options.policy, intent) });
        await executeWithPolicy(options.policy, session, intent, () => livePage.goto(destinationUrl, { waitUntil: "domcontentloaded", timeout: 15_000 }));
      } else if (step.action === "assert") {
        const intent: ActionIntent = { mode: "replay", type: "assert", currentUrl: livePage.url(), declaredRisk: step.risk };
        await emit({ event: "policy_decision", stepId: step.id, decision: evaluateAction(options.policy, intent) });
        await executeWithPolicy(options.policy, session, intent, async () => {
          if (!await waitForCondition(surface!, step.condition, checkpointTimeoutMs)) throw new Error("Assertion condition did not become true");
        });
      } else {
        const resolved = await requireUniqueTarget(surface, step.target);
        await emit({ event: "target_resolved", stepId: step.id, identity: resolved.identity, strategyIndex: resolved.strategyIndex });
        const intent: ActionIntent = { mode: "replay", type: step.action, currentUrl: livePage.url(), control: resolved.identity, declaredRisk: step.risk };
        await emit({ event: "policy_decision", stepId: step.id, decision: evaluateAction(options.policy, intent) });
        await executeWithPolicy(options.policy, session, intent, async () => {
          if (step.action === "fill") await resolved.handle.fill(String(validation.values[step.value.inputRef]), { timeout: 10_000 });
          if (step.action === "click") await resolved.handle.click({ timeout: 10_000 });
          if (step.action === "read") {
            const raw = await surface!.read(resolved.handle);
            const parsed = parseOutput(raw, step.parser);
            outputs[step.output] = parsed;
            sensitiveValues.push(raw);
            if (typeof parsed === "object" && "amount" in parsed) sensitiveValues.push(parsed.amount);
          }
        });
      }
      if (requestViolation) throw new Error(requestViolation);
      if (dialogViolation) throw new Error(dialogViolation);
      if ("after" in step && step.after) {
        const verified = await waitForCondition(surface, step.after, checkpointTimeoutMs);
        await emit({ event: "checkpoint", stepId: step.id, verified });
        if (!verified) throw new Error("Step checkpoint did not become true");
      }
      await observeMarkers();
      await emit({ event: "step_finished", stepId: step.id, outputs });
      const businessCode = await detectBusinessOutcome();
      if (businessCode) return terminal({ status: "business_outcome", capabilityId: options.artifact.id, code: businessCode, stepId: step.id });
    }

    const success = await waitForCondition(surface, options.artifact.success, checkpointTimeoutMs);
    await emit({ event: "success_check", verified: success });
    if (!success) throw new Error("Final success condition did not become true");
    const missingMarkers = options.artifact.compatibility.requiredMarkers.filter((marker) => !observedMarkers.has(marker));
    await emit({ event: "compatibility_check", verified: missingMarkers.length === 0, missingMarkers });
    if (missingMarkers.length) throw new Error(`Missing compatibility markers: ${missingMarkers.join(", ")}`);
    const validatedOutputs = validateDeclaredOutputs(options.artifact, outputs);
    return terminal({ status: "success", capabilityId: options.artifact.id, outputs: validatedOutputs });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const observed = surface ? await surface.captureFailureEvidence().catch(() => "Evidence unavailable") : "Browser did not start";
    await emit({ event: "replay_failed", stepId: currentStepId, reason, observed });
    const code = error instanceof PolicyBlockError ? error.decision.code
      : error instanceof TargetResolutionError ? error.code : "REPLAY_FAILED";
    return terminal({ status: "failure", capabilityId: options.artifact.id, code, stepId: currentStepId,
      expected: currentStepId ? `Complete step ${currentStepId}` : "Start replay", observed: reason, evidenceRef: options.logPath });
  } finally {
    await page?.context().close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}
