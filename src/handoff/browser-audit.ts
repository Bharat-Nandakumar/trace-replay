import type { BrowserContext, Page } from "playwright";
import type { SessionControl } from "../core/control.js";

type Emit = (event: Record<string, unknown>) => Promise<void>;

export async function installHumanActionAudit(
  context: BrowserContext,
  page: Page,
  session: SessionControl,
  emit: Emit,
  activeRequestId?: () => string | undefined,
): Promise<void> {
  await context.exposeBinding("__traceReplayHumanAction", async ({ page: sourcePage }, action: unknown) => {
    if (session.owner !== "human" || !action || typeof action !== "object") return;
    await emit({ event: "human_action", requestId: activeRequestId?.(),
      operatorId: session.events.at(-1)?.actor, ...action as Record<string, unknown>, url: sourcePage.url() });
  });
  const install = (): void => {
    const marker = "__traceReplayAuditInstalled";
    const global = globalThis as unknown as Record<string, unknown>;
    if (global[marker]) return;
    global[marker] = true;
    document.addEventListener("click", (event) => {
      const element = event.target instanceof Element ? event.target.closest("button,a,input") : null;
      if (!element) return;
      const explicitRole = element.getAttribute("role");
      const role = explicitRole || (element.tagName === "A" ? "link" : element.tagName === "BUTTON" ? "button" : "input");
      const name = (element.getAttribute("aria-label") || element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 160);
      const binding = (globalThis as unknown as Record<string, unknown>).__traceReplayHumanAction;
      if (typeof binding === "function") void (binding as (value: unknown) => Promise<void>)({ action: "click", control: { role, name } });
    }, true);
  };
  await context.addInitScript(install);
  await page.evaluate(install);
}
