import { describe, expect, it } from 'vitest';
import {
  encodeAuditCursor,
  NetworkAuditQuerySchema,
  UserAuditQuerySchema,
} from './audit.schemas.js';

/** Los bordes de lectura del audit log: lo que no armó el panel no pasa. */

const NODO = '11111111-1111-4111-8111-111111111111';
const ANA = '22222222-2222-4222-8222-222222222222';
const CURSOR = encodeAuditCursor({ occurredAt: '2026-10-13T12:00:00.000001Z', id: ANA });

describe('NetworkAuditQuerySchema', () => {
  it('acepta el nodo solo, y todos los filtros juntos; los ids en minúsculas', () => {
    expect(NetworkAuditQuerySchema.parse({ tenantId: NODO.toUpperCase() })).toEqual({
      tenantId: NODO,
    });
    expect(
      NetworkAuditQuerySchema.parse({
        tenantId: NODO,
        limit: '25',
        before: CURSOR,
        category: 'users',
        actorUserId: ANA.toUpperCase(),
      }),
    ).toEqual({ tenantId: NODO, limit: 25, before: CURSOR, category: 'users', actorUserId: ANA });
  });

  it('sin nodo, con un nodo que no es UUID o con parámetros de más: 400', () => {
    for (const query of [
      {},
      { tenantId: 'network' },
      { tenantId: NODO, extra: '1' },
      { tenantId: NODO, userId: ANA },
    ]) {
      expect(NetworkAuditQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false);
    }
  });

  it('el tamaño va de 1 a 200 y sólo en dígitos', () => {
    for (const limit of ['1', '200', ' 50 ']) {
      expect(NetworkAuditQuerySchema.safeParse({ tenantId: NODO, limit }).success, limit).toBe(
        true,
      );
    }
    for (const limit of ['0', '201', '5.5', '50 eventos', '', '-1']) {
      expect(NetworkAuditQuerySchema.safeParse({ tenantId: NODO, limit }).success, limit).toBe(
        false,
      );
    }
  });

  it('sólo las cuatro categorías, un cursor emitido por el API y un actor UUID', () => {
    for (const category of ['users', 'credentials', 'pricing', 'network']) {
      expect(NetworkAuditQuerySchema.safeParse({ tenantId: NODO, category }).success).toBe(true);
    }
    for (const bad of [
      { category: 'orders' },
      { category: 'Users' },
      { before: '2026-10-13T12:00:00Z' },
      { before: 'cursor raro' },
      { actorUserId: 'ana' },
    ]) {
      expect(
        NetworkAuditQuerySchema.safeParse({ tenantId: NODO, ...bad }).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });
});

describe('UserAuditQuerySchema', () => {
  it('vacía, o con cursor y tamaño de 1 a 100', () => {
    expect(UserAuditQuerySchema.parse({})).toEqual({});
    expect(UserAuditQuerySchema.parse({ before: CURSOR, limit: '100' })).toEqual({
      before: CURSOR,
      limit: 100,
    });
  });

  it('rechaza un tamaño fuera de rango, un cursor ajeno o parámetros de más', () => {
    for (const query of [
      { limit: '101' },
      { limit: '0' },
      { before: 'x' },
      { category: 'users' },
      { tenantId: NODO },
    ]) {
      expect(UserAuditQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false);
    }
  });
});
