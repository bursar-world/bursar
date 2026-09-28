-- The trust-event store: an append-only journal, a delivery outbox, and a quarantine.
--
-- Events are written in the same transaction as the ledger change that produced them, so a
-- settlement that committed always has its event and a settlement that rolled back never does.
-- Delivery is at-least-once: a message is leased, attempted, and either marked published or
-- released with a longer backoff. A consumer therefore has to be idempotent, which is what
-- `event_id` is for.
--
-- Nothing is ever dropped. A message that exhausts its attempts moves to the quarantine table
-- with its last error attached, where it can be inspected, redriven, or swept after a retention
-- window that an operator chooses.

-- The journal carries no foreign key to the account. It is the record of what happened, and it
-- has to survive the row it describes.
CREATE TABLE IF NOT EXISTS mandate_trust_events (
  -- The replay offset. Monotonic across every subject, which is what makes "replay from offset N"
  -- a single ordered scan rather than a merge across subjects.
  offset_id        BIGSERIAL PRIMARY KEY,
  event_id         TEXT NOT NULL UNIQUE,
  idempotency_key  TEXT NOT NULL UNIQUE,
  subject          TEXT NOT NULL,
  event_type       TEXT NOT NULL,
  occurred_at      TIMESTAMPTZ NOT NULL,
  payload          JSONB NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_trust_event_type CHECK (
    event_type IN (
      'settlement_confirmed',
      'repayment_received',
      'collateral_deposited',
      'collateral_withdrawn',
      'prefund_deposited',
      'prefund_withdrawn'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_trust_events_subject
  ON mandate_trust_events (subject, offset_id);
CREATE INDEX IF NOT EXISTS idx_trust_events_type
  ON mandate_trust_events (event_type, occurred_at DESC);

CREATE TABLE IF NOT EXISTS mandate_trust_outbox (
  id               BIGSERIAL PRIMARY KEY,
  event_id         TEXT NOT NULL UNIQUE,
  offset_id        BIGINT NOT NULL,
  topic            TEXT NOT NULL,
  -- Partition key. Using the subject keeps one agent's events in order at the consumer.
  event_key        TEXT NOT NULL,
  payload          JSONB NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  attempt_count    INT NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Held by the worker that claimed the row. A worker that dies mid-attempt leaves the lease to
  -- expire, and the next sweep picks the message back up instead of stranding it.
  leased_until     TIMESTAMPTZ,
  last_attempt_at  TIMESTAMPTZ,
  last_status_code INT,
  last_error       TEXT,
  published_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_trust_outbox_status CHECK (status IN ('pending', 'processing', 'published')),
  CONSTRAINT chk_trust_outbox_attempts CHECK (attempt_count >= 0),
  CONSTRAINT chk_trust_outbox_published CHECK ((status = 'published') = (published_at IS NOT NULL))
);

-- The claim query orders by due time then insertion order, so the index carries both.
CREATE INDEX IF NOT EXISTS idx_trust_outbox_due
  ON mandate_trust_outbox (next_attempt_at ASC, id ASC) WHERE status <> 'published';
CREATE INDEX IF NOT EXISTS idx_trust_outbox_offset
  ON mandate_trust_outbox (offset_id);

CREATE TABLE IF NOT EXISTS mandate_trust_dead_letter (
  id                BIGSERIAL PRIMARY KEY,
  event_id          TEXT NOT NULL UNIQUE,
  offset_id         BIGINT NOT NULL,
  topic             TEXT NOT NULL,
  event_key         TEXT NOT NULL,
  payload           JSONB NOT NULL,
  attempt_count     INT NOT NULL,
  last_status_code  INT,
  last_error        TEXT NOT NULL,
  first_seen_at     TIMESTAMPTZ NOT NULL,
  dead_lettered_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_trust_dead_letter_attempts CHECK (attempt_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_trust_dead_letter_at
  ON mandate_trust_dead_letter (dead_lettered_at ASC, id ASC);
