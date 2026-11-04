/** Prosty limiter w pamięci: maks. `limit` zdarzeń na klucz w oknie `windowMs`. */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private limit: number;
  private windowMs: number;
  private timer: NodeJS.Timeout;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.timer = setInterval(() => this.sweep(), windowMs);
    this.timer.unref();
  }

  /** Rejestruje zdarzenie; zwraca false, gdy limit został przekroczony. */
  hit(key: string): boolean {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt < now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count++;
    return entry.count <= this.limit;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  close(): void {
    clearInterval(this.timer);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.hits) if (v.resetAt < now) this.hits.delete(k);
  }
}
