import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { GatewayError } from './errors.ts';
import { InferenceGateway } from './gateway.ts';

async function json(request: IncomingMessage): Promise<Record<string, unknown>> {
  const buffers: Buffer[] = []; let bytes = 0;
  for await (const part of request) {
    const buffer = Buffer.from(part as Uint8Array); bytes += buffer.length;
    if (bytes > 80_000) throw new GatewayError(413, 'body_too_large', 'Limite de 80 KB por requisicao.');
    buffers.push(buffer);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(buffers).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch { throw new GatewayError(400, 'invalid_json', 'Envie um objeto JSON valido.'); }
}

export function createApp(gateway: InferenceGateway, keys: Record<string, string>) {
  const server = createServer(async (request, response) => {
    const requestId = randomUUID();
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('x-request-id', requestId);
    response.setHeader('x-content-type-options', 'nosniff');
    try {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      let body: unknown;
      if (request.method === 'GET' && path === '/health') {
        body = { status: 'ok', providers: gateway.providers.map(({ id, kind }) => ({ id, kind })), active: gateway.active };
      } else {
        const token = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
        const client = Object.hasOwn(keys, token) ? keys[token] : undefined;
        if (!client) throw new GatewayError(401, 'unauthorized', 'Bearer token ausente ou invalido.');
        if (request.method === 'GET' && path === '/v1/usage') body = gateway.metrics(client);
        else if (request.method === 'POST' && path === '/v1/infer') {
          const input = await json(request);
          if (typeof input.prompt !== 'string') throw new GatewayError(400, 'invalid_prompt', 'prompt precisa ser texto.');
          body = await gateway.infer(client, input.prompt, requestId);
        } else throw new GatewayError(404, 'not_found', 'Rota nao encontrada.');
      }
      response.writeHead(200); response.end(JSON.stringify(body));
    } catch (error) {
      const known = error instanceof GatewayError;
      if (known && error.retryAfterSeconds) response.setHeader('retry-after', error.retryAfterSeconds);
      response.writeHead(known ? error.status : 500);
      response.end(JSON.stringify({ error: { code: known ? error.code : 'internal_error',
        message: known ? error.message : 'Falha interna.', requestId } }));
    }
  });
  server.requestTimeout = 30_000; server.headersTimeout = 10_000;
  return server;
}
