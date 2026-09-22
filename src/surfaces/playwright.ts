import type { Frame, Locator, Page } from "playwright";
import type { CapabilityStep, Target } from "../core/artifact.js";
import type { ControlIdentity } from "../core/policy.js";
import type { SurfaceAdapter, SurfaceObservation, TargetResolution } from "../core/surface.js";

export type BrowserModelObservation = {
  url: string;
  visibleText: string;
  accessibilitySummary: string;
  screenshot: Buffer;
  observedLinks: string[];
};

type Scope = Page | Frame;

function controlRole(tag: string, explicitRole: string | null): string {
  if (explicitRole) return explicitRole;
  switch (tag) {
    case "BUTTON": return "button";
    case "A": return "link";
    case "INPUT": return "textbox";
    case "TH": return "rowheader";
    case "TD": return "cell";
    default: return tag.toLowerCase();
  }
}

export class PlaywrightSurface implements SurfaceAdapter<Locator> {
  constructor(readonly page: Page) {}

  private async scope(target: Target): Promise<Scope | null> {
    if (!target.frame) return this.page;
    for (const frame of this.page.frames()) {
      if (frame === this.page.mainFrame()) continue;
      const title = await frame.frameElement().then((element) => element.getAttribute("title")).catch(() => null);
      if (title === target.frame.title) return frame;
    }
    return null;
  }

  private candidateLocator(scope: Scope, candidate: Target["candidates"][number]): Locator {
    switch (candidate.kind) {
      case "role": {
        const locator = scope.getByRole(candidate.role as Parameters<Scope["getByRole"]>[0], { name: candidate.name, exact: true });
        return candidate.withinText ? locator.filter({ hasText: candidate.withinText }) : locator;
      }
      case "label": return scope.getByLabel(candidate.text, { exact: true });
      case "text": {
        const locator = scope.getByText(candidate.text, { exact: true });
        return candidate.withinText ? locator.filter({ hasText: candidate.withinText }) : locator;
      }
      case "table_value": return scope.getByRole("row").filter({ has: scope.getByRole("rowheader", { name: candidate.rowHeader, exact: true }) }).getByRole("cell");
    }
  }

  async resolve(target: Target): Promise<TargetResolution<Locator>> {
    const scope = await this.scope(target);
    if (!scope) return { status: "missing", observed: `Frame titled ${target.frame?.title} was not found` };
    for (let index = 0; index < target.candidates.length; index++) {
      const candidate = target.candidates[index];
      const locator = this.candidateLocator(scope, candidate);
      const count = await locator.count();
      if (count > 1) return { status: "ambiguous", matches: count, observed: `${candidate.kind} matched ${count} controls` };
      if (count === 0) continue;
      const identity = await this.identity(locator, candidate, target.frame?.title);
      return { status: "unique", handle: locator, identity, strategyIndex: index };
    }
    return { status: "missing", observed: `No candidate matched in ${target.frame?.title ?? "main page"}` };
  }

  private async identity(locator: Locator, candidate: Target["candidates"][number], frameTitle?: string): Promise<ControlIdentity> {
    const element = await locator.evaluate((node) => ({
      tag: node.tagName,
      role: node.getAttribute("role"),
      label: node.getAttribute("aria-label"),
      text: (node.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 160),
      inputType: node.getAttribute("type"),
    }));
    const role = candidate.kind === "role" ? candidate.role : controlRole(element.tag, element.role);
    const name = candidate.kind === "role" ? candidate.name
      : candidate.kind === "label" ? candidate.text
      : candidate.kind === "table_value" ? candidate.rowHeader
      : element.label || element.text;
    return { role, name, ...(frameTitle ? { frameTitle } : {}) };
  }

  async observe(): Promise<SurfaceObservation> {
    const parts: string[] = [await this.page.ariaSnapshot({ timeout: 5000 }).catch(() => "[page accessibility snapshot unavailable]")];
    for (const frame of this.page.frames()) {
      if (frame === this.page.mainFrame()) continue;
      const title = await frame.frameElement().then((element) => element.getAttribute("title")).catch(() => null);
      parts.push(`Frame: ${title ?? "untitled"}\n${await frame.locator("body").ariaSnapshot({ timeout: 5000 }).catch(() => "[frame snapshot unavailable]")}`);
    }
    const visibleText = await this.page.locator("body").innerText({ timeout: 5000 });
    return { location: this.page.url(), visibleText: visibleText.slice(0, 5000), accessibilitySummary: parts.join("\n").slice(0, 8000) };
  }

  async modelObservation(): Promise<BrowserModelObservation> {
    const observation = await this.observe();
    const observedLinks = await this.page.locator("a[href]").evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).href));
    return {
      url: observation.location,
      visibleText: observation.visibleText,
      accessibilitySummary: observation.accessibilitySummary ?? "",
      observedLinks,
      screenshot: await this.page.screenshot({ type: "jpeg", quality: 70, fullPage: false, timeout: 5000 }),
    };
  }

  async perform(step: CapabilityStep, handle?: Locator, inputValue?: string | number | boolean): Promise<void> {
    switch (step.action) {
      case "navigate": await this.page.goto(new URL(step.path, this.page.url()).toString(), { waitUntil: "domcontentloaded" }); return;
      case "fill":
        if (!handle || inputValue === undefined) throw new Error("Fill requires a resolved target and input");
        await handle.fill(String(inputValue), { timeout: 10_000 }); return;
      case "click":
        if (!handle) throw new Error("Click requires a resolved target");
        await handle.click({ timeout: 10_000 }); return;
      case "read":
        if (!handle) throw new Error("Read requires a resolved target");
        await this.read(handle); return;
      case "assert": return;
    }
  }

  async read(handle: Locator): Promise<string> {
    return (await handle.innerText({ timeout: 10_000 })).trim();
  }

  async captureFailureEvidence(): Promise<string> {
    const observation = await this.observe();
    return `URL: ${observation.location}\n${observation.accessibilitySummary}`;
  }
}
