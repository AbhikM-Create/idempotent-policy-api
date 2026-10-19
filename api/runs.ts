import type { IncomingMessage, ServerResponse } from 'node:http';
import { getPool } from '../src/db.js';
import { getRun, RUN_ID_PATTERN } from '../src/runs.js';

// GET /api/runs?id=<run_id>: read-only snapshot of one demo run (events + affected rows).
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (status: number, payload: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(payload));
  };
  if (req.method !== 'GET') return send(405, { error: 'method_not_allowed' });
  const id = new URL(req.url ?? '/', 'http://localhost').searchParams.get('id') ?? '';
  if (!RUN_ID_PATTERN.test(id)) return send(400, { error: 'invalid_run_id' });
  try {
    send(200, await getRun(getPool(), id));
  } catch (err) {
    console.error(err);
    send(500, { error: 'internal_error' });
  }
}
