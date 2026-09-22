import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArtifact } from "./artifact.js";

type Event = Record<string, unknown>;

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const evidence = resolve(root, "evidence");
const requiredReplayLogs = [
  "phase-6-invalid-input.jsonl",
  "phase-6-member-not-found.jsonl",
  "phase-6-normal-success.jsonl",
  "phase-6-permission-denied.jsonl",
  "phase-6-possible-drift.jsonl",
  "phase-6-session-expired.jsonl",
  "phase-6-slow-load.jsonl",
  "phase-6-unexpected-dialog.jsonl",
  "phase-7-automated-handoff.jsonl",
  "phase-7-manual-handoff-success.jsonl",
];

async function jsonl(name: string): Promise<{ text: string; events: Event[] }> {
  const text = await readFile(resolve(evidence, name), "utf8");
  const events = text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) as Event; }
    catch { throw new Error(`${name}:${index + 1} is not valid JSON`); }
  });
  if (!events.length) throw new Error(`${name} is empty`);
  return { text, events };
}

function resultOf(events: Event[], name: string): Record<string, unknown> {
  const last = events.at(-1);
  if (last?.event !== "run_finished" || !last.result || typeof last.result !== "object") {
    throw new Error(`${name} has no terminal run_finished result`);
  }
  return last.result as Record<string, unknown>;
}

function requireEvents(events: Event[], name: string, required: string[]): void {
  const present = new Set(events.map((event) => event.event));
  for (const event of required) if (!present.has(event)) throw new Error(`${name} is missing ${event}`);
}

async function main(): Promise<void> {
  const discoveryName = "discovery-gpt-5-6-terra-2026-09-20-final.jsonl";
  const discovery = await jsonl(discoveryName);
  if (resultOf(discovery.events, discoveryName).status !== "success") throw new Error("Authoritative discovery did not succeed");
  const started = discovery.events.find((event) => event.event === "run_started");
  const model = started?.model as Record<string, unknown> | undefined;
  if (model?.provider !== "openai" || model.id !== "gpt-5.6-terra") throw new Error("Authoritative discovery model metadata is missing");
  if (!discovery.events.some((event) => event.event === "model_decision" && typeof event.responseId === "string")) {
    throw new Error("Authoritative discovery has no response ID evidence");
  }
  if (/10001|1250\.75|sk-[A-Za-z0-9_-]{8,}/.test(discovery.text)) throw new Error("Sensitive discovery literal found");

  const artifactText = await readFile(resolve(root, "capabilities/lookup-savings-balance.json"), "utf8");
  const artifact = parseArtifact(JSON.parse(artifactText));
  const discoveryHash = createHash("sha256").update(discovery.text).digest("hex");
  if (artifact.provenance?.sourceLogSha256 !== discoveryHash) throw new Error("Artifact provenance does not match the discovery log");
  const artifactHash = createHash("sha256").update(artifactText).digest("hex");

  const summaries: string[] = [];
  for (const name of requiredReplayLogs) {
    const log = await jsonl(name);
    const result = resultOf(log.events, name);
    const terminal = log.events.at(-1)!;
    if (terminal.modelCalls !== 0) throw new Error(`${name} does not prove zero model calls`);
    if (/10002|99999|842\.10|1250\.75|\/Users\/|sk-[A-Za-z0-9_-]{8,}|model_decision|responseId|gpt-5/i.test(log.text)) {
      throw new Error(`${name} contains a runtime value, local path, or model evidence`);
    }
    if (name !== "phase-6-possible-drift.jsonl") {
      const runStarted = log.events.find((event) => event.event === "run_started");
      if (runStarted?.artifactSha256 !== artifactHash) throw new Error(`${name} does not reference the saved artifact`);
    }
    summaries.push(`${name}: ${String(result.status)}${result.code ? `/${String(result.code)}` : ""}`);
  }

  for (const name of ["phase-7-automated-handoff.jsonl", "phase-7-manual-handoff-success.jsonl"]) {
    const log = await jsonl(name);
    requireEvents(log.events, name, ["intervention_requested", "intervention_accepted", "human_action", "handoff_resumed", "handoff_revalidated"]);
    const nativeDismissal = log.events.some((event) => event.event === "human_action" && event.method === "POST" && event.source === "browser_request");
    if (!nativeDismissal) throw new Error(`${name} has no native dismissal request`);
    const revalidation = log.events.find((event) => event.event === "handoff_revalidated");
    if (revalidation?.verified !== true) throw new Error(`${name} did not revalidate after handoff`);
  }

  const screenshot = resolve(evidence, "phase-6-session-expired-session_expired.png");
  await access(screenshot);
  if ((await stat(screenshot)).size === 0) throw new Error("Session-expired screenshot is empty");

  process.stdout.write(`Evidence audit passed\nDiscovery: openai/gpt-5.6-terra, artifact provenance matched\n${summaries.join("\n")}\nSession-expired screenshot: present\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
