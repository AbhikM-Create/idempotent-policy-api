import http from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import handler from '../api/policies.js';
import { issuePolicy, SimulatedCrash, type IssueOptions } from '../src/issuePolicy.js';

const LEASE = 1000; // short lease so crash/stall scenarios run quickly
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pool: pg.Pool;

beforeAll(() => {
  const url = inject('dbUrl');
  process.env.DATABASE_URL = url;
  process.env.LEASE_MS = String(LEASE);
  process.env.PG_POOL_MAX = '10';
  pool = new pg.Pool({ connectionString: url, max: 30 });
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query('TRUNCATE idempotency_keys, policies, events RESTART IDENTITY');
});

const body = (o: Record<string, unknown> = {}) => ({
  partner_id: 'P1',
  booking_id: 'BK-1',
  premium: 49,
  user: { name: 'Synthetic User', email: 'synthetic@example.com' },
  ...o,
});
const issue = (b: unknown, o: IssueOptions = {}) => issuePolicy(pool, b, { leaseMs: LEASE, ...o });
const policyCount = async (booking = 'BK-1', partner = 'P1') =>
  Number((await pool.query('SELECT count(*) FROM policies WHERE partner_id = $1 AND booking_id = $2', [partner, booking])).rows[0].count);
const eventCount = async (type: string, booking = 'BK-1') =>
  Number((await pool.query('SELECT count(*) FROM events WHERE type = $1 AND booking_id = $2', [type, booking])).rows[0].count);

describe('AC1 single request', () => {
  it('creates one policy and completes the key', async () => {
    const r = await issue(body());
    expect(r.status).toBe(201);
    expect(JSON.parse(r.body).policy_number).toMatch(/^POL-[0-9A-F]{8}$/);
    expect(await policyCount()).toBe(1);
    const key = await pool.query("SELECT status FROM idempotency_keys WHERE partner_id = 'P1' AND booking_id = 'BK-1'");
    expect(key.rows[0].status).toBe('completed');
  });
});

describe('AC2 sequential retry', () => {
  it('replays the byte-identical response and creates nothing new', async () => {
    const first = await issue(body());
    const retry = await issue(body());
    expect(retry.status).toBe(200);
    expect(retry.replayed).toBe(true);
    expect(retry.body).toBe(first.body);
    expect(await policyCount()).toBe(1);
  });
});

describe('AC3 concurrent identical requests', () => {
  it('20 simultaneous requests x 25 bookings: exactly one policy per booking, no 5xx', async () => {
    for (let k = 0; k < 25; k++) {
      const b = body({ booking_id: `BK-${k}` });
      const results = await Promise.all(Array.from({ length: 20 }, () => issue(b)));
      const statuses = results.map((r) => r.status);
      expect(statuses.every((s) => [200, 201, 409].includes(s))).toBe(true);
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      const created = results.find((r) => r.status === 201)!.body;
      results.filter((r) => r.status === 200).forEach((r) => expect(r.body).toBe(created));
      expect(await policyCount(`BK-${k}`)).toBe(1);
    }
    const total = Number((await pool.query('SELECT count(*) FROM policies')).rows[0].count);
    expect(total).toBe(25); // duplicate policies across 500 requests: 0
  });
});

describe('AC4 same key, different body', () => {
  it('rejects with 422 and leaves the policy untouched', async () => {
    await issue(body());
    const r = await issue(body({ premium: 59 }));
    expect(r.status).toBe(422);
    expect(JSON.parse(r.body).error).toBe('idempotency_key_reused');
    const p = await pool.query("SELECT premium FROM policies WHERE booking_id = 'BK-1'");
    expect(Number(p.rows[0].premium)).toBe(49);
  });
});

describe('AC5 key is scoped to the partner', () => {
  it('same booking_id from two partners creates two policies', async () => {
    const a = await issue(body({ partner_id: 'P1' }));
    const b = await issue(body({ partner_id: 'P2' }));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(JSON.parse(a.body).policy_number).not.toBe(JSON.parse(b.body).policy_number);
    expect(await policyCount('BK-1', 'P1')).toBe(1);
    expect(await policyCount('BK-1', 'P2')).toBe(1);
  });
});

describe('AC6 crash after claim', () => {
  it('409 while the lease runs, then a retry takes over and issues exactly one policy', async () => {
    await expect(issue(body(), { crashAfterClaim: true })).rejects.toBeInstanceOf(SimulatedCrash);
    const early = await issue(body());
    expect(early.status).toBe(409);
    expect(await policyCount()).toBe(0);

    await sleep(LEASE + 300);
    const late = await issue(body());
    expect(late.status).toBe(201);
    expect(await policyCount()).toBe(1);
  });
});

describe('AC7 two takeovers at the same moment', () => {
  it('exactly one wins the conditional update (10 repetitions)', async () => {
    for (let k = 0; k < 10; k++) {
      const b = body({ booking_id: `BK-T${k}` });
      await expect(issue(b, { crashAfterClaim: true })).rejects.toBeInstanceOf(SimulatedCrash);
      await sleep(LEASE + 200);
      const [x, y] = await Promise.all([issue(b), issue(b)]);
      expect([x.status, y.status].filter((s) => s === 201)).toHaveLength(1);
      expect(await policyCount(`BK-T${k}`)).toBe(1);
      expect(await eventCount('takeover_won', `BK-T${k}`)).toBe(1);
    }
  });
});

describe('AC8 stalled original is fenced off', () => {
  it('the original wakes after a takeover, its write matches 0 rows, and it rolls back', async () => {
    const original = issue(body(), { stallMs: LEASE + 800 });
    await sleep(LEASE + 300);
    const takeover = await issue(body());
    expect(takeover.status).toBe(201);

    const late = await original;
    expect(late.status).toBe(409);
    expect(JSON.parse(late.body).error).toBe('ownership_lost');
    expect(await policyCount()).toBe(1);
    expect(await eventCount('fenced_rollback')).toBe(1);

    const stored = await pool.query("SELECT response_body FROM idempotency_keys WHERE booking_id = 'BK-1'");
    expect(stored.rows[0].response_body).toBe(takeover.body);
  });
});

describe('AC9 invalid input', () => {
  it.each([
    ['missing premium', { premium: undefined }],
    ['negative premium', { premium: -5 }],
    ['premium as string', { premium: '49' }],
    ['missing user', { user: undefined }],
    ['blank booking_id', { booking_id: '  ' }],
  ])('%s returns 400 and writes nothing', async (_name, override) => {
    const r = await issue(body(override));
    expect(r.status).toBe(400);
    const keys = Number((await pool.query('SELECT count(*) FROM idempotency_keys')).rows[0].count);
    const pols = Number((await pool.query('SELECT count(*) FROM policies')).rows[0].count);
    expect(keys + pols).toBe(0);
  });
  it('non-object body returns 400', async () => {
    expect((await issue([1, 2])).status).toBe(400);
  });
});

describe('HTTP handler wiring', () => {
  it('serves 201, then 200 with the replay header, and drops the connection on simulated crash', async () => {
    const server = http.createServer((req, res) => void handler(req, res));
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/policies`;
    const post = (b: unknown, qs = '') =>
      fetch(base + qs, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    try {
      const first = await post(body({ booking_id: 'BK-H' }));
      expect(first.status).toBe(201);
      const again = await post(body({ booking_id: 'BK-H' }));
      expect(again.status).toBe(200);
      expect(again.headers.get('idempotent-replayed')).toBe('true');
      await expect(post(body({ booking_id: 'BK-C' }), '?simulate=crash')).rejects.toThrow();
      expect((await fetch(base)).status).toBe(405);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
