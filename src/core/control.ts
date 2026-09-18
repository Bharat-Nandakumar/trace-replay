export type ControlOwner = "automation" | "paused" | "human" | "finished";

export type ControlEvent = {
  sessionId: string;
  from: ControlOwner;
  to: ControlOwner;
  actor: string;
  reason: string;
  at: string;
};

export class ControlStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlStateError";
  }
}

export class SessionControl {
  readonly sessionId: string;
  private currentOwner: ControlOwner = "automation";
  private history: ControlEvent[] = [];

  constructor(sessionId: string) {
    if (!sessionId) throw new ControlStateError("A session ID is required");
    this.sessionId = sessionId;
  }

  get owner(): ControlOwner {
    return this.currentOwner;
  }

  get events(): readonly ControlEvent[] {
    return this.history;
  }

  assertAutomationControl(): void {
    if (this.currentOwner !== "automation") {
      throw new ControlStateError(`Automation does not own session ${this.sessionId}`);
    }
  }

  pause(reason: string): void {
    this.assertAutomationControl();
    this.transition("paused", "automation", reason);
  }

  takeHumanControl(operatorId: string): void {
    if (this.currentOwner !== "paused") throw new ControlStateError("Session must be paused before human takeover");
    if (!operatorId) throw new ControlStateError("Operator ID is required");
    this.transition("human", operatorId, "operator accepted intervention");
  }

  resume(operatorId: string): void {
    if (this.currentOwner !== "human") throw new ControlStateError("Only a human-controlled session can resume");
    if (!operatorId) throw new ControlStateError("Operator ID is required");
    this.transition("automation", operatorId, "operator returned control");
  }

  finish(actor: string, reason: string): void {
    if (this.currentOwner === "finished") throw new ControlStateError("Session is already finished");
    if (!actor || !reason) throw new ControlStateError("Finishing requires actor and reason");
    this.transition("finished", actor, reason);
  }

  private transition(to: ControlOwner, actor: string, reason: string): void {
    const from = this.currentOwner;
    this.currentOwner = to;
    this.history.push({ sessionId: this.sessionId, from, to, actor, reason, at: new Date().toISOString() });
  }
}
