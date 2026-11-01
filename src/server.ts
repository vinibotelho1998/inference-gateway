import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { UsageStore } from './usage.ts';
import { createProvider } from './providers.ts';
import type { ProviderConfig } from './providers.ts';
import { InferenceGateway } from './gateway.ts';
import { createApp } from './http.ts';

function integer(name: string, fallback: number, min = 1, max = 1_000_000) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} precisa ser inteiro entre ${min} e ${max}.`);
  return value;
}
const keys: unknown = JSON.parse(process.env.API_KEYS_JSON ?? '{}');
if (!keys || typeof keys !== 'object' || Array.isArray(keys) || !Object.entries(keys).length ||
  !Object.entries(keys).every(([key, client]) => key.length >= 8 && typeof client === 'string' && client.length)) throw new Error('Defina API_KEYS_JSON. Veja .env.example.');
const providerConfigs: unknown = JSON.parse(process.env.PROVIDERS_JSON ?? '[]');
if (!Array.isArray(providerConfigs) || !providerConfigs.length || providerConfigs.length > 4 || !providerConfigs.every(item =>
  item && typeof item.id === 'string' && item.id.length && ['demo', 'ollama'].includes(item.kind))) throw new Error('Configure entre 1 e 4 provedores validos em PROVIDERS_JSON.');
if (new Set((providerConfigs as ProviderConfig[]).map(item => item.kind)).size > 1) throw new Error('Nao misture provedores de demonstracao com modelos reais.');
const dataDir = process.env.DATA_DIR ?? 'var'; mkdirSync(dataDir, { recursive: true });
const usage = new UsageStore(join(dataDir, 'usage.sqlite'));
const gateway = new InferenceGateway((providerConfigs as ProviderConfig[]).map(createProvider), usage, {
  requestsPerMinute: integer('REQUESTS_PER_MINUTE', 30), dailyBudget: integer('DAILY_REQUEST_BUDGET', 200),
  maxConcurrency: integer('MAX_CONCURRENCY', 4, 1, 64), providerTimeoutMs: integer('PROVIDER_TIMEOUT_MS', 3000, 10, 120_000),
  failureThreshold: integer('CIRCUIT_FAILURE_THRESHOLD', 2, 1, 100), cooldownMs: integer('CIRCUIT_COOLDOWN_MS', 10_000, 10, 600_000),
});
const server = createApp(gateway, keys as Record<string, string>);
const port = integer('PORT', 8006, 1, 65_535);
server.listen(port, process.env.HOST ?? '127.0.0.1', () => console.log(`Inference Gateway: http://${process.env.HOST ?? '127.0.0.1'}:${port}`));
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => server.close(() => { usage.close(); process.exit(0); }));
