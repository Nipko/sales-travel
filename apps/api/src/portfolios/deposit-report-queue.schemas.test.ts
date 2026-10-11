import { describe, expect, it } from 'vitest';
import {
  DEPOSIT_REPORT_QUEUE_PAGE,
  DepositReportQueueQuerySchema,
  InvalidQueueCursorError,
  decodeQueueCursor,
  encodeQueueCursor,
} from './deposit-report-queue.schemas.js';

const ID = '11111111-1111-4111-8111-111111111111';
const AT = '2026-10-11T12:34:56.123456Z';

describe('cursor de la cola de depósitos', () => {
  it('ida y vuelta, con microsegundos', () => {
    const raw = encodeQueueCursor({ at: AT, id: ID });
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeQueueCursor(raw)).toEqual({ at: AT, id: ID });
  });

  it.each([
    ['basura', 'no-es-base64-json'],
    ['otro JSON', Buffer.from('{"at":"x"}').toString('base64url')],
    [
      'sin microsegundos',
      Buffer.from(JSON.stringify(['2026-10-11T12:34:56Z', ID])).toString('base64url'),
    ],
    ['id que no es uuid', Buffer.from(JSON.stringify([AT, 'x'])).toString('base64url')],
    ['tres elementos', Buffer.from(JSON.stringify([AT, ID, 1])).toString('base64url')],
  ])('rechaza %s', (_caso, raw) => {
    expect(decodeQueueCursor(raw)).toBeUndefined();
  });

  it('el error de cursor inválido es 400 con motivo y en tú', () => {
    const error = new InvalidQueueCursorError();
    expect(error.getStatus()).toBe(400);
    expect(error.reason).toBe('DEPOSIT_REPORT_QUEUE_CURSOR_INVALID');
    expect(error.message).toContain('vuelve a cargar');
  });
});

describe('DepositReportQueueQuerySchema', () => {
  it('sin nada: los pendientes, de a 50', () => {
    expect(DepositReportQueueQuerySchema.parse({})).toEqual({
      status: 'pending',
      limit: DEPOSIT_REPORT_QUEUE_PAGE,
    });
  });

  it('normaliza moneda, tenant y búsqueda, y convierte el límite de la query', () => {
    const cursor = encodeQueueCursor({ at: AT, id: ID });
    expect(
      DepositReportQueueQuerySchema.parse({
        status: 'approved',
        financedBy: 'platform',
        currency: 'usd',
        tenantId: ID.toUpperCase(),
        q: '  TRX-1 ',
        cursor,
        limit: '20',
      }),
    ).toEqual({
      status: 'approved',
      financedBy: 'platform',
      currency: 'USD',
      tenantId: ID,
      q: 'TRX-1',
      cursor,
      limit: 20,
    });
  });

  it.each([
    ['un estado desconocido', { status: 'held' }],
    ['un financiador desconocido', { financedBy: 'me' }],
    ['una moneda inventada', { currency: 'XXZ' }],
    ['un tenant que no es uuid', { tenantId: 'abc' }],
    ['una búsqueda vacía', { q: '   ' }],
    ['una búsqueda larguísima', { q: 'x'.repeat(101) }],
    ['un cursor roto', { cursor: 'abc' }],
    ['un límite de más', { limit: '101' }],
    ['un límite cero', { limit: '0' }],
    ['un campo de más', { sort: 'amount' }],
  ])('rechaza %s', (_caso, query) => {
    expect(DepositReportQueueQuerySchema.safeParse(query).success).toBe(false);
  });
});
