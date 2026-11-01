import { DatabaseSync } from 'node:sqlite';
import { GatewayError } from './errors.ts';

export class UsageStore {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, client TEXT NOT NULL, day TEXT NOT NULL, status TEXT NOT NULL,
        provider TEXT, attempts INTEGER NOT NULL DEFAULT 0, elapsed_ms REAL NOT NULL DEFAULT 0,
        prompt_chars INTEGER NOT NULL, output_chars INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER, output_tokens INTEGER);
      CREATE INDEX IF NOT EXISTS requests_client_day ON requests(client, day);`);
  }
  reserve(id: string, client: string, day: string, promptChars: number, budget: number) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT COUNT(*) as count FROM requests WHERE client = ? AND day = ?').get(client, day);
      if (Number(row!.count) >= budget) throw new GatewayError(429, 'daily_budget', 'Orcamento diario de requisicoes atingido.');
      this.db.prepare('INSERT INTO requests (id, client, day, status, prompt_chars) VALUES (?, ?, ?, ?, ?)').run(id, client, day, 'running', promptChars);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  finish(id: string, status: 'ok' | 'failed', provider: string | null, attempts: number, elapsedMs: number,
    outputChars = 0, inputTokens: number | null = null, outputTokens: number | null = null) {
    this.db.prepare(`UPDATE requests SET status=?, provider=?, attempts=?, elapsed_ms=?, output_chars=?, input_tokens=?, output_tokens=? WHERE id=?`)
      .run(status, provider, attempts, elapsedMs, outputChars, inputTokens, outputTokens, id);
  }
  metrics(client: string, day: string) {
    const rows = this.db.prepare(`SELECT status, COUNT(*) as count, AVG(elapsed_ms) as avg_ms,
      SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens,
      COUNT(input_tokens) as known_input, COUNT(output_tokens) as known_output
      FROM requests WHERE client=? AND day=? GROUP BY status`).all(client, day);
    return rows.map(row => ({ status: String(row.status), requests: Number(row.count), averageLatencyMs: Number(row.avg_ms),
      inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
      outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
      requestsWithInputTokens: Number(row.known_input), requestsWithOutputTokens: Number(row.known_output) }));
  }
  close() { this.db.close(); }
}
