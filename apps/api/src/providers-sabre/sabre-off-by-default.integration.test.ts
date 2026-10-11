import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { platformRootId } from '../__fixtures__/platform-root.js';
import {
  platformDecision,
  type EnablementSetting,
} from '../provider-enablement/provider-enablement.policy.js';
import { SABRE_PROVIDER_CODE } from './sabre.factory.js';

/**
 * 0080: Sabre nace apagado para toda la red con un ajuste GLOBAL en `provider_enablement`.
 *
 * Lo que se prueba contra Postgres: que la migración es idempotente (aplicada dos veces deja UNA
 * fila y UN evento), que no pisa un ajuste global que ya existía —encendido a propósito por el
 * superadmin— y que un ajuste por tenant sigue mandando sobre el global en la cadena que lee la
 * búsqueda (`provider_enablement_chain`, 0048).
 *
 * La base de CI ya tiene 0080 aplicada y es compartida: cada caso corre en UNA transacción de
 * superusuario que se deshace, y quita la fila global dentro de ella para partir de "antes de 0080".
 * Se SALTA sin PGHOST, como el resto de los tests de integración.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

const MIGRACION = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'db',
  'migrations',
  '0080_sabre_off_by_default.sql',
);

const ORIGEN = 'migration:0080_sabre_off_by_default';

interface FilaGlobal {
  id: string;
  enabled: boolean;
  reason: string | null;
  updated_by: string | null;
}

d('0080: Sabre apagado por defecto', () => {
  const pool = new pg.Pool();
  const migracion = readFileSync(MIGRACION, 'utf8');
  const sfx = randomBytes(4).toString('hex');

  afterAll(async () => {
    await pool.end();
  });

  /** Corre `fn` en una transacción que se deshace, sin el ajuste global de Sabre. */
  async function antesDe0080(fn: (c: pg.PoolClient) => Promise<void>): Promise<void> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `DELETE FROM provider_enablement WHERE provider_code = $1 AND tenant_id IS NULL`,
        [SABRE_PROVIDER_CODE],
      );
      await fn(c);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  async function globales(c: pg.PoolClient): Promise<FilaGlobal[]> {
    const { rows } = await c.query<FilaGlobal>(
      `SELECT id, enabled, reason, updated_by FROM provider_enablement
        WHERE provider_code = $1 AND tenant_id IS NULL`,
      [SABRE_PROVIDER_CODE],
    );
    return rows;
  }

  async function eventos(c: pg.PoolClient): Promise<number> {
    const { rows } = await c.query<{ n: string }>(
      `SELECT count(*) AS n FROM domain_events
        WHERE event_type = 'platform.provider_enablement.updated'
          AND aggregate_type = 'provider_enablement'
          AND aggregate_id = $1
          AND payload->>'source' = $2`,
      [SABRE_PROVIDER_CODE, ORIGEN],
    );
    return Number(rows[0]?.n ?? 0);
  }

  it('la base migrada tiene a Sabre apagado para todos los tenants', async () => {
    const c = await pool.connect();
    try {
      const filas = await globales(c);
      expect(filas).toHaveLength(1);
      expect(filas[0]?.enabled).toBe(false);
    } finally {
      c.release();
    }
  });

  it('aplicada dos veces deja una sola fila global apagada, sin autor, y un solo evento', async () => {
    await antesDe0080(async (c) => {
      const plataforma = await platformRootId(c);
      const eventosAntes = await eventos(c);

      await c.query(migracion);
      await c.query(migracion);

      const filas = await globales(c);
      expect(filas).toHaveLength(1);
      expect(filas[0]).toMatchObject({ enabled: false, updated_by: null });
      expect(filas[0]?.reason).toContain('certificación');
      expect(await eventos(c)).toBe(eventosAntes + 1);

      const { rows } = await c.query<{
        tenant_id: string | null;
        actor_user_id: string | null;
        payload: unknown;
      }>(
        `SELECT tenant_id, actor_user_id, payload FROM domain_events
          WHERE aggregate_type = 'provider_enablement' AND aggregate_id = $1
            AND payload->>'source' = $2
          ORDER BY occurred_at DESC LIMIT 1`,
        [SABRE_PROVIDER_CODE, ORIGEN],
      );
      // En la auditoría de la red de la plataforma, como los cambios que hace el superadmin.
      expect(rows[0]?.tenant_id).toBe(plataforma);
      expect(rows[0]?.actor_user_id).toBeNull();
      expect(rows[0]?.payload).toEqual({
        providerCode: SABRE_PROVIDER_CODE,
        scope: 'global',
        targetTenantId: null,
        before: null,
        after: { enabled: false, reason: filas[0]?.reason },
        source: ORIGEN,
      });
    });
  });

  it('con un ajuste global previo encendido no lo cambia ni deja evento', async () => {
    await antesDe0080(async (c) => {
      await c.query(
        `INSERT INTO provider_enablement (provider_code, tenant_id, enabled, reason)
         VALUES ($1, NULL, true, 'Encendido a mano por el superadmin')`,
        [SABRE_PROVIDER_CODE],
      );
      const [previa] = await globales(c);
      const eventosAntes = await eventos(c);

      await c.query(migracion);

      expect(await globales(c)).toEqual([previa]);
      expect(previa).toMatchObject({ enabled: true, reason: 'Encendido a mano por el superadmin' });
      expect(await eventos(c)).toBe(eventosAntes);
    });
  });

  it('un ajuste por tenant encendido sigue mandando: sólo esa sucursal tiene Sabre', async () => {
    await antesDe0080(async (c) => {
      async function tenant(slug: string, type: string, parent: string): Promise<string> {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
           VALUES ($1::text, $1::text, 'CO', 'COP', $2, $3) RETURNING id`,
          [`s80-${slug}-${sfx}`, type, parent],
        );
        return rows[0]!.id;
      }
      const consolidador = await tenant('c', 'consolidator', await platformRootId(c));
      const certificacion = await tenant('cert', 'agency', consolidador);
      const hermana = await tenant('h', 'agency', consolidador);
      await c.query(
        `INSERT INTO provider_enablement (provider_code, tenant_id, enabled, reason)
         VALUES ($1, $2, true, 'Sucursal de certificación')`,
        [SABRE_PROVIDER_CODE, certificacion],
      );

      await c.query(migracion);

      const { rows: porTenant } = await c.query<{ enabled: boolean; reason: string }>(
        `SELECT enabled, reason FROM provider_enablement WHERE provider_code = $1 AND tenant_id = $2`,
        [SABRE_PROVIDER_CODE, certificacion],
      );
      expect(porTenant).toEqual([{ enabled: true, reason: 'Sucursal de certificación' }]);

      async function decision(tenantId: string) {
        const { rows } = await c.query<{
          provider_code: string;
          tenant_id: string | null;
          lvl: number;
          enabled: boolean;
        }>(`SELECT provider_code, tenant_id, lvl, enabled FROM provider_enablement_chain($1)`, [
          tenantId,
        ]);
        const settings: EnablementSetting[] = rows.map((r) => ({
          providerCode: r.provider_code,
          tenantId: r.tenant_id,
          depth: Number(r.lvl),
          enabled: r.enabled,
        }));
        return platformDecision(settings, SABRE_PROVIDER_CODE);
      }

      expect(await decision(certificacion)).toEqual({
        enabled: true,
        origin: 'tenant',
        tenantId: certificacion,
      });
      expect(await decision(hermana)).toEqual({ enabled: false, origin: 'global' });
      expect(await decision(consolidador)).toEqual({ enabled: false, origin: 'global' });
    });
  });
});
