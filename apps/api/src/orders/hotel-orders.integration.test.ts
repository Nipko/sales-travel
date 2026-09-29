import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HCN_PRIORITIES,
  HCN_STATES,
  HOTEL_ORDER_SUB_STATUSES,
  PROVIDER_STATUS_SOURCES,
  type OrderOperationType,
} from '../database/database.types.js';
import { platformRootId } from '../__fixtures__/platform-root.js';

/**
 * Órdenes de hotel (migración 0042) contra Postgres real.
 *
 * Lo que se prueba es aislamiento y unicidad, y las dos cosas sólo significan algo bajo RLS:
 * como superusuario todo se ve y todo se puede. Por eso cada escritura de la app corre con
 * `SET LOCAL ROLE app_user` (NOBYPASSRLS, el rol de la API) y el tenant activo, igual que
 * `DatabaseService.withTenant`. Alcanza con el superusuario que usa CI para montar los datos.
 *
 * La red es la del caso que motiva el índice: un consolidador con una cuenta de proveedor
 * heredable y dos agencias que reservan con esa misma cuenta.
 *
 * Requiere las migraciones hasta la 0042. Se SALTA sin PGHOST.
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
  '0042_hotel_orders.sql',
);

/** SQLSTATE con que falla `p`, o `'ok'`. */
async function sqlstate(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as { code?: string }).code ?? 'sin-codigo';
  }
}

interface OpcionesDeOrden {
  provider?: string;
  ref?: string | null;
  cuenta?: string | null;
}

d('órdenes de hotel (0042)', () => {
  const pool = new pg.Pool();
  const sfx = randomBytes(4).toString('hex');
  // Sintéticos a propósito: el índice de referencias es global, y quien corra esto contra su base
  // local no puede chocar con una reserva real.
  const PROVEEDOR = `hotel-prov-${sfx}`;
  const OTRO_PROVEEDOR = `hotel-otro-${sfx}`;
  const REF_A = `REF-A-${sfx}`;

  let consolidador: string;
  let agenciaA: string;
  let agenciaB: string;
  let usuario: string;
  let cuentaHeredada: string;
  let ordenA: string;
  let ordenASinSeguimiento: string;
  let ordenB: string;
  let numero = 0;

  async function crearTenant(slug: string, tipo: string, padre: string | null): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $1::text, 'CO', 'COP', $2, $3) RETURNING id`,
      [slug, tipo, padre ?? (await platformRootId(pool))],
    );
    return rows[0]!.id;
  }

  async function crearCuenta(tenantId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO provider_accounts (tenant_id, provider_code, label, credentials_enc, is_inheritable, status)
       VALUES ($1, $2, 'default', $3, true, 'active') RETURNING id`,
      [tenantId, PROVEEDOR, Buffer.from('no-es-un-secreto')],
    );
    return rows[0]!.id;
  }

  /**
   * Corre `fn` como `app_user` con `tenantId` activo (o sin tenant, con `null`). Con
   * `confirmar = false` deshace todo al terminar, para que un caso no deje filas.
   */
  async function comoTenant<T>(
    tenantId: string | null,
    fn: (c: pg.PoolClient) => Promise<T>,
    confirmar = true,
  ): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      if (tenantId !== null) {
        await c.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
      }
      const out = await fn(c);
      await c.query(confirmar ? 'COMMIT' : 'ROLLBACK');
      return out;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  /** Corre `fn` como superusuario dentro de una transacción que siempre se deshace. */
  async function enTransaccionDeshecha<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      return await fn(c);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  async function insertarOrden(
    c: pg.PoolClient,
    tenantId: string,
    opciones: OpcionesDeOrden = {},
  ): Promise<string> {
    numero += 1;
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO orders (tenant_id, user_id, provider, search_criteria, selected_offer, passengers,
                           contact_info, total_amount, order_number, status,
                           provider_booking_ref, provider_account_id)
       VALUES ($1, $2, $3, '{"vertical":"hotels"}'::jsonb, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb,
               34012, $4, 'pending', $5, $6)
       RETURNING id`,
      [
        tenantId,
        usuario,
        opciones.provider ?? PROVEEDOR,
        numero,
        opciones.ref ?? null,
        opciones.cuenta ?? null,
      ],
    );
    return rows[0]!.id;
  }

  /** Inserta una fila de seguimiento de `ordenB` como la agencia B, sin dejarla. */
  function seguimientoDeB(columnas: Record<string, unknown>): Promise<string> {
    const nombres = Object.keys(columnas);
    const marcadores = nombres.map((_, i) => `$${i + 3}`);
    return sqlstate(
      comoTenant(
        agenciaB,
        (c) =>
          c.query(
            `INSERT INTO hotel_order_tracking (order_id, tenant_id, ${nombres.join(', ')})
             VALUES ($1, $2, ${marcadores.join(', ')})`,
            [ordenB, agenciaB, ...Object.values(columnas)],
          ),
        false,
      ),
    );
  }

  beforeAll(async () => {
    consolidador = await crearTenant(`hord-c-${sfx}`, 'consolidator', null);
    agenciaA = await crearTenant(`hord-a-${sfx}`, 'agency', consolidador);
    agenciaB = await crearTenant(`hord-b-${sfx}`, 'agency', consolidador);
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) RETURNING id`,
      [`hord-${sfx}@test.local`],
    );
    usuario = u.rows[0]!.id;
    cuentaHeredada = await crearCuenta(consolidador);

    // Las dos agencias reservan con la cuenta del consolidador, como app_user: la FK tiene que
    // aceptar una cuenta que la agencia no puede leer.
    ordenA = await comoTenant(agenciaA, (c) =>
      insertarOrden(c, agenciaA, { ref: REF_A, cuenta: cuentaHeredada }),
    );
    ordenASinSeguimiento = await comoTenant(agenciaA, (c) =>
      insertarOrden(c, agenciaA, { ref: `REF-A2-${sfx}`, cuenta: cuentaHeredada }),
    );
    ordenB = await comoTenant(agenciaB, (c) =>
      insertarOrden(c, agenciaB, { ref: `REF-B-${sfx}`, cuenta: cuentaHeredada }),
    );
    await comoTenant(agenciaA, (c) =>
      c.query(
        `INSERT INTO hotel_order_tracking
           (order_id, tenant_id, provider_status, provider_status_at, provider_status_source,
            hcn, hcn_received_at, hcn_state)
         VALUES ($1, $2, 'Confirmed', now(), 'verify', 'HCN-A', now(), 'received')`,
        [ordenA, agenciaA],
      ),
    );
  });

  afterAll(async () => {
    // parent_tenant_id es ON DELETE RESTRICT: de hoja a raíz. Cada agencia se lleva sus órdenes
    // y su seguimiento; el consolidador, la cuenta, que para entonces ya no tiene órdenes.
    for (const id of [agenciaA, agenciaB, consolidador]) {
      if (id) await pool.query('DELETE FROM tenants WHERE id = $1', [id]);
    }
    if (usuario) await pool.query('DELETE FROM users WHERE id = $1', [usuario]);
    await pool.end();
  });

  it('app_user no es superusuario ni salta la RLS', async () => {
    const rol = await comoTenant(null, async (c) => {
      const { rows } = await c.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
      );
      return rows[0];
    });
    // Si esto falla, los casos de aislamiento de abajo no prueban nada.
    expect(rol).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('la agencia guarda la cuenta heredada sin poder leer su fila', async () => {
    const cuentasVisibles = await comoTenant(agenciaA, async (c) => {
      const { rows } = await c.query('SELECT id FROM provider_accounts WHERE id = $1', [
        cuentaHeredada,
      ]);
      return rows.length;
    });
    const { rows } = await pool.query<{ provider_account_id: string }>(
      'SELECT provider_account_id FROM orders WHERE id = ANY($1)',
      [[ordenA, ordenB]],
    );

    expect(cuentasVisibles).toBe(0);
    expect(rows.map((r) => r.provider_account_id)).toEqual([cuentaHeredada, cuentaHeredada]);
  });

  it('dos agencias que heredan la misma cuenta no pueden repetir una referencia (RF-19 CA-1)', async () => {
    expect({
      // B no ve la orden de A, y aun así el índice la rechaza.
      repetidaEnOtroTenant: await sqlstate(
        comoTenant(
          agenciaB,
          (c) => insertarOrden(c, agenciaB, { ref: REF_A, cuenta: cuentaHeredada }),
          false,
        ),
      ),
      repetidaEnElMismoTenant: await sqlstate(
        comoTenant(agenciaA, (c) => insertarOrden(c, agenciaA, { ref: REF_A }), false),
      ),
      // El espacio de referencias es de cada proveedor.
      mismaReferenciaOtroProveedor: await sqlstate(
        comoTenant(
          agenciaB,
          (c) => insertarOrden(c, agenciaB, { provider: OTRO_PROVEEDOR, ref: REF_A }),
          false,
        ),
      ),
      // Vuelos y autos no escriben referencia: muchas órdenes sin ella conviven.
      variasSinReferencia: await sqlstate(
        comoTenant(
          agenciaA,
          async (c) => {
            await insertarOrden(c, agenciaA);
            await insertarOrden(c, agenciaA);
          },
          false,
        ),
      ),
      enBlanco: await sqlstate(
        comoTenant(agenciaA, (c) => insertarOrden(c, agenciaA, { ref: '   ' }), false),
      ),
    }).toEqual({
      repetidaEnOtroTenant: '23505',
      repetidaEnElMismoTenant: '23505',
      mismaReferenciaOtroProveedor: 'ok',
      variasSinReferencia: 'ok',
      enBlanco: '23514',
    });
  });

  it('una referencia ya escrita no se pisa ni se borra', async () => {
    const actualizar = (set: string, valores: unknown[] = []) =>
      sqlstate(
        comoTenant(
          agenciaA,
          (c) => c.query(`UPDATE orders SET ${set} WHERE id = $1`, [ordenA, ...valores]),
          false,
        ),
      );

    // P0001 = raise_exception, el del trigger.
    expect({
      otraReferencia: await actualizar('provider_booking_ref = $2', [`REF-OTRA-${sfx}`]),
      aNull: await actualizar('provider_booking_ref = NULL'),
      mismaReferencia: await actualizar('provider_booking_ref = $2', [REF_A]),
      otraColumna: await actualizar(`status = 'confirmed'`),
      sobreUnNull: await sqlstate(
        comoTenant(
          agenciaA,
          async (c) => {
            const id = await insertarOrden(c, agenciaA);
            await c.query('UPDATE orders SET provider_booking_ref = $2 WHERE id = $1', [
              id,
              `REF-TARDE-${sfx}`,
            ]);
          },
          false,
        ),
      ),
    }).toEqual({
      otraReferencia: 'P0001',
      aNull: 'P0001',
      mismaReferencia: 'ok',
      otraColumna: 'ok',
      sobreUnNull: 'ok',
    });
  });

  it('como app_user, la agencia B no lee ni toca el seguimiento de la A', async () => {
    const vistoPorB = await comoTenant(
      agenciaB,
      async (c) => ({
        todas: (await c.query('SELECT order_id FROM hotel_order_tracking')).rows.length,
        porId: (
          await c.query('SELECT order_id FROM hotel_order_tracking WHERE order_id = $1', [ordenA])
        ).rows.length,
        actualizadas: (
          await c.query(
            `UPDATE hotel_order_tracking SET sub_status = 'unknown' WHERE order_id = $1`,
            [ordenA],
          )
        ).rowCount,
        borradas: (await c.query('DELETE FROM hotel_order_tracking WHERE order_id = $1', [ordenA]))
          .rowCount,
      }),
      false,
    );
    const vistoPorA = await comoTenant(agenciaA, async (c) => {
      const { rows } = await c.query<{ order_id: string; sub_status: string | null; hcn: string }>(
        'SELECT order_id, sub_status, hcn FROM hotel_order_tracking',
      );
      return rows;
    });
    const sinTenant = await comoTenant(null, async (c) => {
      const { rows } = await c.query('SELECT order_id FROM hotel_order_tracking');
      return rows.length;
    });

    expect(vistoPorB).toEqual({ todas: 0, porId: 0, actualizadas: 0, borradas: 0 });
    expect(vistoPorA).toEqual([{ order_id: ordenA, sub_status: null, hcn: 'HCN-A' }]);
    expect(sinTenant).toBe(0);
  });

  it('la agencia B no puede colgar seguimiento de una orden de la A', async () => {
    const insertar = (orderId: string, tenantId: string) =>
      sqlstate(
        comoTenant(
          agenciaB,
          (c) =>
            c.query('INSERT INTO hotel_order_tracking (order_id, tenant_id) VALUES ($1, $2)', [
              orderId,
              tenantId,
            ]),
          false,
        ),
      );

    expect({
      // La policy acepta la fila (es de B) y la FK de (order_id, tenant_id) la rechaza.
      conSuTenant: await insertar(ordenASinSeguimiento, agenciaB),
      // Con el tenant de A la rechaza la policy.
      conElTenantDeA: await insertar(ordenASinSeguimiento, agenciaA),
      moviendoLaPropia: await sqlstate(
        comoTenant(
          agenciaB,
          async (c) => {
            await c.query(
              'INSERT INTO hotel_order_tracking (order_id, tenant_id) VALUES ($1, $2)',
              [ordenB, agenciaB],
            );
            await c.query('UPDATE hotel_order_tracking SET order_id = $1 WHERE order_id = $2', [
              ordenASinSeguimiento,
              ordenB,
            ]);
          },
          false,
        ),
      ),
      laSuya: await insertar(ordenB, agenciaB),
    }).toEqual({
      conSuTenant: '23503',
      conElTenantDeA: '42501',
      moviendoLaPropia: '23503',
      laSuya: 'ok',
    });
  });

  it('una cuenta con órdenes no se puede borrar, pero el tenant se borra con órdenes y cuenta', async () => {
    const borrarLaCuenta = await enTransaccionDeshecha((c) =>
      sqlstate(c.query('DELETE FROM provider_accounts WHERE id = $1', [cuentaHeredada])),
    );
    // Un tenant con cuenta propia y una orden que la usa: la cascada se lleva las dos en la misma
    // sentencia, y la FK de la cuenta no puede impedir que se limpie un tenant entero.
    const borrarElTenant = await enTransaccionDeshecha(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
         VALUES ($1::text, $1::text, 'CO', 'COP', 'agency', $2) RETURNING id`,
        [`hord-propia-${sfx}`, await platformRootId(c)],
      );
      const tenantId = rows[0]!.id;
      const cuenta = await c.query<{ id: string }>(
        `INSERT INTO provider_accounts (tenant_id, provider_code, credentials_enc, status)
         VALUES ($1, $2, $3, 'active') RETURNING id`,
        [tenantId, PROVEEDOR, Buffer.from('no-es-un-secreto')],
      );
      await insertarOrden(c, tenantId, { ref: `REF-P-${sfx}`, cuenta: cuenta.rows[0]!.id });
      return sqlstate(c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
    });

    expect({ borrarLaCuenta, borrarElTenant }).toEqual({
      borrarLaCuenta: '23503',
      borrarElTenant: 'ok',
    });
  });

  it('borrar la orden se lleva su seguimiento', async () => {
    const restantes = await enTransaccionDeshecha(async (c) => {
      await c.query('DELETE FROM orders WHERE id = $1', [ordenA]);
      const { rows } = await c.query('SELECT 1 FROM hotel_order_tracking WHERE order_id = $1', [
        ordenA,
      ]);
      return rows.length;
    });
    expect(restantes).toBe(0);
  });

  it('los CHECK del seguimiento rechazan valores fuera de contrato', async () => {
    const ahora = new Date();
    // 23514 = check_violation.
    expect({
      completa: await seguimientoDeB({
        provider_status: 'Confirmed',
        provider_voucher_status: 'true',
        provider_status_at: ahora,
        provider_status_source: 'reconciliation',
        sub_status: 'unknown',
        refund_awaited: true,
        invoice_number: 'INV-1',
        client_reference_id: `REF-B-${sfx}`,
        hcn_state: 'scheduled',
        hcn_priority: 'P4+',
        hcn_next_check_at: ahora,
        hcn_attempts: 3,
      }),
      lecturaSinEstado: await seguimientoDeB({
        provider_status_at: ahora,
        provider_status_source: 'book',
        sub_status: 'unverified-read',
      }),
      subestadoRaro: await seguimientoDeB({ sub_status: 'cancel-in-progress' }),
      fuenteRara: await seguimientoDeB({
        provider_status_at: ahora,
        provider_status_source: 'webhook',
      }),
      estadoSinMomento: await seguimientoDeB({ provider_status: 'Confirmed' }),
      voucherSinMomento: await seguimientoDeB({ provider_voucher_status: 'true' }),
      momentoSinFuente: await seguimientoDeB({ provider_status_at: ahora }),
      prioridadRara: await seguimientoDeB({ hcn_priority: 'P6' }),
      estadoHcnRaro: await seguimientoDeB({ hcn_state: 'pending' }),
      recibidoSinNumero: await seguimientoDeB({ hcn_state: 'received' }),
      hcnEnBlanco: await seguimientoDeB({ hcn: ' ', hcn_received_at: ahora }),
      despiertaTerminado: await seguimientoDeB({
        hcn_state: 'received',
        hcn: 'HCN-B',
        hcn_received_at: ahora,
        hcn_next_check_at: ahora,
      }),
      despiertaSinEstado: await seguimientoDeB({ hcn_next_check_at: ahora }),
      intentosNegativos: await seguimientoDeB({ hcn_attempts: -1 }),
    }).toEqual({
      completa: 'ok',
      lecturaSinEstado: 'ok',
      subestadoRaro: '23514',
      fuenteRara: '23514',
      estadoSinMomento: '23514',
      voucherSinMomento: '23514',
      momentoSinFuente: '23514',
      prioridadRara: '23514',
      estadoHcnRaro: '23514',
      recibidoSinNumero: '23514',
      hcnEnBlanco: '23514',
      despiertaTerminado: '23514',
      despiertaSinEstado: '23514',
      intentosNegativos: '23514',
    });
  });
});

// ---------------------------------------------------------------------------
// Sondas sin base de datos: sin Postgres todo lo de arriba se SALTA, y un salto silencioso no
// puede contar como verde. Estas vigilan lo que el bloque de arriba da por supuesto.
// ---------------------------------------------------------------------------

describe('órdenes de hotel 0042, sin base de datos', () => {
  const sql = readFileSync(MIGRACION, 'utf8').replace(/--.*$/gm, '');

  function vocabulario(columna: string): string[] {
    const m = new RegExp(`CHECK \\(${columna} IN \\(([^)]*)\\)\\)`).exec(sql);
    expect(m, `sin CHECK (${columna} IN (...))`).not.toBeNull();
    return (m?.[1] ?? '').split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
  }

  it('cada CHECK de la migración dice lo mismo que el vocabulario de la app', () => {
    // Si divergen, la app escribe un valor que la base rechaza o lee uno que no sabe tratar.
    expect({
      sub_status: vocabulario('sub_status'),
      provider_status_source: vocabulario('provider_status_source'),
      hcn_state: vocabulario('hcn_state'),
      hcn_priority: vocabulario('hcn_priority'),
    }).toEqual({
      sub_status: [...HOTEL_ORDER_SUB_STATUSES],
      provider_status_source: [...PROVIDER_STATUS_SOURCES],
      hcn_state: [...HCN_STATES],
      hcn_priority: [...HCN_PRIORITIES],
    });
  });

  it('la referencia es única por proveedor entre tenants: el índice no lleva tenant_id', () => {
    const m =
      /CREATE UNIQUE INDEX uq_orders_provider_booking_ref\s+ON orders \(([^)]*)\)\s+WHERE provider_booking_ref IS NOT NULL;/.exec(
        sql,
      );
    expect(m, 'falta el índice único parcial de provider_booking_ref').not.toBeNull();
    expect((m?.[1] ?? '').split(',').map((c) => c.trim())).toEqual([
      'provider',
      'provider_booking_ref',
    ]);
    // La recuperación de una reserva incierta depende de que la referencia no cambie.
    expect(sql).toMatch(
      /CREATE TRIGGER \w+\s+BEFORE UPDATE OF provider_booking_ref ON orders\s+FOR EACH ROW\s+WHEN \(OLD\.provider_booking_ref IS NOT NULL/,
    );
  });

  it('toda tabla nueva tiene tenant_id, RLS forzada, policy con WITH CHECK y FK por tenant', () => {
    const tablas = [...sql.matchAll(/CREATE TABLE\s+(\w+)/g)].map((m) => m[1] ?? '');
    expect(tablas).toEqual(['hotel_order_tracking']);

    const tenantActivo = `\\(tenant_id::text = current_setting\\('app\\.current_tenant_id', true\\)\\)`;
    for (const t of tablas) {
      expect(sql).toMatch(
        new RegExp(
          `CREATE TABLE ${t} \\([\\s\\S]*?tenant_id\\s+UUID\\s+NOT NULL REFERENCES tenants`,
        ),
      );
      expect(sql).toMatch(new RegExp(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`));
      expect(sql).toMatch(new RegExp(`ALTER TABLE ${t} FORCE\\s+ROW LEVEL SECURITY`));
      expect(sql).toMatch(
        new RegExp(
          `CREATE POLICY \\w+ ON ${t}\\s+USING\\s+${tenantActivo}\\s+WITH CHECK\\s+${tenantActivo}`,
        ),
      );
    }
    // Con una FK a `id` a secas, una agencia podría colgar seguimiento de una orden ajena.
    expect(sql).toMatch(/FOREIGN KEY \(order_id, tenant_id\) REFERENCES orders \(id, tenant_id\)/);
  });

  it('los tipos de operación de la post-venta de hotel existen en la app', () => {
    // Asignación tipada: si alguno sale de OrderOperationType, falla el typecheck.
    const nuevos: OrderOperationType[] = ['hcn-check', 'hcn-ticket', 'reconcile'];
    expect(nuevos).toHaveLength(3);
  });
});
