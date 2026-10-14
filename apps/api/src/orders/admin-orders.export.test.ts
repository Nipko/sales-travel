import { type ExecutionContext } from '@nestjs/common';
import { PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { CompiledQuery } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { scriptedKysely } from '../__fixtures__/scripted-kysely.js';
import { PlatformConsoleScopeNotFoundError } from '../admin-console/admin-console.errors.js';
import { EXPORT_ROWS_HEADER } from '../audit/admin-audit.controller.js';
import { AuditService } from '../audit/audit.service.js';
import { MfaRecentRequiredError } from '../auth/auth-errors.js';
import { REQUIRE_RECENT_MFA_KEY } from '../auth/decorators/require-recent-mfa.decorator.js';
import { RecentMfaGuard } from '../auth/guards/recent-mfa.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { DatabaseService } from '../database/database.service.js';
import type { Role } from '../database/database.types.js';
import type { NetworkService } from '../network/network.service.js';
import { SuperadminRequiredError } from '../network/superadmin.errors.js';
import { SuperadminGuard } from '../network/superadmin.guard.js';
import { requestContextStorage, type RequestContext } from '../request-context/request-context.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import type { AdminOrderActionsService } from './admin-order-actions.service.js';
import type { AdminOrderSearchRow } from './admin-order-view.js';
import {
  ADMIN_ORDERS_CSV_HEADER,
  ADMIN_ORDERS_EXPORTED_EVENT,
  adminOrderCsvRow,
  adminOrdersCsv,
  bogotaDateTime,
  exportedOrderFilters,
  ordersExportFilename,
} from './admin-orders-export.js';
import { AdminOrdersController } from './admin-orders.controller.js';
import { AdminOrdersExportTooLargeError } from './admin-orders.errors.js';
import {
  ADMIN_ORDERS_EXPORT_MAX_ROWS,
  AdminOrdersExportQuerySchema,
  AdminOrdersQuerySchema,
} from './admin-orders.schemas.js';
import { AdminOrdersService } from './admin-orders.service.js';
import type { HotelOrderReadsService } from './hotel-order-reads.service.js';
import type { OrderCapabilitiesService } from './order-capabilities.service.js';
import type { OrdersService } from './orders.service.js';

/*
 * Reservas de la red › Exportar CSV sin base: qué columnas salen (ninguna de pasajeros ni de contacto),
 * el total en unidades de su moneda, la hora de Bogotá, la guarda contra fórmulas, el tope de 5.000,
 * que la exportación lee EXACTAMENTE lo que lee la lista y que el rastro va en la misma transacción.
 * Que el SQL filtra lo que dice lo prueba admin-orders.export.integration.test.ts contra Postgres.
 */

const SUPERADMIN = '99999999-9999-4999-8999-999999999999';
const NODO = '11111111-1111-4111-8111-111111111111';
const PLATAFORMA = '00000000-0000-4000-8000-0000000000aa';
const O1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
/** 13 oct 2026, 22:30 en Bogotá: en UTC ya es el 14. */
const NOW = new Date('2026-10-14T03:30:00.000Z');

function row(extra: Partial<AdminOrderSearchRow> = {}): AdminOrderSearchRow {
  return {
    id: O1,
    tenant_id: NODO,
    tenant_name: 'Andes Travel',
    tenant_type: 'agency',
    is_branch: false,
    provider: 'latam-ndc',
    vertical: 'flights',
    provider_order_id: 'XYZ789',
    provider_booking_ref: 'ST-1A2B3C',
    order_number: 1042,
    status: 'ticketed',
    sub_status: null,
    total_amount: '150000',
    currency: 'COP',
    created_at: new Date('2026-10-13T14:41:12.123Z'),
    updated_at: new Date('2026-10-13T14:41:12.123Z'),
    seller_email: 'vendedor@andes.test',
    attention_reason: null,
    attention_since: null,
    cursor_at: '2026-10-13T14:41:12.123456Z',
    ...extra,
  };
}

function lines(csv: string): string[] {
  return csv
    .replace(/^\uFEFF/, '')
    .trimEnd()
    .split('\r\n');
}

// ───────────────────────────── El archivo ─────────────────────────────

describe('las columnas', () => {
  it('son éstas, con la zona de las fechas en el encabezado', () => {
    expect(ADMIN_ORDERS_CSV_HEADER).toEqual([
      'fecha (America/Bogota)',
      'nodo',
      'sucursal',
      'vertical',
      'proveedor',
      'localizador',
      'referencia',
      'n_orden',
      'estado',
      'subestado',
      'total',
      'moneda',
      'vendedor_email',
      'atencion',
      'atencion_desde (America/Bogota)',
    ]);
  });

  it('ninguna de pasajeros, documentos, contacto del cliente ni pagos', () => {
    const header = ADMIN_ORDERS_CSV_HEADER.join(',').toLowerCase();
    expect(header).not.toMatch(
      /pasajer|viajer|huesped|conductor|document|pasaporte|nacimiento|cliente|contacto|telefono|tel[eé]fono|direcci|tarjeta|pago|cvv|iban/,
    );
  });

  it('lista blanca: lo que traiga la fila de más no sale', () => {
    // Si un día la consulta trajera pasajeros o contacto, el archivo no los copiaría.
    const leaky = {
      ...row(),
      passengers: [{ givenName: 'Ana', identityDoc: { number: 'DOC123' } }],
      contact_info: { email: 'cliente@correo.com', phone: '3001234567' },
    } as AdminOrderSearchRow;
    const csv = adminOrdersCsv([leaky]);
    expect(csv).not.toMatch(/DOC123|cliente@correo\.com|3001234567|Ana/);
    expect(adminOrderCsvRow(leaky)).toHaveLength(ADMIN_ORDERS_CSV_HEADER.length);
  });
});

describe('cada reserva', () => {
  it('fecha de Bogotá, nodo, sucursal, nombres de la consola, total y moneda', () => {
    const csv = adminOrdersCsv([
      row(),
      row({
        tenant_name: 'Andes Sur',
        is_branch: true,
        vertical: 'hotels',
        provider: 'tbo-hotels',
        provider_order_id: null,
        provider_booking_ref: null,
        order_number: 7,
        status: 'pending',
        sub_status: 'create-uncertain',
        total_amount: 45_990,
        currency: 'USD',
        seller_email: null,
        attention_reason: 'cancel-failed',
        attention_since: new Date('2026-10-13T05:00:00.000Z'),
      }),
    ]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(lines(csv)).toEqual([
      ADMIN_ORDERS_CSV_HEADER.join(','),
      '2026-10-13 09:41:12,Andes Travel,no,Vuelos,latam-ndc,XYZ789,ST-1A2B3C,1042,Emitida,,1500.00,COP,vendedor@andes.test,,',
      '2026-10-13 09:41:12,Andes Sur,sí,Hoteles,tbo-hotels,,,7,Pendiente,create-uncertain,459.90,USD,,Cancelación fallida,2026-10-13 00:00:00',
    ]);
  });

  it('el total va en unidades de su moneda: el monto guardado es SIEMPRE en centésimos', () => {
    const total = (amount: number | string, currency: string) =>
      lines(adminOrdersCsv([row({ total_amount: amount, currency })]))[1]?.split(',')[10];
    expect(total(150_000, 'COP')).toBe('1500.00');
    expect(total('45990', 'USD')).toBe('459.90');
    expect(total(1_234_550, 'BRL')).toBe('12345.50');
    // CLP no tiene decimales en ISO 4217, pero `Money.fromMajor` guarda centésimos igual: 1.500 pesos.
    expect(total(150_000, 'CLP')).toBe('1500.00');
    expect(total(5, 'PEN')).toBe('0.05');
    expect(total(0, 'COP')).toBe('0.00');
  });

  it('un motivo de atención que no conocemos no se inventa', () => {
    const cells = adminOrderCsvRow(
      row({ attention_reason: 'otro-motivo', attention_since: new Date() }),
    );
    expect(cells.slice(-2)).toEqual([null, null]);
    expect(
      adminOrderCsvRow(row({ attention_reason: 'review', attention_since: null })).slice(-2),
    ).toEqual([null, null]);
  });

  it('la hora de Bogotá, sin desfase en cada celda (la zona va en el encabezado)', () => {
    expect(bogotaDateTime(new Date('2026-10-13T14:41:12.999Z'))).toBe('2026-10-13 09:41:12');
    expect(bogotaDateTime('2026-10-14T03:30:00Z')).toBe('2026-10-13 22:30:00');
    expect(bogotaDateTime('no es una fecha')).toBeNull();
    expect(bogotaDateTime(null)).toBeNull();
  });
});

/** La línea de datos de un archivo con una sola reserva, como texto. */
function dataLine(r: AdminOrderSearchRow): string {
  return lines(adminOrdersCsv([r]))[1] ?? '';
}

/** Las celdas de una línea separando sólo por `sep` fuera de las comillas (RFC 4180). */
function split(line: string, sep: string): string[] {
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
    } else if (!quoted && c === sep) {
      out.push(cell);
      cell = '';
    } else {
      cell += c;
    }
  }
  out.push(cell);
  return out;
}

describe('la guarda contra fórmulas (CSV injection)', () => {
  it('un nodo, un correo o un localizador que empiezan con = + - @ llevan apóstrofo', () => {
    const formula = '=HYPERLINK("http://x","clic")';
    expect(dataLine(row({ tenant_name: formula }))).toContain(
      `,"'=HYPERLINK(""http://x"",""clic"")",`,
    );
    expect(split(dataLine(row({ tenant_name: formula })), ',')[1]).toBe(`'${formula}`);
    expect(split(dataLine(row({ seller_email: '@SUM(A1:A9)' })), ',')[12]).toBe("'@SUM(A1:A9)");
    expect(split(dataLine(row({ provider_order_id: '+57300' })), ',')[5]).toBe("'+57300");
    expect(split(dataLine(row({ provider_booking_ref: '-1+1' })), ',')[6]).toBe("'-1+1");
  });

  it('un ; o una tabulación van entre comillas: Excel en es-CO, es-PE o pt-BR separa por ;', () => {
    const line = dataLine(row({ tenant_name: 'Agencia;=1+1' }));
    expect(line).toContain(',"Agencia;=1+1",');
    expect(dataLine(row({ tenant_name: 'Agencia\t=1+1' }))).toContain(',"Agencia\t=1+1",');
    // Abierto separando por `;` (Excel es-CO), ninguna celda empieza con `=` sin su apóstrofo.
    for (const cell of split(line, ';')) expect(cell.startsWith('=')).toBe(false);
    // Separando por comas, la fila tiene las 15 columnas de siempre.
    expect(split(line, ',')).toHaveLength(ADMIN_ORDERS_CSV_HEADER.length);
  });

  it('el total negativo no lleva apóstrofo: es un número que arma el archivo', () => {
    expect(adminOrderCsvRow(row({ total_amount: -5 }))[10]).toEqual({ decimal: '-0.05' });
    expect(dataLine(row({ total_amount: -5 }))).toContain(',-0.05,COP,');
  });
});

describe('el nombre y el rastro', () => {
  it('reservas-AAAA-MM-DD.csv con el día de Bogotá', () => {
    expect(ordersExportFilename(NOW)).toBe('reservas-2026-10-13.csv');
  });

  it('los filtros como se aplicaron', () => {
    expect(
      exportedOrderFilters(
        AdminOrdersExportQuerySchema.parse({
          tenantId: NODO,
          subtree: 'false',
          vertical: 'hotels',
          provider: 'tbo-hotels',
          status: 'pending,confirmed',
          from: '2026-10-01',
          to: '2026-10-13',
          q: 'XYZ789',
          attention: 'true',
        }),
      ),
    ).toEqual({
      tenantId: NODO,
      subtree: false,
      vertical: 'hotels',
      provider: 'tbo-hotels',
      statuses: ['pending', 'confirmed'],
      from: '2026-10-01',
      to: '2026-10-13',
      q: 'XYZ789',
      attention: true,
    });
    expect(exportedOrderFilters(AdminOrdersExportQuerySchema.parse({}))).toEqual({
      tenantId: null,
      subtree: true,
      vertical: null,
      provider: null,
      statuses: null,
      from: null,
      to: null,
      q: null,
      attention: false,
    });
  });

  it('el correo de un cliente no queda en el audit log: sólo que se buscó por correo', () => {
    const filters = exportedOrderFilters(
      AdminOrdersExportQuerySchema.parse({ q: 'Cliente@Correo.com' }),
    );
    expect(filters).toMatchObject({ q: null, qByClientEmail: true });
    expect(JSON.stringify(filters)).not.toMatch(/correo/i);
  });
});

// ───────────────────────────── El borde ─────────────────────────────

describe('AdminOrdersExportQuerySchema', () => {
  it('los mismos filtros que la lista', () => {
    const query = {
      tenantId: NODO,
      subtree: 'false',
      vertical: 'cars',
      provider: 'agent-cars',
      status: 'cancelled',
      from: '2026-10-01',
      to: '2026-10-13',
      q: 'PNR123',
      attention: 'true',
    };
    const { cursor: _c, limit: _l, ...list } = AdminOrdersQuerySchema.parse(query);
    expect(AdminOrdersExportQuerySchema.parse(query)).toEqual(list);
  });

  it('sin página: cursor o limit son un 400', () => {
    expect(AdminOrdersExportQuerySchema.safeParse({ limit: '10' }).success).toBe(false);
    expect(AdminOrdersExportQuerySchema.safeParse({ cursor: 'x' }).success).toBe(false);
    expect(AdminOrdersExportQuerySchema.safeParse({ nodo: NODO }).success).toBe(false);
  });

  it('las fechas al revés también son un 400', () => {
    const res = AdminOrdersExportQuerySchema.safeParse({ from: '2026-10-13', to: '2026-10-01' });
    expect(res.success).toBe(false);
  });
});

// ───────────────────────────── El servicio ─────────────────────────────

/**
 * El servicio sobre un Kysely que compila de verdad. `filas`: lo que devuelve admin_search_orders;
 * `nodo`: si el nodo existe; `deniega`: la base dice que quien pide no es el superadmin;
 * `rastroFalla`: la base no deja escribir el evento de auditoría.
 */
function banco(
  opts: {
    filas?: AdminOrderSearchRow[];
    nodo?: boolean;
    deniega?: boolean;
    rastroFalla?: boolean;
  } = {},
) {
  const scripted = scriptedKysely((q: CompiledQuery) => {
    const s = q.sql;
    if (opts.rastroFalla === true && s.startsWith('insert into "domain_events"')) {
      throw Object.assign(new Error('could not extend file'), { code: '53100' });
    }
    if (s.includes('admin_search_orders(')) {
      if (opts.deniega === true) {
        throw Object.assign(new Error('admin_superadmin_required'), { code: '42501' });
      }
      return opts.filas ?? [];
    }
    if (s.includes('"tenant_type" =')) return [{ id: PLATAFORMA }];
    if (s.includes('from "tenants"')) return opts.nodo === false ? [] : [{ id: NODO }];
    return [];
  });
  const database = new DatabaseService();
  database.db = scripted.db;
  const service = new AdminOrdersService(
    database,
    {} as unknown as OrdersService,
    {} as unknown as HotelOrderReadsService,
    new AuditService(database),
    {} as unknown as OrderCapabilitiesService,
  );
  const lecturas = () => scripted.queries.filter((q) => q.sql.includes('admin_search_orders('));
  const eventos = () =>
    scripted.queries
      .filter((q) => q.sql.startsWith('insert into "domain_events"'))
      .map((q) => ({
        tenantId: q.parameters[0],
        actor: q.parameters[1],
        eventType: q.parameters[2],
        payload: JSON.parse(String(q.parameters[5])) as Record<string, unknown>,
      }));
  return { service, scripted, lecturas, eventos };
}

const FILTROS = {
  tenantId: NODO,
  vertical: 'flights',
  status: 'ticketed,confirmed',
  from: '2026-10-01',
  to: '2026-10-13',
  q: 'XYZ789',
  attention: 'true',
};

describe('AdminOrdersService.exportCsv', () => {
  it('la misma lectura que la lista, con los mismos filtros, sin página y con una de más', async () => {
    const lista = banco();
    await lista.service.search(SUPERADMIN, AdminOrdersQuerySchema.parse(FILTROS));
    const exportacion = banco();
    await exportacion.service.exportCsv(
      SUPERADMIN,
      AdminOrdersExportQuerySchema.parse(FILTROS),
      NOW,
    );

    const [list] = lista.lecturas();
    const [exp] = exportacion.lecturas();
    // Misma consulta y mismos filtros: el archivo no puede traer una reserva que la pantalla no
    // mostraría. Sólo cambian el cursor (ninguno) y el tope.
    expect(exp?.sql).toBe(list?.sql);
    expect(exp?.parameters.slice(0, -3)).toEqual(list?.parameters.slice(0, -3));
    expect(exp?.parameters.slice(-3)).toEqual([null, null, ADMIN_ORDERS_EXPORT_MAX_ROWS + 1]);
    expect(list?.parameters.slice(-1)).toEqual([51]);
  });

  it('deja platform.orders.exported en la raíz, con filtros y filas, después de leer', async () => {
    const { service, eventos, scripted } = banco({ filas: [row(), row({ order_number: 7 })] });
    const out = await service.exportCsv(
      SUPERADMIN,
      AdminOrdersExportQuerySchema.parse(FILTROS),
      NOW,
    );
    expect(out).toMatchObject({ rows: 2, filename: 'reservas-2026-10-13.csv' });
    expect(lines(out.csv)).toHaveLength(3);

    expect(eventos()).toEqual([
      {
        tenantId: PLATAFORMA,
        actor: SUPERADMIN,
        eventType: ADMIN_ORDERS_EXPORTED_EVENT,
        payload: {
          filters: {
            tenantId: NODO,
            subtree: true,
            vertical: 'flights',
            provider: null,
            statuses: ['ticketed', 'confirmed'],
            from: '2026-10-01',
            to: '2026-10-13',
            q: 'XYZ789',
            attention: true,
          },
          rows: 2,
        },
      },
    ]);
    // Una sola transacción: corre como quien pide y el rastro va después de la lectura.
    expect(scripted.queries[0]?.parameters).toContain(SUPERADMIN);
    expect(scripted.indexOf('insert into "domain_events"')).toBeGreaterThan(
      scripted.indexOf('admin_search_orders('),
    );
  });

  it('sin reservas igual queda el rastro: el archivo sólo con el encabezado', async () => {
    const { service, eventos } = banco();
    const out = await service.exportCsv(SUPERADMIN, AdminOrdersExportQuerySchema.parse({}), NOW);
    expect(out.rows).toBe(0);
    expect(lines(out.csv)).toEqual([ADMIN_ORDERS_CSV_HEADER.join(',')]);
    expect(eventos()[0]?.payload).toMatchObject({ rows: 0 });
  });

  it('exactamente 5.000 se exportan', async () => {
    const filas = Array.from({ length: ADMIN_ORDERS_EXPORT_MAX_ROWS }, () => row());
    const { service, eventos } = banco({ filas });
    const out = await service.exportCsv(SUPERADMIN, AdminOrdersExportQuerySchema.parse({}), NOW);
    expect(out.rows).toBe(ADMIN_ORDERS_EXPORT_MAX_ROWS);
    expect(lines(out.csv)).toHaveLength(ADMIN_ORDERS_EXPORT_MAX_ROWS + 1);
    expect(eventos()).toHaveLength(1);
  });

  it('más de 5.000: 422 EXPORT_TOO_LARGE, ningún archivo y ningún rastro', async () => {
    const filas = Array.from({ length: ADMIN_ORDERS_EXPORT_MAX_ROWS + 1 }, () => row());
    const { service, eventos } = banco({ filas });
    const err = await service
      .exportCsv(SUPERADMIN, AdminOrdersExportQuerySchema.parse({}), NOW)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdminOrdersExportTooLargeError);
    expect((err as AdminOrdersExportTooLargeError).getStatus()).toBe(422);
    expect((err as AdminOrdersExportTooLargeError).reason).toBe('EXPORT_TOO_LARGE');
    expect((err as Error).message).toBe(
      'Hay más de 5.000 reservas con estos filtros: acota las fechas o el nodo.',
    );
    expect(eventos()).toEqual([]);
  });

  it('un nodo que no existe: 404, sin leer ni dejar rastro', async () => {
    const { service, lecturas, eventos } = banco({ nodo: false });
    await expect(
      service.exportCsv(SUPERADMIN, AdminOrdersExportQuerySchema.parse({ tenantId: NODO }), NOW),
    ).rejects.toBeInstanceOf(PlatformConsoleScopeNotFoundError);
    expect(lecturas()).toEqual([]);
    expect(eventos()).toEqual([]);
  });

  it('si la base dice que no es superadmin: 403 y ningún rastro', async () => {
    const { service, eventos } = banco({ deniega: true });
    await expect(
      service.exportCsv(SUPERADMIN, AdminOrdersExportQuerySchema.parse({}), NOW),
    ).rejects.toBeInstanceOf(SuperadminRequiredError);
    expect(eventos()).toEqual([]);
  });

  it('si el rastro no se escribe, no sale el archivo: el error sube', async () => {
    const { service, lecturas } = banco({ filas: [row()], rastroFalla: true });
    await expect(
      service.exportCsv(SUPERADMIN, AdminOrdersExportQuerySchema.parse({}), NOW),
    ).rejects.toMatchObject({ code: '53100' });
    // Se leyó, pero el CSV nunca llega a quien lo pidió.
    expect(lecturas()).toHaveLength(1);
  });
});

// ───────────────────────────── La ruta ─────────────────────────────

type Handler = (...args: never[]) => unknown;
const proto = AdminOrdersController.prototype as unknown as Record<
  'list' | 'export' | 'detail',
  Handler
>;

function contextFor(handler: Handler): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => AdminOrdersController,
  } as unknown as ExecutionContext;
}

describe('GET /admin/orders/export', () => {
  it('va antes de :id (Express prueba las rutas en orden) y valida con el esquema sin página', () => {
    expect(Reflect.getMetadata(PATH_METADATA, proto.export)).toBe('export');
    const names = Object.getOwnPropertyNames(AdminOrdersController.prototype);
    expect(names.indexOf('export')).toBeGreaterThan(-1);
    expect(names.indexOf('export')).toBeLessThan(names.indexOf('detail'));

    const args = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      AdminOrdersController,
      'export',
    ) as Record<string, { pipes?: unknown[] }>;
    const pipe = Object.values(args)
      .flatMap((a) => a.pipes ?? [])
      .find((p) => p instanceof ZodValidationPipe);
    expect((pipe as { schema: unknown } | undefined)?.schema).toBe(AdminOrdersExportQuerySchema);
  });

  it('sólo el superadmin: un rol de nodo no llega; platform_admin lo frena SuperadminGuard', async () => {
    const roles = new RolesGuard(new Reflector());
    const allowed = (role: Role) =>
      requestContextStorage.run({ userId: SUPERADMIN, role }, () => {
        try {
          return roles.canActivate(contextFor(proto.export));
        } catch {
          return false;
        }
      });
    for (const role of [
      'tenant_admin',
      'consolidator_admin',
      'agency_admin',
      'vendedor',
    ] as const) {
      expect(allowed(role), role).toBe(false);
    }
    expect(allowed('superadmin')).toBe(true);

    const network = { isSuperadmin: vi.fn(() => Promise.resolve(false)) };
    const superadmin = new SuperadminGuard(network as unknown as NetworkService);
    await requestContextStorage.run({ userId: SUPERADMIN, role: 'platform_admin' }, async () => {
      await expect(superadmin.canActivate(contextFor(proto.export))).rejects.toBeInstanceOf(
        SuperadminRequiredError,
      );
    });
  });

  it('pide el 2FA de los últimos 10 minutos; la lista no', () => {
    const reflector = new Reflector();
    expect(reflector.get(REQUIRE_RECENT_MFA_KEY, proto.export)).toBe(10);
    expect(reflector.get(REQUIRE_RECENT_MFA_KEY, proto.list)).toBeUndefined();

    const guard = new RecentMfaGuard(reflector);
    const superadmin = (minutes: number): RequestContext => ({
      userId: SUPERADMIN,
      role: 'superadmin',
      mfaRequired: true,
      mfaEnabled: true,
      mfaVerified: true,
      mfaVerifiedAt: new Date(Date.now() - minutes * 60_000),
    });
    const run = (handler: Handler, ctx: RequestContext) =>
      requestContextStorage.run(ctx, () => {
        try {
          return guard.canActivate(contextFor(handler));
        } catch (err) {
          return err;
        }
      });
    expect(run(proto.export, superadmin(30))).toBeInstanceOf(MfaRecentRequiredError);
    expect(run(proto.export, superadmin(2))).toBe(true);
    expect(run(proto.list, superadmin(30))).toBe(true);
  });

  it('devuelve el CSV con su nombre y cuántas reservas', async () => {
    const orders = {
      exportCsv: vi.fn(() =>
        Promise.resolve({ csv: '\uFEFFfecha\r\n', filename: 'reservas-2026-10-13.csv', rows: 12 }),
      ),
    };
    const controller = new AdminOrdersController(
      orders as unknown as AdminOrdersService,
      {} as unknown as AdminOrderActionsService,
    );
    const headers = new Map<string, string>();
    const res = { setHeader: (k: string, v: string) => headers.set(k, v) };
    const query = AdminOrdersExportQuerySchema.parse({ status: 'confirmed' });
    await expect(controller.export(SUPERADMIN, query, res as never)).resolves.toBe(
      '\uFEFFfecha\r\n',
    );
    expect(orders.exportCsv).toHaveBeenCalledWith(SUPERADMIN, query);
    expect(Object.fromEntries(headers)).toEqual({
      'Content-Disposition': 'attachment; filename="reservas-2026-10-13.csv"',
      [EXPORT_ROWS_HEADER]: '12',
    });
  });
});
