import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { compileCapability } from "./compile.js";
import { parseCompilationProfile } from "./profile.js";

function argumentMap(args: string[]): Map<string, string[]> {
  const values = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) throw new Error(`Invalid argument near ${flag ?? "end"}`);
    if (!["--log", "--profile", "--output", "--input"].includes(flag)) throw new Error(`Unknown option: ${flag}`);
    values.set(flag, [...(values.get(flag) ?? []), value]);
  }
  return values;
}

async function main(): Promise<void> {
  const values = argumentMap(process.argv.slice(2));
  const one = (name: string): string => {
    const found = values.get(name);
    if (found?.length !== 1) throw new Error(`${name} is required exactly once`);
    return found[0];
  };
  const sensitiveValues = (values.get("--input") ?? []).map((assignment) => {
    const separator = assignment.indexOf("=");
    if (separator < 1 || !assignment.slice(separator + 1)) throw new Error("--input must be NAME=VALUE");
    return assignment.slice(separator + 1);
  });
  const logPath = resolve(one("--log"));
  const profilePath = resolve(one("--profile"));
  const outputPath = resolve(one("--output"));
  const logContent = await readFile(logPath, "utf8");
  const profile = parseCompilationProfile(JSON.parse(await readFile(profilePath, "utf8")));
  const artifact = compileCapability({ logContent, profile, sensitiveValues });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  process.stdout.write(`${JSON.stringify({ status: "compiled", artifact: outputPath, capabilityId: artifact.id, steps: artifact.steps.length, sourceLogSha256: artifact.provenance?.sourceLogSha256 }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
