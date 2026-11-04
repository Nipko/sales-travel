import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import type { GovernanceRow } from './governance.policy.js';

/**
 * Cuánto vale lo leído de la cadena de un tenant. Lo consulta cada búsqueda y cada pago; un cambio
 * hecho en OTRA réplica tarda como mucho esto en verse (en ésta, escribir invalida).
 */
export const GOVERNANCE_CACHE_TTL_MS = 10_000;
const MAX_CACHED_TENANTS = 5_000;

export interface GovernanceSnapshot {
  /** ¿Ya se sembró la configuración vigente? Antes de eso el gobierno no decide nada. */
  readonly bootstrapped: boolean;
  readonly rows: readonly GovernanceRow[];
}

interface ChainRow {
  source: string;
  provider_code: string;
  payment_method: string;
  tenant_id: string | null;
  lvl: number | string;
  enabled: boolean;
  profile_id: string | null;
  profile_name: string | null;
}

/** Lo que el decisor de proveedores necesita. Existe para poder probarlo sin base. */
export interface GovernanceSource {
  snapshotFor(tenantId: string): Promise<GovernanceSnapshot>;
}

/**
 * Lectura de `governance_chain` (0089) con caché corta. Si la lectura falla y hay copia vencida, se
 * usa la copia: una base que tose no puede encender lo que el superadmin apagó.
 */
@Injectable()
export class GovernanceStore implements GovernanceSource {
  private readonly logger = new Logger(GovernanceStore.name);
  private readonly cache = new Map<string, { expiresAt: number; snapshot: GovernanceSnapshot }>();
  private generation = 0;

  constructor(private readonly db: DatabaseService) {}

  async snapshotFor(tenantId: string): Promise<GovernanceSnapshot> {
    const now = Date.now();
    const cached = this.cache.get(tenantId);
    if (cached !== undefined && cached.expiresAt > now) return cached.snapshot;

    const generation = this.generation;
    let snapshot: GovernanceSnapshot;
    try {
      snapshot = await this.read(tenantId);
    } catch (err) {
      if (cached === undefined) throw err;
      this.logger.warn(
        `no se pudo releer el gobierno de proveedores; se usa la última lectura: ${(err as Error).name}`,
      );
      return cached.snapshot;
    }
    if (generation === this.generation) {
      if (this.cache.size >= MAX_CACHED_TENANTS) this.cache.clear();
      this.cache.set(tenantId, { expiresAt: now + GOVERNANCE_CACHE_TTL_MS, snapshot });
    }
    return snapshot;
  }

  invalidate(): void {
    this.generation += 1;
    this.cache.clear();
  }

  private async read(tenantId: string): Promise<GovernanceSnapshot> {
    const [chain, state] = await Promise.all([
      sql<ChainRow>`SELECT * FROM governance_chain(${tenantId}::uuid)`.execute(this.db.db),
      sql<{ n: number | string }>`SELECT count(*) AS n FROM governance_state`.execute(this.db.db),
    ]);
    return {
      bootstrapped: Number(state.rows[0]?.n ?? 0) > 0,
      rows: chain.rows.map((r) => ({
        source: r.source === 'profile' ? 'profile' : 'rule',
        provider: r.provider_code,
        method: r.payment_method,
        tenantId: r.tenant_id,
        depth: Number(r.lvl),
        enabled: r.enabled,
        profileId: r.profile_id,
        profileName: r.profile_name,
      })),
    };
  }
}
