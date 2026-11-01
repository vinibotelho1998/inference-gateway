import { InferenceGateway } from '../src/gateway.ts';
import { UsageStore } from '../src/usage.ts';
import { createProvider } from '../src/providers.ts';
const usage = new UsageStore(':memory:');
const gateway = new InferenceGateway([
  { id: 'unavailable', kind: 'demo-failure', infer: async () => { throw new Error('Falha injetada para a demonstracao'); } },
  createProvider({ id: 'deterministic-backup', kind: 'demo' }),
], usage, { requestsPerMinute: 10, dailyBudget: 20, maxConcurrency: 2, providerTimeoutMs: 100,
  failureThreshold: 1, cooldownMs: 1000 });
try {
  console.log(JSON.stringify(await gateway.infer('demo', 'Explique o que e um circuit breaker.'), null, 2));
  console.log(JSON.stringify(gateway.metrics('demo'), null, 2));
  console.log('Circuitos:', gateway.circuits.snapshot());
} finally { usage.close(); }
