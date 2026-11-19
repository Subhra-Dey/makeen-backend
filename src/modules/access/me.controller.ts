import { ApiTags } from '@nestjs/swagger';
import { Controller, Get, HttpStatus } from '@nestjs/common';
import { SignedIn } from '../../common/access/access.decorators';
import { CurrentActor, type Actor } from '../../common/auth/actor';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { maskAadhaar, maskPhone, type MeResponse } from '../../shared';
import { PrismaService } from '../../prisma/prisma.service';
import { AccessService } from './access.service';
export type { MeResponse };

/** GET /api/me — profile, permission matrix and assigned plants (SEC-11, PROF-2). */
@SignedIn()
@ApiTags('Me')
@Controller('me')
export class MeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
  ) {}

  @Get()
  async me(@CurrentActor() actor: Actor): Promise<MeResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: actor.userId },
      select: {
        id: true,
        employeeCode: true,
        name: true,
        email: true,
        phone: true,
        aadhaarLast4: true,
        designation: true,
        photoUrl: true,
        loginStatus: true,
        workingStatus: true,
        lastLoginAt: true,
      },
    });
    if (!user)
      throw new AppError(HttpStatus.UNAUTHORIZED, ErrorCode.UNAUTHENTICATED, 'Please sign in.');
    const profile = await this.access.profile(user.id);
    return {
      user: {
        id: user.id,
        employeeCode: user.employeeCode,
        name: user.name,
        email: user.email,
        phone: user.phone ? maskPhone(user.phone) : null,
        aadhaar: user.aadhaarLast4 ? maskAadhaar(user.aadhaarLast4) : null,
        designation: user.designation,
        photoUrl: user.photoUrl,
        loginStatus: user.loginStatus,
        workingStatus: user.workingStatus,
        lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      },
      role: profile.baseRole,
      isAdmin: profile.isAdmin,
      plants: profile.plants,
      access: { modules: profile.modules, actions: profile.actions },
    };
  }
}
