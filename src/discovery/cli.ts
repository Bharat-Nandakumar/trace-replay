import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePolicy } from "../core/policy.js";
import { OpenAIDecisionSource } from "./model.js";
import { PlaywrightSurface } from "../surfaces/playwright.js";
import { runDiscovery } from "./run.js";

function usage(): string {
  return `Usage: npm run discover -- --input member_id=10001 [options]

Options:
  --goal TEXT       Natural-language goal (default: savings balance lookup)
  --entry URL       Local app entry URL (default: http://127.0.0.1:3000/start)
  --input K=V       Runtime input; repeat for more inputs
  --log PATH        JSONL evidence path (default: evidence/discovery-<time>.jsonl)
  --model ID        OpenAI model (default: gpt-5.6-terra)
  --help            Show this help

Requires OPENAI_API_KEY in the environment. Start the app with npm run app first.\n`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help")) { process.stdout.write(usage()); return; }
  const values = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) throw new Error(`Invalid argument near ${flag ?? "end"}\n${usage()}`);
    if (!["--goal", "--entry", "--input", "--log", "--model"].includes(flag)) throw new Error(`Unknown option: ${flag}`);
    values.set(flag, [...(values.get(flag) ?? []), value]);
  }
  const single = (name: string): string | undefined => {
    const list = values.get(name);
    if (list && list.length > 1) throw new Error(`${name} may be supplied once`);
    return list?.[0];
  };
  const inputs: Record<string, string> = {};
  for (const assignment of values.get("--input") ?? []) {
    const separator = assignment.indexOf("=");
    if (separator < 1) throw new Error("--input must be NAME=VALUE");
    const name = assignment.slice(0, separator);
    if (!/^[a-z][a-z0-9_]*$/.test(name) || name in inputs) throw new Error(`Invalid or duplicate input name: ${name}`);
    inputs[name] = assignment.slice(separator + 1);
  }
  if (!Object.keys(inputs).length) throw new Error(`At least one --input is required\n${usage()}`);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey?.trim()) throw new Error("OPENAI_API_KEY is not set; export it locally before running discovery");

  const goal = single("--goal") ?? "Look up member {member_id} and return the current balance of their savings account.";
  const entryUrl = single("--entry") ?? "http://127.0.0.1:3000/start";
  const logPath = resolve(single("--log") ?? `evidence/discovery-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  const policy = parsePolicy(JSON.parse(readFileSync(new URL("../../config/mock-bank-policy.json", import.meta.url), "utf8")));
  const model = new OpenAIDecisionSource(apiKey, single("--model") ?? "gpt-5.6-terra");
  const result = await runDiscovery({
    goal, entryUrl, inputs, policy, model, logPath, redactionValues: [apiKey],
    executablePath: process.env.CHROME_PATH || undefined,
    verifyCompletion: async (surface: PlaywrightSurface, readings) => {
      const accountHeading = await surface.resolve({ candidates: [{ kind: "role", role: "heading", name: "Savings Account" }] });
      const balanceHeading = await surface.resolve({ frame: { title: "Savings account details" }, candidates: [{ kind: "role", role: "heading", name: "Account Balance" }] });
      const balanceCell = await surface.resolve({ frame: { title: "Savings account details" }, candidates: [{ kind: "table_value", rowHeader: "Current savings balance" }] });
      const displayedBalance = balanceCell.status === "unique" ? await surface.read(balanceCell.handle) : "";
      return accountHeading.status === "unique" && balanceHeading.status === "unique"
        && /^\$\d[\d,]*\.\d{2} USD$/.test(displayedBalance)
        && readings.includes(displayedBalance);
    },
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== "success") process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
