import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Money } from '@sales-travel/canonical';
import type { HotelBookingView } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import {
  HOTEL_BOOK_MIN_REMAINING_MS,
  HOTEL_BOOK_VERIFY_DELAY_MS,
  checkBookable,
  closingReadSummary,
  decideAfterBook,
  decideAfterClosingRead,
  decideAfterRevalidation,
  hotelBookHttpStatus,
  hotelBookProviderRaw,
  planBookVerification,
  type HotelBookableFacts,
} from './hotel-booking.saga.js';

/**
 * Las decisiones de la saga de reserva de hotel, sin I/O (docs/tbo/09 PR-4.6; 03 §3.9, §4 y §5;
 * 08 RF-10 CA-2, RF-17, RF-20, RF-22).
 */

const T0 = Date.parse('2026-09-25T15:00:00Z');
const USD = (amountMinor: number): Money => ({ amountMinor, currency: 'USD' });

function hechos(overrides: Partial<HotelBookableFacts> = {}): HotelBookableFacts {
  return {
    now: T0,
    expiresAt: T0 + 20 * 60_000,
    signals: [],
    atPropertyCharges: 0,
    atPropertyAcknowledged: false,
    acceptedTotal: USD(32_134),
    shownTotal: USD(32_134),
    ...overrides,
  };
}

describe('checkBookable: lo que se rechaza antes de abrir la orden', () => {
  it('una tarifa vigente, sin cargos en el hotel y con el precio mostrado se reserva', () => {
    expect(checkBookable(hechos())).toBeUndefined();
  });

  it('RF-09: sin margen para la revalidación la ventana ya está vencida', () => {
    expect(checkBookable(hechos({ expiresAt: T0 + HOTEL_BOOK_MIN_REMAINING_MS - 1 }))).toBe(
      'PREBOOK_EXPIRED',
    );
    expect(checkBookable(hechos({ expiresAt: T0 + HOTEL_BOOK_MIN_REMAINING_MS }))).toBeUndefined();
  });

  it('RF-17 con D-TBO-22 A: la tarifa sólo paquete no se vende suelta', () => {
    expect(checkBookable(hechos({ signals: ['NO_NAME_CHANGE', 'PACKAGE_WITH_FLIGHT_ONLY'] }))).toBe(
      'PACKAGE_ONLY_RATE',
    );
    expect(checkBookable(hechos({ signals: ['NO_NAME_CHANGE'] }))).toBeUndefined();
  });

  it('RF-10 CA-2: con cargos en el hotel hace falta el reconocimiento explícito', () => {
    expect(checkBookable(hechos({ atPropertyCharges: 2 }))).toBe('AT_PROPERTY_NOT_ACKNOWLEDGED');
    expect(
      checkBookable(hechos({ atPropertyCharges: 2, atPropertyAcknowledged: true })),
    ).toBeUndefined();
  });

  it.each([
    ['más bajo', USD(30_000)],
    ['más alto (una subida hasta ahí pasaría sin aceptarla)', USD(99_999)],
    ['en otra moneda', { amountMinor: 32_134, currency: 'EUR' }],
  ])('el precio aceptado tiene que ser EXACTAMENTE el mostrado: %s → rechazo', (_c, aceptado) => {
    expect(checkBookable(hechos({ acceptedTotal: aceptado }))).toBe('ACCEPTED_TOTAL_MISMATCH');
  });

  it('el vencimiento gana a todo lo demás: nada de eso se puede corregir sin volver a revalidar', () => {
    expect(
      checkBookable(
        hechos({
          expiresAt: T0,
          signals: ['PACKAGE_WITH_FLIGHT_ONLY'],
          atPropertyCharges: 1,
          acceptedTotal: USD(1),
        }),
      ),
    ).toBe('PREBOOK_EXPIRED');
  });
});

describe('decideAfterRevalidation (C2): el precio de VENTA contra el aceptado', () => {
  const base = {
    outcome: 'UNCHANGED' as const,
    signals: [],
    acceptedTotal: USD(32_134),
    revalidatedTotal: USD(32_134),
  };

  it('igual → se reserva sin aviso', () => {
    expect(decideAfterRevalidation(base)).toEqual({ kind: 'proceed', priceDecreased: false });
  });

  it('D-TBO-20 A: si baja, se reserva con el precio nuevo y se avisa', () => {
    expect(
      decideAfterRevalidation({ ...base, outcome: 'DECREASED', revalidatedTotal: USD(31_000) }),
    ).toEqual({ kind: 'proceed', priceDecreased: true });
  });

  it('RF-20: si sube, 409 aunque el neto no haya cambiado (subió el markup)', () => {
    expect(decideAfterRevalidation({ ...base, revalidatedTotal: USD(32_135) })).toEqual({
      kind: 'reject',
      reason: 'PRICE_INCREASED',
    });
  });

  it('un neto que sube sin mover el precio de venta (el piso lo absorbe) no pide reconfirmar', () => {
    expect(decideAfterRevalidation({ ...base, outcome: 'INCREASED' })).toEqual({
      kind: 'proceed',
      priceDecreased: false,
    });
  });

  it('03 §2.9 regla 2: si cambian precio y condiciones, prevalecen las condiciones', () => {
    expect(
      decideAfterRevalidation({
        ...base,
        outcome: 'CONDITIONS_CHANGED',
        revalidatedTotal: USD(40_000),
      }),
    ).toEqual({ kind: 'reject', reason: 'CONDITIONS_CHANGED' });
  });

  it('otra moneda no es un precio más bajo: son otras condiciones', () => {
    expect(
      decideAfterRevalidation({ ...base, revalidatedTotal: { amountMinor: 1, currency: 'EUR' } }),
    ).toEqual({ kind: 'reject', reason: 'CONDITIONS_CHANGED' });
  });

  it('RF-17: la marca de sólo paquete aparecida en C2 corta antes que cualquier otra cosa', () => {
    expect(
      decideAfterRevalidation({
        ...base,
        outcome: 'CONDITIONS_CHANGED',
        signals: ['PACKAGE_WITH_FLIGHT_ONLY'],
      }),
    ).toEqual({ kind: 'reject', reason: 'PACKAGE_ONLY_RATE' });
  });
});

describe('decideAfterBook: una excepción no es un FAILED (03 §3.9)', () => {
  it('confirmado con localizador → confirmed', () => {
    expect(
      decideAfterBook({
        kind: 'answered',
        reason: 'confirmed',
        result: { outcome: 'CONFIRMED', providerBookingId: ' FL1IMA ', warnings: [] },
      }),
    ).toEqual({ kind: 'confirmed', providerBookingId: 'FL1IMA', reason: 'confirmed' });
  });

  it.each([
    ['sin localizador', undefined],
    ['con un localizador en blanco', '   '],
  ])('"confirmado" %s no se puede leer ni cancelar: incierto', (_c, providerBookingId) => {
    expect(
      decideAfterBook({
        kind: 'answered',
        reason: 'confirmed',
        result: {
          outcome: 'CONFIRMED',
          ...(providerBookingId === undefined ? {} : { providerBookingId }),
          providerStatus: '200',
          warnings: [],
        },
      }),
    ).toEqual({ kind: 'uncertain', reason: 'missing-confirmation-number', providerStatus: '200' });
  });

  it('el motivo del proveedor se conserva si no era `confirmed`', () => {
    expect(
      decideAfterBook({
        kind: 'answered',
        reason: 'client-reference-mismatch',
        result: { outcome: 'CONFIRMED', warnings: [] },
      }),
    ).toEqual({ kind: 'uncertain', reason: 'client-reference-mismatch' });
  });

  it.each(['PENDING', 'UNCERTAIN'] as const)('respondido %s → incierto', (outcome) => {
    expect(
      decideAfterBook({
        kind: 'answered',
        reason: 'missing-confirmation-number',
        result: { outcome, warnings: [] },
      }),
    ).toEqual({ kind: 'uncertain', reason: 'missing-confirmation-number' });
  });

  it('respondido FAILED por un proveedor que no lanza → failed', () => {
    expect(
      decideAfterBook({
        kind: 'answered',
        reason: 'rate-unavailable',
        result: { outcome: 'FAILED', providerStatus: '207', warnings: [] },
      }),
    ).toEqual({ kind: 'failed', reason: 'rate-unavailable', providerStatus: '207' });
  });

  it('lanzó un rechazo del proveedor → failed, con su código', () => {
    expect(
      decideAfterBook({
        kind: 'threw',
        failure: {
          outcome: 'FAILED',
          reason: 'rate-unavailable',
          dispatched: true,
          providerStatus: '207',
        },
      }),
    ).toEqual({ kind: 'failed', reason: 'rate-unavailable', providerStatus: '207' });
    expect(
      decideAfterBook({
        kind: 'threw',
        failure: { outcome: 'FAILED', reason: 'invalid-request', dispatched: true },
      }),
    ).toEqual({ kind: 'failed', reason: 'invalid-request' });
  });

  it('RF-20 CA-4: lanzó sin haber enviado nada → not-dispatched', () => {
    expect(
      decideAfterBook({
        kind: 'threw',
        failure: { outcome: 'FAILED', reason: 'not-dispatched', dispatched: false },
      }),
    ).toEqual({ kind: 'not-dispatched', reason: 'not-dispatched' });
  });

  it('RF-20 CA-3: timeout, red o un código que no prueba nada → incierto', () => {
    expect(
      decideAfterBook({
        kind: 'threw',
        failure: { outcome: 'UNCERTAIN', reason: 'timeout', dispatched: true },
      }),
    ).toEqual({ kind: 'uncertain', reason: 'timeout' });
    expect(
      decideAfterBook({
        kind: 'threw',
        failure: {
          outcome: 'UNCERTAIN',
          reason: 'booking-failed',
          dispatched: true,
          providerStatus: '405',
        },
      }),
    ).toEqual({ kind: 'uncertain', reason: 'booking-failed', providerStatus: '405' });
  });
});

describe('planBookVerification (RF-21): 120 s desde el fallo observado', () => {
  it('la primera lectura es a `tf + 120 s`, no antes', () => {
    expect(HOTEL_BOOK_VERIFY_DELAY_MS).toBe(120_000);
    expect(planBookVerification(T0)).toEqual({ verifyAt: T0 + 120_000 });
  });
});

describe('decideAfterClosingRead: la lectura de cierre por el localizador', () => {
  const vista = (overrides: Partial<HotelBookingView>): HotelBookingView => ({
    found: true,
    warnings: [],
    ...overrides,
  });

  it('confirmada → settled', () => {
    expect(decideAfterClosingRead(vista({ status: 'CONFIRMED' }))).toEqual({
      kind: 'settled',
      status: 'confirmed',
    });
  });

  it('la lectura falló → sigue confirmada y se escala', () => {
    expect(decideAfterClosingRead(null)).toEqual({
      kind: 'escalate',
      reason: 'verification-unavailable',
      status: 'confirmed',
    });
  });

  it.each([
    [vista({ found: false }), 'verified-not-found'],
    [vista({ status: 'CANCELLED' }), 'verified-cancelled-upstream'],
    [vista({ status: 'CANCELLATION_IN_PROGRESS' }), 'verified-cancelled-upstream'],
    [vista({ status: 'UNKNOWN' }), 'verified-status-unexpected'],
    [vista({ status: 'PENDING' }), 'verified-status-unexpected'],
    [vista({}), 'verified-status-unexpected'],
  ])(
    'una contradicción del proveedor no se muestra confirmada: vuelve a pending (%#)',
    (v, reason) => {
      expect(decideAfterClosingRead(v)).toEqual({ kind: 'escalate', reason, status: 'pending' });
    },
  );

  it('el resumen para el evento cuenta los avisos y no los copia', () => {
    expect(closingReadSummary(null)).toEqual({ verified: false, reason: 'read-failed' });
    expect(
      closingReadSummary(vista({ status: 'CONFIRMED', warnings: ['texto libre del proveedor'] })),
    ).toEqual({ verified: true, found: true, status: 'CONFIRMED', warnings: 1 });
    expect(closingReadSummary(vista({ found: false }))).toEqual({
      verified: true,
      found: false,
      warnings: 0,
    });
  });
});

describe('RF-22: 201 con un estado final, 202 si sigue o se verifica', () => {
  it.each([
    [undefined, 202],
    ['pending', 202],
    ['confirmed', 201],
    ['failed', 201],
    ['cancelled', 201],
  ] as const)('%s → %s', (status, http) => {
    expect(hotelBookHttpStatus(status)).toBe(http);
  });
});

describe('provider_raw de una reserva de hotel: lista blanca de escalares', () => {
  it('sólo la vertical, la referencia, el motivo y el código', () => {
    expect(
      hotelBookProviderRaw({
        bookingReference: 'STT0',
        reason: 'rate-unavailable',
        providerStatus: '207',
      }),
    ).toEqual({
      vertical: 'hotels',
      bookingReference: 'STT0',
      reason: 'rate-unavailable',
      providerStatus: '207',
    });
    expect(hotelBookProviderRaw({ bookingReference: 'STT0', reason: 'confirmed' })).toEqual({
      vertical: 'hotels',
      bookingReference: 'STT0',
      reason: 'confirmed',
    });
  });
});

describe('D9: la saga es pura', () => {
  it('sólo importa tipos: ni Nest, ni la base, ni la cola, ni un proveedor', () => {
    const fuente = readFileSync(join(__dirname, 'hotel-booking.saga.ts'), 'utf8');
    const imports = fuente.split('\n').filter((line) => /^import\b/.test(line));

    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line).toMatch(/^import type\b/);
  });
});
