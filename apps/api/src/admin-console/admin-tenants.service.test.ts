import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type QueryResult,
} from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { PLATFORM_ROLES } from '../auth/roles.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB, Role } from '../database/database.types.js';
import { TenantHierarchyNotFoundError } from '../database/tenant-hierarchy-errors.js';
import type { NetworkService } from '../network/network.service.js';
import {
  ADMIN_SUPERADMIN_DB_DENIAL,
  SuperadminRequiredError,
} from '../network/superadmin.errors.js';
import { SuperadminGuard } from '../network/superadmin.guard.js';
import { requestContextStorage } from '../request-context/request-context.js';
import { TenantIdParamSchema } from '../tenants/dto.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { AdminTenantsController } from './admin-tenants.controller.js';
import type { OverviewOrderAttentionRow } from './admin-overview.fold.js';
import {
  AdminTenantsService,
  foldHeld,
  foldImpact,
  foldNodeSales,
  foldNodeStats,
  foldNodeSummary,
  type NodeSalesRow,
  type NodeStatsRow,
  type NodeSummaryTenantView,
} from './admin-tenants.service.js';

const USUARIO = '99999999-9999-4999-8999-999999999999';
const NODO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HIJO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NIETO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** Una fila de admin_node_stats() como la devuelve `pg`: BIGINT como texto. */
function fila(tenantId: string, extra: Partial<NodeStatsRow> = {}): NodeStatsRow {
  return {
    tenant_id: tenantId,
    active_users: '0',
    live_sessions: '0',
    seat_limit: null,
    seats_used: null,
    orders_30d: '0',
    last_order_at: null,
    open_orders: '0',
    held: {},
    pending_deposit_reports: '0',
    pending_invitations: '0',
    ...extra,
  };
}

describe('foldNodeStats: una fila de admin_node_stats() a la vista', () => {
  it('números desde texto, la última venta en ISO y lo retenido por moneda con su exponente', () => {
    expect(
      foldNodeStats(
        fila(NODO, {
          active_users: '4',
          live_sessions: '3',
          seat_limit: 5,
          seats_used: 3,
          orders_30d: '12',
          last_order_at: new Date('2026-10-12T15:00:00Z'),
          open_orders: '2',
          held: { USD: 5000, COP: '125000' },
          pending_deposit_reports: '1',
          pending_invitations: '2',
        }),
        '7',
      ),
    ).toEqual({
      tenantId: NODO,
      seatLimit: 5,
      seatsUsed: 3,
      liveSessions: 3,
      activeUsers: 4,
      orders30d: 12,
      sales30d: 7,
      lastOrderAt: '2026-10-12T15:00:00.000Z',
      openOrders: 2,
      pendingDepositReports: 1,
      pendingInvitations: 2,
      held: [
        { currency: 'COP', exponent: 2, amountMinor: 125_000 },
        { currency: 'USD', exponent: 2, amountMinor: 5000 },
      ],
    });
  });

  it('sin cupo propio, puestos en null; sin reservas, la última en null y ninguna venta', () => {
    const view = foldNodeStats(fila(NODO));
    expect(view).toMatchObject({
      seatLimit: null,
      seatsUsed: null,
      lastOrderAt: null,
      sales30d: 0,
      held: [],
    });
  });

  it('las ventas son las confirmadas o emitidas, no las órdenes de 30 días en cualquier estado', () => {
    // 5 órdenes (fallidas y canceladas incluidas), 2 ventas; sin fila de ventas, ninguna.
    expect(foldNodeStats(fila(NODO, { orders_30d: '5' }), '2')).toMatchObject({
      orders30d: 5,
      sales30d: 2,
    });
    expect(foldNodeStats(fila(NODO, { orders_30d: '5' }), undefined).sales30d).toBe(0);
  });

  it('una fecha ilegible no se inventa: queda en null', () => {
    expect(foldNodeStats(fila(NODO, { last_order_at: 'ayer' })).lastOrderAt).toBeNull();
    expect(foldNodeStats(fila(NODO, { last_order_at: '2026-10-01T00:00:00Z' })).lastOrderAt).toBe(
      '2026-10-01T00:00:00.000Z',
    );
  });
});

describe('foldHeld: nunca suma monedas distintas', () => {
  it('suma dentro de cada moneda y ordena por código; una moneda sin exponente conocido va con null', () => {
    expect(foldHeld([{ COP: 1000, USD: 10 }, { COP: '500' }, { XXY: 7 }, null])).toEqual([
      { currency: 'COP', exponent: 2, amountMinor: 1500 },
      { currency: 'USD', exponent: 2, amountMinor: 10 },
      { currency: 'XXY', exponent: null, amountMinor: 7 },
    ]);
  });

  it('descarta lo que no es un monto y los ceros', () => {
    expect(
      foldHeld([{ COP: 'mucho', USD: 0, EUR: true }, [1, 2], 'COP', undefined, { BRL: null }]),
    ).toEqual([]);
  });
});

describe('foldImpact: el subárbol sumado', () => {
  const tenant = {
    id: NODO,
    name: 'Agencia Norte',
    tenantType: 'agency' as const,
    isBranch: false,
    status: 'active' as const,
  };

  it('cuenta los nodos de abajo, suma sesiones, reservas, depósitos e invitaciones, y lo retenido por moneda', () => {
    const view = foldImpact(
      tenant,
      [
        fila(NODO, {
          live_sessions: '2',
          open_orders: '3',
          held: { COP: 1000 },
          pending_deposit_reports: '1',
          pending_invitations: '1',
        }),
        fila(HIJO, { live_sessions: '1', open_orders: '1', held: { COP: 500, USD: 20 } }),
        fila(NIETO, { pending_invitations: '2' }),
      ],
      5,
    );
    expect(view).toEqual({
      tenant,
      descendants: 2,
      activeUsers: 5,
      liveSessions: 3,
      openOrders: 4,
      held: [
        { currency: 'COP', exponent: 2, amountMinor: 1500 },
        { currency: 'USD', exponent: 2, amountMinor: 20 },
      ],
      pendingDepositReports: 1,
      pendingInvitations: 3,
    });
  });

  it('una hoja: sin nodos de abajo', () => {
    expect(foldImpact(tenant, [fila(NODO)], 0)).toMatchObject({
      descendants: 0,
      activeUsers: 0,
      liveSessions: 0,
      held: [],
    });
  });
});

/** Un driver que contesta cada consulta sin Postgres (o la rechaza, si el que contesta lanza). */
class DriverQueContesta extends DummyDriver {
  constructor(private readonly responder: (q: CompiledQuery) => unknown[]) {
    super();
  }

  override async acquireConnection(): Promise<DatabaseConnection> {
    const base = await super.acquireConnection();
    return {
      executeQuery: <R>(q: CompiledQuery): Promise<QueryResult<R>> => {
        try {
          return Promise.resolve({ rows: this.responder(q) as R[] });
        } catch (err) {
          return Promise.reject(err instanceof Error ? err : new Error(String(err)));
        }
      },
      streamQuery: (q, chunkSize) => base.streamQuery(q, chunkSize),
    };
  }
}

/** Una base que contesta con `responder` y guarda el SQL de cada consulta en `consultas`. */
function baseQueContesta(responder: (q: CompiledQuery) => unknown[]) {
  const consultas: string[] = [];
  const database = new DatabaseService();
  database.db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () =>
        new DriverQueContesta((q) => {
          consultas.push(q.sql);
          return responder(q);
        }),
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { database, consultas };
}

describe('AdminTenantsService.stats: las ventas de admin_sales_summary junto a cada nodo', () => {
  it('suma las confirmadas de los últimos 30 días por nodo; un nodo sin fila de ventas, 0', async () => {
    const { database, consultas } = baseQueContesta((q) => {
      if (q.sql.includes('admin_node_stats')) {
        return [fila(NODO, { orders_30d: '4' }), fila(HIJO, { orders_30d: '1' })];
      }
      if (q.sql.includes('admin_sales_summary')) return [{ tenant_id: NODO, n: '3' }];
      return [];
    });

    const nodes = await new AdminTenantsService(database).stats(USUARIO);
    expect(nodes.map((n) => [n.tenantId, n.orders30d, n.sales30d])).toEqual([
      [NODO, 4, 3],
      [HIJO, 1, 0],
    ]);
    const ventas = consultas.find((q) => q.includes('admin_sales_summary'));
    expect(ventas).toContain("admin_sales_summary(now() - interval '30 days', now())");
    expect(ventas).toContain('sum(s.confirmed_count)');
  });
});

/** Una fila de admin_sales_summary sumada como la arma summary(). */
function venta(extra: Partial<NodeSalesRow>): NodeSalesRow {
  return {
    own: true,
    vertical: 'flights',
    currency: 'COP',
    orders_count: '0',
    confirmed_count: '0',
    confirmed_amount_minor: '0',
    cancelled_count: '0',
    failed_count: '0',
    ...extra,
  };
}

function atencion(orderId: string, reason: string): OverviewOrderAttentionRow {
  return {
    order_id: orderId,
    tenant_id: HIJO,
    tenant_name: 'Hijo',
    order_number: '7',
    provider: 'tbo-hotels',
    provider_order_id: null,
    order_status: 'confirmed',
    reason,
    since: new Date('2026-10-12T10:00:00Z'),
  };
}

const NODO_FICHA: NodeSummaryTenantView = {
  id: NODO,
  name: 'Consolidador Norte',
  slug: 'norte',
  tenantType: 'consolidator',
  isBranch: false,
  status: 'active',
  parent: { id: NIETO, name: 'Planetour' },
  countryCode: 'CO',
  defaultCurrency: 'COP',
  createdAt: '2026-01-05T12:00:00.000Z',
};

describe('foldNodeSales: lo del nodo y lo del nodo con su red, por moneda', () => {
  it('nunca suma monedas distintas; con su red suma dentro de cada moneda y vertical', () => {
    const view = foldNodeSales([
      venta({
        orders_count: '3',
        confirmed_count: '2',
        confirmed_amount_minor: '150000',
        cancelled_count: '1',
      }),
      venta({
        own: false,
        vertical: 'hotels',
        orders_count: '2',
        confirmed_count: '1',
        confirmed_amount_minor: '90000',
        failed_count: '1',
      }),
      venta({
        own: false,
        orders_count: '1',
        confirmed_count: '1',
        confirmed_amount_minor: '50000',
      }),
      venta({
        own: false,
        currency: 'USD',
        orders_count: '1',
        confirmed_count: '1',
        confirmed_amount_minor: '2500',
      }),
    ]);
    expect(view.days).toBe(30);
    expect(view.own).toEqual([
      {
        currency: 'COP',
        exponent: 2,
        ordersCount: 3,
        confirmedCount: 2,
        confirmedAmountMinor: 150_000,
        cancelledCount: 1,
        failedCount: 0,
        byVertical: [{ vertical: 'flights', confirmedCount: 2, confirmedAmountMinor: 150_000 }],
      },
    ]);
    expect(view.subtree).toEqual([
      {
        currency: 'COP',
        exponent: 2,
        ordersCount: 6,
        confirmedCount: 4,
        confirmedAmountMinor: 290_000,
        cancelledCount: 1,
        failedCount: 1,
        byVertical: [
          { vertical: 'flights', confirmedCount: 3, confirmedAmountMinor: 200_000 },
          { vertical: 'hotels', confirmedCount: 1, confirmedAmountMinor: 90_000 },
        ],
      },
      {
        currency: 'USD',
        exponent: 2,
        ordersCount: 1,
        confirmedCount: 1,
        confirmedAmountMinor: 2500,
        cancelledCount: 0,
        failedCount: 0,
        byVertical: [{ vertical: 'flights', confirmedCount: 1, confirmedAmountMinor: 2500 }],
      },
    ]);
  });

  it('una moneda con reservas pero nada confirmado se ve, sin verticales; las verticales van vuelos, hoteles, autos', () => {
    const view = foldNodeSales([
      venta({ orders_count: '2', cancelled_count: '2' }),
      venta({
        currency: 'BRL',
        vertical: 'cars',
        orders_count: '1',
        confirmed_count: '1',
        confirmed_amount_minor: '100',
      }),
      venta({
        currency: 'BRL',
        vertical: 'hotels',
        orders_count: '1',
        confirmed_count: '1',
        confirmed_amount_minor: '200',
      }),
    ]);
    expect(view.own.map((s) => s.currency)).toEqual(['BRL', 'COP']);
    expect(view.own[0]?.byVertical.map((v) => v.vertical)).toEqual(['hotels', 'cars']);
    expect(view.own[1]).toMatchObject({ confirmedCount: 0, cancelledCount: 2, byVertical: [] });
  });

  it('sin filas, nada', () => {
    expect(foldNodeSales([])).toEqual({ days: 30, own: [], subtree: [] });
  });
});

describe('foldNodeSummary: la ficha de un nodo, lo suyo frente a su red', () => {
  const network = {
    rows: [
      fila(NODO, {
        active_users: '2',
        live_sessions: '1',
        seat_limit: 5,
        seats_used: 4,
        open_orders: '1',
        held: { COP: 800 },
        pending_deposit_reports: '1',
      }),
      fila(HIJO, {
        active_users: '3',
        live_sessions: '2',
        open_orders: '4',
        held: { COP: 1000, USD: 2500 },
        pending_invitations: '1',
      }),
    ],
    people: 4,
  };

  it('own es su fila (con sus ventas confirmadas); subtree suma la red, con las personas una vez', () => {
    const view = foldNodeSummary({
      generatedAt: new Date('2026-10-13T15:00:00Z'),
      tenant: NODO_FICHA,
      network,
      sales: [
        venta({ orders_count: '3', confirmed_count: '2', confirmed_amount_minor: '1000' }),
        venta({ own: false, orders_count: '5', confirmed_count: '5' }),
      ],
      attention: [
        atencion('o1', 'cancel-failed'),
        atencion('o1', 'review'),
        atencion('o2', 'review'),
        atencion('o3', 'motivo-nuevo'),
      ],
    });
    expect(view.generatedAt).toBe('2026-10-13T15:00:00.000Z');
    expect(view.tenant).toBe(NODO_FICHA);
    expect(view.own).toMatchObject({
      tenantId: NODO,
      activeUsers: 2,
      liveSessions: 1,
      seatLimit: 5,
      seatsUsed: 4,
      openOrders: 1,
      // Sólo las suyas: las 5 de la red no.
      sales30d: 2,
      pendingDepositReports: 1,
      held: [{ currency: 'COP', exponent: 2, amountMinor: 800 }],
    });
    expect(view.subtree).toEqual({
      descendants: 1,
      // La persona con acceso a los dos nodos cuenta una vez (lo cuenta la base).
      activeUsers: 4,
      liveSessions: 3,
      openOrders: 5,
      held: [
        { currency: 'COP', exponent: 2, amountMinor: 1800 },
        { currency: 'USD', exponent: 2, amountMinor: 2500 },
      ],
      pendingDepositReports: 1,
      pendingInvitations: 1,
    });
    expect(view.sales?.own[0]?.confirmedCount).toBe(2);
    expect(view.sales?.subtree[0]?.confirmedCount).toBe(7);
    // Dos reservas distintas; o1 cuenta en sus dos motivos; un motivo desconocido no cuenta. Sin muestra.
    expect(view.attention).toMatchObject({
      total: 2,
      byReason: { 'cancel-failed': 1, review: 2, 'hold-orphan': 0 },
    });
    expect(view.attention).not.toHaveProperty('sample');
  });

  it('una sección que no se pudo leer queda en null y el resto se ve', () => {
    const view = foldNodeSummary({
      generatedAt: new Date('2026-10-13T15:00:00Z'),
      tenant: NODO_FICHA,
      network,
      sales: null,
      attention: null,
    });
    expect(view.sales).toBeNull();
    expect(view.attention).toBeNull();
    // Sin ventas leídas, las suyas en 0: la pantalla dice que no se pudieron leer.
    expect(view.own?.sales30d).toBe(0);
    expect(view.subtree?.descendants).toBe(1);

    const sinRed = foldNodeSummary({
      generatedAt: new Date('2026-10-13T15:00:00Z'),
      tenant: NODO_FICHA,
      network: null,
      sales: [],
      attention: [],
    });
    expect(sinRed.own).toBeNull();
    expect(sinRed.subtree).toBeNull();
    expect(sinRed.sales).toEqual({ days: 30, own: [], subtree: [] });
    expect(sinRed.attention?.total).toBe(0);
  });

  it('un nodo nuevo, sin fila en admin_node_stats todavía: todo en cero, no un error', () => {
    const view = foldNodeSummary({
      generatedAt: new Date('2026-10-13T15:00:00Z'),
      tenant: NODO_FICHA,
      network: { rows: [], people: 0 },
      sales: [],
      attention: [],
    });
    expect(view.own).toMatchObject({
      tenantId: NODO,
      activeUsers: 0,
      openOrders: 0,
      lastOrderAt: null,
      held: [],
    });
    expect(view.subtree).toMatchObject({ descendants: 0, activeUsers: 0, openOrders: 0 });
  });
});

describe('AdminTenantsService.summary: cada sección en su transacción', () => {
  const tenantRow = {
    id: NODO,
    name: 'Consolidador Norte',
    slug: 'norte',
    tenant_type: 'consolidator',
    is_branch: false,
    status: 'active',
    country_code: 'CO',
    default_currency: 'COP',
    created_at: new Date('2026-01-05T12:00:00Z'),
    parent_id: NIETO,
    parent_name: 'Planetour',
  };

  function responder(fail: { sql: string; err: unknown } | null = null) {
    return (q: CompiledQuery): unknown[] => {
      if (fail !== null && q.sql.includes(fail.sql)) throw fail.err;
      if (q.sql.includes('from "tenants" as "t"')) return [tenantRow];
      if (q.sql.includes('admin_node_stats')) return [fila(NODO, { open_orders: '2' })];
      if (q.sql.includes('count(DISTINCT m.user_id)')) return [{ n: '3' }];
      if (q.sql.includes('admin_sales_summary')) {
        return [venta({ orders_count: '1', confirmed_count: '1', confirmed_amount_minor: '500' })];
      }
      if (q.sql.includes('admin_order_attention')) return [atencion('o1', 'review')];
      return [];
    };
  }

  it('el nodo con su padre, su fila, su red, las ventas de 30 días del subárbol y lo que espera', async () => {
    const { database, consultas } = baseQueContesta(responder());
    const now = new Date('2026-10-13T15:00:00Z');
    const view = await new AdminTenantsService(database).summary(USUARIO, NODO, now);

    expect(view.generatedAt).toBe('2026-10-13T15:00:00.000Z');
    expect(view.tenant).toEqual(NODO_FICHA);
    expect(view.own).toMatchObject({ tenantId: NODO, openOrders: 2, sales30d: 1 });
    expect(view.subtree).toMatchObject({ descendants: 0, activeUsers: 3, openOrders: 2 });
    expect(view.sales?.own[0]).toMatchObject({ currency: 'COP', confirmedAmountMinor: 500 });
    expect(view.attention?.total).toBe(1);

    const ventas = consultas.find((q) => q.includes('admin_sales_summary')) ?? '';
    expect(ventas).toContain('admin_sales_summary(now() - make_interval(days => $');
    expect(ventas).toContain('OPERATOR(public.<@)');
    expect(ventas).toContain('AS own');
    const atencionSql = consultas.find((q) => q.includes('admin_order_attention')) ?? '';
    expect(atencionSql).toContain('OPERATOR(public.<@)');
    // Cada lectura de la red en su transacción, con el usuario en el contexto.
    expect(consultas.filter((q) => q.includes("set_config('app.current_user_id'"))).toHaveLength(4);
  });

  it('una sección que falla llega en null; las otras se ven', async () => {
    const timeout = Object.assign(new Error('canceling statement due to statement timeout'), {
      code: '57014',
    });
    const { database } = baseQueContesta(responder({ sql: 'admin_order_attention', err: timeout }));
    const view = await new AdminTenantsService(database).summary(USUARIO, NODO);
    expect(view.attention).toBeNull();
    expect(view.own).not.toBeNull();
    expect(view.sales).not.toBeNull();

    const { database: sinVentas } = baseQueContesta(
      responder({ sql: 'admin_sales_summary', err: new Error('boom') }),
    );
    const otra = await new AdminTenantsService(sinVentas).summary(USUARIO, NODO);
    expect(otra.sales).toBeNull();
    expect(otra.own?.sales30d).toBe(0);
    expect(otra.subtree).not.toBeNull();
    expect(otra.attention?.total).toBe(1);
  });

  it('el rechazo de la base en una sección no es una falla de sección: es el 403', async () => {
    const denial = Object.assign(new Error(ADMIN_SUPERADMIN_DB_DENIAL), { code: '42501' });
    const { database } = baseQueContesta(responder({ sql: 'admin_node_stats', err: denial }));
    await expect(new AdminTenantsService(database).summary(USUARIO, NODO)).rejects.toBeInstanceOf(
      SuperadminRequiredError,
    );
  });

  it('un problema de permisos en una sección no se tapa como "sin leer": sale tal cual', async () => {
    // Un GRANT que falta (42501 sin el mensaje de la consola): un 500 ruidoso, no una tarjeta vacía.
    const grant = Object.assign(new Error('permission denied for function admin_sales_summary'), {
      code: '42501',
    });
    const { database } = baseQueContesta(responder({ sql: 'admin_sales_summary', err: grant }));
    await expect(new AdminTenantsService(database).summary(USUARIO, NODO)).rejects.toBe(grant);

    // Un error HTTP ya decidido (la sesión, la guarda) tampoco es una sección caída.
    const forbidden = new ForbiddenException('no');
    const { database: otra } = baseQueContesta(
      responder({ sql: 'admin_order_attention', err: forbidden }),
    );
    await expect(new AdminTenantsService(otra).summary(USUARIO, NODO)).rejects.toBe(forbidden);
  });

  it('las tres secciones se piden a la vez, cada una en su transacción', async () => {
    const empezadas: string[] = [];
    let soltar: () => void = () => undefined;
    const todas = new Promise<void>((resolve) => {
      soltar = resolve;
    });
    const { database } = baseQueContesta(responder());
    const real = database.withRequestContext.bind(database);
    vi.spyOn(database, 'withRequestContext').mockImplementation(async (ctx, fn) => {
      const n = empezadas.push('trx');
      // La primera es la del nodo; las tres de la ficha esperan hasta que arrancaron todas.
      if (n === 4) soltar();
      if (n > 1) await todas;
      return real(ctx, fn);
    });
    const view = await new AdminTenantsService(database).summary(USUARIO, NODO);
    expect(empezadas).toHaveLength(4);
    expect(view.own).not.toBeNull();
    expect(view.sales).not.toBeNull();
    expect(view.attention).not.toBeNull();
  });

  it('un nodo que no existe es 404 TENANT_NOT_FOUND, sin leer la red', async () => {
    const { database, consultas } = baseQueContesta((q) =>
      q.sql.includes('from "tenants" as "t"') ? [] : responder()(q),
    );
    const error = await new AdminTenantsService(database)
      .summary(USUARIO, NODO)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TenantHierarchyNotFoundError);
    expect((error as TenantHierarchyNotFoundError).reason).toBe('TENANT_NOT_FOUND');
    expect(consultas.some((q) => q.includes('admin_node_stats'))).toBe(false);
  });

  it('la raíz de la red no tiene padre', async () => {
    const { database } = baseQueContesta((q) =>
      q.sql.includes('from "tenants" as "t"')
        ? [{ ...tenantRow, tenant_type: 'platform', parent_id: null, parent_name: null }]
        : responder()(q),
    );
    const view = await new AdminTenantsService(database).summary(USUARIO, NODO);
    expect(view.tenant).toMatchObject({ tenantType: 'platform', parent: null });
  });
});

describe('AdminTenantsService: el rechazo de la base es el 403 de la guarda', () => {
  const denial = Object.assign(new Error(ADMIN_SUPERADMIN_DB_DENIAL), { code: '42501' });

  function serviceThatFails(err: Error) {
    const db = { withRequestContext: vi.fn(() => Promise.reject(err)) };
    return { service: new AdminTenantsService(db as unknown as DatabaseService), db };
  }

  it('stats, impact y summary: 42501 admin_superadmin_required sale como SuperadminRequiredError', async () => {
    const { service, db } = serviceThatFails(denial);
    await expect(service.stats(USUARIO)).rejects.toBeInstanceOf(SuperadminRequiredError);
    await expect(service.impact(USUARIO, NODO)).rejects.toBeInstanceOf(SuperadminRequiredError);
    await expect(service.summary(USUARIO, NODO)).rejects.toBeInstanceOf(SuperadminRequiredError);
    expect(db.withRequestContext).toHaveBeenCalledWith({ userId: USUARIO }, expect.any(Function));
  });

  it('cualquier otro error sale tal cual', async () => {
    const boom = new Error('boom');
    const { service } = serviceThatFails(boom);
    await expect(service.stats(USUARIO)).rejects.toBe(boom);
    await expect(service.impact(USUARIO, NODO)).rejects.toBe(boom);
    // Sin poder leer el nodo no hay ficha: el error sale tal cual.
    await expect(service.summary(USUARIO, NODO)).rejects.toBe(boom);
  });
});

describe('AdminTenantsController: sólo el superadmin', () => {
  function banco() {
    const tenants = {
      stats: vi.fn(() => Promise.resolve([foldNodeStats(fila(NODO))])),
      impact: vi.fn(() => Promise.resolve({ descendants: 0 })),
      summary: vi.fn(() => Promise.resolve({ tenant: { id: NODO } })),
    };
    const controller = new AdminTenantsController(tenants as unknown as AdminTenantsService);
    return { controller, tenants };
  }

  it('la clase entera pasa por SuperadminGuard y declara los roles de plataforma', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminTenantsController)).toEqual([SuperadminGuard]);
    expect(Reflect.getMetadata(ROLES_KEY, AdminTenantsController)).toEqual([...PLATFORM_ROLES]);
  });

  it('quien no es superadmin recibe 403: platform_admin pasa RolesGuard y SuperadminGuard lo frena', async () => {
    const roles = new RolesGuard(new Reflector());
    const network = { isSuperadmin: vi.fn(() => Promise.resolve(false)) };
    const superadmin = new SuperadminGuard(network as unknown as NetworkService);
    const ctx = {
      getHandler: () => () => undefined,
      getClass: () => AdminTenantsController,
    } as unknown as ExecutionContext;
    await requestContextStorage.run({ userId: USUARIO, role: 'platform_admin' }, async () => {
      expect(roles.canActivate(ctx)).toBe(true);
      const error = await superadmin.canActivate(ctx).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SuperadminRequiredError);
      expect((error as SuperadminRequiredError).getStatus()).toBe(403);
    });
  });

  it('un rol de nodo no llega al controller', () => {
    const guard = new RolesGuard(new Reflector());
    const ctx = {
      getHandler: () => () => undefined,
      getClass: () => AdminTenantsController,
    } as unknown as ExecutionContext;
    const allowed = (role: Role | undefined) =>
      requestContextStorage.run({ userId: USUARIO, role }, () => {
        try {
          return guard.canActivate(ctx);
        } catch {
          return false;
        }
      });
    expect(allowed('superadmin')).toBe(true);
    for (const role of ['consolidator_admin', 'tenant_admin', 'admin', 'vendedor'] as const) {
      expect(allowed(role)).toBe(false);
    }
  });

  it('el superadmin pasa con su id como actor; stats viaja en `nodes`', async () => {
    const { controller, tenants } = banco();
    await expect(controller.stats(USUARIO)).resolves.toEqual({
      nodes: [expect.objectContaining({ tenantId: NODO })],
    });
    await expect(controller.impact(USUARIO, NODO)).resolves.toEqual({ descendants: 0 });
    await expect(controller.summary(USUARIO, NODO)).resolves.toEqual({ tenant: { id: NODO } });
    expect(tenants.stats).toHaveBeenCalledWith(USUARIO);
    expect(tenants.impact).toHaveBeenCalledWith(USUARIO, NODO);
    expect(tenants.summary).toHaveBeenCalledWith(USUARIO, NODO);
  });

  it('el id de la ruta es un uuid en minúsculas', () => {
    const id = new ZodValidationPipe(TenantIdParamSchema);
    expect(id.transform(NODO.toUpperCase())).toBe(NODO);
    expect(() => id.transform('stats')).toThrow();
  });
});
