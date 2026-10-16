-- One row per (partner, booking) request key. The primary key is the dedupe guarantee:
-- only one INSERT for a given key can ever succeed, however many servers race.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  partner_id     text        NOT NULL,
  booking_id     text        NOT NULL,
  request_hash   text        NOT NULL,          -- sha256 of the canonical request body
  status         text        NOT NULL CHECK (status IN ('processing', 'completed')),
  owner_token    uuid        NOT NULL,          -- fencing token: who currently owns the work
  locked_until   timestamptz NOT NULL,          -- lease; after this another server may take over
  response_code  int,
  response_body  text,                          -- stored verbatim so replays are byte-identical
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (partner_id, booking_id)
);

-- Second line of defence: even a bug elsewhere cannot create two policies for one booking.
CREATE TABLE IF NOT EXISTS policies (
  policy_number  text        PRIMARY KEY,
  partner_id     text        NOT NULL,
  booking_id     text        NOT NULL,
  premium        numeric(10,2) NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (partner_id, booking_id)
);

-- Every decision the API makes, so the visualiser replays what really happened.
CREATE TABLE IF NOT EXISTS events (
  id          bigserial   PRIMARY KEY,
  run_id      text,
  request_id  text        NOT NULL,
  partner_id  text,
  booking_id  text,
  type        text        NOT NULL,
  detail      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  at          timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS events_run_idx ON events (run_id, id);
