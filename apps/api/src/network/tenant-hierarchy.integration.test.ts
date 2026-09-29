import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpStatus } from '@nestjs/common';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { legacyTenant, platformRootId } from '../__fixtures__/platform-root.js';
import { tenantHierarchyHttpError } from '../database/tenant-hierarchy-errors.js';

/**
 * La jerarquía de tenants contra Postgres: la promoción de Planetour a raíz `platform` (0049), la
 * matriz D4 y las sucursales (0050) y el movimiento de un nodo con su subárbol (0051).
 *
 * Corre sobre la base compartida por todos los tests de integración: la raíz `platform` es una sola
 * y es la común (`platformRootId`). Lo que necesita otro estado de la raíz (la promoción) se hace en
 * una transacción que se deshace. Se SALTA sin PGHOST.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

const PROMOCION = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'db',
  'migrations',
  '0049_platform_root.sql',
);

interface PgFailure {
  readonly code?: string;
  readonly constraint?: string;
  readonly message: string;
  readonly detail?: string;
  readonly hint?: string;
}

/** El error de Postgres con que falla `p`. Falla el test si `p` no falla. */
async function failure(p: Promise<unknown>): Promise<PgFailure> {
  try {
    await p;
  } catch (err) {
    return err as PgFailure;
  }
  throw new Error('esperaba un error de Postgres');
}

/** La fecha `YYYY-MM-DD` a `offset` días de hoy (negativo = ya pasó). */
function day(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

/** La regla STH01/STH02 (o el constraint) con que falla `p`, como `código/regla`. */
async function rule(p: Promise<unknown>): Promise<string> {
  const err = await failure(p);
  return `${err.code ?? '?'}/${err.constraint ?? '?'}`;
}

d('jerarquía de tenants (0049, 0050, 0051) contra Postgres', () => {
  const pool = new pg.Pool();
  const sfx = randomBytes(4).toString('hex');
  const PROV = `th-prov-${sfx}`;
  const tenants: string[] = [];
  const users: string[] = [];
  let platform: string;
  let orderNumber = 990_000;

  async function tenant(
    slug: string,
    type: string,
    parent: string | null,
    isBranch = false,
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id,
                            is_branch)
       VALUES ($1::text, $1::text, 'CO', 'COP', $2, $3, $4) RETURNING id`,
      [`th-${slug}-${sfx}`, type, parent, isBranch],
    );
    tenants.push(rows[0]!.id);
    return rows[0]!.id;
  }

  async function legacy(
    slug: string,
    type: 'consolidator' | 'agency' | 'subagency',
    parent: string | null = null,
  ): Promise<string> {
    const c = await pool.connect();
    try {
      const id = await legacyTenant(c, `th-${slug}-${sfx}`, type, parent);
      tenants.push(id);
      return id;
    } finally {
      c.release();
    }
  }

  async function user(label: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) RETURNING id`,
      [`th-${label}-${sfx}@test.local`],
    );
    users.push(rows[0]!.id);
    return rows[0]!.id;
  }

  async function move(node: string | null, parent: string | null): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      'SELECT move_tenant_subtree($1::uuid, $2::uuid) AS n',
      [node, parent],
    );
    return Number(rows[0]!.n);
  }

  async function node(id: string): Promise<{ parent: string | null; depth: number; path: string }> {
    const { rows } = await pool.query<{ parent: string | null; depth: number; path: string }>(
      `SELECT parent_tenant_id AS parent, nlevel(path) AS depth, path::text AS path
         FROM tenants WHERE id = $1`,
      [id],
    );
    return { ...rows[0]!, depth: Number(rows[0]!.depth) };
  }

  async function account(tenantId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO provider_accounts (tenant_id, provider_code, credentials_enc, is_inheritable, status)
       VALUES ($1, $2, '\\x00'::bytea, true, 'active') RETURNING id`,
      [tenantId, PROV],
    );
    return rows[0]!.id;
  }

  async function owner(tenantId: string): Promise<string | null> {
    const { rows } = await pool.query<{ tenant_id: string | null }>(
      `SELECT tenant_id FROM resolve_provider_account($1::uuid, $2)`,
      [tenantId, PROV],
    );
    return rows[0]?.tenant_id ?? null;
  }

  /** Una orden del tenant; `checkout` en días desde hoy (negativo = ya pasó). */
  async function order(
    tenantId: string,
    userId: string,
    status: string,
    opts: { checkout?: number; accountId?: string; criteria?: Record<string, unknown> } = {},
  ): Promise<string> {
    orderNumber += 1;
    const criteria =
      opts.criteria ??
      (opts.checkout === undefined ? {} : { vertical: 'hotels', checkoutDate: day(opts.checkout) });
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO orders (tenant_id, user_id, provider, search_criteria, selected_offer, passengers,
                           contact_info, total_amount, order_number, status, provider_account_id)
       VALUES ($1, $2, $3, $4::jsonb, '{}', '[]', '{}', 100, $5, $6, $7) RETURNING id`,
      [
        tenantId,
        userId,
        PROV,
        JSON.stringify(criteria),
        orderNumber,
        status,
        opts.accountId ?? null,
      ],
    );
    return rows[0]!.id;
  }

  /** Retiene saldo de la cartera del tenant para la orden (como `holdBooking`). */
  async function hold(tenantId: string, orderId: string, userId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO agency_portfolios (tenant_id, currency) VALUES ($1, 'COP')
       ON CONFLICT (tenant_id) DO UPDATE SET currency = EXCLUDED.currency
       RETURNING id`,
      [tenantId],
    );
    await pool.query(
      `INSERT INTO portfolio_transactions (portfolio_id, amount_minor, transaction_type, reference_id, created_by)
       VALUES ($1, -100, 'BOOKING_HOLD', $2, $3)`,
      [rows[0]!.id, orderId, userId],
    );
    return rows[0]!.id;
  }

  beforeAll(async () => {
    platform = await platformRootId(pool);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM orders WHERE tenant_id = ANY($1::uuid[])', [tenants]);
    // parent_tenant_id es ON DELETE RESTRICT: de la hoja a la raíz.
    const { rows } = await pool.query<{ id: string }>(
      'SELECT id FROM tenants WHERE id = ANY($1::uuid[]) ORDER BY nlevel(path) DESC',
      [tenants],
    );
    for (const r of rows) await pool.query('DELETE FROM tenants WHERE id = $1', [r.id]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [users]);
    await pool.end();
  });

  describe('la matriz D4 (tenant_hierarchy_rule)', () => {
    it.each([
      ['platform', false, null, null],
      ['platform', false, 'platform', 'tenant_platform_is_root'],
      ['consolidator', false, null, 'tenant_root_must_be_platform'],
      ['agency', false, null, 'tenant_root_must_be_platform'],
      ['subagency', false, null, 'tenant_root_must_be_platform'],
      ['consolidator', false, 'platform', null],
      ['agency', false, 'platform', null],
      ['agency', true, 'platform', null],
      ['subagency', false, 'platform', 'tenant_parent_type'],
      ['agency', false, 'consolidator', null],
      ['consolidator', false, 'consolidator', 'tenant_parent_type'],
      ['subagency', false, 'consolidator', 'tenant_parent_type'],
      ['agency', true, 'consolidator', 'tenant_branch_parent'],
      ['subagency', false, 'agency', null],
      ['agency', false, 'agency', 'tenant_parent_type'],
      ['consolidator', false, 'agency', 'tenant_parent_type'],
      ['subagency', false, 'subagency', 'tenant_parent_type'],
      ['agency', false, 'subagency', 'tenant_parent_type'],
      ['consolidator', true, 'platform', 'tenant_branch_type'],
      ['subagency', true, 'agency', 'tenant_branch_type'],
    ])('%s (sucursal: %s) bajo %s → %s', async (type, isBranch, parentType, expected) => {
      const { rows } = await pool.query<{ rule: string | null }>(
        'SELECT tenant_hierarchy_rule($1, $2, $3) AS rule',
        [type, isBranch, parentType],
      );
      expect(rows[0]!.rule).toBe(expected);
    });
  });

  describe('reserva abierta (order_is_active)', () => {
    it.each([
      ['pending', {}, true],
      ['cancelled', { checkoutDate: day(10) }, false],
      ['failed', { departureDate: day(10) }, false],
      ['confirmed', { vertical: 'hotels', checkoutDate: day(10) }, true],
      ['confirmed', { vertical: 'hotels', checkoutDate: day(0) }, true],
      ['confirmed', { vertical: 'hotels', checkoutDate: day(-3) }, false],
      ['confirmed', { vertical: 'cars', dropOffDate: day(3) }, true],
      ['confirmed', { vertical: 'cars', dropOffDate: day(-3) }, false],
      ['ticketed', { departureDate: day(-5), returnDate: day(2) }, true],
      ['ticketed', { departureDate: day(-5), returnDate: day(-3) }, false],
      ['ticketed', { departureDate: day(1) }, true],
      ['ticketed', { departureDate: day(-3) }, false],
      ['ticketed', { departureDate: day(-5), returnDate: 'pronto' }, false],
      ['confirmed', {}, true],
      ['confirmed', { checkoutDate: '10/10/2026' }, true],
    ])('%s con %j → %s', async (status, criteria, expected) => {
      const { rows } = await pool.query<{ open: boolean }>(
        'SELECT order_is_active($1, $2::jsonb) AS open',
        [status, JSON.stringify(criteria)],
      );
      expect(rows[0]!.open).toBe(expected);
    });
  });

  describe('altas: el trigger aplica la matriz', () => {
    it('la red válida entra: plataforma → consolidador → agencia → sub-agencia, y la sucursal', async () => {
      const cons = await tenant('ok-c', 'consolidator', platform);
      const ag = await tenant('ok-a', 'agency', cons);
      const sub = await tenant('ok-s', 'subagency', ag);
      const directa = await tenant('ok-d', 'agency', platform);
      const sucursal = await tenant('ok-b', 'agency', platform, true);

      expect((await node(sub)).depth).toBe(4);
      expect((await node(directa)).parent).toBe(platform);
      const { rows } = await pool.query<{ is_branch: boolean }>(
        'SELECT is_branch FROM tenants WHERE id = $1',
        [sucursal],
      );
      expect(rows[0]!.is_branch).toBe(true);
    });

    it('una segunda plataforma choca con el índice único, y la API la lee como la regla', async () => {
      const err = await failure(tenant('p2', 'platform', null));

      expect(`${err.code}/${err.constraint}`).toBe('23505/uq_tenants_single_platform');
      expect(tenantHierarchyHttpError(err)?.reason).toBe('TENANT_SINGLE_PLATFORM');
    });

    it('la plataforma no cuelga de nadie', async () => {
      const cons = await tenant('pp-c', 'consolidator', platform);
      expect(await rule(tenant('pp-p', 'platform', cons))).toBe('STH01/tenant_platform_is_root');
    });

    it.each(['consolidator', 'agency', 'subagency'])(
      'un %s no puede ser raíz: sólo la plataforma',
      async (type) => {
        expect(await rule(tenant(`root-${type}`, type, null))).toBe(
          'STH01/tenant_root_must_be_platform',
        );
      },
    );

    it('las combinaciones prohibidas se rechazan con su regla', async () => {
      const cons = await tenant('x-c', 'consolidator', platform);
      const ag = await tenant('x-a', 'agency', cons);
      const sub = await tenant('x-s', 'subagency', ag);

      expect(await rule(tenant('x-1', 'subagency', platform))).toBe('STH01/tenant_parent_type');
      expect(await rule(tenant('x-2', 'consolidator', cons))).toBe('STH01/tenant_parent_type');
      expect(await rule(tenant('x-3', 'agency', ag))).toBe('STH01/tenant_parent_type');
      expect(await rule(tenant('x-4', 'subagency', sub))).toBe('STH01/tenant_parent_type');
      expect(await rule(tenant('x-5', 'agency', cons, true))).toBe('STH01/tenant_branch_parent');
      expect(await rule(tenant('x-6', 'consolidator', platform, true))).toBe(
        'STH01/tenant_branch_type',
      );
    });

    it('un padre que no existe', async () => {
      expect(await rule(tenant('huerfano', 'agency', '00000000-0000-4000-8000-000000000000'))).toBe(
        'STH01/tenant_parent_not_found',
      );
    });

    it('el error nombra la regla en castellano y sin ids; el id queda en el detalle, para los logs', async () => {
      const err = await failure(tenant('msg', 'agency', null));

      expect(err.message).toBe(
        'sólo la plataforma puede ser raíz: un nodo de tipo agency tiene que colgar de la red',
      );
      expect(err.message).not.toMatch(/[0-9a-f]{8}-/);
      expect(err.detail).toMatch(/^tenant [0-9a-f-]{36} \(tipo agency\)/);
      expect(err.hint).toContain('Bajo la plataforma cuelgan consolidadores y agencias');

      const http = tenantHierarchyHttpError(err);
      expect(http?.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(http?.reason).toBe('TENANT_ROOT_MUST_BE_PLATFORM');
    });
  });

  describe('cambios de tipo, padre y sucursal', () => {
    it('un cambio de tipo que deja a los hijos fuera de la matriz se rechaza', async () => {
      const ag = await tenant('ct-a', 'agency', platform);
      await tenant('ct-s', 'subagency', ag);

      expect(
        await rule(
          pool.query(`UPDATE tenants SET tenant_type = 'consolidator' WHERE id = $1`, [ag]),
        ),
      ).toBe('STH01/tenant_children_type');
    });

    it('un cambio de tipo válido para el nodo y sus hijos pasa', async () => {
      const ag = await tenant('ct2-a', 'agency', platform);

      await pool.query(`UPDATE tenants SET tenant_type = 'consolidator' WHERE id = $1`, [ag]);
      await tenant('ct2-hija', 'agency', ag);
      // De vuelta a agencia, su hija agencia quedaría fuera de la matriz.
      expect(
        await rule(pool.query(`UPDATE tenants SET tenant_type = 'agency' WHERE id = $1`, [ag])),
      ).toBe('STH01/tenant_children_type');
    });

    it('sucursal: sólo una agencia hija directa de la plataforma', async () => {
      const directa = await tenant('br-d', 'agency', platform);
      const cons = await tenant('br-c', 'consolidator', platform);
      const deCons = await tenant('br-a', 'agency', cons);

      await pool.query('UPDATE tenants SET is_branch = true WHERE id = $1', [directa]);
      await pool.query('UPDATE tenants SET is_branch = false WHERE id = $1', [directa]);
      expect(
        await rule(pool.query('UPDATE tenants SET is_branch = true WHERE id = $1', [deCons])),
      ).toBe('STH01/tenant_branch_parent');
      expect(
        await rule(pool.query('UPDATE tenants SET is_branch = true WHERE id = $1', [cons])),
      ).toBe('STH01/tenant_branch_type');
    });

    it('lo que ya existía fuera de la matriz sigue funcionando mientras no cambie de tipo, padre o sucursal', async () => {
      const suelta = await legacy('suelta', 'agency');

      await pool.query(`UPDATE tenants SET name = 'Renombrada', status = 'active' WHERE id = $1`, [
        suelta,
      ]);
      await pool.query('UPDATE tenants SET tenant_type = tenant_type WHERE id = $1', [suelta]);
      expect(
        await rule(
          pool.query(`UPDATE tenants SET tenant_type = 'subagency' WHERE id = $1`, [suelta]),
        ),
      ).toBe('STH01/tenant_root_must_be_platform');
    });

    it('el padre no cambia por UPDATE: hace falta move_tenant_subtree', async () => {
      const ag = await tenant('rp-a', 'agency', platform);
      const cons = await tenant('rp-c', 'consolidator', platform);

      expect(
        await rule(
          pool.query('UPDATE tenants SET parent_tenant_id = $2 WHERE id = $1', [ag, cons]),
        ),
      ).toBe('STH01/tenant_move_required');
    });

    it('la marca de movimiento falsificada no le abre el cambio de padre a app_user', async () => {
      const ag = await tenant('rpf-a', 'agency', platform);
      const cons = await tenant('rpf-c', 'consolidator', platform);
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE app_user');
        await c.query(`SELECT set_config('app.tenant_move', $1, true)`, [`${ag}>${cons}`]);
        expect(
          await rule(c.query('UPDATE tenants SET parent_tenant_id = $2 WHERE id = $1', [ag, cons])),
        ).toBe('STH01/tenant_move_required');
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
      expect((await node(ag)).parent).toBe(platform);
    });

    it('nada cuelga por debajo del nivel 4, aunque la matriz lo admita', async () => {
      // Una cadena de antes de 0050 que la matriz ya no deja armar: consolidador bajo consolidador.
      const cons = await tenant('dl-c', 'consolidator', platform);
      const l3 = await legacy('dl-l3', 'consolidator', cons);
      const l4 = await legacy('dl-l4', 'agency', l3);

      expect((await node(l4)).depth).toBe(4);
      expect(await rule(tenant('dl-l5', 'subagency', l4))).toBe('STH01/tenant_depth_limit');
    });
  });

  describe('move_tenant_subtree', () => {
    it('mueve una agencia raíz de antes de 0050 (Amazon) bajo la plataforma, con su subárbol', async () => {
      const amazon = await legacy('amazon-minimalist', 'agency');
      const hija = await tenant('amazon-sub', 'subagency', amazon);
      const antes = await node(amazon);

      expect(await move(amazon, platform)).toBe(2);

      const despues = await node(amazon);
      expect(despues.parent).toBe(platform);
      expect(despues.depth).toBe(2);
      const sub = await node(hija);
      expect(sub.depth).toBe(3);
      expect(sub.path.startsWith(`${despues.path}.`)).toBe(true);
      const { rows: huerfanos } = await pool.query(
        'SELECT 1 FROM tenants WHERE path <@ $1::ltree',
        [antes.path],
      );
      expect(huerfanos).toHaveLength(0);

      const { rows: eventos } = await pool.query<{
        tenant_id: string;
        actor_user_id: string | null;
        payload: Record<string, unknown>;
      }>(
        `SELECT tenant_id, actor_user_id, payload FROM domain_events
          WHERE event_type = 'tenant.moved' AND aggregate_type = 'tenant' AND aggregate_id = $1`,
        [amazon],
      );
      expect(eventos).toEqual([
        {
          tenant_id: amazon,
          actor_user_id: null,
          payload: {
            fromParentId: null,
            toParentId: platform,
            movedTenants: 2,
            source: 'move_tenant_subtree',
          },
        },
      ]);
    });

    it('desde el cambio rigen las credenciales del nuevo padre', async () => {
      const c1 = await tenant('cr-c1', 'consolidator', platform);
      const c2 = await tenant('cr-c2', 'consolidator', platform);
      await account(c1);
      await account(c2);
      const ag = await tenant('cr-a', 'agency', c1);
      const sub = await tenant('cr-s', 'subagency', ag);
      expect(await owner(sub)).toBe(c1);

      expect(await move(ag, c2)).toBe(2);

      expect(await owner(sub)).toBe(c2);
      expect((await node(sub)).path.startsWith((await node(c2)).path)).toBe(true);
    });

    it('mover al padre que ya tiene no hace nada', async () => {
      const ag = await tenant('noop-a', 'agency', platform);

      expect(await move(ag, platform)).toBe(0);
      const { rows } = await pool.query(
        `SELECT 1 FROM domain_events WHERE event_type = 'tenant.moved' AND aggregate_id = $1`,
        [ag],
      );
      expect(rows).toHaveLength(0);
    });

    it('rechaza los ciclos', async () => {
      const cons = await tenant('cy-c', 'consolidator', platform);
      const ag = await tenant('cy-a', 'agency', cons);

      expect(await rule(move(cons, ag))).toBe('STH01/tenant_move_cycle');
      expect(await rule(move(ag, ag))).toBe('STH01/tenant_move_cycle');
    });

    it('rechaza lo que la matriz prohíbe', async () => {
      const c1 = await tenant('mx-c1', 'consolidator', platform);
      const c2 = await tenant('mx-c2', 'consolidator', platform);
      const ag = await tenant('mx-a', 'agency', c1);
      const otraAg = await tenant('mx-a2', 'agency', c2);
      const sub = await tenant('mx-s', 'subagency', otraAg);
      const sucursal = await tenant('mx-b', 'agency', platform, true);

      expect(await rule(move(ag, sub))).toBe('STH01/tenant_parent_type');
      expect(await rule(move(c1, c2))).toBe('STH01/tenant_parent_type');
      expect(await rule(move(ag, null))).toBe('STH01/tenant_root_must_be_platform');
      expect(await rule(move(platform, c1))).toBe('STH01/tenant_move_cycle');
      expect(await rule(move(sucursal, c1))).toBe('STH01/tenant_branch_parent');
      expect((await node(ag)).parent).toBe(c1);
    });

    it('rechaza pasar de 4 niveles contando todo el subárbol', async () => {
      const cons = await tenant('md-c', 'consolidator', platform);
      const l3 = await legacy('md-l3', 'consolidator', cons);
      const ag = await tenant('md-a', 'agency', cons);
      await tenant('md-s', 'subagency', ag);

      expect(await rule(move(ag, l3))).toBe('STH01/tenant_depth_limit');
    });

    it('el nodo o el padre que no existen', async () => {
      const ag = await tenant('nf-a', 'agency', platform);
      const nadie = '00000000-0000-4000-8000-000000000000';

      expect(await rule(move(nadie, platform))).toBe('STH01/tenant_not_found');
      expect(await rule(move(ag, nadie))).toBe('STH01/tenant_parent_not_found');
      expect(tenantHierarchyHttpError(await failure(move(nadie, platform)))?.getStatus()).toBe(
        HttpStatus.NOT_FOUND,
      );
    });

    it('bloquea con reservas abiertas pagadas con cartera, y deja mover cuando se liberan', async () => {
      const c1 = await tenant('w-c1', 'consolidator', platform);
      const c2 = await tenant('w-c2', 'consolidator', platform);
      const ag = await tenant('w-a', 'agency', c1);
      const sub = await tenant('w-s', 'subagency', ag);
      const vendedor = await user('w-v');
      const abierta = await order(sub, vendedor, 'confirmed', { checkout: 10 });
      const cartera = await hold(sub, abierta, vendedor);

      const err = await failure(move(ag, c2));
      expect(`${err.code}/${err.constraint}`).toBe('STH02/tenant_move_open_wallet_bookings');
      expect(err.message).toContain('1 reserva(s) abierta(s) pagada(s) con cartera');
      expect(tenantHierarchyHttpError(err)?.reason).toBe('TENANT_MOVE_OPEN_WALLET_BOOKINGS');
      expect((await node(ag)).parent).toBe(c1);

      await pool.query(
        `INSERT INTO portfolio_transactions (portfolio_id, amount_minor, transaction_type, reference_id, created_by)
         VALUES ($1, 100, 'BOOKING_RELEASED', $2, $3)`,
        [cartera, abierta, vendedor],
      );
      expect(await move(ag, c2)).toBe(2);
    });

    it('una reserva cerrada (cancelada o con el check-out pasado) no bloquea, aunque tenga retención', async () => {
      const c1 = await tenant('wc-c1', 'consolidator', platform);
      const c2 = await tenant('wc-c2', 'consolidator', platform);
      const ag = await tenant('wc-a', 'agency', c1);
      const vendedor = await user('wc-v');
      await hold(ag, await order(ag, vendedor, 'cancelled', { checkout: 10 }), vendedor);
      await hold(ag, await order(ag, vendedor, 'confirmed', { checkout: -3 }), vendedor);

      expect(await move(ag, c2)).toBe(1);
    });

    it('un vuelo o un auto emitidos se cierran al día siguiente de la vuelta o la devolución', async () => {
      const c1 = await tenant('wf-c1', 'consolidator', platform);
      const c2 = await tenant('wf-c2', 'consolidator', platform);
      const ag = await tenant('wf-a', 'agency', c1);
      const vendedor = await user('wf-v');
      const vuelo = {
        origin: 'BOG',
        destination: 'LIM',
        departureDate: day(-9),
        returnDate: day(-3),
      };
      await hold(ag, await order(ag, vendedor, 'ticketed', { criteria: vuelo }), vendedor);
      const auto = { vertical: 'cars', pickUpDate: day(-6), dropOffDate: day(-3) };
      await hold(ag, await order(ag, vendedor, 'confirmed', { criteria: auto }), vendedor);

      expect(await move(ag, c2)).toBe(1);

      // Un vuelo con la vuelta por delante sigue abierto aunque la ida ya haya pasado.
      const abierto = {
        origin: 'BOG',
        destination: 'LIM',
        departureDate: day(-2),
        returnDate: day(4),
      };
      await hold(ag, await order(ag, vendedor, 'ticketed', { criteria: abierto }), vendedor);
      expect(await rule(move(ag, c1))).toBe('STH02/tenant_move_open_wallet_bookings');
    });

    it('bloquea con reservas abiertas hechas con una cuenta que dejaría de heredar', async () => {
      const c1 = await tenant('ia-c1', 'consolidator', platform);
      const c2 = await tenant('ia-c2', 'consolidator', platform);
      const cuenta = await account(c1);
      const ag = await tenant('ia-a', 'agency', c1);
      const vendedor = await user('ia-v');
      const pendiente = await order(ag, vendedor, 'pending', { accountId: cuenta });

      const err = await failure(move(ag, c2));
      expect(`${err.code}/${err.constraint}`).toBe('STH02/tenant_move_open_inherited_bookings');
      expect(tenantHierarchyHttpError(err)?.reason).toBe('TENANT_MOVE_OPEN_INHERITED_BOOKINGS');

      await pool.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [pendiente]);
      expect(await move(ag, c2)).toBe(1);
    });

    it('una cuenta que se mueve con el subárbol no bloquea', async () => {
      const c1 = await tenant('ow-c1', 'consolidator', platform);
      const c2 = await tenant('ow-c2', 'consolidator', platform);
      const ag = await tenant('ow-a', 'agency', c1);
      const propia = await account(ag);
      const sub = await tenant('ow-s', 'subagency', ag);
      const vendedor = await user('ow-v');
      await order(sub, vendedor, 'pending', { accountId: propia });

      expect(await move(ag, c2)).toBe(2);
    });

    it('desde la app, sólo el superadmin de la plataforma; el evento lleva su id', async () => {
      const ag = await tenant('au-a', 'agency', platform);
      const cons = await tenant('au-c', 'consolidator', platform);
      const admin = await user('au-admin');
      const superadmin = await user('au-root');
      // Miembros de la plataforma que no son su superadmin activo: el admin de Planetour de
      // producción (consolidator_admin), el rol retirado platform_admin (D7 B), un superadmin con la
      // membresía suspendida y uno con el usuario suspendido.
      const adminPlataforma = await user('au-pc');
      const platformAdmin = await user('au-pa');
      const superSuspendido = await user('au-ss');
      const usuarioSuspendido = await user('au-us');
      const membresia = async (tenantId: string, userId: string, role: string, status = 'active') =>
        pool.query(
          `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, $3, $4)`,
          [tenantId, userId, role, status],
        );
      await membresia(ag, admin, 'tenant_admin');
      await membresia(platform, superadmin, 'superadmin');
      await membresia(platform, adminPlataforma, 'consolidator_admin');
      await membresia(platform, platformAdmin, 'platform_admin');
      await membresia(platform, superSuspendido, 'superadmin', 'suspended');
      await membresia(platform, usuarioSuspendido, 'superadmin');
      await pool.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [usuarioSuspendido]);

      /**
       * La llamada con la sesión de la app (`app_user`, sin privilegios) y el usuario de la petición
       * en `app.current_user_id`, como `DatabaseService.withRequestContext`. Al final se vuelve a la
       * sesión original a mano: Postgres deshace el `SET LOCAL` con el ROLLBACK, PGlite no.
       */
      const comoApp = async (actor: string | null): Promise<PgFailure | number> => {
        const c = await pool.connect();
        const { rows: yo } = await c.query<{ me: string }>('SELECT session_user AS me');
        const original = `"${yo[0]!.me.replace(/"/g, '""')}"`;
        try {
          await c.query('BEGIN');
          await c.query('SET LOCAL SESSION AUTHORIZATION app_user');
          await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [actor ?? '']);
          const moved = await c
            .query<{ n: number }>('SELECT move_tenant_subtree($1::uuid, $2::uuid) AS n', [ag, cons])
            .then(
              (r) => Number(r.rows[0]!.n),
              (err: PgFailure) => err,
            );
          if (typeof moved === 'number') {
            await c.query(`SET LOCAL SESSION AUTHORIZATION ${original}`);
            const { rows } = await c.query<{ actor_user_id: string | null }>(
              `SELECT actor_user_id FROM domain_events
                WHERE event_type = 'tenant.moved' AND aggregate_id = $1`,
              [ag],
            );
            expect(rows).toEqual([{ actor_user_id: actor }]);
          }
          return moved;
        } finally {
          await c.query('ROLLBACK');
          await c.query(`SET SESSION AUTHORIZATION ${original}`);
          c.release();
        }
      };

      for (const actor of [
        null,
        admin,
        adminPlataforma,
        platformAdmin,
        superSuspendido,
        usuarioSuspendido,
      ]) {
        const err = await comoApp(actor);
        expect(typeof err === 'number' ? err : `${err.code}/${err.constraint}`).toBe(
          '42501/tenant_move_forbidden',
        );
        // Si un endpoint olvidara comprobarlo, la API responde 403 y no un 500.
        expect(
          typeof err === 'number' ? undefined : tenantHierarchyHttpError(err)?.getStatus(),
        ).toBe(HttpStatus.FORBIDDEN);
      }
      expect(await comoApp(superadmin)).toBe(1);
      expect((await node(ag)).parent).toBe(platform);
    });
  });

  describe('promoción de la raíz platform (0049)', () => {
    const migracion = readFileSync(PROMOCION, 'utf8');

    /**
     * Corre `fn` en una transacción que se deshace, con el slug `platform` libre. La raíz común no
     * se toca fuera de la transacción: los demás tests siguen viéndola como siempre.
     */
    async function enTransaccion(fn: (c: pg.PoolClient) => Promise<void>): Promise<void> {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`UPDATE tenants SET slug = slug || '-' || $1::text WHERE slug = 'platform'`, [
          sfx,
        ]);
        await fn(c);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    }

    /**
     * La agencia raíz `platform` de producción antes de 0049. La matriz ya no deja crearla: se inserta
     * con los triggers apagados dentro de la transacción del test, que se deshace al final.
     */
    async function planetourComoAgencia(c: pg.PoolClient): Promise<string> {
      const id = randomUUID();
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        `INSERT INTO tenants (id, slug, name, country_code, default_currency, tenant_type, path)
         VALUES ($1::uuid, 'platform', 'Planetour S.A.S', 'CO', 'COP', 'agency',
                 replace($1::text, '-', '')::ltree)`,
        [id],
      );
      await c.query('SET LOCAL session_replication_role = origin');
      return id;
    }

    async function eventos(c: pg.PoolClient, id: string): Promise<unknown[]> {
      const { rows } = await c.query<{ payload: unknown }>(
        `SELECT payload FROM domain_events
          WHERE event_type = 'tenant.type.changed' AND aggregate_id = $1`,
        [id],
      );
      return rows.map((r) => r.payload);
    }

    it('promueve la agencia raíz con slug platform, deja el evento y es idempotente', async () => {
      await enTransaccion(async (c) => {
        // Sin otra plataforma: la común se degrada dentro de la transacción.
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query(`UPDATE tenants SET tenant_type = 'agency' WHERE tenant_type = 'platform'`);
        const planetour = await planetourComoAgencia(c);

        await c.query(migracion);
        await c.query(migracion);

        const { rows } = await c.query<{ tenant_type: string; parent_tenant_id: string | null }>(
          'SELECT tenant_type, parent_tenant_id FROM tenants WHERE id = $1',
          [planetour],
        );
        expect(rows[0]).toEqual({ tenant_type: 'platform', parent_tenant_id: null });
        expect(await eventos(c, planetour)).toEqual([
          { from: 'agency', to: 'platform', source: 'migration:0049_platform_root' },
        ]);
      });
    });

    it('con otra plataforma ya presente, falla con un mensaje claro y no promueve', async () => {
      await enTransaccion(async (c) => {
        await planetourComoAgencia(c);

        const err = await failure(c.query(migracion));
        expect(err.message).toMatch(/ya hay 1 tenant\(s\) de tipo platform/);
      });
    });

    it('sin una raíz con slug platform no hace nada', async () => {
      await enTransaccion(async (c) => {
        // Con slug platform pero con padre: no es la raíz de producción.
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
           VALUES ('platform', 'Planetour', 'CO', 'COP', 'agency', $1) RETURNING id`,
          [platform],
        );
        const hija = rows[0]!.id;

        await c.query(migracion);

        const tipo = await c.query<{ tenant_type: string }>(
          'SELECT tenant_type FROM tenants WHERE id = $1',
          [hija],
        );
        expect(tipo.rows[0]!.tenant_type).toBe('agency');
        expect(await eventos(c, hija)).toEqual([]);
        const raiz = await c.query<{ tenant_type: string }>(
          'SELECT tenant_type FROM tenants WHERE id = $1',
          [platform],
        );
        expect(raiz.rows[0]!.tenant_type).toBe('platform');
      });
    });
  });
});
