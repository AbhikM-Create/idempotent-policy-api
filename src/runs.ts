import type pg from 'pg';

export const RUN_ID_PATTERN = /^[A-Za-z0-9-]{4,64}$/;

export interface RunSnapshot {
  run_id: string;
  events: Array<{ id: number; request_id: string; partner_id: string | null; booking_id: string | null; type: string; detail: Record<string, unknown>; at: string }>;
  keys: Array<Record<string, unknown>>;
  policies: Array<Record<string, unknown>>;
}

// Everything the visualiser shows comes from here: the recorded events in insertion order,
// plus the current rows for every key those events touched.
export async function getRun(pool: pg.Pool, runId: string): Promise<RunSnapshot> {
  const events = await pool.query(
    `SELECT id::int, request_id, partner_id, booking_id, type, detail, at
     FROM events WHERE run_id = $1 ORDER BY id LIMIT 500`,
    [runId],
  );
  const keys = await pool.query(
    `SELECT k.partner_id, k.booking_id, k.status, k.owner_token, k.locked_until, k.response_code, k.request_hash, k.updated_at
     FROM idempotency_keys k
     WHERE (k.partner_id, k.booking_id) IN (SELECT DISTINCT partner_id, booking_id FROM events WHERE run_id = $1 AND booking_id IS NOT NULL)
     ORDER BY k.booking_id`,
    [runId],
  );
  const policies = await pool.query(
    `SELECT p.policy_number, p.partner_id, p.booking_id, p.premium, p.created_at
     FROM policies p
     WHERE (p.partner_id, p.booking_id) IN (SELECT DISTINCT partner_id, booking_id FROM events WHERE run_id = $1 AND booking_id IS NOT NULL)
     ORDER BY p.created_at`,
    [runId],
  );
  return { run_id: runId, events: events.rows, keys: keys.rows, policies: policies.rows };
}
