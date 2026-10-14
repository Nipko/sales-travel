import { type ExecutionContext } from '@nestjs/common';
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
import {
  AdminTenantsService,
  foldHeld,
  foldImpact,
  foldNodeStats,
  type NodeStatsRow,
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

describe('AdminTenantsService.stats: las ventas de admin_sales_summary junto a cada nodo', () => {
  /** Un driver que contesta cada consulta sin Postgres y guarda el SQL que recibiría. */
  class DriverQueContesta extends DummyDriver {
    constructor(private readonly responder: (q: CompiledQuery) => unknown[]) {
      super();
    }

    override async acquireConnection(): Promise<DatabaseConnection> {
      const base = await super.acquireConnection();
      return {
        executeQuery: <R>(q: CompiledQuery): Promise<QueryResult<R>> =>
          Promise.resolve({ rows: this.responder(q) as R[] }),
        streamQuery: (q, chunkSize) => base.streamQuery(q, chunkSize),
      };
    }
  }

  it('suma las confirmadas de los últimos 30 días por nodo; un nodo sin fila de ventas, 0', async () => {
    const consultas: string[] = [];
    const database = new DatabaseService();
    database.db = new Kysely<DB>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () =>
          new DriverQueContesta((q) => {
            consultas.push(q.sql);
            if (q.sql.includes('admin_node_stats')) {
              return [fila(NODO, { orders_30d: '4' }), fila(HIJO, { orders_30d: '1' })];
            }
            if (q.sql.includes('admin_sales_summary')) return [{ tenant_id: NODO, n: '3' }];
            return [];
          }),
        createIntrospector: (k) => new PostgresIntrospector(k),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
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

describe('AdminTenantsService: el rechazo de la base es el 403 de la guarda', () => {
  const denial = Object.assign(new Error(ADMIN_SUPERADMIN_DB_DENIAL), { code: '42501' });

  function serviceThatFails(err: Error) {
    const db = { withRequestContext: vi.fn(() => Promise.reject(err)) };
    return { service: new AdminTenantsService(db as unknown as DatabaseService), db };
  }

  it('stats e impact: 42501 admin_superadmin_required sale como SuperadminRequiredError', async () => {
    const { service, db } = serviceThatFails(denial);
    await expect(service.stats(USUARIO)).rejects.toBeInstanceOf(SuperadminRequiredError);
    await expect(service.impact(USUARIO, NODO)).rejects.toBeInstanceOf(SuperadminRequiredError);
    expect(db.withRequestContext).toHaveBeenCalledWith({ userId: USUARIO }, expect.any(Function));
  });

  it('cualquier otro error sale tal cual', async () => {
    const boom = new Error('boom');
    const { service } = serviceThatFails(boom);
    await expect(service.stats(USUARIO)).rejects.toBe(boom);
    await expect(service.impact(USUARIO, NODO)).rejects.toBe(boom);
  });
});

describe('AdminTenantsController: sólo el superadmin', () => {
  function banco() {
    const tenants = {
      stats: vi.fn(() => Promise.resolve([foldNodeStats(fila(NODO))])),
      impact: vi.fn(() => Promise.resolve({ descendants: 0 })),
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
    expect(tenants.stats).toHaveBeenCalledWith(USUARIO);
    expect(tenants.impact).toHaveBeenCalledWith(USUARIO, NODO);
  });

  it('el id de la ruta es un uuid en minúsculas', () => {
    const id = new ZodValidationPipe(TenantIdParamSchema);
    expect(id.transform(NODO.toUpperCase())).toBe(NODO);
    expect(() => id.transform('stats')).toThrow();
  });
});
