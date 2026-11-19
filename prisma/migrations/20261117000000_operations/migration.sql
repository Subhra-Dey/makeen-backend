-- Phase 9 — Plant Operations (Plant master, Audit, Licences, Review Check).

-- Observation Id (AUD-2): "OB-" + a running number, unique across ALL plants. The app role sees
-- only its own plants (RLS), so the number is taken here, as the owner, under a transaction lock
-- so two saves never get the same Id.
CREATE OR REPLACE FUNCTION next_observation_code() RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('audit_observations.observation_code'));
  SELECT COALESCE(max(substring(observation_code FROM 4)::integer), 0) + 1 INTO n
    FROM audit_observations WHERE observation_code ~ '^OB-[0-9]+$';
  RETURN 'OB-' || lpad(n::text, 4, '0');
END
$$;
REVOKE ALL ON FUNCTION next_observation_code() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'makeen_app') THEN
    GRANT EXECUTE ON FUNCTION next_observation_code() TO makeen_app;
  END IF;
END
$$;

ALTER TABLE audit_observations
  ADD CONSTRAINT audit_observations_code_format CHECK (observation_code ~ '^OB-[0-9]{4,}$'),
  ADD CONSTRAINT audit_observations_revised_after_target CHECK (
    revised_target_date IS NULL OR target_date IS NULL OR revised_target_date >= target_date);

ALTER TABLE audits ADD CONSTRAINT audits_version CHECK (version >= 1);
ALTER TABLE licences ADD CONSTRAINT licences_version CHECK (version >= 1);

ALTER TABLE plant_activities
  ADD CONSTRAINT plant_activities_heading CHECK (length(btrim(heading)) > 0);
ALTER TABLE plant_details
  ADD CONSTRAINT plant_details_non_negative CHECK (
    (capacity IS NULL OR capacity >= 0) AND (production IS NULL OR production >= 0));
