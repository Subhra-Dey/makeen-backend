-- Phase 10 — notifications engine.

-- Email outbox (D-118): an email is logged QUEUED in the same transaction as the notice and sent
-- by the dispatcher after commit, so a rolled-back change never emails anyone.
ALTER TYPE "SendState" ADD VALUE IF NOT EXISTS 'QUEUED' BEFORE 'SENT';

-- The dispatcher reads the oldest queued rows (a new enum value cannot be used in a partial
-- index created in the same transaction, so the index covers every state).
CREATE INDEX IF NOT EXISTS notification_send_log_state_at_idx ON notification_send_log (state, at);

ALTER TABLE notification_recipients
  ADD CONSTRAINT notification_recipients_reply CHECK (
    (reply IS NULL AND replied_at IS NULL) OR (length(btrim(reply)) > 0 AND replied_at IS NOT NULL)),
  ADD CONSTRAINT notification_recipients_ack_after_read CHECK (
    acknowledged_at IS NULL OR read_at IS NOT NULL);
