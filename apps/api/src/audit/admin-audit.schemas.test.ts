import { describe, expect, it } from 'vitest';
import { AuditPeriodInvalidError } from './admin-audit.errors.js';
import {
  ADMIN_AUDIT_PAGE,
  AdminAuditExportQuerySchema,
  AdminAuditQuerySchema,
  AUDIT_MAX_DAYS,
  auditExportFilename,
  resolveAuditPeriod,
} from './admin-audit.schemas.js';
import { encodeAuditCursor } from './audit.schemas.js';

const ID = '11111111-1111-4111-8111-111111111111';
/** 13 oct 2026, 10:00 en Bogotá. */
const NOW = new Date('2026-10-13T15:00:00.000Z');

function issues(
  input: unknown,
  schema: typeof AdminAuditQuerySchema | typeof AdminAuditExportQuerySchema = AdminAuditQuerySchema,
): string[] {
  const res = schema.safeParse(input);
  return res.success ? [] : res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

describe('AdminAuditQuerySchema', () => {
  it('sin nada: la página de siempre', () => {
    expect(AdminAuditQuerySchema.parse({})).toEqual({ limit: ADMIN_AUDIT_PAGE });
  });

  it('lee cada filtro', () => {
    const cursor = encodeAuditCursor({ occurredAt: '2026-10-13T14:00:00.123456Z', id: ID });
    expect(
      AdminAuditQuerySchema.parse({
        from: '2026-10-01',
        to: '2026-10-13',
        category: 'orders',
        eventType: 'platform.order.viewed',
        actorEmail: '  Ana@Agencia.COM ',
        tenantId: ID.toUpperCase(),
        includePlatform: 'false',
        aggregateType: 'order',
        aggregateId: ` ${ID} `,
        cursor,
        limit: '200',
      }),
    ).toEqual({
      from: '2026-10-01',
      to: '2026-10-13',
      category: 'orders',
      eventType: 'platform.order.viewed',
      actorEmail: 'ana@agencia.com',
      tenantId: ID,
      includePlatform: false,
      aggregateType: 'order',
      aggregateId: ID,
      cursor: { occurredAt: '2026-10-13T14:00:00.123456Z', id: ID },
      limit: 200,
    });
  });

  it('estricto: un parámetro de más es 400', () => {
    expect(issues({ tenant: ID })).toEqual([expect.stringContaining('tenant')]);
  });

  it(`el período: al derecho y de hasta ${AUDIT_MAX_DAYS} días`, () => {
    expect(issues({ from: '2026-10-13', to: '2026-10-01' })).toEqual([
      'to: la fecha "hasta" no puede ser anterior a "desde"',
    ]);
    // 92 días, ambos incluidos, sí; 93 no.
    expect(issues({ from: '2026-07-14', to: '2026-10-13' })).toEqual([]);
    expect(issues({ from: '2026-07-13', to: '2026-10-13' })).toEqual([
      `from: el período puede tener hasta ${AUDIT_MAX_DAYS} días`,
    ]);
    expect(issues({ from: '2026-02-30' })).toEqual(['from: esa fecha no existe']);
  });

  it.each([
    [{ category: 'pricing' }, 'category'],
    [{ eventType: 'a' }, 'eventType'],
    [{ eventType: "auth'; DROP" }, 'eventType'],
    [{ actorEmail: 'ana' }, 'actorEmail'],
    [{ tenantId: 'nodo' }, 'tenantId'],
    [{ includePlatform: 'si' }, 'includePlatform'],
    [{ aggregateType: 'Order' }, 'aggregateType'],
    [{ aggregateId: 'x'.repeat(101) }, 'aggregateId'],
    [{ aggregateId: 'a\u0000b' }, 'aggregateId'],
    [{ cursor: 'no-es-un-cursor' }, 'cursor'],
    [{ limit: '0' }, 'limit'],
    [{ limit: '201' }, 'limit'],
  ])('%j es 400', (input, field) => {
    expect(issues(input)).toEqual([expect.stringMatching(new RegExp(`^${field}: `))]);
  });

  it('la exportación: los mismos filtros, sin página', () => {
    expect(AdminAuditExportQuerySchema.parse({ category: 'system' })).toEqual({
      category: 'system',
    });
    expect(issues({ cursor: 'x' }, AdminAuditExportQuerySchema)).toHaveLength(1);
    expect(issues({ limit: '10' }, AdminAuditExportQuerySchema)).toHaveLength(1);
    expect(
      issues({ from: '2026-01-01', to: '2026-10-13' }, AdminAuditExportQuerySchema),
    ).toHaveLength(1);
  });
});

describe('resolveAuditPeriod', () => {
  it('sin fechas: los últimos 7 días contando hoy, en Bogotá', () => {
    expect(resolveAuditPeriod({}, NOW)).toEqual({ from: '2026-10-07', to: '2026-10-13' });
    // 23:30 del 12 en Bogotá ya es el 13 en UTC: el "hoy" es el de Bogotá.
    expect(resolveAuditPeriod({}, new Date('2026-10-13T04:30:00.000Z'))).toEqual({
      from: '2026-10-06',
      to: '2026-10-12',
    });
  });

  it('con un solo extremo se completa', () => {
    expect(resolveAuditPeriod({ to: '2026-09-30' }, NOW)).toEqual({
      from: '2026-09-24',
      to: '2026-09-30',
    });
    expect(resolveAuditPeriod({ from: '2026-10-01' }, NOW)).toEqual({
      from: '2026-10-01',
      to: '2026-10-13',
    });
  });

  it('al revés o de más de 92 días: 400', () => {
    expect(() => resolveAuditPeriod({ from: '2026-10-20' }, NOW)).toThrow(AuditPeriodInvalidError);
    expect(() => resolveAuditPeriod({ from: '2026-01-01' }, NOW)).toThrow(/hasta 92 días/);
    const err = (() => {
      try {
        resolveAuditPeriod({ from: '2026-01-01' }, NOW);
      } catch (e) {
        return e as AuditPeriodInvalidError;
      }
      return undefined;
    })();
    expect(err?.getStatus()).toBe(400);
    expect(err?.reason).toBe('AUDIT_PERIOD_INVALID');
  });

  it('el nombre del archivo dice el período', () => {
    expect(auditExportFilename({ from: '2026-10-07', to: '2026-10-13' })).toBe(
      'actividad-2026-10-07-a-2026-10-13.csv',
    );
  });
});
