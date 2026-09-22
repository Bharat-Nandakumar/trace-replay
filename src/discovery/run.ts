import { randomUUID } from "node:crypto";
import { mkdir, appendFile, open } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { SessionControl } from "../core/control.js";
import { evaluateAction, evaluateUrl, executeWithPolicy, PolicyBlockError, requireAllowedRequest, type ActionIntent, type Policy } from "../core/policy.js";
import { redactForEvidence } from "../core/redaction.js";
import { requireUniqueTarget, TargetResolutionError } from "../core/surface.js";
import type { DecisionSource, ModelObservation } from "./model.js";
import { PlaywrightSurface } from "../surfaces/playwright.js";

export type DiscoveryResult =
  | { status: "success"; readings: string[]; actions: number; logPath: string }
  | { status: "intervention_required"; reason: string; actions: number; logPath: string }
  | { status: "failure"; code: string; reason: string; actions: number; logPath: string };

export type DiscoveryOptions = {
  goal: string;
  entryUrl: string;
  inputs: Record<string, string>;
  policy: Policy;
  model: DecisionSource;
  logPath: string;
  verifyCompletion: (surface: PlaywrightSurface, readings: readonly string[]) => Promise<boolean>;
  executablePath?: string;
  maxActions?: number;
  maxDurationMs?: number;
  redactionValues?: string[];
};

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

async function record(path: string, value: unknown, sensitiveValues: readonly string[]): Promise<void> {
  await appendFile(path, `${JSON.stringify(scrubEvidence(value, sensitiveValues))}\n`, { mode: 0o600 });
}

function observationForLog(observation: ModelObservation): unknown {
  return {
    url: observation.url,
    visibleText: observation.visibleText,
    accessibilitySummary: observation.accessibilitySummary,
    observedLinks: observation.observedLinks,
    screenshot: "sent_to_model_in_memory_not_persisted",
  };
}

export async function runDiscovery(options: DiscoveryOptions): Promise<DiscoveryResult> {
  const maxActions = options.maxActions ?? 15;
  const maxDurationMs = options.maxDurationMs ?? 300_000;
  const started = Date.now();
  const session = new SessionControl(randomUUID());
  const sensitiveValues = [...Object.values(options.inputs).filter(Boolean), ...(options.redactionValues ?? [])];
  const recentActions: string[] = [];
  const readings: string[] = [];
  let actions = 0;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let surface: PlaywrightSurface | undefined;
  let requestViolation: string | undefined;
  let dialogViolation: string | undefined;
  await mkdir(dirname(options.logPath), { recursive: true });
  await (await open(options.logPath, "wx", 0o600)).close();

  const emit = async (value: unknown): Promise<void> => record(options.logPath, { at: new Date().toISOString(), ...value as object }, sensitiveValues);
  const terminate = async (result: DiscoveryResult): Promise<DiscoveryResult> => {
    session.finish("automation", result.status);
    const { logPath: _localPath, ...persistedResult } = result;
    await emit({ event: "run_finished", result: persistedResult, controlEvents: session.events });
    return result;
  };

  try {
    const entryDecision = evaluateUrl(options.policy, options.entryUrl);
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

    await emit({
      event: "run_started",
      goal: options.goal,
      entryUrl: options.entryUrl,
      inputNames: Object.keys(options.inputs),
      sessionId: session.sessionId,
      model: { provider: options.model.provider ?? "custom", id: options.model.model ?? "unspecified" },
      limits: { maxActions, maxDurationMs },
    });
    const entryIntent: ActionIntent = {
      mode: "discovery", type: "navigate", currentUrl: "about:blank", destinationUrl: options.entryUrl,
    };
    await emit({ event: "policy_decision", actionIndex: 0, decision: evaluateAction(options.policy, entryIntent) });
    await executeWithPolicy(options.policy, session, entryIntent, () => livePage.goto(options.entryUrl, { waitUntil: "domcontentloaded", timeout: 15_000 }));
    if (requestViolation) throw new Error(requestViolation);

    let unchangedCount = 0;
    let previousSignature = "";
    while (actions < maxActions && Date.now() - started < maxDurationMs) {
      const observation = await surface.modelObservation();
      const signature = `${observation.url}\n${observation.accessibilitySummary}`;
      unchangedCount = signature === previousSignature ? unchangedCount + 1 : 0;
      previousSignature = signature;
      if (unchangedCount >= 3) {
        session.pause("No visible progress after three decisions");
        return terminate({ status: "intervention_required", reason: "No visible progress after three decisions", actions, logPath: options.logPath });
      }
      await emit({ event: "observation", actionIndex: actions, state: observationForLog(observation) });
      const { decision, usage, responseId } = await options.model.decide({ goal: options.goal, inputNames: Object.keys(options.inputs), observation, recentActions });
      await emit({ event: "model_decision", actionIndex: actions, decision, responseId, usage });
      if (Date.now() - started >= maxDurationMs) {
        return terminate({ status: "failure", code: "TIME_LIMIT", reason: "Discovery exceeded its configured duration", actions, logPath: options.logPath });
      }

      if (decision.action === "request_human") {
        session.pause(decision.reason);
        return terminate({ status: "intervention_required", reason: decision.reason, actions, logPath: options.logPath });
      }
      if (decision.action === "finish") {
        const verified = readings.length > 0 && await options.verifyCompletion(surface, readings);
        await emit({ event: "completion_check", verified, readings });
        if (!verified) {
          recentActions.push("finish rejected: no verified read matched the current live UI; propose the required read action before finish");
          continue;
        }
        return terminate({ status: "success", readings, actions, logPath: options.logPath });
      }

      actions++;
      let actionResult = "completed";
      try {
        if (decision.action === "navigate") {
          const destination = new URL(decision.url, livePage.url()).toString();
          if (destination !== options.entryUrl && !observation.observedLinks.includes(destination)) {
            throw new Error("Navigation URL was not observed in the current page");
          }
          const intent: ActionIntent = {
            mode: "discovery", type: "navigate", currentUrl: livePage.url(), destinationUrl: destination,
          };
          await emit({ event: "policy_decision", actionIndex: actions, decision: evaluateAction(options.policy, intent) });
          await executeWithPolicy(options.policy, session, intent, () => livePage.goto(destination, { waitUntil: "domcontentloaded", timeout: 15_000 }));
        } else if (decision.action === "wait") {
          session.assertAutomationControl();
          const urlDecision = evaluateUrl(options.policy, livePage.url());
          await emit({ event: "policy_decision", actionIndex: actions, decision: urlDecision });
          if (urlDecision.kind !== "allow") throw new PolicyBlockError(urlDecision);
          await livePage.waitForFunction(
            ({ url, text }) => window.location.href !== url || document.body?.innerText !== text,
            { url: observation.url, text: observation.visibleText },
            { timeout: decision.waitMs, polling: 200 },
          ).catch(() => {});
        } else if ("target" in decision) {
          if (decision.action === "click" && decision.target.candidates[0].kind !== "role") {
            throw new Error("Clicks must use an accessible role and name");
          }
          const resolved = await requireUniqueTarget(surface, decision.target);
          await emit({ event: "target_resolved", actionIndex: actions, identity: resolved.identity, strategyIndex: resolved.strategyIndex });
          const inputValue = decision.action === "fill" ? options.inputs[decision.inputRef] : undefined;
          if (decision.action === "fill" && inputValue === undefined) throw new Error(`Unknown inputRef: ${decision.inputRef}`);
          if (decision.action === "click" && !["button", "link"].includes(resolved.identity.role)) {
            throw new Error(`Click target has unsupported role: ${resolved.identity.role}`);
          }
          const intent: ActionIntent = {
            mode: "discovery", type: decision.action, currentUrl: livePage.url(), control: resolved.identity,
          };
          await emit({ event: "policy_decision", actionIndex: actions, decision: evaluateAction(options.policy, intent) });
          await executeWithPolicy(options.policy, session, intent, async () => {
            if (decision.action === "fill") await resolved.handle.fill(inputValue!, { timeout: 10_000 });
            if (decision.action === "click") await resolved.handle.click({ timeout: 10_000 });
            if (decision.action === "read") {
              const value = await surface!.read(resolved.handle);
              readings.push(value);
              sensitiveValues.push(value);
              actionResult = `read ${value}`;
            }
          });
        }
        if (requestViolation) throw new Error(requestViolation);
        if (dialogViolation) throw new Error(dialogViolation);
        const currentUrl = livePage.url();
        const currentDecision = evaluateUrl(options.policy, currentUrl);
        if (currentDecision.kind !== "allow") throw new PolicyBlockError(currentDecision);
        await emit({ event: "action_result", actionIndex: actions, result: actionResult, url: currentUrl });
        recentActions.push(`${decision.action}: ${decision.reason} → ${actionResult}`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const evidence = await surface.captureFailureEvidence().catch(() => "Snapshot unavailable");
        await emit({ event: "action_failed", actionIndex: actions, reason, evidence });
        if (error instanceof PolicyBlockError && error.decision.kind === "human_required") {
          session.pause(reason);
          return terminate({ status: "intervention_required", reason, actions, logPath: options.logPath });
        }
        if (error instanceof TargetResolutionError || dialogViolation) {
          session.pause(reason);
          return terminate({ status: "intervention_required", reason, actions, logPath: options.logPath });
        }
        return terminate({ status: "failure", code: error instanceof PolicyBlockError ? error.decision.code : "ACTION_FAILED", reason, actions, logPath: options.logPath });
      }
    }
    return terminate({ status: "failure", code: Date.now() - started >= maxDurationMs ? "TIME_LIMIT" : "ACTION_LIMIT", reason: "Discovery stopped at its configured limit", actions, logPath: options.logPath });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await emit({ event: "run_failed", reason, evidence: surface ? await surface.captureFailureEvidence().catch(() => "Snapshot unavailable") : undefined });
    return terminate({ status: "failure", code: error instanceof PolicyBlockError ? error.decision.code : "RUN_FAILED", reason, actions, logPath: options.logPath });
  } finally {
    await page?.context().close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}
