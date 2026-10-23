import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import {
  describePlatformAdminConfig,
  resolvePlatformAdminConfig,
  type PlatformAdminConfig,
} from './platform-admin-config';
import { checkPlatformAdminIndexes } from './platform-admin-indexes';
import {
  platformAdminCollections,
  type PlatformAdminCollections,
} from './platform-admin-store';

/** Configuration résolue (substituable dans les tests). */
export const PLATFORM_ADMIN_CONFIG = Symbol('PLATFORM_ADMIN_CONFIG');
/** Horloge serveur (substituable dans les tests). */
export const PLATFORM_ADMIN_CLOCK = Symbol('PLATFORM_ADMIN_CLOCK');
export type PlatformAdminClock = () => Date;

export const platformAdminConfigProvider = {
  provide: PLATFORM_ADMIN_CONFIG,
  useFactory: (): PlatformAdminConfig => {
    const config = resolvePlatformAdminConfig(process.env);
    const logger = new Logger('PlatformAdmin');
    const summary = `Administration de la plateforme : ${describePlatformAdminConfig(config)}`;
    if (!config.enabled && config.state === 'invalid') logger.warn(summary);
    else logger.log(summary);
    return config;
  },
};

export const platformAdminClockProvider = {
  provide: PLATFORM_ADMIN_CLOCK,
  useValue: (() => new Date()) as PlatformAdminClock,
};

/** Nouvelle vérification des index après un échec (pas à chaque requête). */
const INDEX_RECHECK_MS = 60_000;

/**
 * État d'ouverture de l'espace : configuration valide ET index en place.
 * Les index ne sont lus qu'une fois tant qu'ils sont valides ; absents, la
 * lecture est refaite au plus une fois par minute (espace fermé entre-temps).
 */
@Injectable()
export class PlatformAdminRuntime {
  private indexesReady = false;
  private lastIndexCheck = 0;
  private readonly logger = new Logger('PlatformAdmin');

  constructor(
    @Inject(PLATFORM_ADMIN_CONFIG) readonly config: PlatformAdminConfig,
    @Inject(PLATFORM_ADMIN_CLOCK) readonly clock: PlatformAdminClock,
    @InjectConnection() readonly connection: Connection,
  ) {}

  collections(): PlatformAdminCollections {
    return platformAdminCollections(this.connection);
  }

  async isOpen(): Promise<boolean> {
    if (!this.config.enabled) return false;
    if (this.indexesReady) return true;
    const now = Date.now();
    if (
      this.lastIndexCheck !== 0 &&
      now - this.lastIndexCheck < INDEX_RECHECK_MS
    ) {
      return false;
    }
    this.lastIndexCheck = now;
    try {
      const problems = await checkPlatformAdminIndexes(this.connection);
      if (problems.length > 0) {
        this.logger.warn(
          `Index de l'administration absents ou différents (migrate:predeploy) : ${problems.join(', ')}`,
        );
        return false;
      }
      this.indexesReady = true;
      return true;
    } catch {
      this.logger.warn(
        "Vérification des index de l'administration impossible.",
      );
      return false;
    }
  }
}
