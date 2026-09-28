import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TboRequestBuildError } from '../errors';
import {
  TBO_BOOKINGS_BY_DATE_MAX_DAYS,
  TboBookingsByDateRequestSchema,
  buildTboBookingsByDateRequest,
  splitTboBookingDateRange,
  type TboBookingDateWindow,
} from './booking-by-date.request.builder';

/**
 * El body de BookingDetailsbasedondate y sus ventanas (docs/tbo/04 §5.3 y §9.5; 08 RF-28; PV-25 y
 * PV-26): `FromDate`/`ToDate` en PascalCase, fechas de calendario y hasta 60 días con los extremos
 * incluidos.
 */

const REQUEST_1511 = JSON.parse(
  readFileSync(
    join(__dirname, '..', '__fixtures__', 'pdf', 'booking-by-date-request.p63.json'),
    'utf8',
  ),
) as Record<string, unknown>;

function issuesOf(run: () => unknown): readonly string[] {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(TboRequestBuildError);
    const error = err as TboRequestBuildError;
    expect(error.path).toBe('/BookingDetailsbasedondate');
    expect(error.reason).toBe('SCHEMA');
    return error.issues;
  }
  throw new Error('el builder no lanzó');
}

describe('15.1.1 Sample Request (p. 63)', () => {
  it('las mismas fechas, con la grafía de la tabla y de Postman (PV-25)', () => {
    const body = buildTboBookingsByDateRequest({ fromDate: '2023-11-09', toDate: '2023-11-10' });
    expect(body).toEqual({ FromDate: '2023-11-09', ToDate: '2023-11-10' });
    // El ejemplo escribe las claves en minúsculas: difieren SÓLO en eso.
    expect(Object.keys(body).map((key) => key.toLowerCase())).toEqual(Object.keys(REQUEST_1511));
    expect(Object.values(body)).toEqual(Object.values(REQUEST_1511));
  });

  it('nada más que las dos fechas', () => {
    expect(
      TboBookingsByDateRequestSchema.safeParse({
        FromDate: '2023-11-09',
        ToDate: '2023-11-10',
        PaymentMode: 'Limit',
      }).success,
    ).toBe(false);
  });
});

describe('la ventana: hasta 60 días con los dos extremos incluidos (p. 62)', () => {
  it('un solo día vale', () => {
    expect(buildTboBookingsByDateRequest({ fromDate: '2026-09-26', toDate: '2026-09-26' })).toEqual(
      { FromDate: '2026-09-26', ToDate: '2026-09-26' },
    );
  });

  it('exactamente 60 días vale; 61 no sale', () => {
    expect(TBO_BOOKINGS_BY_DATE_MAX_DAYS).toBe(60);
    expect(() =>
      buildTboBookingsByDateRequest({ fromDate: '2026-01-01', toDate: '2026-03-01' }),
    ).not.toThrow();
    expect(
      issuesOf(() =>
        buildTboBookingsByDateRequest({ fromDate: '2026-01-01', toDate: '2026-03-02' }),
      ),
    ).toEqual(['toDate:window_too_long']);
  });

  it('en año bisiesto el 29 de febrero cuenta', () => {
    expect(() =>
      buildTboBookingsByDateRequest({ fromDate: '2024-01-01', toDate: '2024-02-29' }),
    ).not.toThrow();
    expect(
      issuesOf(() =>
        buildTboBookingsByDateRequest({ fromDate: '2024-01-01', toDate: '2024-03-01' }),
      ),
    ).toEqual(['toDate:window_too_long']);
  });

  it('un rango invertido no es una ventana vacía', () => {
    expect(
      issuesOf(() =>
        buildTboBookingsByDateRequest({ fromDate: '2026-09-26', toDate: '2026-09-25' }),
      ),
    ).toEqual(['toDate:before_from_date']);
  });

  it.each<[TboBookingDateWindow, string[]]>([
    [{ fromDate: '2023-11-9', toDate: '2023-11-10' }, ['fromDate:invalid_date']],
    [{ fromDate: '2023-02-30', toDate: '2023-03-01' }, ['fromDate:invalid_date']],
    [{ fromDate: '2023-11-09', toDate: '10-Nov-2023' }, ['toDate:invalid_date']],
    [{ fromDate: '', toDate: '' }, ['fromDate:invalid_date', 'toDate:invalid_date']],
    [
      { fromDate: 20231109, toDate: null } as unknown as TboBookingDateWindow,
      ['fromDate:invalid_date', 'toDate:invalid_date'],
    ],
  ])('%j no sale', (window, issues) => {
    expect(issuesOf(() => buildTboBookingsByDateRequest(window))).toEqual(issues);
  });
});

describe('splitTboBookingDateRange: tramos de 60 días, sin huecos ni solapes (04 §9.3)', () => {
  it('un rango corto es una sola ventana', () => {
    expect(splitTboBookingDateRange({ fromDate: '2026-09-24', toDate: '2026-09-26' })).toEqual([
      { fromDate: '2026-09-24', toDate: '2026-09-26' },
    ]);
  });

  it('61 días son dos ventanas: 60 y 1', () => {
    expect(splitTboBookingDateRange({ fromDate: '2026-01-01', toDate: '2026-03-02' })).toEqual([
      { fromDate: '2026-01-01', toDate: '2026-03-01' },
      { fromDate: '2026-03-02', toDate: '2026-03-02' },
    ]);
  });

  it('un año son ceil(365 / 60) = 7 ventanas contiguas, todas válidas para el builder', () => {
    const windows = splitTboBookingDateRange({ fromDate: '2025-09-27', toDate: '2026-09-26' });
    expect(windows).toHaveLength(7);
    expect(windows[0]?.fromDate).toBe('2025-09-27');
    expect(windows.at(-1)?.toDate).toBe('2026-09-26');
    for (const [index, window] of windows.entries()) {
      expect(() => buildTboBookingsByDateRequest(window)).not.toThrow();
      const next = windows[index + 1];
      if (next === undefined) continue;
      const gapDays =
        (Date.parse(`${next.fromDate}T00:00:00Z`) - Date.parse(`${window.toDate}T00:00:00Z`)) /
        86_400_000;
      expect(gapDays).toBe(1);
    }
  });

  it('un rango roto o invertido lanza en vez de devolver cero ventanas', () => {
    expect(
      issuesOf(() => splitTboBookingDateRange({ fromDate: '2026-09-26', toDate: '2026-09-25' })),
    ).toEqual(['toDate:before_from_date']);
    expect(
      issuesOf(() => splitTboBookingDateRange({ fromDate: 'hoy', toDate: '2026-09-25' })),
    ).toEqual(['fromDate:invalid_date']);
  });
});
