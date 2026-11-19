import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { IS_PUBLIC } from '../auth/actor';
import { ADMIN_ONLY, REQUIRE_ACTION, REQUIRE_MODULE, SIGNED_IN } from './access.decorators';

const RULE_KEYS = [IS_PUBLIC, SIGNED_IN, REQUIRE_MODULE, REQUIRE_ACTION, ADMIN_ONLY];

/** Routes (Controller.method) that carry no access rule at all. Exported for tests. */
export function routesWithoutRule(
  discovery: DiscoveryService,
  scanner: MetadataScanner,
  reflector: Reflector,
): string[] {
  const missing: string[] = [];
  for (const wrapper of discovery.getControllers()) {
    const instance: unknown = wrapper.instance;
    const ctor = wrapper.metatype;
    if (!instance || typeof ctor !== 'function') continue;
    const proto = Object.getPrototypeOf(instance) as object;
    for (const name of scanner.getAllMethodNames(proto)) {
      const handler: unknown = Reflect.get(proto, name);
      if (typeof handler !== 'function') continue;
      if (Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue; // not a route
      const hasRule = RULE_KEYS.some(
        (key) => reflector.getAllAndOverride<unknown>(key, [handler, ctor]) !== undefined,
      );
      if (!hasRule) missing.push(`${ctor.name}.${name}`);
    }
  }
  return missing;
}

/**
 * Fail-closed wiring check (SEC-9): the API refuses to start when any route has no access rule,
 * so a new endpoint can never be silently reachable by every signed-in person.
 */
@Injectable()
export class AccessMetadataCheck implements OnApplicationBootstrap {
  private readonly log = new Logger(AccessMetadataCheck.name);

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onApplicationBootstrap(): void {
    const missing = routesWithoutRule(this.discovery, this.scanner, this.reflector);
    if (missing.length > 0) {
      const msg = `Routes without an access rule (@Public/@SignedIn/@RequireModule/@RequireAction/@AdminOnly): ${missing.join(', ')}`;
      this.log.error(msg);
      throw new Error(msg);
    }
  }
}
