import { DESCRIBE, replay } from './replay.js';

const LEASE_MS = 3000; // must match the server's LEASE_MS
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const SCENARIOS = {
  single: {
    label: 'Single request',
    desc: 'One request. Expect 201 and exactly one policy.',
    run: (ctx) => ctx.send('r1'),
  },
  retry: {
    label: 'Retry after success',
    desc: 'The same request twice, one after the other. The retry should get the stored response (200), not a new policy.',
    run: async (ctx) => { await ctx.send('r1'); await ctx.send('r2'); },
  },
  burst: {
    label: '20 simultaneous requests',
    desc: '20 identical requests fired at once. Exactly one should win the claim; the rest get 409 or the replayed 200.',
    run: (ctx) => Promise.all(Array.from({ length: 20 }, (_, i) => ctx.send(`r${i + 1}`))),
  },
  body: {
    label: 'Same key, different premium',
    desc: 'A request, then the same booking with premium 59 instead of 49. The second should be rejected with 422.',
    run: async (ctx) => { await ctx.send('r1'); await ctx.send('r2', { premium: 59 }, '', 'premium 59'); },
  },
  crash: {
    label: 'Server crashes mid-request',
    desc: 'r1 claims the key and its connection drops. r2 retries at once (lease still running → 409). r3 retries after the lease expires and takes over.',
    run: async (ctx) => {
      await ctx.send('r1', {}, '?simulate=crash', 'crash after claim');
      await ctx.send('r2', {}, '', 'immediate retry');
      await sleep(LEASE_MS + 600);
      await ctx.send('r3', {}, '', `retry after ${LEASE_MS + 600} ms`);
    },
  },
  stall: {
    label: 'Stalled server gets fenced off',
    desc: 'r1 claims and stalls for 5 s. After the lease expires, r2 takes over and issues the policy. When r1 wakes, its ownership check fails and it rolls back.',
    run: async (ctx) => {
      const original = ctx.send('r1', {}, '?stall_ms=5000', 'stalls 5 s');
      await sleep(LEASE_MS + 500);
      await ctx.send('r2', {}, '', `retry after ${LEASE_MS + 500} ms`);
      await original;
    },
  },
};

const sel = $('scenario');
for (const [k, s] of Object.entries(SCENARIOS)) {
  const o = document.createElement('option');
  o.value = k; o.textContent = s.label; sel.appendChild(o);
}
const showDesc = () => { $('desc').textContent = SCENARIOS[sel.value].desc; };
sel.addEventListener('change', showDesc);
showDesc();

let events = [];
let pos = 0;
let timer = null;
let requests = [];

function codeClass(status) {
  if (status === 'dropped') return 'cx';
  if (status >= 200 && status < 300) return 'c2';
  if (status === 409) return 'c4';
  return 'c4x';
}

function renderRequests() {
  $('reqs').innerHTML = requests.length
    ? requests.map((r) => `<tr><td>${esc(r.id)}</td><td>${esc(r.note)}</td><td>${r.status === undefined ? '…' : `<span class="code ${codeClass(r.status)}">${esc(r.status === 'dropped' ? 'connection dropped' : r.status)}</span>`}</td><td>${esc(r.policy ?? '')}</td><td>${r.ms ?? ''}</td></tr>`).join('')
    : '<tr><td colspan="5" class="empty">No requests yet.</td></tr>';
}

function renderMap() {
  const st = replay(events, pos);
  const active = st.last && st.last.request_id;
  $('chips').innerHTML = st.order.length
    ? st.order.map((id) => `<span class="chip p-${st.requests[id].phase}${id === active ? ' active' : ''}" title="${esc(st.requests[id].phase)}">${esc(id)}</span>`).join('')
    : `<span class="empty">${events.length ? 'Press Play or Step to replay the run.' : 'Run a scenario to see requests here.'}</span>`;

  if (st.last) {
    const d = DESCRIBE[st.last.type] || { text: st.last.type, target: 'api' };
    $('arrow').innerHTML = `<span class="who">${esc(st.last.request_id)}</span> → ${d.target === 'db' ? 'Database' : 'API'}: ${esc(d.text)}`;
  } else {
    $('arrow').textContent = events.length ? `Ready: ${events.length} recorded events.` : 'Waiting for a run.';
  }

  const k = st.key;
  $('dbkey').textContent = k ? `P-DEMO + ${k.booking_id}` : 'no key yet';
  $('dbcard').innerHTML = k
    ? `<div class="kv"><small>status</small><strong class="st-${k.status}">${esc(k.status)}</strong></div>
       <div class="kv"><small>owner</small><strong>${esc(k.owner)}${k.ownerCrashed ? ' (crashed)' : ''}</strong></div>
       <div class="kv"><small>policies created</small><strong>${st.policiesCreated}</strong></div>
       <div class="kv"><small>policy</small><strong>${esc(k.policy ?? '—')}</strong></div>`
    : '';

  $('counter').textContent = `${pos} / ${events.length} events`;
  Array.from($('events').querySelectorAll('tr')).forEach((tr, i) => tr.classList.toggle('cur', i === pos - 1));
  $('play').disabled = !events.length;
  $('step').disabled = !events.length || pos >= events.length;
  $('reset').disabled = !events.length;
}

function renderLog(snapshot) {
  const t0 = events.length ? new Date(events[0].at).getTime() : 0;
  $('events').innerHTML = events.length
    ? events.map((e, i) => {
        const detail = Object.entries(e.detail || {}).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ');
        return `<tr class="clk" data-i="${i}"><td>${i + 1}</td><td>${new Date(e.at).getTime() - t0}</td><td>${esc(e.request_id)}</td><td>${esc(e.type)}</td><td>${esc(detail)}</td></tr>`;
      }).join('')
    : '<tr><td colspan="5" class="empty">No events recorded.</td></tr>';
  $('events').querySelectorAll('tr.clk').forEach((tr) => tr.addEventListener('click', () => { stop(); pos = Number(tr.dataset.i) + 1; renderMap(); }));

  const time = (v) => (v ? new Date(v).toLocaleTimeString([], { hour12: false }) + '.' + String(new Date(v).getMilliseconds()).padStart(3, '0') : '');
  $('keys').innerHTML = snapshot.keys.length
    ? snapshot.keys.map((k) => `<tr><td>${esc(k.partner_id)} + ${esc(k.booking_id)}</td><td class="st-${esc(k.status)}">${esc(k.status)}</td><td>${esc(String(k.owner_token).slice(0, 8))}…</td><td>${time(k.locked_until)}</td><td>${esc(k.response_code ?? '—')}</td></tr>`).join('')
    : '<tr><td colspan="5" class="empty">No key rows (nothing was claimed).</td></tr>';
  $('policies').innerHTML = snapshot.policies.length
    ? snapshot.policies.map((p) => `<tr><td>${esc(p.policy_number)}</td><td>${esc(p.booking_id)}</td><td>₹${esc(Number(p.premium))}</td><td>${time(p.created_at)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="empty">No policies for this run.</td></tr>';
}

function stop() { clearInterval(timer); timer = null; $('play').textContent = 'Play'; }
function play() {
  if (timer) return stop();
  if (pos >= events.length) pos = 0;
  $('play').textContent = 'Pause';
  timer = setInterval(() => {
    if (pos >= events.length) return stop();
    pos += 1; renderMap();
  }, Number($('speed').value));
}
$('play').addEventListener('click', play);
$('step').addEventListener('click', () => { stop(); if (pos < events.length) { pos += 1; renderMap(); } });
$('reset').addEventListener('click', () => { stop(); pos = 0; renderMap(); });
$('speed').addEventListener('change', () => { if (timer) { stop(); play(); } });

$('run').addEventListener('click', async () => {
  stop();
  const scenario = SCENARIOS[sel.value];
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const booking = `DEMO-${runId.slice(4)}`;
  requests = []; events = []; pos = 0;
  renderRequests(); renderMap();
  renderLog({ keys: [], policies: [] });
  $('run').disabled = true;
  $('status').textContent = `Running "${scenario.label}"…`;

  const ctx = {
    async send(id, overrides = {}, qs = '', note = '') {
      const r = { id, note };
      requests.push(r); renderRequests();
      const body = { partner_id: 'P-DEMO', booking_id: booking, premium: 49, user: { name: 'Synthetic User', email: 'synthetic@example.com' }, ...overrides };
      const t = performance.now();
      try {
        const res = await fetch(`/api/policies${qs}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-run-id': runId, 'x-request-id': id },
          body: JSON.stringify(body),
        });
        r.status = res.status;
        const json = await res.json().catch(() => ({}));
        r.policy = json.policy_number ?? json.error ?? '';
      } catch {
        r.status = 'dropped';
      }
      r.ms = Math.round(performance.now() - t);
      renderRequests();
    },
  };

  try {
    await scenario.run(ctx);
    const snap = await fetch(`/api/runs?id=${encodeURIComponent(runId)}`).then((r) => r.json());
    events = snap.events || [];
    renderLog(snap);
    pos = 0; renderMap();
    $('status').textContent = `Done: ${requests.length} requests, ${events.length} recorded events, ${snap.policies.length} ${snap.policies.length === 1 ? 'policy' : 'policies'} in the database. Replaying…`;
    play();
  } catch (err) {
    $('status').textContent = `Run failed: ${err.message}`;
  } finally {
    $('run').disabled = false;
  }
});

renderMap();
