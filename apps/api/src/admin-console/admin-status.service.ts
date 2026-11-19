import { Injectable } from '@nestjs/common';
import { AdminOverviewService } from './admin-overview.service.js';
import { AdminSystemService } from './admin-system.service.js';
import { foldPlatformStatus, type PlatformStatusView } from './platform-status.fold.js';
import { PROJECT_PENDINGS, pendingsView } from './project-pendings.js';

/** Cuándo arrancó este proceso: lo que lleva corriendo la versión desplegada en esta réplica. */
const STARTED_AT = new Date(Date.now() - process.uptime() * 1000);

/**
 * Plataforma → Estado: junta lo que ya leen Salud (búsquedas por proveedor), Sistema (barrido,
 * conciliación, catálogos) y el Resumen (reservas que esperan, depósitos, apagados y circuitos) y lo
 * pliega a un semáforo por área, con los pendientes del proyecto. No agrega lecturas propias: cada
 * una ya exige al superadmin en la base, y así el Estado no puede decir algo distinto que la
 * pantalla a la que enlaza.
 */
@Injectable()
export class AdminStatusService {
  constructor(
    private readonly system: AdminSystemService,
    private readonly overview: AdminOverviewService,
  ) {}

  async status(actorUserId: string, now: Date = new Date()): Promise<PlatformStatusView> {
    const [health, jobs, overview] = await Promise.all([
      this.system.providerHealth(actorUserId, now),
      this.system.jobs(actorUserId, now),
      this.overview.overview(actorUserId, {}, now),
    ]);
    return foldPlatformStatus(
      {
        health: health.providers,
        signals: overview.providers,
        sweep: jobs.postSaleSweep,
        reconciliation: jobs.reconciliation,
        catalogs: jobs.catalogs,
        attention: overview.attention,
      },
      {
        now,
        version: process.env['APP_VERSION'] ?? 'dev',
        startedAt: STARTED_AT,
        pendings: pendingsView(PROJECT_PENDINGS, now),
      },
    );
  }
}
