import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import { InferenceGateway } from '../src/gateway.ts';
import { createApp } from '../src/http.ts';
import { createProvider } from '../src/providers.ts';
import { UsageStore } from '../src/usage.ts';

type Json = Record<string, unknown>;
type Step = { name: string; elapsedMs: number; details: unknown };
type Usage = { status: string; requests: number; inputTokens: number | null; outputTokens: number | null };

const gatewayUrl = process.env.GATEWAY_URL ?? 'http://127.0.0.1:8006';
const ollamaUrl = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
const generationModel = process.env.GENERATION_MODEL ?? 'qwen2.5:1.5b';
const apiKey = process.env.GATEWAY_API_KEY ?? 'demo-client-a';
const reportPath = process.env.INTEGRATION_REPORT ?? 'var/ollama-integration.json';
const timeoutMs = Number(process.env.INTEGRATION_TIMEOUT_MS ?? 120_000);
assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 600_000);
const steps: Step[] = [];
const report: Json = {
  startedAt: new Date().toISOString(),
  validation: 'real Ollama; deployed gateway HTTP; isolated HTTP gateway with unreachable primary and real backup',
  generationModel, steps,
};

async function json(base: string, path: string, body?: Json, key?: string) {
  const response = await fetch(new URL(path, base), {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs),
  });
  const value = await response.json() as Json;
  assert.ok(response.ok, `${path}: HTTP ${response.status}: ${JSON.stringify(value)}`);
  return value;
}

async function step(name: string, operation: () => Promise<unknown>) {
  const started = performance.now();
  const details = await operation();
  const result = { name, elapsedMs: Math.round(performance.now() - started), details };
  steps.push(result);
  console.log(JSON.stringify(result));
}

function assertRealInference(result: Json) {
  assert.equal(result.kind, 'ollama', 'A demo adapter cannot satisfy this integration check');
  assert.equal(result.model, generationModel);
  assert.ok(typeof result.text === 'string' && result.text.trim() && !result.text.includes('[DEMO:'));
  const usage = result.usage as Json;
  assert.ok(Number.isInteger(usage.inputTokens) && Number(usage.inputTokens) > 0, 'Real prompt token count missing');
  assert.ok(Number.isInteger(usage.outputTokens) && Number(usage.outputTokens) > 0, 'Real output token count missing');
}

async function verifyIsolatedFailover() {
  // Obtain a real local address, close its listener, then let the actual HTTP adapter fail.
  // The backup below is an Ollama model; no mocked inference adapter is involved.
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const unavailable = `http://127.0.0.1:${(reservation.address() as AddressInfo).port}`;
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));

  const usage = new UsageStore(':memory:');
  const gateway = new InferenceGateway([
    createProvider({ id: 'unreachable-primary', kind: 'ollama', baseUrl: unavailable, model: generationModel }),
    createProvider({ id: 'real-backup', kind: 'ollama', baseUrl: ollamaUrl, model: generationModel }),
  ], usage, {
    requestsPerMinute: 10, dailyBudget: 10, maxConcurrency: 1,
    providerTimeoutMs: timeoutMs, failureThreshold: 1, cooldownMs: 600_000,
  });
  const key = 'local-real-integration-key';
  const server = createApp(gateway, { [key]: 'isolated-integration' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const first = await json(base, '/v1/infer', {
      prompt: 'Responda em uma frase curta: para que serve um gateway de modelos?',
    }, key);
    assertRealInference(first);
    assert.equal(first.provider, 'real-backup');
    assert.equal(first.fallbackUsed, true);
    assert.deepEqual(first.attempted, ['unreachable-primary', 'real-backup']);
    assert.ok(gateway.circuits.snapshot().some(circuit => circuit.id === 'unreachable-primary' && circuit.state === 'open'));

    const second = await json(base, '/v1/infer', { prompt: 'Responda apenas com a palavra pronto.' }, key);
    assertRealInference(second);
    assert.deepEqual(second.attempted, ['real-backup'], 'An open circuit should skip the unreachable provider');
    assert.equal(second.fallbackUsed, true);
    const measured = await json(base, '/v1/usage', undefined, key);
    const successful = (measured.usage as Usage[]).find(row => row.status === 'ok');
    assert.equal(successful?.requests, 2);
    assert.ok(Number(successful?.inputTokens) >= Number((first.usage as Json).inputTokens) + Number((second.usage as Json).inputTokens));
    return {
      primaryFailure: 'real connection refused after closing a reserved local listener',
      first, second, circuits: gateway.circuits.snapshot(), usage: measured,
    };
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    usage.close();
  }
}

try {
  await step('real-model-preflight', async () => {
    const version = await json(ollamaUrl, '/api/version');
    const model = await json(ollamaUrl, '/api/show', { model: generationModel });
    assert.ok(Array.isArray(model.capabilities) && model.capabilities.includes('completion'));
    return { version: version.version, capabilities: model.capabilities, details: model.details };
  });
  await step('deployed-gateway-real-inference-and-accounting', async () => {
    const health = await json(gatewayUrl, '/health');
    assert.ok(Array.isArray(health.providers) && (health.providers as Json[]).length > 0);
    assert.ok((health.providers as Json[]).every(provider => provider.kind === 'ollama'));
    const before = await json(gatewayUrl, '/v1/usage', undefined, apiKey);
    const previousSuccess = (before.usage as Usage[]).find(row => row.status === 'ok')?.requests ?? 0;
    const result = await json(gatewayUrl, '/v1/infer', {
      prompt: 'Explique em uma frase curta o que é um gateway de modelos de IA.',
    }, apiKey);
    assertRealInference(result);
    const after = await json(gatewayUrl, '/v1/usage', undefined, apiKey);
    const successful = (after.usage as Usage[]).find(row => row.status === 'ok');
    assert.ok((successful?.requests ?? 0) >= previousSuccess + 1);
    assert.ok(Number(successful?.inputTokens) > 0 && Number(successful?.outputTokens) > 0);
    return { health, result, usageAfter: after };
  });
  await step('unreachable-primary-real-backup-and-open-circuit', verifyIsolatedFailover);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message : String(error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`Integration report: ${reportPath}; passed=${report.passed}`);
}
