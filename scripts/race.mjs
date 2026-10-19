// Live race check (AC3 on the deployed system): N simultaneous FIRST requests for a fresh booking,
// then count policies for that booking straight from the database.
// Usage: node --env-file=.env scripts/race.mjs https://<your-app>.vercel.app [N]
import pg from 'pg';

const base = process.argv[2];
const n = Number(process.argv[3] ?? 20);
if (!base || !process.env.DATABASE_URL) {
  console.error('Usage: node --env-file=.env scripts/race.mjs https://<your-app>.vercel.app [N]');
  process.exit(1);
}
const booking = `RACE-${Date.now()}`;
const payload = JSON.stringify({
  partner_id: 'P-RACE',
  booking_id: booking,
  premium: 49,
  user: { name: 'Synthetic User', email: 'synthetic@example.com' },
});

const responses = await Promise.all(
  Array.from({ length: n }, () =>
    fetch(`${base.replace(/\/$/, '')}/api/policies`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload })
      .then(async (r) => ({ status: r.status, body: await r.text() })),
  ),
);
const tally = responses.reduce((t, r) => ({ ...t, [r.status]: (t[r.status] ?? 0) + 1 }), {});
const numbers = new Set(responses.filter((r) => r.status === 200 || r.status === 201).map((r) => JSON.parse(r.body).policy_number));

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const { rows } = await db.query('SELECT count(*)::int AS c FROM policies WHERE partner_id = $1 AND booking_id = $2', ['P-RACE', booking]);
await db.end();

console.log(`booking ${booking}: ${n} simultaneous first requests`);
console.log('status tally:', JSON.stringify(tally));
console.log('distinct policy numbers returned:', numbers.size);
console.log('policies in database for this booking:', rows[0].c);
const ok = rows[0].c === 1 && numbers.size === 1 && !Object.keys(tally).some((s) => Number(s) >= 500);
console.log(ok ? 'PASS  exactly one policy, no 5xx' : 'FAIL');
process.exit(ok ? 0 : 1);
