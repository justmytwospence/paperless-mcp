import type { PolicyClock } from "../api/requestPolicy.js";

export const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Manual deadlines/cooldowns without sleeping or touching an account. */
export class FakeClock implements PolicyClock {
  time = Date.parse("2025-01-01T00:00:00Z");
  next = 1;
  timers = new Map<number, { at: number; fn: () => void }>();
  now = () => this.time;
  setTimeout = (fn: () => void, ms: number) => {
    const id = this.next++;
    this.timers.set(id, { at: this.time + ms, fn });
    return id;
  };
  clearTimeout = (id: unknown) => { this.timers.delete(id as number); };
  async advance(ms: number) {
    const end = this.time + ms;
    for (;;) {
      const next = [...this.timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].fn();
      await settle();
    }
    this.time = end;
    await settle();
  }
}
