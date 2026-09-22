import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArtifact } from "../core/artifact.js";
import { parsePolicy } from "../core/policy.js";
import { runReplay } from "./run.js";

function argumentMap(args: string[]): Map<string, string[]> {
  const values = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) throw new Error(`Invalid argument near ${flag ?? "end"}`);
    if (!["--artifact", "--input", "--base-origin", "--log"].includes(flag)) throw new Error(`Unknown option: ${flag}`);
    values.set(flag, [...(values.get(flag) ?? []), value]);
  }
  return values;
}

async function main(): Promise<void> {
  const values = argumentMap(process.argv.slice(2));
  const one = (name: string, fallback?: string): string => {
    const found = values.get(name);
    if (!found?.length && fallback !== undefined) return fallback;
    if (found?.length !== 1) throw new Error(`${name} is required exactly once`);
    return found[0];
  };
  const inputs: Record<string, string> = {};
  for (const assignment of values.get("--input") ?? []) {
    const separator = assignment.indexOf("=");
    if (separator < 1) throw new Error("--input must be NAME=VALUE");
    const name = assignment.slice(0, separator);
    if (name in inputs) throw new Error(`Duplicate input: ${name}`);
    inputs[name] = assignment.slice(separator + 1);
  }
  const artifactPath = resolve(one("--artifact"));
  const artifactContent = readFileSync(artifactPath, "utf8");
  const artifact = parseArtifact(JSON.parse(artifactContent));
  const policy = parsePolicy(JSON.parse(readFileSync(new URL("../../config/mock-bank-policy.json", import.meta.url), "utf8")));
  const execution = await runReplay({
    artifact,
    artifactSha256: createHash("sha256").update(artifactContent).digest("hex"),
    inputs,
    baseOrigin: one("--base-origin", "http://127.0.0.1:3000"),
    policy,
    logPath: resolve(one("--log", `evidence/replay-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`)),
    executablePath: process.env.CHROME_PATH || undefined,
  });
  process.stdout.write(`${JSON.stringify(execution.result, null, 2)}\n`);
  if (execution.result.status !== "success") process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
