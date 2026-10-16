import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { validate, type PolicyRequest } from './validate.js';

export interface IssueResult {
  status: number;
  body: string; // exact bytes sent to the client
  replayed?: boolean;
}

export interface IssueOptions {
  runId?: string;
  requestId?: string;
  leaseMs?: number;
  /** Demo/test only: abandon the request right after claiming the key, like a server dying. */
  crashAfterClaim?: boolean;
  /** Demo/test only: pause after claiming, like a GC pause or a slow downstream call. */
  stallMs?: number;
}

export class SimulatedCrash extends Error {
  constructor() {
    super('simulated crash after claim');
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Key order is fixed so the same logical request always hashes the same.
function requestHash(r: PolicyRequest): string {
  const canonical = JSON.stringify({
    partner_id: r.partner_id,
    booking_id: r.booking_id,
    premium: r.premium,
    user: { name: r.user.name, email: r.user.email },
  });
  return createHash('sha256').update(canonical).digest('hex');
}

const json = (status: number, payload: unknown): IssueResult => ({ status, body: JSON.stringify(payload) });

export async function issuePolicy(pool: pg.Pool, rawBody: unknown, opts: IssueOptions = {}): Promise<IssueResult> {
  const requestId = opts.requestId ?? randomUUID();
  const leaseMs = opts.leaseMs ?? Number(process.env.LEASE_MS ?? 3000);

  const log = async (type: string, detail: Record<string, unknown> = {}, key?: PolicyRequest) => {
    // Logged on the pool, outside any transaction, so a rollback cannot erase the record of what happened.
    await pool.query(
      'INSERT INTO events (run_id, request_id, partner_id, booking_id, type, detail) VALUES ($1, $2, $3, $4, $5, $6)',
      [opts.runId ?? null, requestId, key?.partner_id ?? null, key?.booking_id ?? null, type, detail],
    );
  };

  const v = validate(rawBody);
  if (!v.ok) {
    await log('rejected_invalid', { errors: v.errors });
    return json(400, { error: 'invalid_request', details: v.errors });
  }
  const req = v.value;
  const hash = requestHash(req);
  const token = randomUUID();
  await log('received', { premium: req.premium }, req);

  // Step 1: claim the key. The primary key lets exactly one INSERT win; everyone else gets nothing back.
  const claim = await pool.query(
    `INSERT INTO idempotency_keys (partner_id, booking_id, request_hash, status, owner_token, locked_until)
     VALUES ($1, $2, $3, 'processing', $4, now() + make_interval(secs => $5::double precision / 1000))
     ON CONFLICT (partner_id, booking_id) DO NOTHING
     RETURNING owner_token`,
    [req.partner_id, req.booking_id, hash, token, leaseMs],
  );

  let owns = claim.rowCount === 1;
  if (owns) {
    await log('claim_won', { lease_ms: leaseMs }, req);
  } else {
    await log('claim_duplicate_key', {}, req);
    const { rows } = await pool.query(
      `SELECT request_hash, status, response_code, response_body, locked_until < now() AS lease_expired
       FROM idempotency_keys WHERE partner_id = $1 AND booking_id = $2`,
      [req.partner_id, req.booking_id],
    );
    const existing = rows[0];

    if (existing.request_hash !== hash) {
      await log('rejected_key_reused', {}, req);
      return json(422, {
        error: 'idempotency_key_reused',
        message: `booking_id ${req.booking_id} was already used with different parameters`,
      });
    }

    if (existing.status === 'completed') {
      await log('replayed', { original_status: existing.response_code }, req);
      return { status: 200, body: existing.response_body, replayed: true };
    }

    if (!existing.lease_expired) {
      await log('in_progress', {}, req);
      return json(409, { error: 'in_progress', message: 'request is being processed; retry later' });
    }

    // Step 2: lease expired, so the owner is presumed dead. One conditional write decides who takes over.
    const takeover = await pool.query(
      `UPDATE idempotency_keys
       SET owner_token = $3, locked_until = now() + make_interval(secs => $4::double precision / 1000), updated_at = now()
       WHERE partner_id = $1 AND booking_id = $2 AND status = 'processing' AND locked_until < now()`,
      [req.partner_id, req.booking_id, token, leaseMs],
    );
    owns = takeover.rowCount === 1;
    await log(owns ? 'takeover_won' : 'takeover_lost', { rows_affected: takeover.rowCount }, req);
    if (!owns) {
      return json(409, { error: 'in_progress', message: 'request is being processed; retry later' });
    }
  }

  if (opts.crashAfterClaim) {
    await log('simulated_crash', {}, req);
    throw new SimulatedCrash();
  }
  if (opts.stallMs) {
    await log('stall_start', { stall_ms: opts.stallMs }, req);
    await sleep(opts.stallMs);
    await log('stall_end', {}, req);
  }

  // Step 3: do the work and mark it complete in one transaction, but only if we still own the key.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fence = await client.query(
      `SELECT 1 FROM idempotency_keys
       WHERE partner_id = $1 AND booking_id = $2 AND owner_token = $3 AND status = 'processing'
       FOR UPDATE`,
      [req.partner_id, req.booking_id, token],
    );
    if (fence.rowCount !== 1) {
      await client.query('ROLLBACK');
      await log('fenced_rollback', { reason: 'ownership lost while stalled' }, req);
      return json(409, { error: 'ownership_lost', message: 'another server took over this request; retry to get its result' });
    }

    const policyNumber = `POL-${randomUUID().slice(0, 8).toUpperCase()}`;
    await client.query(
      'INSERT INTO policies (policy_number, partner_id, booking_id, premium) VALUES ($1, $2, $3, $4)',
      [policyNumber, req.partner_id, req.booking_id, req.premium],
    );
    const result = json(201, {
      policy_number: policyNumber,
      partner_id: req.partner_id,
      booking_id: req.booking_id,
      premium: req.premium,
      status: 'issued',
    });
    await client.query(
      `UPDATE idempotency_keys
       SET status = 'completed', response_code = $4, response_body = $5, updated_at = now()
       WHERE partner_id = $1 AND booking_id = $2 AND owner_token = $3`,
      [req.partner_id, req.booking_id, token, result.status, result.body],
    );
    await client.query('COMMIT');
    await log('policy_created', { policy_number: policyNumber }, req);
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
