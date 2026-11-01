export type InferenceResult = { text: string; inputTokens: number | null; outputTokens: number | null; model: string };
export type Provider = { id: string; kind: string; infer: (prompt: string, signal: AbortSignal) => Promise<InferenceResult> };
export type ProviderConfig = { id: string; kind: 'demo' | 'ollama'; baseUrl?: string; model?: string };

export function createProvider(config: ProviderConfig): Provider {
  if (config.kind === 'demo') return {
    id: config.id, kind: 'demo',
    async infer(prompt, signal) {
      signal.throwIfAborted();
      return { text: `[DEMO: sem inferencia real] Recebidos ${prompt.length} caracteres.`, inputTokens: null, outputTokens: null, model: 'deterministic-demo' };
    },
  };
  if (config.kind !== 'ollama' || !config.baseUrl || !config.model) throw new Error('Provedor Ollama precisa de baseUrl e model.');
  const baseUrl = new URL(config.baseUrl);
  if (!['http:', 'https:'].includes(baseUrl.protocol)) throw new Error('baseUrl precisa ser HTTP(S).');
  return {
    id: config.id, kind: 'ollama',
    async infer(prompt, signal) {
      const response = await fetch(new URL('/api/generate', baseUrl), { method: 'POST',
        headers: { 'content-type': 'application/json' }, signal,
        body: JSON.stringify({ model: config.model, prompt, stream: false, options: { num_predict: 512 } }) });
      if (!response.ok) throw new Error(`Provider HTTP ${response.status}`);
      const body = await response.json() as Record<string, unknown>;
      if (typeof body.response !== 'string' || !body.response.trim() || body.response.length > 100_000) throw new Error('Invalid provider response');
      const tokenCount = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
      return { text: body.response, inputTokens: tokenCount(body.prompt_eval_count), outputTokens: tokenCount(body.eval_count), model: config.model! };
    },
  };
}
