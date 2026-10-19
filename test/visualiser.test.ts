import http from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import runsHandler from '../api/runs.js';
import { issuePolicy, SimulatedCrash } from '../src/issuePolicy.js';
import { getRun } from '../src/runs.js';
// The exact module the browser loads.
// @ts-expect-error plain JS module without type declarations
import { DESCRIBE, replay } from '../public/replay.js';

const LEASE = 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pool: pg.Pool;

beforeAll(() => {
  const url = inject('dbUrl');
  process.env.DATABASE_URL = url;
  pool = new pg.Pool({ connectionString: url, max: 30 });
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query('TRUNCATE idempotency_keys, policies, events RESTART IDENTITY');
});

const body = (booking: string, o: Record<string, unknown> = {}) => ({
  partner_id: 'P-DEMO',
  booking_id: booking,
  premium: 49,
  user: { name: 'Synthetic User', email: 'synthetic@example.com' },
  ...o,
});
const send = (runId: string, requestId: string, b: unknown, o: Record<string, unknown> = {}) =>
  issuePolicy(pool, b, { runId, requestId, leaseMs: LEASE, ...o });

describe('AC10 the map is derived only from recorded events', () => {
  it('every recorded event is replayed, and every event type has a description', async () => {
    const run = 'run-ac10';
    await Promise.all(Array.from({ length: 8 }, (_, i) => send(run, `r${i + 1}`, body('B-10'))));
    const snap = await getRun(pool, run);
    expect(snap.events.length).toBeGreaterThan(8);
    const state = replay(snap.events);
    expect(state.applied).toBe(snap.events.length); // map count == event count, nothing added or skipped
    snap.events.forEach((e) => expect(DESCRIBE[e.type], `no description for ${e.type}`).toBeDefined());
    // ids are strictly increasing: the replay order is the order the server wrote them
    snap.events.forEach((e, i) => i && expect(e.id).toBeGreaterThan(snap.events[i - 1].id));
  });

  it('a different run id sees none of these events', async () => {
    await send('run-a', 'r1', body('B-A'));
    expect((await getRun(pool, 'run-b')).events).toHaveLength(0);
  });
});

describe('AC11 twenty simultaneous requests', () => {
  it('replay shows exactly one claim winner and one policy; the DB agrees', async () => {
    const run = 'run-ac11';
    await Promise.all(Array.from({ length: 20 }, (_, i) => send(run, `r${i + 1}`, body('B-11'))));
    const snap = await getRun(pool, run);
    const state = replay(snap.events);
    expect(state.order).toHaveLength(20);
    expect(snap.events.filter((e) => e.type === 'claim_won')).toHaveLength(1);
    expect(Object.values(state.requests).filter((r: any) => r.phase === 'created')).toHaveLength(1);
    expect(state.policiesCreated).toBe(1);
    expect(snap.policies).toHaveLength(1);
    expect(snap.keys[0].status).toBe('completed');
  });
});

describe('Failure scenarios replay correctly', () => {
  it('crash: owner marked crashed, a later request takes over and creates the policy', async () => {
    const run = 'run-crash';
    await expect(send(run, 'r1', body('B-C'), { crashAfterClaim: true })).rejects.toBeInstanceOf(SimulatedCrash);
    expect((await send(run, 'r2', body('B-C'))).status).toBe(409);
    const mid = replay((await getRun(pool, run)).events);
    expect(mid.key.owner).toBe('r1');
    expect(mid.key.ownerCrashed).toBe(true);
    await sleep(LEASE + 300);
    expect((await send(run, 'r3', body('B-C'))).status).toBe(201);
    const end = replay((await getRun(pool, run)).events);
    expect(end.key.owner).toBe('r3');
    expect(end.requests.r3.phase).toBe('created');
    expect(end.policiesCreated).toBe(1);
  });

  it('stall: the stalled original ends fenced, the takeover ends created', async () => {
    const run = 'run-stall';
    const original = send(run, 'r1', body('B-S'), { stallMs: LEASE + 800 });
    await sleep(LEASE + 300);
    expect((await send(run, 'r2', body('B-S'))).status).toBe(201);
    expect((await original).status).toBe(409);
    const end = replay((await getRun(pool, run)).events);
    expect(end.requests.r1.phase).toBe('fenced');
    expect(end.requests.r2.phase).toBe('created');
    expect(end.policiesCreated).toBe(1);
  });
});

describe('GET /api/runs handler', () => {
  it('validates the id, rejects POST, and returns the snapshot', async () => {
    await send('run-http', 'r1', body('B-H'));
    const server = http.createServer((req, res) => void runsHandler(req, res));
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/runs`;
    try {
      expect((await fetch(`${base}?id=bad id!`)).status).toBe(400);
      expect((await fetch(`${base}?id=run-http`, { method: 'POST' })).status).toBe(405);
      const ok = await fetch(`${base}?id=run-http`);
      expect(ok.status).toBe(200);
      const snap = await ok.json();
      expect(snap.events.map((e: any) => e.type)).toEqual(['received', 'claim_won', 'policy_created']);
      expect(snap.policies).toHaveLength(1);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
