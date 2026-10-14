import { randomBytes } from 'node:crypto';
import type { HttpException } from '@nestjs/common';
import { Kysely, PostgresDialect, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformRootId } from '../__fixtures__/platform-root.js';
import { addDays, todayIn } from '../admin-console/admin-overview.schemas.js';
import { AuditService, type AuditEvent } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import type { AdminOrderListItem } from './admin-order-view.js';
import { ADMIN_ORDERS_CSV_HEADER, ADMIN_ORDERS_EXPORTED_EVENT } from './admin-orders-export.js';
import {
  ADMIN_ORDERS_EXPORT_MAX_ROWS,
  AdminOrdersExportQuerySchema,
  AdminOrdersQuerySchema,
} from './admin-orders.schemas.js';
import { AdminOrdersService } from './admin-orders.service.js';
import type { HotelOrderReadsService } from './hotel-order-reads.service.js';
import type { OrderCapabilitiesService } from './order-capabilities.service.js';
import type { OrdersService } from './orders.service.js';

/**
 * Reservas de la red › Exportar CSV contra Postgres, como `app_user` (el rol de producción, sujeto a
 * la RLS):
 *
 *   - con cada combinación de filtros el archivo trae EXACTAMENTE las reservas de la lista, en su
 *     orden (todas sus páginas): nunca una que la pantalla no mostraría;
 *   - sin pasajeros, documentos ni contacto del cliente; el total en unidades de su moneda; la guarda
 *     contra fórmulas con un nodo que se llama como una;
 *   - sólo el superadmin: los admins de nodo reciben 403 y no queda rastro;
 *   - platform.orders.exported en la raíz `platform` con filtros y filas, en la misma transacción que
 *     la lectura: si el rastro falla no hay archivo y no queda nada;
 *   - 5.000 se exportan; 5.001, 422 EXPORT_TOO_LARGE sin rastro.
 *
 * La red: Planetour → consolidador C → agencia A → sub-agencia S; Planetour → agencia D (que se
 * llama como una fórmula); Planetour → agencia M con 5.001 reservas. La base es compartida con otros
 * tests: lo exacto se mira acotado a un nodo o a un proveedor propio de esta corrida.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['APP_USER_PASSWORD']);
const d = hasDb ? describe : describe.skip;

const BOGOTA = 'America/Bogota';

/** `código HTTP/motivo` del error con que falla `p`. Falla el test si `p` no falla. */
async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const http = err as HttpException & { reason?: string };
    if (typeof http.getStatus !== 'function') throw err;
    return `${http.getStatus()}/${http.reason ?? '?'}`;
  }
  throw new Error('esperaba un error HTTP');
}

/** Las celdas de una línea del CSV, separando sólo por comas fuera de las comillas. */
function cells(line: string): string[] {
  const out: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted && c === '"' && line[i + 1] === '"') {
      cell += '"';
      i += 1;
    } else if (c === '"') {
      quoted = !quoted;
    } else if (!quoted && c === ',') {
      out.push(cell);
      cell = '';
    } else {
      cell += c;
    }
  }
  out.push(cell);
  return out;
}

function dataLines(csv: string): string[] {
  return csv
    .replace(/^\uFEFF/, '')
    .trimEnd()
    .split('\r\n')
    .slice(1);
}

d('Reservas de la red › Exportar CSV (0076 como app_user)', () => {
  const sfx = randomBytes(4).toString('hex');
  const SFX = sfx.toUpperCase();
  /** SUPERUSUARIO: sólo para montar la red, mirar el audit log y desmontarla. */
  const admin = new pg.Pool();
  const appPool = new pg.Pool({
    user: 'app_user',
    password: process.env['APP_USER_PASSWORD'],
    host: process.env['PGHOST'],
    port: Number(process.env['PGPORT'] ?? 5432),
    database: process.env['PGDATABASE'],
  });
  const database = new DatabaseService();
  database.db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: appPool }) });

  /** La lista y la exportación no usan las lecturas de la ficha. */
  function serviceWith(audit: AuditService): AdminOrdersService {
    return new AdminOrdersService(
      database,
      {} as unknown as OrdersService,
      {} as unknown as HotelOrderReadsService,
      audit,
      {} as unknown as OrderCapabilitiesService,
    );
  }
  const service = serviceWith(new AuditService(database));

  const tenants: string[] = [];
  const users: string[] = [];
  let seq = 0;

  async function tenant(slug: string, type: string, parent: string, name?: string) {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $2::text, 'CO', 'COP', $3, $4) RETURNING id`,
      [`rx-${slug}-${sfx}`, name ?? `rx-${slug}-${sfx}`, type, parent],
    );
    tenants.push(rows[0]!.id);
    return rows[0]!.id;
  }

  async function user(label: string, tenantId: string, role: string): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO users (email, name, status) VALUES ($1, $2, 'active') RETURNING id`,
      [`rx-${label}-${sfx}@test.local`, `Usuario ${label}`],
    );
    users.push(rows[0]!.id);
    await admin.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, $3, 'active')`,
      [tenantId, rows[0]!.id, role],
    );
    return rows[0]!.id;
  }

  async function order(
    tenantId: string,
    userId: string,
    o: {
      status: string;
      provider?: string;
      vertical?: string;
      pnr?: string;
      bookingRef?: string;
      amount?: number;
      currency?: string;
      passengers?: unknown[];
      contact?: Record<string, unknown>;
      ago?: string;
    },
  ): Promise<{ id: string; number: number }> {
    seq += 1;
    const number = 7_000 + seq;
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO orders (tenant_id, user_id, provider, provider_order_id, provider_booking_ref,
                           search_criteria, selected_offer, passengers, contact_info, total_amount,
                           currency, order_number, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, '{}'::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11, $12,
               now() - $13::interval, now() - $13::interval)
       RETURNING id`,
      [
        tenantId,
        userId,
        o.provider ?? 'latam-ndc',
        o.pnr ?? null,
        o.bookingRef ?? null,
        JSON.stringify(o.vertical === undefined ? {} : { vertical: o.vertical }),
        JSON.stringify(o.passengers ?? []),
        JSON.stringify(o.contact ?? {}),
        o.amount ?? 150_000,
        o.currency ?? 'COP',
        number,
        o.status,
        o.ago ?? '1 day',
      ],
    );
    return { id: rows[0]!.id, number };
  }

  /** Las exportaciones que dejó `actor` en el audit log (lee el superusuario, sin RLS). */
  async function exportsBy(actor: string) {
    const { rows } = await admin.query<{ tenant_id: string; payload: Record<string, unknown> }>(
      `SELECT tenant_id, payload FROM domain_events
        WHERE actor_user_id = $1 AND event_type = $2 ORDER BY occurred_at, id`,
      [actor, ADMIN_ORDERS_EXPORTED_EVENT],
    );
    return rows;
  }

  const today = todayIn(BOGOTA, new Date());
  const crossProvider = `rx-${sfx}`;
  const bulkProvider = `rxb-${sfx}`;
  const pnr = `RXP${SFX}`;
  const clientEmail = `cliente.${sfx}@correo.test`;
  const formulaName = `=HYPERLINK("http://x.test";"rx-${sfx}")`;

  let platform: string;
  let consolidator: string;
  let agency: string;
  let sub: string;
  let direct: string;
  let bulk: string;
  let superadmin: string;
  let consolidatorAdmin: string;
  let agencyAdmin: string;

  const o: Record<string, { id: string; number: number }> = {};

  beforeAll(async () => {
    platform = await platformRootId(admin);
    consolidator = await tenant('c', 'consolidator', platform);
    agency = await tenant('a', 'agency', consolidator);
    sub = await tenant('s', 'subagency', agency);
    direct = await tenant('d', 'agency', platform, formulaName);
    bulk = await tenant('m', 'agency', platform);

    superadmin = await user('sa', platform, 'superadmin');
    consolidatorAdmin = await user('ca', consolidator, 'consolidator_admin');
    agencyAdmin = await user('aa', agency, 'tenant_admin');
    const seller = await user('ve', agency, 'vendedor');
    const directSeller = await user('dv', direct, 'tenant_admin');

    o['flight'] = await order(agency, seller, {
      status: 'confirmed',
      pnr,
      amount: 45_990,
      currency: 'usd',
      contact: { email: clientEmail, phone: '3001234567', countryDialingCode: '57' },
      passengers: [
        {
          paxType: 'ADT',
          givenName: `Ana${SFX}`,
          surname: 'Pérez',
          birthdate: '1990-05-17',
          identityDoc: { type: 'PT', number: `DOC${SFX}`, expiryDate: '2031-01-01' },
        },
      ],
    });
    o['hotel'] = await order(agency, seller, {
      status: 'confirmed',
      provider: 'tbo-hotels',
      vertical: 'hotels',
      bookingRef: `ST-${SFX}`,
      ago: '20 hours',
    });
    o['stuck'] = await order(agency, seller, { status: 'pending', ago: '2 hours' });
    o['ticketed'] = await order(agency, seller, { status: 'ticketed', ago: '5 hours' });
    o['old'] = await order(agency, seller, { status: 'confirmed', ago: '10 days' });
    o['car'] = await order(sub, seller, { status: 'confirmed', provider: 'agent-cars' });
    o['crossA'] = await order(agency, seller, { status: 'failed', provider: crossProvider });
    o['crossD'] = await order(direct, directSeller, {
      status: 'ticketed',
      provider: crossProvider,
      amount: 150_000,
      currency: 'CLP',
      ago: '3 hours',
    });

    // M: 5.000 confirmadas y una fallida, de un proveedor propio de esta corrida.
    await admin.query(
      `INSERT INTO orders (tenant_id, user_id, provider, search_criteria, selected_offer, passengers,
                           contact_info, total_amount, currency, order_number, status, created_at)
       SELECT $1, $2, $3, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 1000, 'COP', g,
              CASE WHEN g = 1 THEN 'failed' ELSE 'confirmed' END,
              now() - make_interval(secs => g)
         FROM generate_series(1, $4::int) g`,
      [bulk, directSeller, bulkProvider, ADMIN_ORDERS_EXPORT_MAX_ROWS + 1],
    );
  });

  afterAll(async () => {
    await admin.query('DELETE FROM domain_events WHERE actor_user_id = ANY($1::uuid[])', [users]);
    const { rows } = await admin.query<{ id: string }>(
      'SELECT id FROM tenants WHERE id = ANY($1::uuid[]) ORDER BY nlevel(path) DESC',
      [tenants],
    );
    for (const r of rows) await admin.query('DELETE FROM tenants WHERE id = $1', [r.id]);
    await admin.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [users]);
    await database.db.destroy();
    await admin.end();
  });

  /** Todas las páginas de la lista con estos filtros, de a 2 (así pasa también por el cursor). */
  async function listAll(filters: Record<string, string>): Promise<AdminOrderListItem[]> {
    const out: AdminOrderListItem[] = [];
    let cursor: string | null = null;
    do {
      const page = await service.search(
        superadmin,
        AdminOrdersQuerySchema.parse({ ...filters, limit: '2', ...(cursor ? { cursor } : {}) }),
      );
      out.push(...page.orders);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return out;
  }

  it('con cada combinación de filtros, el archivo es exactamente la lista, en su orden', async () => {
    const combos: Record<string, string>[] = [
      { provider: crossProvider },
      { tenantId: consolidator },
      { tenantId: consolidator, subtree: 'false' },
      { tenantId: agency, subtree: 'false' },
      { tenantId: sub },
      { tenantId: consolidator, vertical: 'hotels' },
      { tenantId: consolidator, vertical: 'cars' },
      { tenantId: consolidator, status: 'confirmed,ticketed' },
      { tenantId: consolidator, status: 'pending' },
      { tenantId: consolidator, from: addDays(today, -3), to: today },
      { tenantId: consolidator, to: addDays(today, -5) },
      { tenantId: consolidator, attention: 'true' },
      { tenantId: agency, q: pnr.toLowerCase() },
      { tenantId: agency, q: clientEmail.toUpperCase() },
      { tenantId: agency, q: String(o['stuck']!.number) },
      { tenantId: consolidator, q: `cliente.${sfx}` },
    ];
    for (const filters of combos) {
      const list = await listAll(filters);
      const out = await service.exportCsv(superadmin, AdminOrdersExportQuerySchema.parse(filters));
      const exported = dataLines(out.csv).map((line) => {
        const c = cells(line);
        // El nombre que parece una fórmula lleva su apóstrofo (lo prueba otro caso).
        return `${c[1]?.replace(/^'(?=[=+\-@])/, '')}#${c[7]}`;
      });
      const label = JSON.stringify(filters);
      expect(exported, label).toEqual(list.map((r) => `${r.tenantName}#${r.orderNumber}`));
      expect(out.rows, label).toBe(list.length);
    }
    // Las combinaciones no son triviales: hay vacías y con varias filas.
    expect((await listAll({ tenantId: consolidator })).length).toBeGreaterThanOrEqual(7);
    expect(await listAll({ tenantId: consolidator, q: `cliente.${sfx}` })).toEqual([]);
  });

  it('el contenido: sin pasajeros ni contacto, el total en su moneda y la hora de Bogotá', async () => {
    const out = await service.exportCsv(
      superadmin,
      AdminOrdersExportQuerySchema.parse({ tenantId: agency, q: pnr }),
    );
    expect(out.csv.startsWith('\uFEFF')).toBe(true);
    expect(out.csv.replace(/^\uFEFF/, '').split('\r\n')[0]).toBe(ADMIN_ORDERS_CSV_HEADER.join(','));
    expect(out.csv).not.toMatch(new RegExp(`DOC${SFX}|Ana${SFX}|cliente\\.|3001234567|1990-05-17`));

    const [line] = dataLines(out.csv);
    const c = cells(line ?? '');
    const { rows } = await admin.query<{ local: string }>(
      `SELECT to_char(created_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD HH24:MI:SS') AS local
         FROM orders WHERE id = $1`,
      [o['flight']!.id],
    );
    expect(c).toEqual([
      rows[0]!.local,
      `rx-a-${sfx}`,
      'no',
      'Vuelos',
      'latam-ndc',
      pnr,
      '',
      String(o['flight']!.number),
      'Confirmada',
      '',
      '459.90',
      'USD',
      `rx-ve-${sfx}@test.local`,
      '',
      '',
    ]);
  });

  it('un nodo que se llama como una fórmula sale con apóstrofo; CLP en unidades', async () => {
    const out = await service.exportCsv(
      superadmin,
      AdminOrdersExportQuerySchema.parse({ tenantId: direct }),
    );
    const [line] = dataLines(out.csv);
    // Entre comillas por el `;` y con el apóstrofo: ninguna planilla la ejecuta.
    expect(line).toContain(`"'=HYPERLINK(""http://x.test"";""rx-${sfx}"")"`);
    const c = cells(line ?? '');
    expect(c[1]).toBe(`'${formulaName}`);
    // 150.000 centésimos de CLP son 1.500 pesos (Money guarda centésimos en toda moneda).
    expect(c.slice(10, 12)).toEqual(['1500.00', 'CLP']);
  });

  it('deja platform.orders.exported en la raíz, con los filtros y cuántas filas', async () => {
    const before = (await exportsBy(superadmin)).length;
    const out = await service.exportCsv(
      superadmin,
      AdminOrdersExportQuerySchema.parse({
        tenantId: consolidator,
        status: 'confirmed',
        q: clientEmail,
      }),
    );
    expect(out.rows).toBe(1);
    const trail = await exportsBy(superadmin);
    expect(trail).toHaveLength(before + 1);
    expect(trail.at(-1)).toEqual({
      tenant_id: platform,
      payload: {
        filters: {
          tenantId: consolidator,
          subtree: true,
          vertical: null,
          provider: null,
          statuses: ['confirmed'],
          from: null,
          to: null,
          q: null,
          qByClientEmail: true,
          attention: false,
        },
        rows: 1,
      },
    });
    // El correo del cliente no quedó en el audit log.
    expect(JSON.stringify(trail)).not.toContain(clientEmail);
  });

  it('los admins de nodo no exportan: 403 y ningún rastro', async () => {
    for (const actor of [consolidatorAdmin, agencyAdmin]) {
      expect(
        await rejection(
          service.exportCsv(actor, AdminOrdersExportQuerySchema.parse({ tenantId: agency })),
        ),
      ).toBe('403/SUPERADMIN_REQUIRED');
      expect(await exportsBy(actor)).toEqual([]);
    }
  });

  it('si el rastro falla después de escribirse, la transacción se deshace: ni archivo ni rastro', async () => {
    class RastroQueFalla extends AuditService {
      override async emitWithin(trx: Transaction<DB>, event: AuditEvent): Promise<void> {
        await super.emitWithin(trx, event);
        throw Object.assign(new Error('could not extend file'), { code: '53100' });
      }
    }
    const before = (await exportsBy(superadmin)).length;
    await expect(
      serviceWith(new RastroQueFalla(database)).exportCsv(
        superadmin,
        AdminOrdersExportQuerySchema.parse({ tenantId: agency }),
      ),
    ).rejects.toMatchObject({ code: '53100' });
    expect(await exportsBy(superadmin)).toHaveLength(before);
  });

  it('5.000 se exportan; con 5.001, 422 EXPORT_TOO_LARGE y ningún rastro', async () => {
    const before = (await exportsBy(superadmin)).length;
    expect(
      await rejection(
        service.exportCsv(
          superadmin,
          AdminOrdersExportQuerySchema.parse({ provider: bulkProvider }),
        ),
      ),
    ).toBe('422/EXPORT_TOO_LARGE');
    expect(await exportsBy(superadmin)).toHaveLength(before);

    const out = await service.exportCsv(
      superadmin,
      AdminOrdersExportQuerySchema.parse({ provider: bulkProvider, status: 'confirmed' }),
    );
    expect(out.rows).toBe(ADMIN_ORDERS_EXPORT_MAX_ROWS);
    expect(dataLines(out.csv)).toHaveLength(ADMIN_ORDERS_EXPORT_MAX_ROWS);
    const trail = await exportsBy(superadmin);
    expect(trail).toHaveLength(before + 1);
    expect(trail.at(-1)?.payload).toMatchObject({ rows: ADMIN_ORDERS_EXPORT_MAX_ROWS });
  });
});
