import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoggerPort, MetricsPort } from '@sales-travel/core';
import { describe, expect, it } from 'vitest';
import { TboApiError, TboCancelMappingError, TboResponseMappingError } from '../errors';
import { mapTboCancelResponse } from './response.mapper';
import { TboCancelEnvelopeSchema, type TboCancelEnvelope } from './response.schema';

/**
 * `/Cancel` → `{ success }` (docs/tbo/04 §4.2-§4.3; 08 RF-25 y §9 C-05): `200` y `479` sin lanzar,
 * todo lo demás relanzado tal cual y lo ilegible como `TboCancelMappingError` con path `/Cancel`.
 */

const RESPONSE_921 = JSON.parse(
  readFileSync(join(__dirname, '..', '__fixtures__', 'pdf', 'cancel-response.p42.json'), 'utf8'),
) as Record<string, unknown>;

const CONTEXT = { confirmationNumber: 'FL1IMA', requestId: 'req-cancel-1' };

function envelope(raw: unknown): TboCancelEnvelope {
  return TboCancelEnvelopeSchema.parse(raw);
}

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  throw new Error('no lanzó');
}

function apiError(kind: TboApiError['kind'], tboCode?: number, path = '/Cancel'): TboApiError {
  return new TboApiError({
    status: 200,
    ...(tboCode === undefined ? {} : { tboCode }),
    path,
    kind,
    requestId: 'req-x',
  });
}

describe('200: cancelación ACEPTADA (p. 42)', () => {
  it('9.2.1 tal cual', () => {
    expect(
      mapTboCancelResponse({ kind: 'answered', envelope: envelope(RESPONSE_921) }, CONTEXT),
    ).toEqual({
      success: true,
      tboCode: 200,
      confirmationNumber: 'FL1IMA',
      diagnostics: { unknownKeys: [] },
    });
  });

  it('el localizador se compara sin distinguir mayúsculas', () => {
    const reply = mapTboCancelResponse(
      { kind: 'answered', envelope: envelope({ ...RESPONSE_921, ConfirmationNumber: 'fl1ima' }) },
      CONTEXT,
    );
    expect(reply.success).toBe(true);
  });

  it('un localizador numérico es el mismo texto', () => {
    const parsed = envelope({ Status: { Code: 200 }, ConfirmationNumber: 123456 });
    expect(parsed.ConfirmationNumber).toBe('123456');
  });

  it('registra el NOMBRE de una clave nueva, nunca su valor', () => {
    const logs: unknown[] = [];
    const counters: { name: string; tags?: Record<string, string> }[] = [];
    const logger: LoggerPort = {
      debug: () => undefined,
      info: () => undefined,
      warn: (message, meta) => logs.push({ message, meta }),
      error: () => undefined,
      child: () => logger,
    };
    const metrics: MetricsPort = {
      counter: (name, _value, tags) => counters.push({ name, ...(tags ? { tags } : {}) }),
      gauge: () => undefined,
      histogram: () => undefined,
    };
    const reply = mapTboCancelResponse(
      {
        kind: 'answered',
        envelope: envelope({ ...RESPONSE_921, CancellationCharge: 'Sharma 99.00' }),
      },
      CONTEXT,
      { logger, metrics },
    );
    expect(reply.diagnostics.unknownKeys).toEqual(['CancellationCharge']);
    expect(counters).toContainEqual({
      name: 'tbo.contract.unknown_key',
      tags: { op: 'cancel', key: 'CancellationCharge' },
    });
    expect(JSON.stringify(logs)).not.toContain('Sharma');
  });
});

describe('200 que no se puede leer: TboCancelMappingError, nunca la clase madre (01 §9.3)', () => {
  it.each([
    [
      'nombra otra reserva',
      { ...RESPONSE_921, ConfirmationNumber: 'YOSUR8' },
      'ConfirmationNumber:not_the_requested_booking',
    ],
    [
      'localizador sin forma',
      { ...RESPONSE_921, ConfirmationNumber: 'FL1 IMA' },
      'ConfirmationNumber:invalid_format',
    ],
    [
      'Status.Code que no es 200',
      { ...RESPONSE_921, Status: { Code: 201 } },
      'Status.Code:not_a_success_code',
    ],
  ])('%s', (_name, raw, issue) => {
    const error = thrownBy(() =>
      mapTboCancelResponse({ kind: 'answered', envelope: envelope(raw) }, CONTEXT),
    );
    expect(error).toBeInstanceOf(TboCancelMappingError);
    expect(error).toMatchObject({
      name: 'TboCancelMappingError',
      path: '/Cancel',
      issues: [issue],
      requestId: 'req-cancel-1',
    });
  });

  it('sin ConfirmationNumber el esquema no pasa (el cliente lo convierte en TboCancelMappingError)', () => {
    const parsed = TboCancelEnvelopeSchema.safeParse({ Status: { Code: 200 } });
    expect(parsed.success).toBe(false);
  });
});

describe('479: success false SIN lanzar (C-05)', () => {
  it('el 479 del cliente vuelve como rechazo', () => {
    expect(
      mapTboCancelResponse({ kind: 'threw', error: apiError('CANCEL_FAILED', 479) }, CONTEXT),
    ).toEqual({
      success: false,
      tboCode: 479,
      error: 'TBO_CANCEL_FAIL',
      diagnostics: { unknownKeys: [] },
    });
  });

  it('un CANCEL_FAILED de otro path no es la respuesta de /Cancel: se relanza', () => {
    const error = apiError('CANCEL_FAILED', 479, '/BookingDetail');
    expect(thrownBy(() => mapTboCancelResponse({ kind: 'threw', error }, CONTEXT))).toBe(error);
  });
});

describe('todo lo demás se relanza tal cual, la misma instancia', () => {
  it.each([
    [
      'timeout',
      new TboApiError({
        status: 0,
        path: '/Cancel',
        kind: 'TRANSPORT',
        requestId: 'r',
        timedOut: true,
      }),
    ],
    ['500 en el cuerpo', apiError('UPSTREAM', 500)],
    ['429', apiError('THROTTLED', 429)],
    ['401', apiError('CREDENTIALS_INVALID', 401)],
    [
      'código desconocido (ya convertido por el cliente)',
      new TboCancelMappingError('/Cancel', ['Status.Code:unknown_code']),
    ],
    ['un error que no es de TBO', new TypeError('bug')],
  ])('%s', (_name, error) => {
    expect(thrownBy(() => mapTboCancelResponse({ kind: 'threw', error }, CONTEXT))).toBe(error);
  });

  it('un TboResponseMappingError genérico tampoco se disfraza', () => {
    const error = new TboResponseMappingError('/Cancel', []);
    expect(thrownBy(() => mapTboCancelResponse({ kind: 'threw', error }, CONTEXT))).toBe(error);
  });
});
