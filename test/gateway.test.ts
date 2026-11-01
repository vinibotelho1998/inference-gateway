import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InferenceGateway } from '../src/gateway.ts';
import { UsageStore } from '../src/usage.ts';
import { createProvider } from '../src/providers.ts';
import type { Provider } from '../src/providers.ts';
import { CircuitBreaker, RateLimiter, withDeadline } from '../src/policies.ts';
import { createApp } from '../src/http.ts';

const config = { requestsPerMinute: 30, dailyBudget: 10, maxConcurrency: 2, providerTimeoutMs: 30, failureThreshold: 1, cooldownMs: 1000 };
const demo = () => createProvider({ id: 'backup', kind: 'demo' });
const failed: Provider = { id: 'failed', kind: 'test', infer: async () => { throw new Error('provider unavailable'); } };

test('fallback returns the successful provider and counts one request with two attempts', async () => {
  const store = new UsageStore(':memory:');
  const gateway = new InferenceGateway([failed, demo()], store, config);
  try {
    const result = await gateway.infer('client', 'test');
    assert.equal(result.provider, 'backup'); assert.equal(result.fallbackUsed, true);
    assert.deepEqual(result.attempted, ['failed', 'backup']);
    assert.equal(gateway.metrics('client').usage[0]!.requests, 1);
    assert.equal(gateway.metrics('client').usage[0]!.inputTokens, null);
    assert.equal(gateway.metrics('client').usage[0]!.requestsWithInputTokens, 0);
    const second = await gateway.infer('client', 'again');
    assert.deepEqual(second.attempted, ['backup']);
  } finally { store.close(); }
});
test('failed requests consume daily budget and another client has a separate budget', async () => {
  const store = new UsageStore(':memory:');
  const gateway = new InferenceGateway([failed], store, { ...config, dailyBudget: 1 });
  try {
    await assert.rejects(gateway.infer('a', 'hello'), { code: 'providers_unavailable' });
    await assert.rejects(gateway.infer('a', 'again'), { code: 'daily_budget' });
    await assert.rejects(gateway.infer('b', 'hello'), { code: 'providers_unavailable' });
    assert.equal(gateway.metrics('a').usage[0]!.status, 'failed');
    assert.equal(gateway.active, 0);
  } finally { store.close(); }
});
test('a saturated gateway does not reserve quota for a rejected request', async () => {
  const store = new UsageStore(':memory:');
  let finish: (() => void) | undefined;
  const blocking: Provider = { id: 'blocking', kind: 'test', infer: async () => {
    await new Promise<void>(resolve => { finish = resolve; });
    return { text: 'ok', model: 'test', inputTokens: 1, outputTokens: 1 };
  } };
  const gateway = new InferenceGateway([blocking], store, { ...config, maxConcurrency: 1, providerTimeoutMs: 1000 });
  try {
    const first = gateway.infer('a', 'hello');
    await assert.rejects(gateway.infer('b', 'hello'), { code: 'busy' });
    assert.deepEqual(gateway.metrics('b').usage, []);
    finish!(); await first;
    assert.equal(gateway.active, 0);
  } finally { store.close(); }
});
test('deadline aborts a hanging adapter and allows fallback', async () => {
  const store = new UsageStore(':memory:'); let aborted = false;
  const hanging: Provider = { id: 'hanging', kind: 'test', infer: async (_prompt, signal) => {
    signal.addEventListener('abort', () => { aborted = true; });
    return new Promise(() => {});
  } };
  try {
    const gateway = new InferenceGateway([hanging, demo()], store, config);
    assert.equal((await gateway.infer('a', 'hello')).provider, 'backup');
    assert.equal(aborted, true);
  } finally { store.close(); }
});
test('fast operations clear the deadline timer', async () => {
  assert.equal(await withDeadline(1000, async () => 42), 42);
});
test('circuit permits only one half-open probe and recovers after success', () => {
  let now = 0; const breaker = new CircuitBreaker(1, 100, () => now);
  breaker.failure('primary'); assert.equal(breaker.acquire('primary'), false);
  now = 100; assert.equal(breaker.acquire('primary'), true);
  assert.equal(breaker.acquire('primary'), false);
  breaker.success('primary'); assert.equal(breaker.acquire('primary'), true);
});
test('rate limit resets at the end of its window without affecting another client', () => {
  let now = 0; const limiter = new RateLimiter(1, () => now);
  limiter.consume('a'); limiter.consume('b');
  assert.throws(() => limiter.consume('a'), { code: 'rate_limit' });
  now = 60_000; limiter.consume('a');
});
test('daily reservation survives a restart and rolls back when budget is exhausted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-test-'));
  let store = new UsageStore(join(dir, 'usage.sqlite'));
  try {
    store.reserve('1', 'a', '2026-01-01', 5, 1); store.close();
    store = new UsageStore(join(dir, 'usage.sqlite'));
    assert.throws(() => store.reserve('2', 'a', '2026-01-01', 5, 1), { code: 'daily_budget' });
    assert.equal(store.metrics('a', '2026-01-01')[0]!.requests, 1);
    store.reserve('3', 'a', '2026-01-02', 5, 1);
    assert.equal(store.metrics('a', '2026-01-02')[0]!.requests, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('usage distinguishes partial token accounting from zero usage', () => {
  const store = new UsageStore(':memory:');
  try {
    store.reserve('a', 'client', '2026-01-01', 5, 10);
    store.reserve('b', 'client', '2026-01-01', 5, 10);
    store.finish('a', 'ok', 'primary', 1, 1, 3, 5, 2);
    store.finish('b', 'ok', 'primary', 1, 1, 3, null, null);
    const metrics = store.metrics('client', '2026-01-01')[0]!;
    assert.equal(metrics.requests, 2); assert.equal(metrics.inputTokens, 5);
    assert.equal(metrics.requestsWithInputTokens, 1); assert.equal(metrics.requestsWithOutputTokens, 1);
  } finally { store.close(); }
});
test('HTTP authentication and usage isolation prevent cross-client access', async () => {
  const store = new UsageStore(':memory:');
  const gateway = new InferenceGateway([demo()], store, config);
  const server = createApp(gateway, { 'key-client-a': 'a', 'key-client-b': 'b' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/v1/usage`)).status, 401);
    const headers = { authorization: 'Bearer key-client-a', 'content-type': 'application/json' };
    assert.equal((await fetch(`${base}/v1/infer`, { method: 'POST', headers, body: '{' })).status, 400);
    assert.equal((await fetch(`${base}/v1/infer`, { method: 'POST', headers, body: JSON.stringify({ prompt: '   ' }) })).status, 400);
    const response = await fetch(`${base}/v1/infer`, { method: 'POST', headers, body: JSON.stringify({ prompt: 'hello', client: 'b' }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { kind: string }).kind, 'demo');
    const usage = await fetch(`${base}/v1/usage`, { headers: { authorization: 'Bearer key-client-b' } });
    assert.deepEqual((await usage.json() as { usage: unknown[] }).usage, []);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});
test('Ollama adapter sends a real protocol request and validates response', async () => {
  let sent: Record<string, unknown> = {}; let valid = true;
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += String(part);
    sent = JSON.parse(raw) as Record<string, unknown>;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(valid ? { response: 'resposta', prompt_eval_count: 5, eval_count: 2 } : { response: 123 }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const provider = createProvider({ id: 'local', kind: 'ollama', model: 'test-model', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
  try {
    assert.equal((await provider.infer('hello', new AbortController().signal)).outputTokens, 2);
    assert.equal(sent.model, 'test-model'); assert.equal(sent.stream, false);
    valid = false; await assert.rejects(provider.infer('hello', new AbortController().signal), /Invalid/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
