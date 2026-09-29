import { readdirSync, statSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ForbiddenException,
  Logger,
  RequestMethod,
  type ArgumentsHost,
  type ExecutionContext,
} from '@nestjs/common';
import {
  CONTROLLER_WATERMARK,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { MetadataScanner, Reflector } from '@nestjs/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AllExceptionsFilter } from '../all-exceptions.filter.js';
import { AppModule } from '../app.module.js';
import type { Role } from '../database/database.types.js';
import { requestContextStorage } from '../request-context/request-context.js';
import { IS_PUBLIC_KEY } from './decorators/public.decorator.js';
import { ROLES_KEY } from './decorators/roles.decorator.js';
import { SALES_OPERATION_KEY } from './decorators/sales-operation.decorator.js';
import { RolesGuard } from './guards/roles.guard.js';
import { PLATFORM_ROLES, SELLING_ROLES } from './roles.js';
import { PlatformRoleCannotSellError } from './sales-operation-errors.js';

/**
 * GUARD: el superadmin cuadra la red pero no vende (modelo Planetour, 2026-09-28).
 *
 * `RolesGuard` le da a la plataforma un pase libre en los controles de administración y se lo
 * quita en las rutas `@SalesOperation()`. Que una ruta sea o no una venta no se puede deducir del
 * código, así que este archivo lleva el inventario: TODAS las rutas que sirve `AppModule`, cada
 * una clasificada con su motivo. Falla si aparece una ruta sin clasificar, si la marca de una ruta
 * no coincide con su clasificación, o si el superadmin llega a una venta.
 *
 * Sumar una ruta a la API obliga a decidir acá si vende. Una venta es lo que da precio o
 * disponibilidad para vender o lo que compromete la venta; la post-venta de lectura, las
 * correcciones (cancelar, reintentar, rechazar un hold) y la administración no lo son.
 */

type Controller = abstract new (...args: never[]) => unknown;

interface Clase {
  readonly venta: boolean;
  readonly motivo: string;
}

function venta(motivo: string, ...rutas: string[]): [string, Clase][] {
  return rutas.map((ruta) => [ruta, { venta: true, motivo }]);
}

function noVenta(motivo: string, ...rutas: string[]): [string, Clase][] {
  return rutas.map((ruta) => [ruta, { venta: false, motivo }]);
}

const ENTRADAS: [string, Clase][] = [
  // ───────────────────────── Ventas ─────────────────────────
  ...venta('búsqueda y revalidación de vuelos', 'POST /search/flights', 'POST /search/offer-price'),
  ...venta('búsqueda de hoteles con precio', 'POST /hotels/availability', 'POST /hotels/detail'),
  ...venta(
    'reserva de hotel: PreBook, medios de pago, Book y aceptar un salto de precio',
    'POST /hotels/prebook',
    'GET /hotels/payments',
    'POST /hotels/book',
    'POST /hotels/reservations/:id/recovery',
  ),
  ...venta(
    'búsqueda de autos con precio',
    'POST /cars/search',
    'POST /cars/selection',
    'GET /cars/rate-detail',
  ),
  ...venta(
    'reserva de autos y confirmación de una reserva retenida (release)',
    'POST /cars/book',
    'POST /cars/reservations/release',
  ),
  ...venta(
    'órdenes: crear, pagar o emitir, recotizar y vender servicios adicionales',
    'POST /orders',
    'POST /orders/:id/pay',
    'POST /orders/:id/reshop',
    'POST /orders/:id/services',
  ),
  ...venta(
    'cotizaciones: crear, editar y enviar',
    'POST /quotations',
    'PATCH /quotations/:id/status',
    'PATCH /quotations/:id/customer',
    'POST /quotations/:id/send-email',
  ),
  ...venta(
    'paquetes: crear y editar',
    'POST /packages',
    'POST /packages/:id/items',
    'DELETE /packages/:id/items/:itemId',
  ),
  ...venta(
    'pagar o emitir una reserva con la cartera',
    'POST /portfolios/hold-booking',
    'POST /portfolios/orders/:orderId/approve',
  ),

  // ───────────────────────── No ventas ─────────────────────────
  ...noVenta(
    'pública: sin usuario no hay rol que vender',
    'GET /health',
    'GET /airports',
    'POST /auth/register',
    'POST /auth/login',
    'POST /auth/forgot-password',
    'POST /auth/reset-password',
    'POST /auth/mfa/verify',
    'POST /auth/verify-email',
    'POST /invitations/accept',
  ),
  ...noVenta(
    'la cuenta propia: sesión, contraseña y MFA',
    'POST /auth/switch-tenant',
    'POST /auth/logout',
    'POST /auth/logout-all',
    'GET /auth/sessions',
    'POST /auth/change-password',
    'GET /auth/mfa',
    'POST /auth/mfa/enroll',
    'POST /auth/mfa/confirm',
    'POST /auth/mfa/disable',
    'POST /auth/resend-verification',
    'GET /me',
    'GET /me/memberships',
  ),
  ...noVenta(
    'administración de la red: nodos, usuarios, invitaciones, marca y configuración',
    'GET /admin/tenants',
    'POST /admin/tenants',
    'PATCH /admin/tenants/:id',
    'POST /admin/tenants/:id/move',
    'GET /admin/users',
    'POST /admin/users',
    'PATCH /admin/users/status',
    'PATCH /admin/memberships/role',
    'PATCH /admin/memberships/status',
    'POST /invitations',
    'GET /invitations',
    'POST /invitations/:id/revoke',
    'GET /tenants/network',
    'GET /tenants/network/sales',
    'GET /tenants/network/audit',
    'GET /tenants/network/users',
    'GET /tenants/:id/config',
    'PATCH /tenants/:id/config',
    'GET /tenants/:id/branding',
    'GET /tenants/:id/branding/own',
    'PATCH /tenants/:id/branding',
    'POST /tenants/:id/brand-assets',
    'POST /mail/test',
  ),
  ...noVenta(
    'administración de proveedores: credenciales, habilitación, visibilidad, conciliación y payloads',
    'POST /provider-accounts',
    'GET /provider-accounts',
    'GET /provider-accounts/resolve',
    'POST /provider-accounts/:accountId/reconciliation',
    'GET /provider-accounts/:accountId/reconciliation',
    'GET /admin/providers',
    'GET /admin/providers/tenants/:tenantId',
    'PUT /admin/providers/:code/global',
    'DELETE /admin/providers/:code/global',
    'PUT /admin/providers/:code/tenants/:tenantId',
    'DELETE /admin/providers/:code/tenants/:tenantId',
    'GET /provider-disclosure',
    'PATCH /provider-disclosure',
    'GET /provider-payloads/requests/:requestId',
    'GET /provider-payloads/orders/:orderId',
  ),
  ...noVenta(
    'reglas de precio y su simulador: configuración, no venta',
    'GET /pricing/rules',
    'POST /pricing/rules',
    'DELETE /pricing/rules/:id',
    'POST /pricing/waterfall',
  ),
  ...noVenta(
    'reportes de lectura',
    'GET /reports/dashboard',
    'GET /reports/sales-metrics',
    'GET /reports/commissions',
  ),
  ...noVenta(
    'clientes y CRM: gestionan la cartera de clientes, no cotizan ni reservan',
    'POST /customers',
    'GET /customers',
    'GET /customers/:id',
    'PATCH /customers/:id',
    'DELETE /customers/:id',
    'POST /crm/opportunities',
    'GET /crm/opportunities',
    'GET /crm/opportunities/:id',
    'PATCH /crm/opportunities/:id',
    'POST /crm/interactions',
    'GET /crm/interactions/customer/:customerId',
    'POST /crm/tasks',
    'GET /crm/tasks',
    'POST /crm/tasks/:id/complete',
    'POST /crm/tasks/reassign',
  ),
  ...noVenta(
    'datos de referencia sin precio: autocompletar destinos, monedas de búsqueda, oficinas y tipos de tarifa',
    'GET /hotels/suggestions',
    'GET /hotels/currencies',
    'GET /cars/suggestions',
    'GET /cars/offices',
    'GET /cars/rates',
  ),
  ...noVenta(
    'ficha estática de un hotel, sin precio: la usa también el voucher de una reserva hecha',
    'GET /hotels/content/:providerCode/:hotelId',
  ),
  ...noVenta(
    'fotos de los resultados por lote: contenido estático sin precio, por el cupo de fondo',
    'POST /hotels/content/batch',
  ),
  ...noVenta(
    'post-venta de lectura',
    'GET /orders',
    'GET /orders/:id',
    'POST /orders/:id/retrieve',
    'GET /orders/:id/cancellation-estimate',
    'GET /orders/:id/operations',
    'GET /hotels/reservations/:id',
    'POST /cars/reservation',
    'GET /cars/daily-report',
    'GET /quotations',
    'GET /quotations/:id',
    'GET /packages',
    'GET /packages/:id',
    'GET /portfolios',
    'GET /portfolios/transactions',
    'GET /portfolios/deposit-reports',
  ),
  ...noVenta(
    'post-venta: reenvía la confirmación de una reserva ya hecha',
    'POST /orders/:id/send-confirmation',
  ),
  ...noVenta(
    'corrección: cancelar lo vendido, reintentar una cancelación o rechazar un hold',
    'POST /orders/:id/cancel',
    'POST /orders/:id/operations/:opId/retry',
    'POST /hotels/reservations/:id/cancel',
    'POST /cars/reservations/cancel',
    'POST /portfolios/orders/:orderId/reject',
  ),
  ...noVenta(
    'la agencia y su cartera: informa depósitos; las rutas viejas de movimientos responden 403',
    'POST /portfolios/deposit-reports',
    'POST /portfolios/deposit',
    'POST /portfolios/withdraw',
    'PATCH /portfolios/credit-limit',
  ),
  ...noVenta(
    'quien financia a un nodo gestiona sus carteras: monedas, cupo, depósitos, ajustes e informes',
    'GET /tenants/:tenantId/portfolios',
    'POST /tenants/:tenantId/portfolios',
    'PATCH /tenants/:tenantId/portfolios/:portfolioId',
    'POST /tenants/:tenantId/portfolios/:portfolioId/deposits',
    'POST /tenants/:tenantId/portfolios/:portfolioId/adjustments',
    'GET /tenants/:tenantId/portfolios/transactions',
    'GET /tenants/:tenantId/portfolios/deposit-reports',
    'POST /tenants/:tenantId/portfolios/deposit-reports/:reportId/approve',
    'POST /tenants/:tenantId/portfolios/deposit-reports/:reportId/reject',
  ),
];

/**
 * Lo que el modelo nombra como venta, fuera de la tabla: si alguien la reclasifica como "no venta"
 * para destrabar al superadmin, esto falla igual.
 */
const VENTAS_DEL_MODELO = [
  'POST /search/flights',
  'POST /search/offer-price',
  'POST /hotels/availability',
  'POST /hotels/prebook',
  'POST /hotels/book',
  'POST /cars/search',
  'POST /cars/book',
  'POST /orders',
  'POST /orders/:id/pay',
  'POST /quotations',
  'PATCH /quotations/:id/status',
  'POST /quotations/:id/send-email',
  'POST /packages',
  'POST /packages/:id/items',
];

function clasificacion(): Map<string, Clase> {
  const out = new Map<string, Clase>();
  for (const [ruta, clase] of ENTRADAS) {
    if (out.has(ruta)) throw new Error(`ruta clasificada dos veces: ${ruta}`);
    out.set(ruta, clase);
  }
  return out;
}

const CLASIFICACION = clasificacion();

/** Los controladores que Nest registra, recorriendo los módulos desde `AppModule`. */
function controladoresDe(raiz: unknown): Set<Controller> {
  const vistos = new Set<unknown>();
  const out = new Set<Controller>();

  const visitar = (modulo: unknown): void => {
    if (modulo === undefined || modulo === null) return;
    if (typeof modulo === 'object' && 'forwardRef' in modulo) {
      visitar((modulo as { forwardRef: () => unknown }).forwardRef());
      return;
    }
    // Un módulo dinámico (`X.forRoot()`) trae sus controladores e imports en el objeto.
    if (typeof modulo === 'object' && 'module' in modulo) {
      const dinamico = modulo as {
        module: unknown;
        imports?: unknown[];
        controllers?: Controller[];
      };
      for (const c of dinamico.controllers ?? []) out.add(c);
      for (const i of dinamico.imports ?? []) visitar(i);
      visitar(dinamico.module);
      return;
    }
    if (typeof modulo !== 'function' || vistos.has(modulo)) return;
    vistos.add(modulo);
    const controladores = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, modulo) ??
      []) as Controller[];
    for (const c of controladores) out.add(c);
    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, modulo) ?? []) as unknown[];
    for (const i of imports) visitar(i);
  };

  visitar(raiz);
  return out;
}

const CONTROLADORES = [...controladoresDe(AppModule)];

interface Ruta {
  readonly clave: string;
  readonly controlador: Controller;
  readonly handler: (...args: unknown[]) => unknown;
  readonly venta: boolean;
  readonly publica: boolean;
  readonly roles: Role[] | undefined;
}

/** `@Controller('x')` y `@Get('y')` guardan un string; sin argumento, Nest guarda '/'. */
function segmentos(path: unknown): string[] {
  if (typeof path !== 'string') throw new Error(`path de ruta inesperado: ${typeof path}`);
  return path.split('/').filter((s) => s.length > 0);
}

const reflector = new Reflector();
const scanner = new MetadataScanner();

function rutasDe(controlador: Controller): Ruta[] {
  const base = segmentos(Reflect.getMetadata(PATH_METADATA, controlador));
  const out: Ruta[] = [];
  // Los mismos métodos que explora Nest al registrar rutas, heredados incluidos.
  const prototipo = controlador.prototype as Record<string, unknown>;
  for (const nombre of scanner.getAllMethodNames(prototipo)) {
    const valor = prototipo[nombre];
    if (typeof valor !== 'function') continue;
    const handler = valor as (...args: unknown[]) => unknown;
    const metodo: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
    if (typeof metodo !== 'number') continue;

    const path = [...base, ...segmentos(Reflect.getMetadata(PATH_METADATA, handler))].join('/');
    const targets = [handler, controlador];
    out.push({
      clave: `${RequestMethod[metodo]} /${path}`,
      controlador,
      handler,
      venta:
        reflector.getAllAndOverride<boolean | undefined>(SALES_OPERATION_KEY, targets) === true,
      publica: reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, targets) === true,
      roles: reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets),
    });
  }
  return out;
}

const RUTAS = CONTROLADORES.flatMap(rutasDe);
const VENTAS = RUTAS.filter((r) => r.venta);

function contexto(ruta: Ruta): ExecutionContext {
  return {
    getHandler: () => ruta.handler,
    getClass: () => ruta.controlador,
  } as unknown as ExecutionContext;
}

const guard = new RolesGuard(reflector);

/**
 * El error con que el guard corta la ruta para ese rol, o `undefined` si la deja pasar.
 * `platformUser`: el usuario es superadmin en algún nodo, aunque en este tenant tenga `role`.
 */
function rechazo(ruta: Ruta, role: Role | undefined, platformUser = false): unknown {
  try {
    requestContextStorage.run({ userId: 'u-1', tenantId: 't-1', role, platformUser }, () =>
      guard.canActivate(contexto(ruta)),
    );
    return undefined;
  } catch (err) {
    return err;
  }
}

function raizDeFuentes(): string {
  for (const candidato of [
    resolvePath(process.cwd(), 'src'),
    resolvePath(process.cwd(), 'apps', 'api', 'src'),
  ]) {
    try {
      if (statSync(join(candidato, 'app.module.ts')).isFile()) return candidato;
    } catch {
      // Sigue con el próximo candidato.
    }
  }
  throw new Error(`no se encontró apps/api/src desde ${process.cwd()}`);
}

function archivosDeControladores(dir: string): string[] {
  const out: string[] = [];
  for (const nombre of readdirSync(dir)) {
    const full = join(dir, nombre);
    if (statSync(full).isDirectory()) {
      if (nombre !== '__fixtures__') out.push(...archivosDeControladores(full));
    } else if (nombre.endsWith('.controller.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('inventario de rutas', () => {
  it('recorre de verdad los módulos: encuentra los controladores que venden', () => {
    const nombres = CONTROLADORES.map((c) => c.name);
    for (const esperado of [
      'SearchController',
      'HotelsController',
      'CarsController',
      'OrdersController',
      'QuotationsController',
      'PackagesController',
      'PortfoliosController',
    ]) {
      expect(nombres).toContain(esperado);
    }
    for (const c of CONTROLADORES) {
      expect(Reflect.getMetadata(CONTROLLER_WATERMARK, c), c.name).toBe(true);
    }
  });

  it('todo controlador de un *.controller.ts está registrado: el recorrido no se salta ninguno', async () => {
    const registrados = new Set(CONTROLADORES.map((c) => c.name));
    const archivos = archivosDeControladores(raizDeFuentes());
    expect(archivos.length).toBeGreaterThan(0);

    const sueltos: string[] = [];
    for (const archivo of archivos) {
      const modulo = (await import(pathToFileURL(archivo).href)) as Record<string, unknown>;
      const exportados = Object.values(modulo).filter(
        (v): v is Controller =>
          typeof v === 'function' && Reflect.getMetadata(CONTROLLER_WATERMARK, v) === true,
      );
      expect(exportados.length, archivo).toBeGreaterThan(0);
      for (const c of exportados) if (!registrados.has(c.name)) sueltos.push(c.name);
    }
    expect(sueltos).toEqual([]);
  });

  it('ninguna ruta se repite', () => {
    const claves = RUTAS.map((r) => r.clave);
    expect(claves.filter((c, i) => claves.indexOf(c) !== i)).toEqual([]);
  });

  it('toda ruta de la API está clasificada, y la tabla no tiene rutas que ya no existen', () => {
    const existentes = new Set(RUTAS.map((r) => r.clave));
    const sinClasificar = [...existentes].filter((c) => !CLASIFICACION.has(c)).sort();
    const obsoletas = [...CLASIFICACION.keys()].filter((c) => !existentes.has(c)).sort();

    // Una ruta nueva: decidí si vende, marcala con @SalesOperation() si lo hace y sumala arriba.
    expect(sinClasificar).toEqual([]);
    expect(obsoletas).toEqual([]);
  });

  it('la marca @SalesOperation() de cada ruta coincide con su clasificación', () => {
    const distintas = RUTAS.filter((r) => CLASIFICACION.get(r.clave)?.venta !== r.venta)
      .map((r) => `${r.clave}: marcada ${r.venta ? 'venta' : 'no venta'}`)
      .sort();
    expect(distintas).toEqual([]);
  });

  it('lo que el modelo nombra como venta sigue clasificado y marcado como venta', () => {
    for (const clave of VENTAS_DEL_MODELO) {
      expect(CLASIFICACION.get(clave)?.venta, clave).toBe(true);
      expect(
        VENTAS.some((r) => r.clave === clave),
        clave,
      ).toBe(true);
    }
  });
});

describe('RolesGuard con la metadata REAL de cada venta', () => {
  it('hay ventas que probar', () => {
    expect(VENTAS.length).toBe([...CLASIFICACION.values()].filter((c) => c.venta).length);
  });

  it('ninguna venta es pública', () => {
    expect(VENTAS.filter((r) => r.publica).map((r) => r.clave)).toEqual([]);
  });

  it.each(VENTAS.map((r) => [r.clave, r] as const))(
    '%s: el superadmin y el platform_admin reciben 403 con el motivo',
    (_clave, ruta) => {
      for (const role of PLATFORM_ROLES) {
        const err = rechazo(ruta, role);
        expect(err, role).toBeInstanceOf(PlatformRoleCannotSellError);
        expect((err as PlatformRoleCannotSellError).getStatus()).toBe(403);
        expect((err as PlatformRoleCannotSellError).message).toBe(
          'El superadministrador no vende: usá un usuario de una sucursal',
        );
      }
    },
  );

  it.each(VENTAS.map((r) => [r.clave, r] as const))(
    '%s: el superadmin tampoco vende con otro rol en el tenant activo, ni sin membership en él',
    (_clave, ruta) => {
      for (const role of [...SELLING_ROLES, undefined]) {
        expect(rechazo(ruta, role, true), role ?? 'sin rol').toBeInstanceOf(
          PlatformRoleCannotSellError,
        );
      }
    },
  );

  it.each(VENTAS.map((r) => [r.clave, r] as const))(
    '%s: la operan los roles que venden y declara la ruta, nadie más',
    (_clave, ruta) => {
      const habilitados = SELLING_ROLES.filter(
        (role) => ruta.roles === undefined || ruta.roles.length === 0 || ruta.roles.includes(role),
      );
      // Una venta que no puede operar nadie es un error de configuración, no una restricción.
      expect(habilitados.length).toBeGreaterThan(0);
      for (const role of habilitados) expect(rechazo(ruta, role), role).toBeUndefined();

      for (const role of [
        'cliente_final',
        ...SELLING_ROLES.filter((r) => !habilitados.includes(r)),
      ] as Role[]) {
        const err = rechazo(ruta, role);
        expect(err, role).toBeInstanceOf(ForbiddenException);
        expect(err, role).not.toBeInstanceOf(PlatformRoleCannotSellError);
      }
    },
  );

  it('fuera de la venta, el superadmin sigue pasando donde pasaba (administración y post-venta)', () => {
    const cortadas = RUTAS.filter((r) => !r.venta && !r.publica && (r.roles?.length ?? 0) > 0)
      .filter((r) => PLATFORM_ROLES.some((role) => rechazo(r, role, true) !== undefined))
      .map((r) => r.clave);
    expect(cortadas).toEqual([]);
  });
});

describe('la respuesta HTTP del 403', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lleva el mensaje en español y el motivo máquina para la web', () => {
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({ method: 'POST', url: '/api/search/flights' }),
      }),
    } as unknown as ArgumentsHost;

    new AllExceptionsFilter().catch(new PlatformRoleCannotSellError(), host);

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({
      statusCode: 403,
      error: 'Forbidden',
      message: 'El superadministrador no vende: usá un usuario de una sucursal',
      reason: 'PLATFORM_ROLE_CANNOT_SELL',
    });
  });
});
