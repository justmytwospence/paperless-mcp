/** Local process admission policy, not a claim about Paperless's REST quota. */
export interface PolicyClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

const clock: PolicyClock = {
  now: Date.now,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export interface RequestPolicyOptions {
  concurrency?: number;
  maxQueue?: number;
  timeoutMs?: number;
  queueTimeoutMs?: number;
  maxReadRetryWaitMs?: number;
  clock?: PolicyClock;
}

export class RequestThrottledError extends Error {
  readonly status = 429;
  constructor(readonly retryAt: number) {
    super(`Paperless returned HTTP 429; cooldown until ${new Date(retryAt).toISOString()}. Writes are not replayed.`);
  }
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer?: unknown;
}

export class RequestPolicy {
  readonly concurrency: number;
  readonly maxQueue: number;
  readonly timeoutMs: number;
  readonly queueTimeoutMs: number;
  readonly maxReadRetryWaitMs: number;
  private readonly clock: PolicyClock;
  private active = 0;
  private queue: Waiter[] = [];
  private wake?: unknown;
  private attempts = 0;
  private readRetries = 0;
  private lastAttempt: number | null = null;
  private last429: number | null = null;
  private retryAfter: string | null = null;
  private cooldownUntil = 0;

  constructor(options: RequestPolicyOptions = {}) {
    this.concurrency = options.concurrency ?? 4;
    this.maxQueue = options.maxQueue ?? 64;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.queueTimeoutMs = options.queueTimeoutMs ?? 30_000;
    this.maxReadRetryWaitMs = options.maxReadRetryWaitMs ?? 10_000;
    this.clock = options.clock ?? clock;
    for (const [name, n] of Object.entries({ concurrency: this.concurrency, maxQueue: this.maxQueue,
      timeoutMs: this.timeoutMs, queueTimeoutMs: this.queueTimeoutMs, maxReadRetryWaitMs: this.maxReadRetryWaitMs })) {
      if (!Number.isSafeInteger(n) || n < (name === "maxQueue" || name === "maxReadRetryWaitMs" ? 0 : 1) ||
          ((name === "timeoutMs" || name === "queueTimeoutMs") && n > 2_147_483_647)) {
        throw new Error(`Invalid request policy ${name}`);
      }
    }
  }

  /** Called for every response, including binary downloads and multipart uploads. */
  observe(res: Response): void {
    if (res.status !== 429) return;
    const now = this.clock.now();
    this.last429 = now;
    const header = res.headers.get("retry-after");
    // Invalid/missing Retry-After gets a local one-second backoff, not a quota reset.
    const seconds = header && /^\d+(?:\.\d+)?$/.test(header.trim()) ? Number(header) * 1000 : NaN;
    const date = header ? Date.parse(header) : NaN;
    const delay = Number.isFinite(seconds) ? seconds : Number.isFinite(date) ? Math.max(0, date - now) : 1000;
    this.retryAfter = header?.slice(0, 128) ?? null;
    this.cooldownUntil = Math.max(this.cooldownUntil, now + Math.min(delay, 365 * 86400_000));
  }

  throttled(): RequestThrottledError {
    return new RequestThrottledError(this.cooldownUntil);
  }

  /** Zero upstream calls; aggregate counters contain no library names, URLs or ids. */
  status() {
    const iso = (n: number | null) => n === null ? null : new Date(n).toISOString();
    return {
      source: "local_process_policy", upstream_quota: null,
      quota_note: "Paperless REST allowance is unknown; these are local limits, not remaining quota.",
      observed_at: iso(this.clock.now()),
      concurrency: this.concurrency, max_queue: this.maxQueue,
      request_timeout_ms: this.timeoutMs, queue_timeout_ms: this.queueTimeoutMs,
      active: this.active, queued: this.queue.length,
      attempts: this.attempts, read_retries: this.readRetries, last_attempt_at: iso(this.lastAttempt),
      last_429_at: iso(this.last429), retry_after: this.retryAfter,
      cooldown_until: this.cooldownUntil > this.clock.now() ? iso(this.cooldownUntil) : null,
      max_read_retries: 1, max_read_retry_wait_ms: this.maxReadRetryWaitMs,
      retry_policy: "Only GET/HEAD HTTP 429 may retry once. No write, timeout, network or 5xx replay.",
    };
  }

  private pump(): void {
    if (this.wake !== undefined) this.clock.clearTimeout(this.wake);
    this.wake = undefined;
    if (!this.queue.length) return;
    const remaining = this.cooldownUntil - this.clock.now();
    if (remaining > 0) {
      this.wake = this.clock.setTimeout(() => this.pump(), Math.min(remaining, 2_147_483_647));
      return;
    }
    while (this.active < this.concurrency && this.queue.length) {
      const waiter = this.queue.shift()!;
      this.clock.clearTimeout(waiter.timer);
      this.active++;
      waiter.resolve();
    }
  }

  private admit(): Promise<void> {
    if (this.active < this.concurrency && !this.queue.length && this.cooldownUntil <= this.clock.now()) {
      this.active++;
      return Promise.resolve();
    }
    if (this.queue.length >= this.maxQueue) return Promise.reject(new Error("Local Paperless request queue is full; try later."));
    if (this.cooldownUntil - this.clock.now() >= this.queueTimeoutMs) {
      return Promise.reject(new Error("Paperless cooldown exceeds the local queue deadline; try after cooldown_until in paperless://library/load-status."));
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      waiter.timer = this.clock.setTimeout(() => {
        this.queue = this.queue.filter((w) => w !== waiter);
        reject(new Error("Local Paperless admission timed out; no request was sent."));
        this.pump();
      }, this.queueTimeoutMs);
      this.queue.push(waiter);
      this.pump();
    });
  }

  async run<T>(method: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.admit();
      const controller = new AbortController();
      const timer = this.clock.setTimeout(() => controller.abort(), this.timeoutMs);
      this.attempts++;
      if (attempt > 0) this.readRetries++;
      this.lastAttempt = this.clock.now();
      try {
        return await operation(controller.signal);
      } catch (err) {
        if (controller.signal.aborted) {
          throw new Error(`Upstream request timed out after ${this.timeoutMs}ms. ${/^(GET|HEAD)$/i.test(method) ? "Read was not retried." : "Write outcome may be unknown; inspect state before any manual retry."}`);
        }
        if (!(err instanceof RequestThrottledError) || attempt > 0 || !/^(GET|HEAD)$/i.test(method) ||
            this.cooldownUntil - this.clock.now() > this.maxReadRetryWaitMs) throw err;
      } finally {
        this.clock.clearTimeout(timer);
        this.active--;
        this.pump();
      }
    }
  }
}
