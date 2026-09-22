import type { CapabilityArtifact } from "./artifact.js";

const REDACTED = "[REDACTED]";
const SECRET_KEY = /(?:api[_-]?key|password|secret|credential)|^(?:token|access[_-]?token|refresh[_-]?token|auth[_-]?token|bearer[_-]?token)$/i;

/** Redact known runtime values and secret-named fields before any event is persisted. */
export function redactForEvidence(value: unknown, sensitiveValues: readonly string[] = []): unknown {
  const secrets = [...sensitiveValues].filter(Boolean).sort((a, b) => b.length - a.length);

  function visit(item: unknown): unknown {
    if (typeof item === "string") {
      return secrets.reduce((text, secret) => text.replaceAll(secret, REDACTED), item);
    }
    if (typeof item === "number" && secrets.includes(String(item))) return REDACTED;
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).map(([key, entry]) => [
        key,
        SECRET_KEY.test(key) ? REDACTED : visit(entry),
      ]));
    }
    return item;
  }

  return visit(value);
}

/** Collect sensitivity from the capability contract instead of relying on each logger call site. */
export function redactCapabilityEvent(
  artifact: CapabilityArtifact,
  inputs: Record<string, unknown>,
  outputs: Record<string, unknown>,
  event: unknown,
): unknown {
  const sensitiveValues: string[] = [];
  for (const [name, definition] of Object.entries(artifact.inputs)) {
    if (definition.sensitive && inputs[name] !== undefined) sensitiveValues.push(String(inputs[name]));
  }
  for (const [name, definition] of Object.entries(artifact.outputs)) {
    if (!definition.sensitive || outputs[name] === undefined) continue;
    const value = outputs[name];
    if (typeof value === "object" && value !== null && "amount" in value) {
      sensitiveValues.push(String(value.amount));
    } else {
      sensitiveValues.push(String(value));
    }
  }
  return redactForEvidence(event, sensitiveValues);
}
