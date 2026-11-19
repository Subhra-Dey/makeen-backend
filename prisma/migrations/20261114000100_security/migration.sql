-- ============================================================================================
-- MAKEEN FM Portal — security & integrity objects Prisma cannot model.
--   1. audit_log append-only triggers              (SEC-20)
--   2. CHECK constraints mirroring the shared formulas and ranges (SEC-13 / SEC-14, D-13, D-15)
--   3. Grants for the runtime role makeen_app       (D-08)
--   4. Row-level security on plant-scoped tables    (SEC-10, D-08)
-- The schema owner (migrations, seed) is not subject to RLS; makeen_app is.
-- ============================================================================================

-- ---------------------------------------------------------------- 1. append-only audit log
CREATE OR REPLACE FUNCTION audit_log_block_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_block_change();

CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_block_change();

-- ---------------------------------------------------------------- 2. integrity checks
-- Daily MIS system sums (same formulas as src/shared/rules/daily-mis.ts).
ALTER TABLE daily_mis
  ADD CONSTRAINT daily_mis_closing_book_stock_formula CHECK (
    closing_book_stock IS NOT DISTINCT FROM (
      CASE WHEN opening_stock IS NULL THEN NULL
           ELSE opening_stock + COALESCE(bulk_receipts, 0)
                - (COALESCE(normal_cylinder_despatch, 0) + COALESCE(normal_tt_loading, 0)
                   + COALESCE(ot_cylinder_despatch, 0) + COALESCE(ot_tt_loading, 0))
                + COALESCE(prcn_return, 0)
      END)),
  ADD CONSTRAINT daily_mis_stock_gain_loss_formula CHECK (
    stock_gain_loss IS NOT DISTINCT FROM (
      CASE WHEN closing_book_stock IS NULL OR physical_stock IS NULL THEN NULL
           ELSE physical_stock - closing_book_stock
      END)),
  ADD CONSTRAINT daily_mis_mechanical_total CHECK (
    loss_mechanical_total = COALESCE(loss_carousel, 0) + COALESCE(loss_eld, 0) + COALESCE(loss_old, 0)
      + COALESCE(loss_conveyor, 0) + COALESCE(loss_up_down_stream, 0) + COALESCE(loss_utility, 0)),
  ADD CONSTRAINT daily_mis_electrical_total CHECK (
    loss_electrical_total = COALESCE(loss_power_eb, 0) + COALESCE(loss_motor_cable, 0)
      + COALESCE(loss_automation, 0)),
  ADD CONSTRAINT daily_mis_misc_total CHECK (
    loss_misc_total = COALESCE(loss_fire_drill, 0) + COALESCE(loss_training, 0) + COALESCE(loss_manpower, 0)),
  ADD CONSTRAINT daily_mis_market_return_total CHECK (
    mr_total = COALESCE(mr_pin_leak, 0) + COALESCE(mr_pin_cut, 0) + COALESCE(mr_body_leak, 0)
      + COALESCE(mr_bung_leak, 0) + COALESCE(mr_dpt_hr, 0) + COALESCE(mr_weight, 0) + COALESCE(mr_other, 0)),
  ADD CONSTRAINT daily_mis_shifts_range CHECK (shifts_operated IS NULL OR shifts_operated BETWEEN 0 AND 3),
  ADD CONSTRAINT daily_mis_ot_hours_range CHECK (ot_hours IS NULL OR ot_hours BETWEEN 0 AND 24),
  ADD CONSTRAINT daily_mis_mt_non_negative CHECK (
    COALESCE(opening_stock, 0) >= 0 AND COALESCE(bulk_receipts, 0) >= 0
    AND COALESCE(normal_cylinder_despatch, 0) >= 0 AND COALESCE(normal_tt_loading, 0) >= 0
    AND COALESCE(ot_cylinder_despatch, 0) >= 0 AND COALESCE(ot_tt_loading, 0) >= 0
    AND COALESCE(prcn_return, 0) >= 0 AND COALESCE(physical_stock, 0) >= 0),
  ADD CONSTRAINT daily_mis_counts_non_negative CHECK (
    LEAST(COALESCE(cyl_filled_14_2, 0), COALESCE(cyl_filled_19, 0), COALESCE(loss_carousel, 0),
          COALESCE(loss_eld, 0), COALESCE(loss_old, 0), COALESCE(loss_conveyor, 0),
          COALESCE(loss_up_down_stream, 0), COALESCE(loss_utility, 0), COALESCE(loss_power_eb, 0),
          COALESCE(loss_motor_cable, 0), COALESCE(loss_automation, 0), COALESCE(loss_indent_truck, 0),
          COALESCE(loss_fire_drill, 0), COALESCE(loss_training, 0), COALESCE(loss_manpower, 0),
          COALESCE(indents_status, 0), COALESCE(mr_pin_leak, 0), COALESCE(mr_pin_cut, 0),
          COALESCE(mr_body_leak, 0), COALESCE(mr_bung_leak, 0), COALESCE(mr_dpt_hr, 0),
          COALESCE(mr_weight, 0), COALESCE(mr_other, 0), COALESCE(sqc_defective, 0),
          COALESCE(test_bath_body_leak, 0), COALESCE(test_bath_bung_leak, 0)) >= 0),
  ADD CONSTRAINT daily_mis_percent_range CHECK (
    COALESCE(accuracy_zero, 0) BETWEEN 0 AND 100 AND COALESCE(accuracy_50, 0) BETWEEN 0 AND 100
    AND COALESCE(accuracy_100, 0) BETWEEN 0 AND 100 AND COALESCE(accuracy_beyond_100, 0) BETWEEN 0 AND 100
    AND COALESCE(eld_tested_pct, 0) BETWEEN 0 AND 100 AND COALESCE(old_tested_pct, 0) BETWEEN 0 AND 100),
  ADD CONSTRAINT daily_mis_sqc_time_format CHECK (sqc_time IS NULL OR sqc_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ADD CONSTRAINT daily_mis_return_reason CHECK (status <> 'RETURNED' OR length(btrim(COALESCE(return_reason, ''))) > 0),
  ADD CONSTRAINT daily_mis_approved_stamp CHECK (status <> 'APPROVED' OR (approved_at IS NOT NULL AND approved_by_id IS NOT NULL)),
  ADD CONSTRAINT daily_mis_reopen_reason CHECK (reopened_at IS NULL OR length(btrim(COALESCE(reopen_reason, ''))) > 0),
  ADD CONSTRAINT daily_mis_version_positive CHECK (version >= 1);

-- Monthly MIS.
ALTER TABLE monthly_mis
  ADD CONSTRAINT monthly_mis_first_of_month CHECK (month = date_trunc('month', month)::date),
  ADD CONSTRAINT monthly_mis_training_total CHECK (
    training_total = COALESCE(training_staff, 0) + COALESCE(training_workmen, 0) + COALESCE(training_drivers, 0)),
  ADD CONSTRAINT monthly_mis_penalty_reason CHECK (
    status = 'DRAFT' OR penalty_incurred IS DISTINCT FROM 'YES' OR length(btrim(COALESCE(penalty_details, ''))) > 0),
  ADD CONSTRAINT monthly_mis_solar_capacity CHECK (
    status = 'DRAFT' OR solar_available IS DISTINCT FROM 'YES' OR length(btrim(COALESCE(solar_capacity, ''))) > 0),
  ADD CONSTRAINT monthly_mis_power_factor_range CHECK (power_factor IS NULL OR power_factor BETWEEN 0 AND 1),
  ADD CONSTRAINT monthly_mis_percent_range CHECK (
    COALESCE(caps_used_pct, 0) BETWEEN 0 AND 100 AND COALESCE(seals_used_pct, 0) BETWEEN 0 AND 100
    AND COALESCE(o_rings_replaced_pct, 0) BETWEEN 0 AND 100 AND COALESCE(valves_replaced_pct, 0) BETWEEN 0 AND 100),
  ADD CONSTRAINT monthly_mis_return_reason CHECK (status <> 'RETURNED' OR length(btrim(COALESCE(return_reason, ''))) > 0),
  ADD CONSTRAINT monthly_mis_approved_stamp CHECK (status <> 'APPROVED' OR (approved_at IS NOT NULL AND approved_by_id IS NOT NULL)),
  ADD CONSTRAINT monthly_mis_reopen_reason CHECK (reopened_at IS NULL OR length(btrim(COALESCE(reopen_reason, ''))) > 0);

ALTER TABLE monthly_cylinder_stats ADD CONSTRAINT monthly_cylinder_stats_non_negative CHECK (quantity >= 0);
ALTER TABLE monthly_inventory_items ADD CONSTRAINT monthly_inventory_items_non_negative CHECK (quantity >= 0);

-- Daily Exceptions.
ALTER TABLE daily_exception_lines
  ADD CONSTRAINT daily_exception_lines_line_no CHECK (line_no BETWEEN 1 AND 13),
  ADD CONSTRAINT daily_exception_lines_details_object CHECK (jsonb_typeof(details) = 'object');

-- Plants: start = contract date; end = contract date + period years − 1 day (D-15), with the same
-- 29-February behaviour as src/shared/rules/plant.ts (anniversary rolls to 1 March).
ALTER TABLE plants
  ADD CONSTRAINT plants_period_range CHECK (period_years BETWEEN 1 AND 50),
  ADD CONSTRAINT plants_extension_non_negative CHECK (extension_years IS NULL OR extension_years >= 0),
  ADD CONSTRAINT plants_start_is_contract CHECK (start_date = contract_date),
  ADD CONSTRAINT plants_end_date_formula CHECK (
    end_date = (date_trunc('month', contract_date) + make_interval(years => period_years))::date
               + (EXTRACT(DAY FROM contract_date)::int - 1) - 1),
  ADD CONSTRAINT plants_key_format CHECK (plant_key ~ '^PK-[0-9A-F]{6}$'),
  ADD CONSTRAINT plants_delete_reason CHECK (deleted_at IS NULL OR length(btrim(COALESCE(delete_reason, ''))) > 0);

ALTER TABLE plant_equipment ADD CONSTRAINT plant_equipment_non_negative CHECK (quantity >= 0);
ALTER TABLE plant_year_volumes
  ADD CONSTRAINT plant_year_volumes_fy_format CHECK (fy ~ '^[0-9]{4}-[0-9]{2}$'),
  ADD CONSTRAINT plant_year_volumes_non_negative CHECK (volume_mt >= 0);

-- Audit.
ALTER TABLE audits
  ADD CONSTRAINT audits_fy_format CHECK (fy ~ '^[0-9]{4}-[0-9]{2}$'),
  ADD CONSTRAINT audits_dates CHECK (end_date >= start_date),
  ADD CONSTRAINT audits_recommendations_non_negative CHECK (total_recommendations >= 0);

-- Licences: type must belong to the tab (LIC-1); dates ordered; sensible remind window.
ALTER TABLE licences
  ADD CONSTRAINT licences_type_matches_category CHECK (
    (category = 'STATUTORY' AND licence_type IN ('STATUTORY', 'SAFETY_CALIBRATION'))
    OR (category = 'INTERNAL' AND licence_type IN ('ELECTRICAL_CALIBRATION', 'MAINTENANCE_CALIBRATION'))),
  ADD CONSTRAINT licences_dates CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date),
  ADD CONSTRAINT licences_remind_range CHECK (remind_before_days BETWEEN 0 AND 3650);

-- Files: PDF / JPG / PNG / XLSX only, ≤ 10 MB (UXV-12, SEC-15; magic bytes are checked in the API).
ALTER TABLE attachments
  ADD CONSTRAINT attachments_size CHECK (size_bytes BETWEEN 1 AND 10485760),
  ADD CONSTRAINT attachments_mime CHECK (mime_type IN (
    'application/pdf', 'image/jpeg', 'image/png',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')),
  ADD CONSTRAINT attachments_sha256_hex CHECK (sha256 ~ '^[0-9a-f]{64}$');

ALTER TABLE users
  ADD CONSTRAINT users_aadhaar_last4 CHECK (aadhaar_last4 IS NULL OR aadhaar_last4 ~ '^[0-9]{4}$'),
  ADD CONSTRAINT users_token_version CHECK (token_version >= 0);

ALTER TABLE otp_challenges ADD CONSTRAINT otp_challenges_attempts CHECK (attempts BETWEEN 0 AND 5);

-- ---------------------------------------------------------------- 3. runtime role grants
-- The runtime role is created by `npm run db:bootstrap` (dev) or the DBA (production) BEFORE
-- migrations run. Skipped silently where it does not exist (e.g. throw-away CI databases).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'makeen_app') THEN
    GRANT USAGE ON SCHEMA public TO makeen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO makeen_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO makeen_app;
    -- The audit trail can be appended to and read — never changed.
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM makeen_app;
    -- Migration bookkeeping is not the application's business.
    REVOKE ALL ON _prisma_migrations FROM makeen_app;
    -- Tables created by later migrations get the same data grants.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO makeen_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO makeen_app;
  END IF;
END
$$;

-- ---------------------------------------------------------------- 4. row-level security
-- Every request-scoped transaction runs:
--   SELECT set_config('app.user_id', '<uuid>', true), set_config('app.is_admin', 'true|false', true);
-- Nothing set → nothing visible (deny by default).
CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_is_admin() RETURNS boolean
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(current_setting('app.is_admin', true), '') = 'true'
$$;

-- True when the acting user may see/write the plant: Admin, or an assignment to that plant.
CREATE OR REPLACE FUNCTION app_plant_visible(p_plant_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT app_is_admin()
      OR EXISTS (SELECT 1 FROM plant_assignments a
                 WHERE a.plant_id = p_plant_id AND a.user_id = app_current_user_id())
$$;

-- Plants: visible when assigned; only Admin creates plants.
ALTER TABLE plants ENABLE ROW LEVEL SECURITY;
CREATE POLICY plants_select ON plants FOR SELECT USING (app_plant_visible(id));
CREATE POLICY plants_insert ON plants FOR INSERT WITH CHECK (app_is_admin());
CREATE POLICY plants_update ON plants FOR UPDATE USING (app_plant_visible(id)) WITH CHECK (app_plant_visible(id));
CREATE POLICY plants_delete ON plants FOR DELETE USING (app_is_admin());

-- Tables that carry plant_id directly.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'daily_mis', 'daily_mis_revisions', 'monthly_mis', 'daily_exceptions', 'lapse_notes',
    'audits', 'audit_observations', 'licences', 'licence_remind_users',
    'plant_details', 'plant_equipment', 'plant_year_volumes', 'plant_activities', 'attachments'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL USING (app_plant_visible(plant_id)) WITH CHECK (app_plant_visible(plant_id))',
      t || '_plant_scope', t);
  END LOOP;
END
$$;

-- Child tables: visible when the (RLS-protected) parent row is visible.
ALTER TABLE monthly_cylinder_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY monthly_cylinder_stats_parent ON monthly_cylinder_stats FOR ALL
  USING (EXISTS (SELECT 1 FROM monthly_mis m WHERE m.id = monthly_mis_id))
  WITH CHECK (EXISTS (SELECT 1 FROM monthly_mis m WHERE m.id = monthly_mis_id));

ALTER TABLE monthly_inventory_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY monthly_inventory_items_parent ON monthly_inventory_items FOR ALL
  USING (EXISTS (SELECT 1 FROM monthly_mis m WHERE m.id = monthly_mis_id))
  WITH CHECK (EXISTS (SELECT 1 FROM monthly_mis m WHERE m.id = monthly_mis_id));

ALTER TABLE daily_exception_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY daily_exception_lines_parent ON daily_exception_lines FOR ALL
  USING (EXISTS (SELECT 1 FROM daily_exceptions e WHERE e.id = exception_id))
  WITH CHECK (EXISTS (SELECT 1 FROM daily_exceptions e WHERE e.id = exception_id));
