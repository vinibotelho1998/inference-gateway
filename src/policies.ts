import { GatewayError } from './errors.ts';

export class RateLimiter {
  buckets = new Map<string, { remaining: number; startsAt: number }>();
  limit: number;
  now: () => number;
  constructor(limit: number, now = Date.now) { this.limit = limit; this.now = now; }
  consume(client: string) {
    const now = this.now();
    let bucket = this.buckets.get(client);
    if (!bucket || now - bucket.startsAt >= 60_000) {
      bucket = { remaining: this.limit, startsAt: now }; this.buckets.set(client, bucket);
    }
    if (bucket.remaining <= 0) throw new GatewayError(429, 'rate_limit', 'Limite de requisicoes por minuto atingido.', Math.max(1, Math.ceil((bucket.startsAt + 60_000 - now) / 1000)));
    bucket.remaining--;
  }
}

type Circuit = { failures: number; openUntil: number; probing: boolean };
export class CircuitBreaker {
  circuits = new Map<string, Circuit>();
  threshold: number;
  cooldownMs: number;
  now: () => number;
  constructor(threshold: number, cooldownMs: number, now = Date.now) {
    this.threshold = threshold; this.cooldownMs = cooldownMs; this.now = now;
  }
  acquire(id: string): boolean {
    const state = this.circuits.get(id);
    if (!state) return true;
    if (state.openUntil > this.now()) return false;
    if (state.failures >= this.threshold) {
      if (state.probing) return false;
      state.probing = true;
    }
    return true;
  }
  success(id: string) { this.circuits.delete(id); }
  failure(id: string) {
    const state = this.circuits.get(id) ?? { failures: 0, openUntil: 0, probing: false };
    state.failures++; state.probing = false;
    if (state.failures >= this.threshold) state.openUntil = this.now() + this.cooldownMs;
    this.circuits.set(id, state);
  }
  snapshot() {
    return [...this.circuits.entries()].map(([id, state]) => ({ id, failures: state.failures,
      state: state.openUntil > this.now() ? 'open' : state.probing ? 'half-open' : 'closed' }));
  }
}

export async function withDeadline<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('Provider deadline exceeded')); }, timeoutMs);
  });
  try { return await Promise.race([operation(controller.signal), timeout]); }
  finally { clearTimeout(timer); }
}
