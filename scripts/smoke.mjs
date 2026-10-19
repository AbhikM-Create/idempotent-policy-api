// End-to-end check against a deployed URL: node scripts/smoke.mjs https://<your-app>.vercel.app
// Uses a fresh synthetic booking each run, so it never collides with earlier runs.
const base = process.argv[2];
if (!base) {
  console.error('Usage: node scripts/smoke.mjs https://<your-app>.vercel.app');
  process.exit(1);
}
const url = `${base.replace(/\/$/, '')}/api/policies`;
const booking = `SMOKE-${Date.now()}`;
const body = (premium = 49) => ({
  partner_id: 'P-SMOKE',
  booking_id: booking,
  premium,
  user: { name: 'Synthetic User', email: 'synthetic@example.com' },
});
const post = (b) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

const checks = [];
const check = (name, ok, detail) => {
  checks.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const first = await post(body());
const firstText = await first.text();
check('first request returns 201', first.status === 201, `got ${first.status}`);

const retry = await post(body());
const retryText = await retry.text();
check('retry returns 200 with identical body', retry.status === 200 && retryText === firstText, `got ${retry.status}`);
check('retry carries idempotent-replayed header', retry.headers.get('idempotent-replayed') === 'true');

const burst = await Promise.all(Array.from({ length: 10 }, () => post(body())));
const burstStatuses = burst.map((r) => r.status);
check('10 parallel retries: all 200 or 409, no 5xx', burstStatuses.every((s) => s === 200 || s === 409), burstStatuses.join(','));

const changed = await post(body(59));
check('same key, different premium returns 422', changed.status === 422, `got ${changed.status}`);

const bad = await post({ partner_id: 'P-SMOKE' });
check('invalid body returns 400', bad.status === 400, `got ${bad.status}`);

const failed = checks.filter((c) => !c).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed against ${url}`);
process.exit(failed ? 1 : 0);
