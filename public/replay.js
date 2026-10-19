// Pure replay logic for the process map. The map's state is derived ONLY from recorded events:
// nothing here knows which scenario ran. Feed it the events from /api/runs, in order.

export const DESCRIBE = {
  received: { text: 'arrives at the API', target: 'api' },
  rejected_invalid: { text: 'invalid body → 400, nothing written', target: 'api' },
  claim_won: { text: 'INSERT claim → won, now owns the key', target: 'db' },
  claim_duplicate_key: { text: 'INSERT claim → duplicate key (someone owns it)', target: 'db' },
  rejected_key_reused: { text: 'stored hash differs → 422', target: 'db' },
  replayed: { text: 'row is completed → replay stored response (200)', target: 'db' },
  in_progress: { text: 'row is processing, lease running → 409', target: 'db' },
  takeover_won: { text: 'lease expired → conditional UPDATE matched 1 row → takes over', target: 'db' },
  takeover_lost: { text: 'conditional UPDATE matched 0 rows → 409', target: 'db' },
  simulated_crash: { text: 'crashes after claiming (connection dropped)', target: 'api' },
  stall_start: { text: 'stalls while holding the claim', target: 'api' },
  stall_end: { text: 'wakes up', target: 'api' },
  fenced_rollback: { text: 'ownership check matched 0 rows → ROLLBACK (409)', target: 'db' },
  policy_created: { text: 'COMMIT: policy + key completed (201)', target: 'db' },
};

// Final phase each event leaves its request in (drives the chip colour).
const PHASE = {
  received: 'sent',
  rejected_invalid: 'rejected',
  claim_won: 'owner',
  claim_duplicate_key: 'checking',
  rejected_key_reused: 'rejected',
  replayed: 'replayed',
  in_progress: 'told-wait',
  takeover_won: 'owner',
  takeover_lost: 'told-wait',
  simulated_crash: 'crashed',
  stall_start: 'stalled',
  stall_end: 'owner',
  fenced_rollback: 'fenced',
  policy_created: 'created',
};

export function initialState() {
  return { requests: {}, order: [], key: null, policiesCreated: 0, applied: 0, last: null };
}

export function apply(state, ev) {
  const s = {
    ...state,
    requests: { ...state.requests },
    order: state.order.slice(),
    key: state.key ? { ...state.key } : null,
    applied: state.applied + 1,
    last: ev,
  };
  if (!s.requests[ev.request_id]) {
    s.requests[ev.request_id] = { phase: 'sent' };
    s.order.push(ev.request_id);
  }
  if (PHASE[ev.type]) s.requests[ev.request_id] = { phase: PHASE[ev.type] };

  switch (ev.type) {
    case 'claim_won':
      s.key = { booking_id: ev.booking_id, status: 'processing', owner: ev.request_id };
      break;
    case 'takeover_won':
      if (s.key) { s.key.owner = ev.request_id; s.key.status = 'processing'; }
      break;
    case 'simulated_crash':
      if (s.key && s.key.owner === ev.request_id) s.key.ownerCrashed = true;
      break;
    case 'policy_created':
      if (s.key) { s.key.status = 'completed'; s.key.ownerCrashed = false; s.key.policy = ev.detail && ev.detail.policy_number; }
      s.policiesCreated += 1;
      break;
    default:
      break;
  }
  return s;
}

export function replay(events, upTo = events.length) {
  return events.slice(0, upTo).reduce(apply, initialState());
}
