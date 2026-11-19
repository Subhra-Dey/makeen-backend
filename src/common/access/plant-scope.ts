import type { Action, Capability, Module } from '../../shared';
import type { ResolvedAccess, RoleGrants } from '../../modules/access/access.service';
import { forbidden } from './access.guard';

/** What a plant-level operation needs: a module capability, optionally plus an action switch. */
export interface PlantNeed {
  module: Module;
  capability: Capability;
  action?: Action;
}

/** Plants a person may act on for a need: every plant (Admin) or an explicit list. */
export type PlantScope = { all: true } | { all: false; plantIds: string[] };

export const NO_PLANT_ACCESS_MESSAGE = 'You do not have access to this plant.';

function roleAllows(role: RoleGrants, need: PlantNeed): boolean {
  if (role.isAdmin) return true;
  if (!role.modules[need.module].includes(need.capability)) return false;
  return need.action === undefined || role.actions.has(need.action);
}

/**
 * True when the person's role ON THAT PLANT allows the need (D-11). The base role never grants
 * plant data (GEN-1); Admin may act on every plant (GEN-2).
 */
export function canOnPlant(access: ResolvedAccess, plantId: string, need: PlantNeed): boolean {
  if (access.isAdmin) return true;
  const role = access.plantRoles.get(plantId);
  return role !== undefined && roleAllows(role, need);
}

/** Throws 403 unless `canOnPlant`. Services call this with the plant of the row they touch. */
export function assertPlant(access: ResolvedAccess, plantId: string, need: PlantNeed): void {
  if (!canOnPlant(access, plantId, need)) throw forbidden(NO_PLANT_ACCESS_MESSAGE);
}

/** All plants the need is allowed on. */
export function plantScope(access: ResolvedAccess, need: PlantNeed): PlantScope {
  if (access.isAdmin) return { all: true };
  const plantIds = [...access.plantRoles.entries()]
    .filter(([, role]) => roleAllows(role, need))
    .map(([plantId]) => plantId);
  return { all: false, plantIds };
}

/**
 * The plant filter for a list or export: a requested plant must be allowed (never trust a
 * client plantId — SEC-9); no plant means every allowed plant.
 */
export function plantFilter(
  access: ResolvedAccess,
  requestedPlantId: string | undefined,
  need: PlantNeed,
): PlantScope {
  if (requestedPlantId !== undefined) {
    assertPlant(access, requestedPlantId, need);
    return { all: false, plantIds: [requestedPlantId] };
  }
  return plantScope(access, need);
}

/** Prisma `where` fragment for a scope (`{}` for all plants). */
export function plantWhere(scope: PlantScope): { plantId?: { in: string[] } } {
  return scope.all ? {} : { plantId: { in: scope.plantIds } };
}
