import type { IncomingMessage, ServerResponse } from 'node:http';
import { getPool } from '../src/db.js';
import { issuePolicy, SimulatedCrash } from '../src/issuePolicy.js';

type Req = IncomingMessage & { body?: unknown };

async function readJson(req: Req): Promise<unknown> {
  if (req.body !== undefined) return req.body; // Vercel pre-parses JSON bodies
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return Symbol.for('invalid-json');
  }
}

export default async function handler(req: Req, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
    res.end(JSON.stringify({ error: 'method_not_allowed' }));
    return;
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  const body = await readJson(req);
  if (body === Symbol.for('invalid-json')) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_json' }));
    return;
  }

  // Demo-only fault injection, so the visualiser can show crash and stall behaviour on demand.
  const simulate = url.searchParams.get('simulate');
  const stallMs = Math.min(Number(url.searchParams.get('stall_ms') ?? 0) || 0, 10_000);

  try {
    const result = await issuePolicy(getPool(), body, {
      runId: (req.headers['x-run-id'] as string | undefined) ?? undefined,
      requestId: (req.headers['x-request-id'] as string | undefined) ?? undefined,
      crashAfterClaim: simulate === 'crash',
      stallMs: stallMs > 0 ? stallMs : undefined,
    });
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (result.replayed) headers['idempotent-replayed'] = 'true';
    res.writeHead(result.status, headers);
    res.end(result.body);
  } catch (err) {
    if (err instanceof SimulatedCrash) {
      // Drop the connection without a response: from the client's side this is a server dying mid-request.
      res.destroy();
      return;
    }
    console.error(err);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal_error' }));
  }
}
