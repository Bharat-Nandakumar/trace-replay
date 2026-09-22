import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { HandoffHandler } from "./types.js";

export function createTerminalHandoff(operatorId: string, timeoutMs: number): HandoffHandler {
  return {
    operatorId,
    timeoutMs,
    handle: async (request) => {
      const readline = createInterface({ input: stdin, output: stdout });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        stdout.write(`\nIntervention required\nRequest: ${request.requestId}\nStep: ${request.stepId ?? "unknown"}\nReason: ${request.reason}\n`);
        const first = (await readline.question('Type "take" to accept control or "abort" to stop: ', { signal: controller.signal })).trim().toLowerCase();
        if (first === "abort") return "abort";
        if (first !== "take") throw new Error('Expected "take" or "abort"');
        await request.accept();
        stdout.write("You now control the visible Chrome window. Resolve the issue in that same window.\n");
        const second = (await readline.question('Type "resume" to return control or "abort" to stop: ', { signal: controller.signal })).trim().toLowerCase();
        if (second === "abort") return "abort";
        if (second !== "resume") throw new Error('Expected "resume" or "abort"');
        return "resume";
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return "timeout";
        throw error;
      } finally {
        clearTimeout(timer);
        readline.close();
      }
    },
  };
}
