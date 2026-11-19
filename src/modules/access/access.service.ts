import { Injectable } from '@nestjs/common';
import {
  ACTIONS,
  CAPABILITIES,
  MODULES,
  capabilitiesOf,
  type Action,
  type Capability,
  type Module,
  type ModuleSetting,
} from '../../shared';
import { PrismaService } from '../../prisma/prisma.service';
import type { RoleRef, PlantAccess } from '../../shared';
export type { RoleRef, PlantAccess };

/** One role's grants, resolved from its module settings (D-10 bundles) and action switches. */
export interface RoleGrants {
  id: string;
  name: string;
  isAdmin: boolean;
  modules: Readonly<Record<Module, readonly Capability[]>>;
  actions: ReadonlySet<Action>;
}

/**
 * Everything the API needs to decide a request (BEV-1, SEC-9). Read fresh from the database on
 * every guarded request — never from the token — so a Role-screen save or an assignment change
 * applies to the very next request (D-70).
 */
export interface ResolvedAccess {
  userId: string;
  isAdmin: boolean;
  /** Non-plant screens and people with no plant (D-11). Never grants plant data on its own. */
  baseRole: RoleGrants | null;
  /** Role per assigned plant (D-11). */
  plantRoles: ReadonlyMap<string, RoleGrants>;
  /** Union over every role the person holds; Hidden everywhere → []. */
  modules: Readonly<Record<Module, readonly Capability[]>>;
  actions: readonly Action[];
  hasRole: boolean;
}

/** Effective access of one person, with plant names (for /me and the UI menu). */
export interface AccessProfile {
  isAdmin: boolean;
  baseRole: RoleRef | null;
  plants: PlantAccess[];
  modules: Record<Module, Capability[]>;
  actions: Action[];
  /** False for an unmapped designation with no role anywhere (cannot sign in — PPL-4). */
  hasRole: boolean;
}

interface RoleRow {
  id: string;
  name: string;
  isAdmin: boolean;
  modules: { module: Module; setting: ModuleSetting }[];
  actions: { action: Action; allowed: boolean }[];
}

const roleSelect = {
  id: true,
  name: true,
  isAdmin: true,
  modules: { select: { module: true, setting: true } },
  actions: { select: { action: true, allowed: true } },
} as const;

function emptyModules(): Record<Module, Capability[]> {
  return Object.fromEntries(MODULES.map((m) => [m, [] as Capability[]])) as Record<
    Module,
    Capability[]
  >;
}

/** A role's grants. Admin is a flagged system role with everything (it cannot lock itself out). */
export function grantsOf(role: RoleRow): RoleGrants {
  const modules = emptyModules();
  if (role.isAdmin) {
    for (const m of MODULES) modules[m] = [...CAPABILITIES];
    return { id: role.id, name: role.name, isAdmin: true, modules, actions: new Set(ACTIONS) };
  }
  for (const m of role.modules) modules[m.module] = [...capabilitiesOf(m.setting)];
  const actions = new Set(role.actions.filter((a) => a.allowed).map((a) => a.action));
  return { id: role.id, name: role.name, isAdmin: false, modules, actions };
}

/** Union of several roles' grants (the menu and the module-level guard). */
export function unionOf(roles: readonly RoleGrants[]): {
  modules: Record<Module, Capability[]>;
  actions: Action[];
} {
  const modules = emptyModules();
  const actions = new Set<Action>();
  for (const r of roles) {
    for (const m of MODULES) {
      const merged = new Set([...modules[m], ...r.modules[m]]);
      modules[m] = CAPABILITIES.filter((c) => merged.has(c));
    }
    for (const a of r.actions) actions.add(a);
  }
  return { modules, actions: ACTIONS.filter((a) => actions.has(a)) };
}

@Injectable()
export class AccessService {
  constructor(private readonly prisma: PrismaService) {}

  /** Roles only (no plant names) — one query, and needs no RLS context. */
  async resolve(userId: string): Promise<ResolvedAccess> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        baseRole: { select: roleSelect },
        assignments: { select: { plantId: true, role: { select: roleSelect } } },
      },
    });
    const baseRole = user?.baseRole ? grantsOf(user.baseRole) : null;
    const plantRoles = new Map<string, RoleGrants>();
    const byRoleId = new Map<string, RoleGrants>();
    for (const a of user?.assignments ?? []) {
      const g = byRoleId.get(a.role.id) ?? grantsOf(a.role);
      byRoleId.set(a.role.id, g);
      plantRoles.set(a.plantId, g);
    }
    const all = [...(baseRole ? [baseRole] : []), ...byRoleId.values()];
    const union = unionOf(all);
    return {
      userId,
      isAdmin: all.some((r) => r.isAdmin),
      baseRole,
      plantRoles,
      modules: union.modules,
      actions: union.actions,
      hasRole: all.length > 0,
    };
  }

  async profile(userId: string): Promise<AccessProfile> {
    const access = await this.resolve(userId);
    // Plant names are RLS-protected: read them as the person (Admin sees all plants).
    const plants = await this.prisma.runAs({ userId, isAdmin: access.isAdmin }, (tx) =>
      tx.plant.findMany({
        where: { deletedAt: null },
        select: { id: true, name: true, code: true },
        orderBy: { name: 'asc' },
      }),
    );
    const fallback = access.baseRole
      ? { id: access.baseRole.id, name: access.baseRole.name }
      : null;
    const plantAccess: PlantAccess[] = plants.flatMap((p) => {
      const r = access.plantRoles.get(p.id);
      const role = r ? { id: r.id, name: r.name } : access.isAdmin ? fallback : null;
      return role ? [{ plantId: p.id, name: p.name, code: p.code, role }] : [];
    });
    return {
      isAdmin: access.isAdmin,
      baseRole: fallback,
      plants: plantAccess,
      modules: Object.fromEntries(MODULES.map((m) => [m, [...access.modules[m]]])) as Record<
        Module,
        Capability[]
      >,
      actions: [...access.actions],
      hasRole: access.hasRole,
    };
  }
}
