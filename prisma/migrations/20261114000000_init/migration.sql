-- Case-insensitive text for emails, names, codes and designations.
CREATE EXTENSION IF NOT EXISTS citext;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "WorkingStatus" AS ENUM ('WORKING', 'RESIGNED');

-- CreateEnum
CREATE TYPE "LoginStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "Module" AS ENUM ('DASHBOARD', 'DAILY_MIS', 'MONTHLY_MIS', 'DAILY_EXCEPTIONS', 'MANAGEMENT_REVIEW', 'PLANT_MASTER', 'AUDIT', 'LICENCES', 'REVIEW_CHECK', 'GRAPHS', 'PEOPLE', 'NOTIFICATION_CONTROL');

-- CreateEnum
CREATE TYPE "ModuleSetting" AS ENUM ('SEARCH', 'SUBMIT', 'DOWNLOAD', 'APPROVE', 'HIDDEN');

-- CreateEnum
CREATE TYPE "Action" AS ENUM ('RETURN', 'DELETE_PLANT', 'REOPEN_APPROVED', 'REPLACE_FILE_AFTER_APPROVE', 'READ_FILE_INTO_FIELDS');

-- CreateEnum
CREATE TYPE "OtpChannel" AS ENUM ('SMS', 'EMAIL');

-- CreateEnum
CREATE TYPE "PlantStatus" AS ENUM ('NEW', 'WORKING');

-- CreateEnum
CREATE TYPE "VolumeType" AS ENUM ('PROJECTED', 'MINIMUM');

-- CreateEnum
CREATE TYPE "EquipmentType" AS ENUM ('PUMPS', 'COMPRESSOR', 'FIRE_ENGINE', 'WATER_PUMPS', 'CAPPING_MACHINE', 'VALVE_OPENING_MACHINE', 'REPAIR_MACHINE', 'PURGING_MACHINE', 'PNEUMATIC_TESTING', 'HYDROTESTING', 'PAINTING_BOOTH', 'CYLINDER_RETESTING', 'CCTV_CAMERAS', 'CHAIN_CONVEYOR');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'RETURNED');

-- CreateEnum
CREATE TYPE "YesNo" AS ENUM ('YES', 'NO');

-- CreateEnum
CREATE TYPE "PlantOperatingStatus" AS ENUM ('OPERATIONAL', 'NON_OPERATIONAL');

-- CreateEnum
CREATE TYPE "ExceptionStatus" AS ENUM ('PARTIAL', 'PENDING', 'COMPLETED');

-- CreateEnum
CREATE TYPE "CylinderSize" AS ENUM ('KG5', 'KG14_2', 'KG19', 'KG35_A', 'KG47_5', 'KG35_B', 'KG425');

-- CreateEnum
CREATE TYPE "CylinderStatCategory" AS ENUM ('DUE_TESTING', 'TESTED_DESPATCHED', 'CLOSING_DUE_TESTING', 'CLOSING_HOT_REPAIR', 'CLOSING_SCRAP');

-- CreateEnum
CREATE TYPE "InventoryItem" AS ENUM ('SCRAP_SC_VALVE', 'SCRAP_REGULATOR', 'NEW_SC_VALVE', 'NEW_REGULATOR', 'NEW_O_RINGS', 'NEW_TE_SEALS', 'NEW_SAFETY_CAPS', 'NEW_NYLON_THREAD', 'NEW_SS_CLIP', 'NEW_TEFLON_TAPE', 'DPT_ZINC_CHROMATE_PRIMER', 'DPT_SIGNAL_RED', 'DPT_OXFORD_BLUE', 'DPT_WHITE', 'DPT_YELLOW', 'DPT_BLACK', 'DPT_STENCIL');

-- CreateEnum
CREATE TYPE "AuditType" AS ENUM ('ISA', 'OISD', 'MEIPL');

-- CreateEnum
CREATE TYPE "AuditFrequency" AS ENUM ('MONTHS_3', 'MONTHS_12', 'YEARS_5');

-- CreateEnum
CREATE TYPE "ObservationStatus" AS ENUM ('PENDING', 'COMPLIED');

-- CreateEnum
CREATE TYPE "LicenceCategory" AS ENUM ('STATUTORY', 'INTERNAL');

-- CreateEnum
CREATE TYPE "LicenceType" AS ENUM ('STATUTORY', 'SAFETY_CALIBRATION', 'ELECTRICAL_CALIBRATION', 'MAINTENANCE_CALIBRATION');

-- CreateEnum
CREATE TYPE "RenewalFrequency" AS ENUM ('MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY', 'NA');

-- CreateEnum
CREATE TYPE "NotificationCategory" AS ENUM ('SYSTEM', 'CUSTOM', 'PERSON');

-- CreateEnum
CREATE TYPE "NotificationEvent" AS ENUM ('REPORT_SUBMITTED', 'EXCEPTION_RAISED', 'REPORT_DECIDED', 'LICENCE_DUE', 'AUDIT_OVERDUE', 'ACCESS_CHANGED', 'PASSWORD_OTP', 'PERSON_NOTE');

-- CreateEnum
CREATE TYPE "SendChannel" AS ENUM ('IN_APP', 'EMAIL', 'SMS');

-- CreateEnum
CREATE TYPE "SendState" AS ENUM ('SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "AttachmentOwner" AS ENUM ('DAILY_EXCEPTION', 'AUDIT', 'LICENCE', 'PLANT_CONTRACT', 'PLANT_ACTIVITY');

-- CreateEnum
CREATE TYPE "ScanStatus" AS ENUM ('PENDING', 'CLEAN', 'INFECTED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "KekaImportSource" AS ENUM ('CSV', 'API');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "employee_code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "email" CITEXT NOT NULL,
    "phone" VARCHAR(20),
    "aadhaar_enc" BYTEA,
    "aadhaar_key_id" VARCHAR(32),
    "aadhaar_last4" CHAR(4),
    "designation" CITEXT NOT NULL,
    "photo_url" VARCHAR(500),
    "working_status" "WorkingStatus" NOT NULL DEFAULT 'WORKING',
    "login_status" "LoginStatus" NOT NULL DEFAULT 'INACTIVE',
    "password_hash" VARCHAR(255),
    "must_set_password" BOOLEAN NOT NULL DEFAULT true,
    "token_version" INTEGER NOT NULL DEFAULT 0,
    "last_login_at" TIMESTAMPTZ(3),
    "base_role_id" UUID,
    "keka_synced_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "name" CITEXT NOT NULL,
    "is_standard" BOOLEAN NOT NULL DEFAULT false,
    "is_admin" BOOLEAN NOT NULL DEFAULT false,
    "copied_from_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_module_permissions" (
    "role_id" UUID NOT NULL,
    "module" "Module" NOT NULL,
    "setting" "ModuleSetting" NOT NULL,

    CONSTRAINT "role_module_permissions_pkey" PRIMARY KEY ("role_id","module")
);

-- CreateTable
CREATE TABLE "role_action_permissions" (
    "role_id" UUID NOT NULL,
    "action" "Action" NOT NULL,
    "allowed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "role_action_permissions_pkey" PRIMARY KEY ("role_id","action")
);

-- CreateTable
CREATE TABLE "designation_role_map" (
    "designation" CITEXT NOT NULL,
    "role_id" UUID NOT NULL,

    CONSTRAINT "designation_role_map_pkey" PRIMARY KEY ("designation","role_id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "refresh_token_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idle_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "rotated_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_reason" VARCHAR(40),
    "ip" VARCHAR(64),
    "user_agent" VARCHAR(400),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_challenges" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "channel" "OtpChannel" NOT NULL,
    "code_hash" CHAR(64) NOT NULL,
    "sent_to" VARCHAR(120) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "superseded_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "otp_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plants" (
    "id" UUID NOT NULL,
    "name" CITEXT NOT NULL,
    "address" VARCHAR(400) NOT NULL,
    "code" CITEXT NOT NULL,
    "plant_key" VARCHAR(16) NOT NULL,
    "manager_id" UUID NOT NULL,
    "contract_date" DATE NOT NULL,
    "period_years" INTEGER NOT NULL,
    "extension_years" INTEGER,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "status" "PlantStatus" NOT NULL DEFAULT 'NEW',
    "read_file_into_fields" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    "deleted_by_id" UUID,
    "delete_reason" VARCHAR(500),

    CONSTRAINT "plants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plant_assignments" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "plant_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "assigned_by_id" UUID,
    "remarks" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "plant_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plant_details" (
    "plant_id" UUID NOT NULL,
    "capacity" DECIMAL(14,3),
    "production" DECIMAL(14,3),
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "plant_details_pkey" PRIMARY KEY ("plant_id")
);

-- CreateTable
CREATE TABLE "plant_equipment" (
    "plant_id" UUID NOT NULL,
    "equipment" "EquipmentType" NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "note" VARCHAR(300),

    CONSTRAINT "plant_equipment_pkey" PRIMARY KEY ("plant_id","equipment")
);

-- CreateTable
CREATE TABLE "plant_year_volumes" (
    "id" UUID NOT NULL,
    "plant_id" UUID NOT NULL,
    "type" "VolumeType" NOT NULL,
    "fy" CHAR(7) NOT NULL,
    "volume_mt" DECIMAL(14,3) NOT NULL,

    CONSTRAINT "plant_year_volumes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plant_activities" (
    "id" UUID NOT NULL,
    "plant_id" UUID NOT NULL,
    "heading" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plant_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_mis" (
    "id" UUID NOT NULL,
    "plant_id" UUID NOT NULL,
    "report_date" DATE NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'DRAFT',
    "shifts_operated" SMALLINT,
    "ot_hours" DECIMAL(6,2),
    "entered_by_id" UUID NOT NULL,
    "opening_stock" DECIMAL(14,3),
    "bulk_receipts" DECIMAL(14,3),
    "normal_cylinder_despatch" DECIMAL(14,3),
    "normal_tt_loading" DECIMAL(14,3),
    "ot_cylinder_despatch" DECIMAL(14,3),
    "ot_tt_loading" DECIMAL(14,3),
    "cyl_filled_14_2" INTEGER,
    "cyl_filled_19" INTEGER,
    "prcn_return" DECIMAL(14,3),
    "closing_book_stock" DECIMAL(14,3),
    "physical_stock" DECIMAL(14,3),
    "stock_gain_loss" DECIMAL(14,3),
    "loss_carousel" INTEGER,
    "loss_eld" INTEGER,
    "loss_old" INTEGER,
    "loss_conveyor" INTEGER,
    "loss_up_down_stream" INTEGER,
    "loss_utility" INTEGER,
    "loss_mechanical_total" INTEGER NOT NULL DEFAULT 0,
    "loss_power_eb" INTEGER,
    "loss_motor_cable" INTEGER,
    "loss_automation" INTEGER,
    "loss_electrical_total" INTEGER NOT NULL DEFAULT 0,
    "loss_indent_truck" INTEGER,
    "loss_fire_drill" INTEGER,
    "loss_training" INTEGER,
    "loss_manpower" INTEGER,
    "loss_misc_total" INTEGER NOT NULL DEFAULT 0,
    "indents_status" INTEGER,
    "pending_indent_reason" VARCHAR(500),
    "accuracy_zero" DECIMAL(5,2),
    "accuracy_50" DECIMAL(5,2),
    "accuracy_100" DECIMAL(5,2),
    "accuracy_beyond_100" DECIMAL(5,2),
    "eld_tested_pct" DECIMAL(5,2),
    "old_tested_pct" DECIMAL(5,2),
    "mr_pin_leak" INTEGER,
    "mr_pin_cut" INTEGER,
    "mr_body_leak" INTEGER,
    "mr_bung_leak" INTEGER,
    "mr_dpt_hr" INTEGER,
    "mr_weight" INTEGER,
    "mr_other" INTEGER,
    "mr_total" INTEGER NOT NULL DEFAULT 0,
    "sqc_defective" INTEGER,
    "test_bath_body_leak" INTEGER,
    "test_bath_bung_leak" INTEGER,
    "sqc_time" CHAR(5),
    "sqc_remarks" VARCHAR(1000),
    "meetings" VARCHAR(1000),
    "licence_renewal" VARCHAR(1000),
    "remarks" VARCHAR(2000),
    "last_modified_by_id" UUID,
    "submitted_at" TIMESTAMPTZ(3),
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "returned_by_id" UUID,
    "returned_at" TIMESTAMPTZ(3),
    "return_reason" VARCHAR(1000),
    "reopened_by_id" UUID,
    "reopened_at" TIMESTAMPTZ(3),
    "reopen_reason" VARCHAR(1000),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "daily_mis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_mis_revisions" (
    "id" UUID NOT NULL,
    "daily_mis_id" UUID NOT NULL,
    "plant_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "ReportStatus" NOT NULL,
    "snapshot" JSONB NOT NULL,
    "saved_by_id" UUID NOT NULL,
    "saved_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_mis_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monthly_mis" (
    "id" UUID NOT NULL,
    "plant_id" UUID NOT NULL,
    "month" DATE NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'DRAFT',
    "entered_by_id" UUID NOT NULL,
    "eb_units" DECIMAL(14,2),
    "dg_units" DECIMAL(14,2),
    "energy_charges" DECIMAL(14,2),
    "electricity_bill" DECIMAL(14,2),
    "diesel_bill" DECIMAL(14,2),
    "diesel_dg" DECIMAL(14,2),
    "diesel_fire_engine" DECIMAL(14,2),
    "hours_dg" DECIMAL(8,2),
    "hours_fire_engine" DECIMAL(8,2),
    "bottling_revenue" DECIMAL(14,2),
    "bottling_expenditure" DECIMAL(14,2),
    "retesting_revenue" DECIMAL(14,2),
    "retesting_expenditure" DECIMAL(14,2),
    "opex_per_cylinder" DECIMAL(14,2),
    "operating_cost_per_mt" DECIMAL(14,2),
    "tender_cost_per_mt" DECIMAL(14,2),
    "penalty_incurred" "YesNo",
    "penalty_details" VARCHAR(1000),
    "training_staff" INTEGER,
    "training_workmen" INTEGER,
    "training_drivers" INTEGER,
    "training_total" INTEGER NOT NULL DEFAULT 0,
    "units_per_mt" DECIMAL(14,2),
    "power_factor" DECIMAL(4,3),
    "contract_demand_kva" DECIMAL(14,2),
    "max_demand_kva" DECIMAL(14,2),
    "solar_available" "YesNo",
    "solar_capacity" VARCHAR(100),
    "solar_units" DECIMAL(14,2),
    "caps_used_pct" DECIMAL(5,2),
    "seals_used_pct" DECIMAL(5,2),
    "o_rings_replaced_pct" DECIMAL(5,2),
    "valves_replaced_pct" DECIMAL(5,2),
    "brown_soap_kg" DECIMAL(14,2),
    "teflon_tape" DECIMAL(14,2),
    "defective_market_return" INTEGER,
    "cvr_cycle_count_date" DATE,
    "cvr_cycle_deviation" "YesNo",
    "warehouse_cycle_count_date" DATE,
    "warehouse_cycle_deviation" "YesNo",
    "paint_signal_red" DECIMAL(14,2),
    "paint_primer" DECIMAL(14,2),
    "paint_stencil" DECIMAL(14,2),
    "thinner" DECIMAL(14,2),
    "remarks" VARCHAR(2000),
    "summary_snapshot" JSONB,
    "last_modified_by_id" UUID,
    "submitted_at" TIMESTAMPTZ(3),
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "returned_by_id" UUID,
    "returned_at" TIMESTAMPTZ(3),
    "return_reason" VARCHAR(1000),
    "reopened_by_id" UUID,
    "reopened_at" TIMESTAMPTZ(3),
    "reopen_reason" VARCHAR(1000),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "monthly_mis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monthly_cylinder_stats" (
    "monthly_mis_id" UUID NOT NULL,
    "category" "CylinderStatCategory" NOT NULL,
    "size" "CylinderSize" NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "monthly_cylinder_stats_pkey" PRIMARY KEY ("monthly_mis_id","category","size")
);

-- CreateTable
CREATE TABLE "monthly_inventory_items" (
    "monthly_mis_id" UUID NOT NULL,
    "item" "InventoryItem" NOT NULL,
    "quantity" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "monthly_inventory_items_pkey" PRIMARY KEY ("monthly_mis_id","item")
);

-- CreateTable
CREATE TABLE "daily_exceptions" (
    "id" UUID NOT NULL,
    "plant_id" UUID NOT NULL,
    "report_date" DATE NOT NULL,
    "plant_status" "PlantOperatingStatus",
    "status" "ExceptionStatus" NOT NULL DEFAULT 'PARTIAL',
    "problem_highlight" VARCHAR(500),
    "read_file_into_fields" BOOLEAN NOT NULL DEFAULT false,
    "entered_by_id" UUID NOT NULL,
    "last_modified_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "daily_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_exception_lines" (
    "exception_id" UUID NOT NULL,
    "line_no" SMALLINT NOT NULL,
    "answer" "YesNo",
    "details" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "daily_exception_lines_pkey" PRIMARY KEY ("exception_id","line_no")
);

-- CreateTable
CREATE TABLE "lapse_notes" (
    "plant_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "note" VARCHAR(300) NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lapse_notes_pkey" PRIMARY KEY ("plant_id","date")
);

-- CreateTable
CREATE TABLE "audits" (
    "id" UUID NOT NULL,
    "plant_id" UUID NOT NULL,
    "audit_type" "AuditType" NOT NULL,
    "frequency" "AuditFrequency" NOT NULL,
    "fy" CHAR(7) NOT NULL,
    "total_recommendations" INTEGER NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "read_file_into_fields" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_observations" (
    "id" UUID NOT NULL,
    "audit_id" UUID NOT NULL,
    "plant_id" UUID NOT NULL,
    "observation_code" VARCHAR(20) NOT NULL,
    "sub_group_code" VARCHAR(40),
    "checklist_ref" VARCHAR(80),
    "particular" VARCHAR(500),
    "observation" VARCHAR(2000),
    "recommendation" VARCHAR(2000),
    "action_plan" VARCHAR(2000),
    "target_date" DATE,
    "revised_target_date" DATE,
    "status" "ObservationStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "audit_observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "licence_items" (
    "id" UUID NOT NULL,
    "licence_type" "LicenceType" NOT NULL,
    "title" VARCHAR(200) NOT NULL,

    CONSTRAINT "licence_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "licences" (
    "id" UUID NOT NULL,
    "plant_id" UUID NOT NULL,
    "category" "LicenceCategory" NOT NULL,
    "licence_type" "LicenceType" NOT NULL,
    "item_id" UUID NOT NULL,
    "doc_ref" VARCHAR(80),
    "notes" VARCHAR(1000),
    "start_date" DATE,
    "end_date" DATE,
    "frequency" "RenewalFrequency" NOT NULL,
    "remind_before_days" INTEGER NOT NULL,
    "read_file_into_fields" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "licences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "licence_remind_users" (
    "licence_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "plant_id" UUID NOT NULL,

    CONSTRAINT "licence_remind_users_pkey" PRIMARY KEY ("licence_id","user_id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL,
    "owner_type" "AttachmentOwner" NOT NULL,
    "owner_id" UUID NOT NULL,
    "plant_id" UUID NOT NULL,
    "storage_key" VARCHAR(200) NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "scan_status" "ScanStatus" NOT NULL DEFAULT 'PENDING',
    "uploaded_by_id" UUID NOT NULL,
    "uploaded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "replaced_at" TIMESTAMPTZ(3),
    "replaced_by_id" UUID,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "event" "NotificationEvent",
    "custom_category" VARCHAR(60),
    "title" VARCHAR(200) NOT NULL,
    "body" TEXT NOT NULL,
    "sender_id" UUID,
    "link_entity" VARCHAR(40),
    "link_id" UUID,
    "plant_id" UUID,
    "can_acknowledge" BOOLEAN NOT NULL DEFAULT false,
    "can_reply" BOOLEAN NOT NULL DEFAULT false,
    "dedupe_key" VARCHAR(200),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_recipients" (
    "notification_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "read_at" TIMESTAMPTZ(3),
    "acknowledged_at" TIMESTAMPTZ(3),
    "reply" VARCHAR(2000),
    "replied_at" TIMESTAMPTZ(3),

    CONSTRAINT "notification_recipients_pkey" PRIMARY KEY ("notification_id","user_id")
);

-- CreateTable
CREATE TABLE "notification_event_config" (
    "event" "NotificationEvent" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "email_enabled" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_event_config_pkey" PRIMARY KEY ("event")
);

-- CreateTable
CREATE TABLE "notification_send_log" (
    "id" UUID NOT NULL,
    "notification_id" UUID,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "category" "NotificationCategory" NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "sent_to" VARCHAR(300) NOT NULL,
    "recipient_count" INTEGER NOT NULL DEFAULT 0,
    "channel" "SendChannel" NOT NULL,
    "state" "SendState" NOT NULL,
    "error" VARCHAR(500),

    CONSTRAINT "notification_send_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" UUID,
    "actor_role" VARCHAR(80),
    "ip" VARCHAR(64),
    "user_agent" VARCHAR(400),
    "request_id" VARCHAR(64),
    "action" VARCHAR(40) NOT NULL,
    "entity" VARCHAR(40) NOT NULL,
    "entity_id" VARCHAR(64),
    "plant_id" UUID,
    "before" JSONB,
    "after" JSONB,
    "reason" VARCHAR(1000),

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "keka_import_batches" (
    "id" UUID NOT NULL,
    "source" "KekaImportSource" NOT NULL,
    "file_name" VARCHAR(255),
    "dry_run" BOOLEAN NOT NULL,
    "started_by_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "unchanged" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "report" JSONB,

    CONSTRAINT "keka_import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "key" VARCHAR(80) NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_employee_code_key" ON "users"("employee_code");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_login_status_working_status_idx" ON "users"("login_status", "working_status");

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refresh_token_hash_key" ON "sessions"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_family_id_idx" ON "sessions"("family_id");

-- CreateIndex
CREATE INDEX "otp_challenges_user_id_created_at_idx" ON "otp_challenges"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "plants_name_key" ON "plants"("name");

-- CreateIndex
CREATE UNIQUE INDEX "plants_code_key" ON "plants"("code");

-- CreateIndex
CREATE UNIQUE INDEX "plants_plant_key_key" ON "plants"("plant_key");

-- CreateIndex
CREATE INDEX "plants_status_idx" ON "plants"("status");

-- CreateIndex
CREATE INDEX "plant_assignments_plant_id_idx" ON "plant_assignments"("plant_id");

-- CreateIndex
CREATE UNIQUE INDEX "plant_assignments_user_id_plant_id_key" ON "plant_assignments"("user_id", "plant_id");

-- CreateIndex
CREATE UNIQUE INDEX "plant_year_volumes_plant_id_type_fy_key" ON "plant_year_volumes"("plant_id", "type", "fy");

-- CreateIndex
CREATE INDEX "plant_activities_plant_id_idx" ON "plant_activities"("plant_id");

-- CreateIndex
CREATE INDEX "daily_mis_plant_id_report_date_idx" ON "daily_mis"("plant_id", "report_date");

-- CreateIndex
CREATE INDEX "daily_mis_status_created_at_idx" ON "daily_mis"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "daily_mis_one_non_draft_per_plant_date" ON "daily_mis"("plant_id", "report_date") WHERE (status <> 'DRAFT');

-- CreateIndex
CREATE UNIQUE INDEX "daily_mis_revisions_daily_mis_id_version_key" ON "daily_mis_revisions"("daily_mis_id", "version");

-- CreateIndex
CREATE INDEX "monthly_mis_status_created_at_idx" ON "monthly_mis"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "monthly_mis_plant_id_month_key" ON "monthly_mis"("plant_id", "month");

-- CreateIndex
CREATE INDEX "daily_exceptions_status_report_date_idx" ON "daily_exceptions"("status", "report_date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_exceptions_plant_id_report_date_key" ON "daily_exceptions"("plant_id", "report_date");

-- CreateIndex
CREATE INDEX "audits_plant_id_fy_idx" ON "audits"("plant_id", "fy");

-- CreateIndex
CREATE UNIQUE INDEX "audit_observations_observation_code_key" ON "audit_observations"("observation_code");

-- CreateIndex
CREATE INDEX "audit_observations_audit_id_idx" ON "audit_observations"("audit_id");

-- CreateIndex
CREATE INDEX "audit_observations_plant_id_status_idx" ON "audit_observations"("plant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "licence_items_licence_type_title_key" ON "licence_items"("licence_type", "title");

-- CreateIndex
CREATE INDEX "licences_plant_id_category_idx" ON "licences"("plant_id", "category");

-- CreateIndex
CREATE INDEX "licences_end_date_idx" ON "licences"("end_date");

-- CreateIndex
CREATE UNIQUE INDEX "attachments_storage_key_key" ON "attachments"("storage_key");

-- CreateIndex
CREATE INDEX "attachments_owner_type_owner_id_idx" ON "attachments"("owner_type", "owner_id");

-- CreateIndex
CREATE INDEX "attachments_plant_id_idx" ON "attachments"("plant_id");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_dedupe_key_key" ON "notifications"("dedupe_key");

-- CreateIndex
CREATE INDEX "notifications_created_at_idx" ON "notifications"("created_at");

-- CreateIndex
CREATE INDEX "notification_recipients_user_id_read_at_idx" ON "notification_recipients"("user_id", "read_at");

-- CreateIndex
CREATE INDEX "notification_send_log_at_idx" ON "notification_send_log"("at");

-- CreateIndex
CREATE INDEX "audit_log_at_idx" ON "audit_log"("at");

-- CreateIndex
CREATE INDEX "audit_log_entity_entity_id_idx" ON "audit_log"("entity", "entity_id");

-- CreateIndex
CREATE INDEX "audit_log_actor_id_at_idx" ON "audit_log"("actor_id", "at");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_base_role_id_fkey" FOREIGN KEY ("base_role_id") REFERENCES "roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_copied_from_id_fkey" FOREIGN KEY ("copied_from_id") REFERENCES "roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_module_permissions" ADD CONSTRAINT "role_module_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_action_permissions" ADD CONSTRAINT "role_action_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "designation_role_map" ADD CONSTRAINT "designation_role_map_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "otp_challenges" ADD CONSTRAINT "otp_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plants" ADD CONSTRAINT "plants_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant_assignments" ADD CONSTRAINT "plant_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant_assignments" ADD CONSTRAINT "plant_assignments_assigned_by_id_fkey" FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant_assignments" ADD CONSTRAINT "plant_assignments_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "plants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant_assignments" ADD CONSTRAINT "plant_assignments_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant_details" ADD CONSTRAINT "plant_details_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "plants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant_equipment" ADD CONSTRAINT "plant_equipment_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "plants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant_year_volumes" ADD CONSTRAINT "plant_year_volumes_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "plants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant_activities" ADD CONSTRAINT "plant_activities_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "plants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_mis" ADD CONSTRAINT "daily_mis_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "plants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_mis_revisions" ADD CONSTRAINT "daily_mis_revisions_daily_mis_id_fkey" FOREIGN KEY ("daily_mis_id") REFERENCES "daily_mis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monthly_mis" ADD CONSTRAINT "monthly_mis_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "plants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monthly_cylinder_stats" ADD CONSTRAINT "monthly_cylinder_stats_monthly_mis_id_fkey" FOREIGN KEY ("monthly_mis_id") REFERENCES "monthly_mis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monthly_inventory_items" ADD CONSTRAINT "monthly_inventory_items_monthly_mis_id_fkey" FOREIGN KEY ("monthly_mis_id") REFERENCES "monthly_mis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_exceptions" ADD CONSTRAINT "daily_exceptions_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "plants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_exception_lines" ADD CONSTRAINT "daily_exception_lines_exception_id_fkey" FOREIGN KEY ("exception_id") REFERENCES "daily_exceptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lapse_notes" ADD CONSTRAINT "lapse_notes_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "plants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audits" ADD CONSTRAINT "audits_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "plants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_observations" ADD CONSTRAINT "audit_observations_audit_id_fkey" FOREIGN KEY ("audit_id") REFERENCES "audits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "licences" ADD CONSTRAINT "licences_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "plants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "licences" ADD CONSTRAINT "licences_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "licence_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "licence_remind_users" ADD CONSTRAINT "licence_remind_users_licence_id_fkey" FOREIGN KEY ("licence_id") REFERENCES "licences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "licence_remind_users" ADD CONSTRAINT "licence_remind_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_recipients" ADD CONSTRAINT "notification_recipients_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_recipients" ADD CONSTRAINT "notification_recipients_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_send_log" ADD CONSTRAINT "notification_send_log_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE SET NULL ON UPDATE CASCADE;
