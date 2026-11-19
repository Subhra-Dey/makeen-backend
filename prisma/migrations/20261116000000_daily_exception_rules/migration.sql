-- Phase 8 — Daily Exceptions: the status rules of src/shared/rules/daily-exception.ts as CHECKs
-- (DEX-S1…S3, D-20, D-22). The API computes status and highlight; the database refuses rows
-- that break the rules even if a bug or a manual edit tried.

ALTER TABLE daily_exceptions
  -- Completed = submitted, plant Operational, nothing to highlight.
  ADD CONSTRAINT daily_exceptions_completed CHECK (
    status <> 'COMPLETED' OR (plant_status = 'OPERATIONAL' AND problem_highlight IS NULL)),
  -- Pending = submitted with a Yes, an incident or a Non-operational plant: always highlighted.
  ADD CONSTRAINT daily_exceptions_pending CHECK (
    status <> 'PENDING' OR (plant_status IS NOT NULL AND length(btrim(COALESCE(problem_highlight, ''))) > 0)),
  ADD CONSTRAINT daily_exceptions_version CHECK (version >= 1);

-- A missed-day note is short, non-blank text (DEX-S7).
ALTER TABLE lapse_notes
  ADD CONSTRAINT lapse_notes_note CHECK (length(btrim(note)) BETWEEN 1 AND 300);
