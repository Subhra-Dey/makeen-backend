import { DEFAULT_MODULE_SETTINGS, MODULES, type ModuleSetting } from '../../shared';
import {
  grantsOf,
  unionOf,
  type ResolvedAccess,
  type RoleGrants,
} from '../../modules/access/access.service';
import { AppError } from '../errors/app-error';
import { assertPlant, canOnPlant, plantFilter, plantScope, plantWhere } from './plant-scope';

const PLANT_A = 'plant-a';
const PLANT_B = 'plant-b';

function role(name: keyof typeof DEFAULT_MODULE_SETTINGS, isAdmin = false): RoleGrants {
  const matrix = DEFAULT_MODULE_SETTINGS[name];
  return grantsOf({
    id: name,
    name,
    isAdmin,
    modules: MODULES.map((m) => ({ module: m, setting: matrix[m] satisfies ModuleSetting })),
    actions: name === 'Plant Manager' ? [{ action: 'RETURN', allowed: true }] : [],
  });
}

function accessOf(
  plants: Record<string, RoleGrants>,
  base: RoleGrants | null = null,
): ResolvedAccess {
  const all = [...(base ? [base] : []), ...Object.values(plants)];
  const u = unionOf(all);
  return {
    userId: 'u',
    isAdmin: all.some((r) => r.isAdmin),
    baseRole: base,
    plantRoles: new Map(Object.entries(plants)),
    modules: u.modules,
    actions: u.actions,
    hasRole: all.length > 0,
  };
}

describe('plant scope (D-11 role per plant, GEN-1, GEN-2)', () => {
  // Plant Manager on A, Staff on B.
  const mixed = accessOf({ [PLANT_A]: role('Plant Manager'), [PLANT_B]: role('Staff') });

  it('uses the role on THAT plant, not the union', () => {
    const approve = { module: 'DAILY_MIS', capability: 'APPROVE' } as const;
    expect(mixed.modules.DAILY_MIS).toContain('APPROVE'); // union passes the route guard …
    expect(canOnPlant(mixed, PLANT_A, approve)).toBe(true);
    expect(canOnPlant(mixed, PLANT_B, approve)).toBe(false); // … the plant check stops it
    expect(() => {
      assertPlant(mixed, PLANT_B, approve);
    }).toThrow(AppError);
  });

  it('checks action switches on the plant role', () => {
    const ret = { module: 'DAILY_MIS', capability: 'APPROVE', action: 'RETURN' } as const;
    expect(canOnPlant(mixed, PLANT_A, ret)).toBe(true);
    expect(canOnPlant(mixed, 'other', ret)).toBe(false);
  });

  it('lists only allowed plants and refuses a forged plantId', () => {
    const view = { module: 'DAILY_MIS', capability: 'VIEW' } as const;
    expect(plantScope(mixed, view)).toEqual({ all: false, plantIds: [PLANT_A, PLANT_B] });
    expect(plantScope(mixed, { module: 'DAILY_MIS', capability: 'DOWNLOAD' })).toEqual({
      all: false,
      plantIds: [PLANT_A],
    });
    expect(() => plantFilter(mixed, 'someone-elses-plant', view)).toThrow(AppError);
    expect(plantFilter(mixed, PLANT_B, view)).toEqual({ all: false, plantIds: [PLANT_B] });
  });

  it('never grants plant data from the base role alone (GEN-1)', () => {
    const noPlants = accessOf({}, role('QHSE Head'));
    expect(noPlants.modules.DAILY_MIS).toContain('VIEW');
    expect(plantScope(noPlants, { module: 'DAILY_MIS', capability: 'VIEW' })).toEqual({
      all: false,
      plantIds: [],
    });
  });

  it('gives Admin every plant (GEN-2)', () => {
    const admin = accessOf({}, role('Admin', true));
    expect(plantScope(admin, { module: 'AUDIT', capability: 'APPROVE' })).toEqual({ all: true });
    expect(canOnPlant(admin, 'any', { module: 'PEOPLE', capability: 'SUBMIT' })).toBe(true);
    expect(plantWhere({ all: true })).toEqual({});
    expect(plantWhere({ all: false, plantIds: ['x'] })).toEqual({ plantId: { in: ['x'] } });
  });

  it('treats Hidden as nothing at all (ROLE-9)', () => {
    const staff = accessOf({ [PLANT_A]: role('Staff') });
    expect(staff.modules.MANAGEMENT_REVIEW).toEqual([]);
    expect(canOnPlant(staff, PLANT_A, { module: 'MANAGEMENT_REVIEW', capability: 'VIEW' })).toBe(
      false,
    );
  });
});
