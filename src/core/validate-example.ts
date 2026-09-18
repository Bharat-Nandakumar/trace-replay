import { readFileSync } from "node:fs";
import { parseArtifact } from "./artifact.js";
import { parsePolicy } from "./policy.js";

const artifact = parseArtifact(JSON.parse(readFileSync(new URL("../../examples/hand-authored-savings-balance.json", import.meta.url), "utf8")));
const policy = parsePolicy(JSON.parse(readFileSync(new URL("../../config/mock-bank-policy.json", import.meta.url), "utf8")));

process.stdout.write([
  `${artifact.name} (${artifact.id}@${artifact.version})`,
  `App family: ${artifact.compatibility.appFamily}`,
  `Inputs: ${Object.keys(artifact.inputs).join(", ")}`,
  `Outputs: ${Object.keys(artifact.outputs).join(", ")}`,
  `Steps: ${artifact.steps.map((step) => `${step.id}:${step.action}`).join(" → ")}`,
  `Business outcomes: ${artifact.businessOutcomes.map((outcome) => outcome.code).join(", ")}`,
  `Policy origins: ${policy.allowedOrigins.join(", ")}`,
].join("\n") + "\n");
