import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, open } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { validateDeclaredOutputs, validateInvocationInputs, type CapabilityArtifact, type Condition, type OutputValue, type RuntimeCondition } from "../core/artifact.js";
import { SessionControl } from "../core/control.js";
import { evaluateAction, evaluateUrl, executeWithPolicy, PolicyBlockError, requireAllowedRequest, type ActionIntent, type Policy } from "../core/policy.js";
import { redactForEvidence } from "../core/redaction.js";
import type { RunResult } from "../core/results.js";
import { requireUniqueTarget, TargetResolutionError } from "../core/surface.js";
import { PlaywrightSurface } from "../surfaces/playwright.js";
import { installHumanActionAudit } from "../handoff/browser-audit.js";
import { conductHandoff } from "../handoff/coordinator.js";
import type { HandoffHandler } from "../handoff/types.js";

export type ReplayOptions = {
  artifact: CapabilityArtifact;
  artifactSha256: string;
  inputs: Record<string, unknown>;
  baseOrigin: string;
  entryUrl?: string;
  policy: Policy;
  logPath: string;
  executablePath?: string;
  checkpointTimeoutMs?: number;
  handoff?: HandoffHandler;
  headed?: boolean;
};

export type ReplayExecution = { result: RunResult; logPath: string };

function evidenceReference(path: string): string {
  const projectRelative = relative(process.cwd(), path);
  return projectRelative && !projectRelative.startsWith("..") ? projectRelative : path;
}

function scrubEvidence(value: unknown, sensitiveValues: readonly string[]): unknown {
  function scrub(item: unknown): unknown {
    if (typeof item === "string") {
      return item.replace(/\$\s*-?\d[\d,]*\.\d{2}\s*USD/gi, "[REDACTED MONEY]").replace(/\bSAV-\d+\b/g, "[REDACTED ACCOUNT]");
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

function failureCategory(error: unknown): "possible_drift" | "policy" | "execution" {
  if (error instanceof PolicyBlockError) return "policy";
  if (error instanceof TargetResolutionError) return "possible_drift";
  return "execution";
}

export async function runReplay(options: ReplayOptions): Promise<ReplayExecution> {
  const checkpointTimeoutMs = options.checkpointTimeoutMs ?? 10_000;
  const session = new SessionControl(randomUUID());
  const sensitiveValues = Object.values(options.inputs).filter((value): value is string => typeof value === "string" && Boolean(value));
  const outputs: Record<string, OutputValue> = {};
  const observedMarkers = new Set<string>();
  const recoveryAttempts = new Map<string, number>();
  let browser: Browser | undefined;
  let page: Page | undefined;
  let surface: PlaywrightSurface | undefined;
  let requestViolation: string | undefined;
  let dialogViolation: string | undefined;
  let currentStepId: string | undefined;
  let activeInterventionRequestId: string | undefined;
  await mkdir(dirname(options.logPath), { recursive: true });
  await (await open(options.logPath, "wx", 0o600)).close();

  const emit = async (value: unknown): Promise<void> => {
    await appendFile(options.logPath, `${JSON.stringify(scrubEvidence({ at: new Date().toISOString(), ...value as object }, sensitiveValues))}\n`, { mode: 0o600 });
  };
  const terminal = async (result: RunResult): Promise<ReplayExecution> => {
    const actor = session.owner === "human" ? options.handoff?.operatorId ?? "operator"
      : session.owner === "paused" ? "handoff-coordinator" : "automation";
    session.finish(actor, result.status);
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
  const diagnosticEvidence = async (condition: RuntimeCondition): Promise<string> => {
    const observed = surface ? await surface.captureFailureEvidence().catch(() => "Evidence unavailable") : "Browser did not start";
    let screenshotRef: string | undefined;
    if (condition.classification === "failure" && condition.captureScreenshot && page) {
      const screenshotPath = options.logPath.replace(/\.jsonl$/i, "") + `-${condition.code.toLowerCase()}.png`;
      await page.screenshot({ path: screenshotPath, type: "png", fullPage: false });
      await chmod(screenshotPath, 0o600);
      screenshotRef = evidenceReference(screenshotPath);
    }
    await emit({ event: "diagnostic_evidence", stepId: currentStepId, code: condition.code,
      expected: currentStepId ? `Complete step ${currentStepId}` : "Start replay",
      observedUrl: page?.url(), observed, screenshotRef });
    return screenshotRef ?? evidenceReference(options.logPath);
  };
  const handleRuntimeConditions = async (): Promise<RunResult | undefined> => {
    if (!surface || !page) return undefined;
    for (const condition of options.artifact.runtimeConditions ?? []) {
      if (!await conditionSatisfied(surface, condition.when)) continue;
      await emit({ event: "runtime_condition_detected", stepId: currentStepId, code: condition.code,
        classification: condition.classification, currentUrl: page.url() });
      if (condition.classification === "recoverable") {
        const attempt = (recoveryAttempts.get(condition.code) ?? 0) + 1;
        recoveryAttempts.set(condition.code, attempt);
        if (attempt > condition.recovery.maxAttempts) {
          const evidenceRef = await diagnosticEvidence(condition);
          return { status: "failure", capabilityId: options.artifact.id, category: "runtime", code: `${condition.code}_RECOVERY_EXHAUSTED`,
            stepId: currentStepId, expected: `${condition.description} to clear within ${condition.recovery.timeoutMs}ms`,
            observed: `Recovery budget of ${condition.recovery.maxAttempts} attempt(s) was exhausted`, evidenceRef };
        }
        await emit({ event: "recovery_started", stepId: currentStepId, code: condition.code,
          attempt, action: condition.recovery.action, timeoutMs: condition.recovery.timeoutMs });
        const cleared = await waitForCondition(surface, { kind: "absent", target: condition.when.target }, condition.recovery.timeoutMs);
        await emit({ event: "recovery_finished", stepId: currentStepId, code: condition.code, attempt, recovered: cleared });
        if (!cleared) {
          const evidenceRef = await diagnosticEvidence(condition);
          return { status: "failure", capabilityId: options.artifact.id, category: "runtime", code: `${condition.code}_RECOVERY_TIMEOUT`,
            stepId: currentStepId, expected: `${condition.description} to clear within ${condition.recovery.timeoutMs}ms`,
            observed: "The declared recovery condition remained visible", evidenceRef };
        }
        continue;
      }
      const evidenceRef = await diagnosticEvidence(condition);
      if (condition.classification === "intervention") {
        const requestId = randomUUID();
        activeInterventionRequestId = requestId;
        const resolution = await conductHandoff({
          session, handler: options.handoff, page, requestId, reason: condition.description,
          stepId: currentStepId, code: condition.code, emit,
          revalidate: async () => {
            const currentDecision = evaluateUrl(options.policy, page!.url());
            return currentDecision.kind === "allow" && !await conditionSatisfied(surface!, condition.when);
          },
        });
        activeInterventionRequestId = undefined;
        if (resolution === "resumed") continue;
        if (resolution === "unavailable") {
          return { status: "intervention_required", capabilityId: options.artifact.id, requestId,
            stepId: currentStepId, reason: condition.description, evidenceRef };
        }
        const code = resolution === "aborted" ? "OPERATOR_ABORTED"
          : resolution === "timeout" ? "HANDOFF_TIMEOUT"
          : resolution === "unresolved" ? "INTERVENTION_UNRESOLVED" : "HANDOFF_INVALID";
        return { status: "failure", capabilityId: options.artifact.id, category: "intervention", code,
          stepId: currentStepId, expected: `${condition.description} to be resolved in the same browser session`,
          observed: `Handoff ended with ${resolution}`, evidenceRef };
      }
      return { status: "failure", capabilityId: options.artifact.id, category: condition.failureCategory, code: condition.code,
        stepId: currentStepId, expected: currentStepId ? `Complete step ${currentStepId}` : "Start replay",
        observed: condition.description, evidenceRef };
    }
    return undefined;
  };
  const detectTerminalState = async (): Promise<RunResult | undefined> => {
    const businessCode = await detectBusinessOutcome();
    if (businessCode) return { status: "business_outcome", capabilityId: options.artifact.id, code: businessCode, stepId: currentStepId };
    return handleRuntimeConditions();
  };

  try {
    const validation = validateInvocationInputs(options.artifact, options.inputs);
    await emit({ event: "run_started", mode: "replay", decisionSource: "artifact", modelCalls: 0,
      capabilityId: options.artifact.id, capabilityVersion: options.artifact.version,
      artifactSha256: options.artifactSha256, inputNames: Object.keys(options.inputs), entryUrl: options.entryUrl });
    await emit({ event: "input_validation", valid: validation.ok, code: validation.ok ? undefined : validation.code, field: validation.ok ? undefined : validation.field });
    if (!validation.ok) return terminal({ status: "business_outcome", capabilityId: options.artifact.id, code: validation.code });

    const base = new URL(options.baseOrigin);
    if (base.origin !== base.toString().replace(/\/$/, "")) throw new Error("Replay base origin must not include a path");
    const defaultEntryUrl = new URL(options.artifact.compatibility.entryPath, base);
    const entry = new URL(options.entryUrl ?? defaultEntryUrl.toString());
    if (entry.origin !== base.origin || entry.pathname !== options.artifact.compatibility.entryPath) {
      throw new Error("Entry URL override must use the replay origin and artifact entry path");
    }
    const entryDecision = evaluateUrl(options.policy, entry.toString());
    if (entryDecision.kind !== "allow") throw new PolicyBlockError(entryDecision);
    browser = await chromium.launch({ headless: !(options.headed ?? Boolean(options.handoff)), executablePath: options.executablePath });
    const context = await browser.newContext({ viewport: { width: 1100, height: 800 }, serviceWorkers: "block" });
    page = await context.newPage();
    const livePage = page;
    surface = new PlaywrightSurface(livePage);
    if (options.handoff) await installHumanActionAudit(context, livePage, session, emit, () => activeInterventionRequestId);
    await context.route("**/*", async (route) => {
      try {
        if (session.owner === "human" && route.request().isNavigationRequest()) {
          await emit({ event: "human_action", requestId: activeInterventionRequestId,
            operatorId: options.handoff?.operatorId, action: "navigate",
            method: route.request().method(), url: route.request().url(), source: "browser_request" });
        }
        requireAllowedRequest(options.policy, route.request().url());
        await route.continue();
      } catch (error) {
        requestViolation = error instanceof Error ? error.message : String(error);
        if (session.owner === "human") {
          await emit({ event: "human_request_blocked", requestId: activeInterventionRequestId,
            operatorId: options.handoff?.operatorId, url: route.request().url(), reason: requestViolation });
        }
        await route.abort("blockedbyclient").catch(() => {});
      }
    });
    livePage.on("popup", (popup) => { requestViolation = "Unexpected popup"; void popup.close(); });
    livePage.on("dialog", (dialog) => { dialogViolation = `Unexpected browser dialog: ${dialog.type()}`; void dialog.dismiss(); });

    const entryIntent: ActionIntent = { mode: "replay", type: "navigate", currentUrl: "about:blank", destinationUrl: entry.toString() };
    await emit({ event: "policy_decision", stepId: "entry", decision: evaluateAction(options.policy, entryIntent) });
    await executeWithPolicy(options.policy, session, entryIntent, () => livePage.goto(entry.toString(), { waitUntil: "domcontentloaded", timeout: 15_000 }));
    if (requestViolation) throw new Error(requestViolation);
    await observeMarkers();

    for (const step of options.artifact.steps) {
      currentStepId = step.id;
      const beforeStep = await detectTerminalState();
      if (beforeStep) return terminal(beforeStep);
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
        let resolved;
        try {
          resolved = await requireUniqueTarget(surface, step.target);
        } catch (error) {
          const knownState = await detectTerminalState();
          if (knownState) return terminal(knownState);
          throw error;
        }
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
      const runtimeResult = await detectTerminalState();
      if (runtimeResult) return terminal(runtimeResult);
      if ("after" in step && step.after) {
        const verified = await waitForCondition(surface, step.after, checkpointTimeoutMs);
        await emit({ event: "checkpoint", stepId: step.id, verified });
        if (!verified) {
          const knownState = await detectTerminalState();
          if (knownState) return terminal(knownState);
          throw new Error("Step checkpoint did not become true");
        }
      }
      await observeMarkers();
      await emit({ event: "step_finished", stepId: step.id, outputs });
    }

    const finalState = await detectTerminalState();
    if (finalState) return terminal(finalState);
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
    await emit({ event: "replay_failed", stepId: currentStepId, reason, observed, category: failureCategory(error), currentUrl: page?.url() });
    const code = error instanceof PolicyBlockError ? error.decision.code : error instanceof TargetResolutionError ? error.code : "REPLAY_FAILED";
    const resultObserved = error instanceof TargetResolutionError ? error.observed : reason;
    return terminal({ status: "failure", capabilityId: options.artifact.id, category: failureCategory(error), code, stepId: currentStepId,
      expected: currentStepId ? `Complete step ${currentStepId}` : "Start replay", observed: resultObserved, evidenceRef: evidenceReference(options.logPath) });
  } finally {
    await page?.context().close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}
