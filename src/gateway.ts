import { randomUUID } from 'node:crypto';
import { GatewayError } from './errors.ts';
import { RateLimiter, CircuitBreaker, withDeadline } from './policies.ts';
import { UsageStore } from './usage.ts';
import type { Provider, InferenceResult } from './providers.ts';

export type GatewayConfig = { requestsPerMinute: number; dailyBudget: number; maxConcurrency: number; providerTimeoutMs: number; failureThreshold: number; cooldownMs: number };

export class InferenceGateway {
  providers: Provider[];
  usage: UsageStore;
  config: GatewayConfig;
  limiter: RateLimiter;
  circuits: CircuitBreaker;
  active = 0;
  now: () => number;
  constructor(providers: Provider[], usage: UsageStore, config: GatewayConfig, now = Date.now) {
    if (!providers.length || new Set(providers.map(provider => provider.id)).size !== providers.length) throw new Error('Provedores precisam de ids unicos e lista nao vazia.');
    this.providers = providers; this.usage = usage; this.config = config; this.now = now;
    this.limiter = new RateLimiter(config.requestsPerMinute, now);
    this.circuits = new CircuitBreaker(config.failureThreshold, config.cooldownMs, now);
  }
  day() { return new Date(this.now()).toISOString().slice(0, 10); }
  async infer(client: string, prompt: string, requestId = randomUUID()) {
    if (!prompt.trim() || prompt.length > 16_000) throw new GatewayError(400, 'invalid_prompt', 'prompt deve ter entre 1 e 16000 caracteres.');
    this.limiter.consume(client);
    if (this.active >= this.config.maxConcurrency) throw new GatewayError(503, 'busy', 'Gateway ocupado. Tente novamente.', 1);
    this.usage.reserve(requestId, client, this.day(), prompt.length, this.config.dailyBudget);
    this.active++;
    const started = performance.now();
    let attempts = 0;
    const attempted: string[] = [];
    try {
      for (const provider of this.providers) {
        if (!this.circuits.acquire(provider.id)) continue;
        attempts++; attempted.push(provider.id);
        let result: InferenceResult;
        try {
          result = await withDeadline(this.config.providerTimeoutMs, signal => provider.infer(prompt, signal));
        } catch {
          this.circuits.failure(provider.id);
          continue;
        }
        this.circuits.success(provider.id);
        const elapsedMs = performance.now() - started;
        this.usage.finish(requestId, 'ok', provider.id, attempts, elapsedMs, result.text.length, result.inputTokens, result.outputTokens);
        return { requestId, provider: provider.id, kind: provider.kind, model: result.model, text: result.text,
          fallbackUsed: attempts > 1 || provider !== this.providers[0], attempted,
          usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens }, elapsedMs };
      }
      throw new GatewayError(502, 'providers_unavailable', 'Nenhum provedor respondeu dentro das politicas configuradas.');
    } catch (error) {
      this.usage.finish(requestId, 'failed', null, attempts, performance.now() - started);
      throw error;
    } finally { this.active--; }
  }
  metrics(client: string) {
    return { day: this.day(), timezone: 'UTC', dailyBudget: this.config.dailyBudget, usage: this.usage.metrics(client, this.day()) };
  }
}
