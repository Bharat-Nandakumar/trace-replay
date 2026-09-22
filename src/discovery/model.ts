import OpenAI from "openai";
import { decisionTool, parseDecision, type DiscoveryDecision } from "./decision.js";
import type { BrowserModelObservation } from "../surfaces/playwright.js";

export type ModelObservation = BrowserModelObservation;

export type DecisionContext = {
  goal: string;
  inputNames: string[];
  observation: ModelObservation;
  recentActions: string[];
};

export type ModelDecision = {
  decision: DiscoveryDecision;
  responseId?: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
};
export interface DecisionSource {
  readonly provider?: string;
  readonly model?: string;
  decide(context: DecisionContext): Promise<ModelDecision>;
}

const instructions = `You are discovering a UI workflow in a synthetic bank application. Use only the current browser observation and visible UI controls. Propose one action per turn through propose_action. Never invent an unobserved URL or use an application backend/API. Fill fields by referring to a supplied input name, never by writing a literal value. Prefer unique accessible role and name. For values in tables use table_value and the row header. Include a frameTitle when the target is inside a frame. Wait only when visible loading is in progress. Request human help for risky controls, unexpected dialogs, uncertainty, or unsafe actions. Seeing an answer in the screenshot or page summary does not count as extracting it: you must propose a read action for the requested result before proposing finish. Your reason must be one short statement about visible evidence, not hidden reasoning.`;

export class OpenAIDecisionSource implements DecisionSource {
  private readonly client: OpenAI;
  readonly provider = "openai";
  readonly model: string;

  constructor(apiKey: string, model = "gpt-5.6-terra") {
    if (!apiKey.trim()) throw new Error("OPENAI_API_KEY is required");
    this.client = new OpenAI({ apiKey, maxRetries: 1, timeout: 60_000 });
    this.model = model;
  }

  async decide(context: DecisionContext): Promise<ModelDecision> {
    const summary = {
      goal: context.goal,
      suppliedInputNames: context.inputNames,
      currentUrl: context.observation.url,
      visibleText: context.observation.visibleText,
      accessibilitySummary: context.observation.accessibilitySummary,
      observedLinks: context.observation.observedLinks,
      recentActions: context.recentActions.slice(-5),
    };
    const response = await this.client.responses.create({
      model: this.model,
      instructions,
      input: [{ role: "user", content: [
        { type: "input_text", text: JSON.stringify(summary) },
        { type: "input_image", image_url: `data:image/jpeg;base64,${context.observation.screenshot.toString("base64")}`, detail: "high" },
      ] }],
      tools: [decisionTool],
      tool_choice: { type: "function", name: "propose_action" },
      parallel_tool_calls: false,
      reasoning: { effort: "low" },
      max_output_tokens: 800,
      store: false,
    });
    const calls = response.output.filter((item): item is Extract<typeof item, { type: "function_call" }> => item.type === "function_call" && item.name === "propose_action");
    if (calls.length !== 1) throw new Error(`Expected one propose_action call, received ${calls.length}`);
    const decision = parseDecision(JSON.parse(calls[0].arguments));
    return {
      decision,
      responseId: response.id,
      usage: response.usage ? {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        totalTokens: response.usage.total_tokens,
      } : undefined,
    };
  }
}
