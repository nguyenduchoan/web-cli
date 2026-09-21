export const MAX_RECONNECT_ATTEMPTS = 5;
export const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000];

export type ReconnectDecision =
  | { action: "retry"; delayMs: number; attempt: number }
  | { action: "stop"; reason: "max_attempts_reached" | "auth_expired" | "session_missing" | "forbidden" };

export class ReconnectManager {
  private attempt = 0;
  private stopped = false;

  constructor(
    private readonly maxAttempts = MAX_RECONNECT_ATTEMPTS,
    private readonly delays = RECONNECT_DELAYS
  ) {}

  public getAttempt(): number {
    return this.attempt;
  }

  public isStopped(): boolean {
    return this.stopped;
  }

  public onSyncSuccess(): void {
    this.attempt = 0;
  }

  public onManualReconnect(): void {
    this.stopped = false;
    this.attempt = 0;
  }

  public stop(): void {
    this.stopped = true;
  }

  public nextAttempt(): ReconnectDecision {
    if (this.stopped || this.attempt >= this.maxAttempts) {
      this.stopped = true;
      return { action: "stop", reason: "max_attempts_reached" };
    }

    const base = this.delays[this.attempt] ?? 15_000;
    const currentAttempt = this.attempt + 1;
    this.attempt += 1;
    return { action: "retry", delayMs: base, attempt: currentAttempt };
  }

  public handleCloseCode(code: number): ReconnectDecision {
    if (code === 4001) {
      this.stopped = true;
      return { action: "stop", reason: "auth_expired" };
    }
    if (code === 4004) {
      this.stopped = true;
      return { action: "stop", reason: "session_missing" };
    }
    if (code === 4003) {
      this.stopped = true;
      return { action: "stop", reason: "forbidden" };
    }
    return this.nextAttempt();
  }

  public handleTicketError(status: number, code?: string): ReconnectDecision {
    if (status === 404 || code === "unknown_session") {
      this.stopped = true;
      return { action: "stop", reason: "session_missing" };
    }
    if (status === 401) {
      this.stopped = true;
      return { action: "stop", reason: "auth_expired" };
    }
    if (status === 403) {
      this.stopped = true;
      return { action: "stop", reason: "forbidden" };
    }
    return this.nextAttempt();
  }
}
