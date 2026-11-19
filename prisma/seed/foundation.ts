import { encryptAadhaar } from '../../src/common/crypto/aadhaar';
import { hashPassword } from '../../src/common/crypto/password';
import type { Prisma } from '../../src/generated/prisma/client';
import {
  ACTIONS,
  DEFAULT_MODULE_SETTINGS,
  MODULES,
  STANDARD_ROLES,
  defaultActionAllowed,
  plantEndDate,
  type StandardRole,
} from '../../src/shared';
import type { Rng, SeedCalendar } from './context';
import { DESIGNATION_MAP, PEOPLE } from './data/people';
import { PLANTS } from './data/plants';

export interface SeedSecrets {
  password: string;
  pepper: string;
  aadhaarKeyB64: string;
  aadhaarKeyId: string;
}

export interface Foundation {
  roleId: Record<StandardRole, string>;
  userId: Record<string, string>; // by employee code
  plantId: Record<string, string>; // by plant code
  plantByName: Record<string, string>;
  adminId: string;
}

export async function seedFoundation(
  prisma: Prisma.TransactionClient,
  cal: SeedCalendar,
  rng: Rng,
  secrets: SeedSecrets,
): Promise<Foundation> {
  // Roles + default access (ROLE-1, ROLE-D1…D7, ACT-2).
  const roleId = {} as Record<StandardRole, string>;
  for (const name of STANDARD_ROLES) {
    const role = await prisma.role.create({
      data: {
        name,
        isStandard: true,
        isAdmin: name === 'Admin',
        modules: {
          create: MODULES.map((module) => ({
            module,
            setting: DEFAULT_MODULE_SETTINGS[name][module],
          })),
        },
        actions: {
          create: ACTIONS.map((action) => ({
            action,
            allowed: defaultActionAllowed(name, action),
          })),
        },
      },
    });
    roleId[name] = role.id;
  }

  await prisma.designationRoleMap.createMany({
    data: DESIGNATION_MAP.flatMap(([designation, roles]) =>
      roles.map((r) => ({ designation, roleId: roleId[r] })),
    ),
  });

  // People (KEKA). One hash per ACTIVE person (each has its own salt).
  const userId: Record<string, string> = {};
  for (const p of PEOPLE) {
    const aadhaar = encryptAadhaar(p.aadhaar, secrets.aadhaarKeyB64, secrets.aadhaarKeyId);
    const [lastDate, lastTime] = p.lastLogin?.split(' ') ?? [];
    const active = p.login === 'ACTIVE';
    const user = await prisma.user.create({
      data: {
        employeeCode: p.code,
        name: p.name,
        email: `${p.name
          .toLowerCase()
          .replace(/[^a-z]+/g, '.')
          .replace(/^\.|\.$/g, '')}@makeenenergy.com`,
        phone: p.phone,
        aadhaarEnc: new Uint8Array(aadhaar.enc),
        aadhaarKeyId: aadhaar.keyId,
        aadhaarLast4: aadhaar.last4,
        designation: p.designation,
        workingStatus: p.working ?? 'WORKING',
        loginStatus: p.login,
        passwordHash: active ? await hashPassword(secrets.password, secrets.pepper) : null,
        mustSetPassword: !active,
        lastLoginAt: lastDate && lastTime ? cal.atAuthored(lastDate, lastTime) : null,
        baseRoleId: p.role === null ? null : roleId[p.role],
        kekaSyncedAt: cal.atAuthored('2026-10-16', '06:00'),
      },
    });
    userId[p.code] = user.id;
  }
  const adminId = userId['MEI-00412'];
  if (adminId === undefined) throw new Error('Admin missing from people data');

  // Plants (PLT-2). Start = contract date; end = contract + period − 1 day (CHECK enforces both).
  const plantId: Record<string, string> = {};
  const plantByName: Record<string, string> = {};
  const usedKeys = new Set(PLANTS.flatMap((p) => (p.plantKey ? [p.plantKey] : [])));
  for (const p of PLANTS) {
    let key = p.plantKey;
    while (key === undefined || (!p.plantKey && usedKeys.has(key))) {
      key = `PK-${rng.int(0, 0xffffff).toString(16).toUpperCase().padStart(6, '0')}`;
    }
    usedKeys.add(key);
    const contract = cal.d(p.contractDate);
    const managerId = userId[p.manager];
    if (managerId === undefined) throw new Error(`Manager ${p.manager} missing`);
    const plant = await prisma.plant.create({
      data: {
        name: p.name,
        code: p.code,
        address: p.address,
        plantKey: key,
        managerId,
        contractDate: cal.date(contract),
        periodYears: p.periodYears,
        extensionYears: p.extensionYears ?? null,
        startDate: cal.date(contract),
        endDate: cal.date(plantEndDate(contract, p.periodYears)),
        status: p.status,
        createdById: adminId,
      },
    });
    plantId[p.code] = plant.id;
    plantByName[p.name] = plant.id;
  }

  // Assignments: the person's base role on each assigned plant (D-11).
  const allCodes = PLANTS.map((p) => p.code);
  const assignments = PEOPLE.flatMap((p) => {
    if (p.role === null) return [];
    const role = p.role;
    const codes = p.plants === 'ALL' ? allCodes : p.plants;
    return codes.map((code) => {
      const pid = plantId[code];
      const uid = userId[p.code];
      if (pid === undefined || uid === undefined)
        throw new Error(`Bad assignment ${p.code} → ${code}`);
      return {
        userId: uid,
        plantId: pid,
        roleId: roleId[role],
        assignedById: adminId,
        remarks:
          p.code === 'MEI-00733' && code === 'HPB-017'
            ? 'Barhi cover while Manoj is on leave, till 31-10-2026'
            : null,
      };
    });
  });
  await prisma.plantAssignment.createMany({ data: assignments });

  return { roleId, userId, plantId, plantByName, adminId };
}
