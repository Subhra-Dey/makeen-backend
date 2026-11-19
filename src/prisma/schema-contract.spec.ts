import { Prisma } from '../generated/prisma/client';
import * as Db from '../generated/prisma/enums';
import {
  ACTIONS,
  AUDIT_TYPES,
  CYLINDER_SIZES,
  CYLINDER_STAT_CATEGORIES,
  DAILY_MIS_FIELDS,
  DAILY_MIS_SHOWN_ONLY,
  EQUIPMENT_TYPES,
  EXCEPTION_STATUSES,
  INVENTORY_ITEMS,
  LICENCE_TYPES,
  MODULES,
  MODULE_SETTINGS,
  MONTHLY_MIS_INPUT_FIELDS,
  NOTIFICATION_EVENTS,
  RENEWAL_FREQUENCIES,
  REPORT_STATUSES,
} from '../shared';

/**
 * The database schema and the shared contract must never drift (CLAUDE.md: field definitions
 * live once). These checks fail the build if a field or enum value exists on one side only.
 */
describe('Prisma schema ↔ shared contract', () => {
  it.each([
    ['ReportStatus', Db.ReportStatus, REPORT_STATUSES],
    ['ExceptionStatus', Db.ExceptionStatus, EXCEPTION_STATUSES],
    ['Module', Db.Module, MODULES],
    ['ModuleSetting', Db.ModuleSetting, MODULE_SETTINGS],
    ['Action', Db.Action, ACTIONS],
    ['AuditType', Db.AuditType, AUDIT_TYPES],
    ['LicenceType', Db.LicenceType, LICENCE_TYPES],
    ['RenewalFrequency', Db.RenewalFrequency, RENEWAL_FREQUENCIES],
    ['NotificationEvent', Db.NotificationEvent, NOTIFICATION_EVENTS],
    ['CylinderSize', Db.CylinderSize, CYLINDER_SIZES],
    ['CylinderStatCategory', Db.CylinderStatCategory, CYLINDER_STAT_CATEGORIES],
    ['InventoryItem', Db.InventoryItem, INVENTORY_ITEMS],
    ['EquipmentType', Db.EquipmentType, EQUIPMENT_TYPES],
  ])('enum %s matches', (_name, dbEnum, shared) => {
    expect(Object.values(dbEnum)).toEqual([...shared]);
  });

  it('every Daily MIS field (except shown-only header fields) is a daily_mis column', () => {
    const columns = Object.values(Prisma.DailyMisScalarFieldEnum) as string[];
    const expected = DAILY_MIS_FIELDS.map((f) => f.key).filter(
      (k) => !(DAILY_MIS_SHOWN_ONLY as readonly string[]).includes(k),
    );
    for (const key of expected) expect(columns).toContain(key);
    expect(columns).toContain('enteredById');
    expect(columns).toContain('status');
  });

  it('every Monthly MIS input (26–69, 122) is a monthly_mis column', () => {
    const columns = Object.values(Prisma.MonthlyMisScalarFieldEnum) as string[];
    for (const f of MONTHLY_MIS_INPUT_FIELDS) expect(columns).toContain(f.key);
  });
});
