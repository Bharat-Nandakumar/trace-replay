import type { Page } from "playwright";

export type HandoffOutcome = "resume" | "abort" | "timeout";

export type HandoffRequest = {
  requestId: string;
  reason: string;
  stepId?: string;
  page: Page;
  accept: () => Promise<void>;
};

export type HandoffHandler = {
  operatorId: string;
  timeoutMs: number;
  handle: (request: HandoffRequest) => Promise<HandoffOutcome>;
};

export type HandoffResolution =
  | "unavailable"
  | "resumed"
  | "aborted"
  | "timeout"
  | "unresolved"
  | "invalid";
