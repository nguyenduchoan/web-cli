export const BACKOFF_DELAYS = [1000, 2000, 4000, 8000, 15000] as const;

export type PollingDelayOptions = {
  activeSession: boolean;
  visible: boolean;
  online: boolean;
  retryCount: number;
  lastAttemptFailed: boolean;
  randomJitterFn?: () => number;
};

export function getPollingDelay({
  activeSession,
  visible,
  online,
  retryCount,
  lastAttemptFailed,
  randomJitterFn = Math.random
}: PollingDelayOptions): number | null {
  if (!visible || !online) return null;

  if (lastAttemptFailed) {
    const clampedCount = Math.min(Math.max(1, retryCount), 5);
    const baseMs = BACKOFF_DELAYS[clampedCount - 1] ?? 15000;
    const jitterMs = randomJitterFn() * 0.2 * baseMs;
    return baseMs + jitterMs;
  }

  if (!activeSession) return null;

  return 5000;
}

export type PollingSchedulerOptions = {
  fetchSessions: () => Promise<void>;
  hasActiveSession: () => boolean;
  isAuthenticated: () => boolean;
  isVisible?: () => boolean;
  isOnline?: () => boolean;
  setTimeoutFn?: (cb: () => void, ms: number) => any;
  clearTimeoutFn?: (id: any) => void;
  randomJitterFn?: () => number;
  onTimerScheduled?: (delayMs: number) => void;
};

export class SessionPollingScheduler {
  private fetchSessions: () => Promise<void>;
  private hasActiveSessionFn: () => boolean;
  private isAuthenticatedFn: () => boolean;
  private isVisibleFn: () => boolean;
  private isOnlineFn: () => boolean;
  private setTimeoutFn: (cb: () => void, ms: number) => any;
  private clearTimeoutFn: (id: any) => void;
  private randomJitterFn: () => number;
  private onTimerScheduled?: (delayMs: number) => void;

  public stopped = true;
  public retryCount = 0;
  public lastAttemptFailed = false;
  public isFetching = false;
  public timerId: any = undefined;
  public authGeneration = 0;
  private resumeAfterFetch = false;

  constructor(options: PollingSchedulerOptions) {
    this.fetchSessions = options.fetchSessions;
    this.hasActiveSessionFn = options.hasActiveSession;
    this.isAuthenticatedFn = options.isAuthenticated;
    this.isVisibleFn = options.isVisible ?? (() => typeof document === "undefined" || document.visibilityState === "visible");
    this.isOnlineFn = options.isOnline ?? (() => typeof navigator === "undefined" || navigator.onLine);
    this.setTimeoutFn = options.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((id) => clearTimeout(id));
    this.randomJitterFn = options.randomJitterFn ?? Math.random;
    this.onTimerScheduled = options.onTimerScheduled;
  }

  public start(): void {
    this.stopped = false;
    this.authGeneration++;
    if (this.isFetching) {
      this.resumeAfterFetch = true;
    }
    this.retryCount = 0;
    this.lastAttemptFailed = false;
  }

  public stop(): void {
    this.stopped = true;
    this.authGeneration++;
    this.resumeAfterFetch = false;
    this.clearTimer();
  }

  public clearTimer(): void {
    if (this.timerId !== undefined) {
      this.clearTimeoutFn(this.timerId);
      this.timerId = undefined;
    }
  }

  public hasScheduledTimer(): boolean {
    return this.timerId !== undefined;
  }

  public reconcileActiveSession(hasActive: boolean): void {
    if (this.stopped || !this.isAuthenticatedFn()) return;

    if (!hasActive) {
      // If no active session and not currently in error-retry backoff, cancel periodic timer immediately
      if (!this.lastAttemptFailed) {
        this.clearTimer();
      }
    } else {
      // Transition false -> true: if no timer is running and no fetch is in flight, schedule periodic timer
      if (this.timerId === undefined && !this.isFetching) {
        this.scheduleNext();
      }
    }
  }

  public async triggerImmediateRefresh(): Promise<void> {
    if (this.stopped || !this.isAuthenticatedFn() || !this.isVisibleFn() || !this.isOnlineFn()) {
      return;
    }
    this.clearTimer();
    this.retryCount = 0;
    this.lastAttemptFailed = false;
    await this.executeFetch();
  }

  public async executeFetch(): Promise<void> {
    // A scheduled timer may outlive the visible/online/authenticated state that created it.
    if (
      this.stopped || this.isFetching || !this.isAuthenticatedFn() ||
      !this.isVisibleFn() || !this.isOnlineFn()
    ) return;
    this.isFetching = true;
    const currentGen = this.authGeneration;

    try {
      await this.fetchSessions();
      if (this.stopped || this.authGeneration !== currentGen) return;
      this.lastAttemptFailed = false;
      this.retryCount = 0;
    } catch {
      if (this.stopped || this.authGeneration !== currentGen) return;
      this.lastAttemptFailed = true;
      this.retryCount = Math.min(this.retryCount + 1, 5);
    } finally {
      this.isFetching = false;
      if (this.stopped) return;

      if (this.authGeneration === currentGen) {
        this.scheduleNext();
        return;
      }

      if (this.resumeAfterFetch) {
        this.resumeAfterFetch = false;
        void this.executeFetch();
      }
    }
  }

  public scheduleNext(): void {
    this.clearTimer();
    if (this.stopped || !this.isAuthenticatedFn()) return;

    const delay = getPollingDelay({
      activeSession: this.hasActiveSessionFn(),
      visible: this.isVisibleFn(),
      online: this.isOnlineFn(),
      retryCount: this.retryCount,
      lastAttemptFailed: this.lastAttemptFailed,
      randomJitterFn: this.randomJitterFn
    });

    if (delay === null) return;

    this.timerId = this.setTimeoutFn(() => {
      this.timerId = undefined;
      // Explicit refreshes and error retries still work without an active session.
      if (!this.lastAttemptFailed && !this.hasActiveSessionFn()) return;
      void this.executeFetch();
    }, delay);

    this.onTimerScheduled?.(delay);
  }
}
