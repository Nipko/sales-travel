import { describe, expect, expectTypeOf, it } from 'vitest';
import type { OrderStatus } from '../database/database.types.js';
import {
  ADMIN_ORDER_ACTION_REASON_MAX,
  ADMIN_ORDERS_MAX_PAGE,
  ADMIN_ORDERS_MAX_QUERY,
  ADMIN_ORDERS_PAGE,
  AdminOrderActionSchema,
  AdminOrderCancelSchema,
  AdminOrdersQuerySchema,
  ORDER_STATUSES,
  decodeAdminOrdersCursor,
  encodeAdminOrdersCursor,
} from './admin-orders.schemas.js';

const NODO = '0b0e4b7c-9a3d-4c1e-8f2a-1d2c3b4a5f60';
const CURSOR = { at: '2026-10-13T15:04:05.123456Z', id: '7f1d2c3b-4a5f-4e60-8b0e-4b7c9a3d4c1e' };

function parse(query: Record<string, string>) {
  return AdminOrdersQuerySchema.safeParse(query);
}

function messages(query: Record<string, string>): string[] {
  const result = parse(query);
  return result.success ? [] : result.error.issues.map((i) => i.message);
}

describe('AdminOrdersQuerySchema', () => {
  it('sin nada, toda la red: la primera página de 50 con el subárbol por defecto', () => {
    expect(AdminOrdersQuerySchema.parse({})).toEqual({ subtree: true, limit: ADMIN_ORDERS_PAGE });
  });

  it('cada filtro llega como lo espera la consulta', () => {
    const cursor = encodeAdminOrdersCursor(CURSOR);
    expect(
      AdminOrdersQuerySchema.parse({
        tenantId: NODO.toUpperCase(),
        subtree: 'false',
        vertical: 'hotels',
        provider: 'tbo-hotels',
        status: 'pending, confirmed,pending',
        from: '2026-10-01',
        to: '2026-10-13',
        q: '  ABC123 ',
        attention: 'true',
        cursor,
        limit: '20',
      }),
    ).toEqual({
      tenantId: NODO,
      subtree: false,
      vertical: 'hotels',
      provider: 'tbo-hotels',
      status: ['pending', 'confirmed'],
      from: '2026-10-01',
      to: '2026-10-13',
      q: 'ABC123',
      attention: true,
      cursor: CURSOR,
      limit: 20,
    });
  });

  it('un parámetro que no existe es un 400, no un filtro ignorado', () => {
    expect(parse({ nodo: NODO }).success).toBe(false);
    expect(parse({ tenant: NODO }).success).toBe(false);
  });

  it('las fechas: AAAA-MM-DD, que existan, en años razonables y en orden', () => {
    expect(parse({ from: '2026-02-28', to: '2026-02-28' }).success).toBe(true);
    expect(messages({ from: '13/10/2026' })).toContain('la fecha va como AAAA-MM-DD');
    expect(messages({ to: '2026-02-30' })).toContain('esa fecha no existe');
    expect(messages({ from: '1999-12-31' })[0]).toMatch(/tiene que caer entre/);
    expect(messages({ from: '2026-10-13', to: '2026-10-01' })).toEqual([
      'la fecha "hasta" no puede ser anterior a "desde"',
    ]);
  });

  it('los estados: una lista de OrderStatus separada por comas, sin repetir', () => {
    expect(AdminOrdersQuerySchema.parse({ status: 'failed' }).status).toEqual(['failed']);
    expect(AdminOrdersQuerySchema.parse({ status: ORDER_STATUSES.join(',') }).status).toEqual([
      ...ORDER_STATUSES,
    ]);
    expect(messages({ status: 'pending,voided' })[0]).toMatch(/cada estado es uno de pending/);
    expect(parse({ status: 'pending,' }).success).toBe(false);
    expect(parse({ status: '' }).success).toBe(false);
  });

  it('ORDER_STATUSES es exactamente OrderStatus', () => {
    expectTypeOf<(typeof ORDER_STATUSES)[number]>().toEqualTypeOf<OrderStatus>();
  });

  it('la vertical, el proveedor y el nodo tienen su forma', () => {
    expect(parse({ vertical: 'trains' }).success).toBe(false);
    expect(messages({ provider: 'TBO Hotels' })).toEqual([
      'el proveedor es un código como latam-ndc',
    ]);
    expect(parse({ provider: 'x' }).success).toBe(false);
    expect(parse({ tenantId: 'planetour' }).success).toBe(false);
    expect(parse({ subtree: 'si' }).success).toBe(false);
    expect(parse({ attention: 'false' }).success).toBe(false);
  });

  it('la búsqueda: de 2 a 100 caracteres y sin caracteres de control', () => {
    expect(messages({ q: ' a ' })).toEqual(['escribe al menos 2 caracteres']);
    expect(messages({ q: 'x'.repeat(ADMIN_ORDERS_MAX_QUERY + 1) })).toEqual([
      `la búsqueda puede tener hasta ${ADMIN_ORDERS_MAX_QUERY} caracteres`,
    ]);
    expect(parse({ q: 'x'.repeat(ADMIN_ORDERS_MAX_QUERY) }).success).toBe(true);
    expect(messages({ q: 'ab\u0000cd' })).toEqual(['la búsqueda tiene caracteres no válidos']);
    expect(AdminOrdersQuerySchema.parse({ q: 'cliente@correo.com' }).q).toBe('cliente@correo.com');
  });

  it('el tamaño de página va de 1 a 100', () => {
    expect(AdminOrdersQuerySchema.parse({ limit: String(ADMIN_ORDERS_MAX_PAGE) }).limit).toBe(100);
    expect(parse({ limit: '0' }).success).toBe(false);
    expect(parse({ limit: '101' }).success).toBe(false);
    expect(parse({ limit: '2.5' }).success).toBe(false);
    expect(parse({ limit: 'muchos' }).success).toBe(false);
  });

  it('un cursor que no armó la API es un 400 que dice qué hacer', () => {
    const invalid = 'el cursor no es válido: vuelve a cargar la lista desde el principio';
    expect(messages({ cursor: 'basura' })).toEqual([invalid]);
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
    // Milisegundos: dos reservas del mismo milisegundo se saltarían entre páginas.
    expect(messages({ cursor: encode({ at: '2026-10-13T15:04:05.123Z', id: CURSOR.id }) })).toEqual(
      [invalid],
    );
    expect(messages({ cursor: encode({ at: CURSOR.at, id: 'no-es-un-uuid' }) })).toEqual([invalid]);
    expect(messages({ cursor: encode([CURSOR.at, CURSOR.id]) })).toEqual([invalid]);
    expect(messages({ cursor: encode(null) })).toEqual([invalid]);
    expect(messages({ cursor: 'a'.repeat(201) })).toEqual([invalid]);
  });
});

describe('el cursor', () => {
  it('ida y vuelta', () => {
    const raw = encodeAdminOrdersCursor(CURSOR);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeAdminOrdersCursor(raw)).toEqual(CURSOR);
  });

  it('lo que no es base64url de un JSON no es un cursor', () => {
    expect(decodeAdminOrdersCursor('%%%')).toBeUndefined();
    expect(
      decodeAdminOrdersCursor(Buffer.from('{"at":', 'utf8').toString('base64url')),
    ).toBeUndefined();
  });
});

describe('AdminOrderActionSchema: el motivo de la acción', () => {
  const issues = (body: unknown): string[] => {
    const result = AdminOrderActionSchema.safeParse(body);
    return result.success ? [] : result.error.issues.map((i) => i.message);
  };

  it('obligatorio, recortado, de 5 a 500 caracteres', () => {
    expect(AdminOrderActionSchema.parse({ reason: '  La agencia no entra  ' })).toEqual({
      reason: 'La agencia no entra',
    });
    expect(issues({})).toEqual(['escribe el motivo: queda en la auditoría']);
    expect(issues(undefined)).toEqual(['escribe el motivo: queda en la auditoría']);
    expect(issues({ reason: 42 })).toEqual(['escribe el motivo: queda en la auditoría']);
    expect(issues({ reason: '   abc  ' })).toEqual([
      'el motivo tiene que tener al menos 5 caracteres',
    ]);
    expect(issues({ reason: 'x'.repeat(ADMIN_ORDER_ACTION_REASON_MAX + 1) })).toEqual([
      'el motivo puede tener hasta 500 caracteres',
    ]);
    expect(AdminOrderActionSchema.safeParse({ reason: 'x'.repeat(500) }).success).toBe(true);
  });

  it('admite saltos de línea; otros caracteres de control no', () => {
    expect(AdminOrderActionSchema.safeParse({ reason: 'Línea uno\nlínea dos' }).success).toBe(true);
    expect(issues({ reason: 'Motivo\u0000 raro' })).toEqual([
      'el motivo tiene caracteres no válidos',
    ]);
  });

  it('estricto: un campo de más es un error', () => {
    expect(AdminOrderActionSchema.safeParse({ reason: 'Motivo largo', extra: 1 }).success).toBe(
      false,
    );
  });
});

describe('AdminOrderCancelSchema: el motivo y el número de la orden', () => {
  it('los dos obligatorios', () => {
    expect(
      AdminOrderCancelSchema.parse({ reason: 'Pedido del cliente', orderNumber: 1042 }),
    ).toEqual({ reason: 'Pedido del cliente', orderNumber: 1042 });
    const sinNumero = AdminOrderCancelSchema.safeParse({ reason: 'Pedido del cliente' });
    expect(sinNumero.success ? [] : sinNumero.error.issues.map((i) => i.message)).toEqual([
      'escribe el número de la orden para confirmar',
    ]);
    expect(AdminOrderCancelSchema.safeParse({ orderNumber: 1042 }).success).toBe(false);
  });

  it('un número entero y positivo, no un texto', () => {
    for (const orderNumber of ['1042', 0, -3, 1.5, 2_147_483_648]) {
      expect(
        AdminOrderCancelSchema.safeParse({ reason: 'Pedido del cliente', orderNumber }).success,
        String(orderNumber),
      ).toBe(false);
    }
  });
});
