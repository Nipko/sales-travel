import { OfferSchema, SegmentSchema } from '@sales-travel/canonical';
import type { OrderCreateOutcome, Passenger } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';

/**
 * Los campos añadidos para Sabre (provider.raw, provider.source, expiresAtSource,
 * operatingFlightNumber) son ADITIVOS Y OPCIONALES. `OfferSchema` es validación de borde real
 * en `search.schemas.ts`: un campo requerido nuevo rechazaría al instante toda oferta que un
 * cliente tenga hoy en pantalla. Estos tests fijan esa promesa.
 */

/** Oferta tal y como la produce hoy el ACL de LATAM: sin ninguno de los campos nuevos. */
const legacyOffer = {
  id: '3f1a1b6c-2b0a-4c3d-9f2e-8a1b2c3d4e5f',
  tenantId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  products: ['flight'],
  provider: { name: 'latam-ndc', offerRef: 'OFFER-123|ITEM-1,ITEM-2' },
  total: { amountMinor: 125000, currency: 'USD' },
  baseFare: { amountMinor: 100000, currency: 'USD' },
  taxes: { amountMinor: 25000, currency: 'USD' },
  fetchedAt: '2026-08-26T14:30:00-05:00',
  expiresAt: '2026-08-26T14:31:30-05:00',
};

const validSegment = {
  carrier: 'AV',
  flightNumber: '6789',
  origin: 'BOG',
  destination: 'LIM',
  departureAt: '2026-09-01T08:00:00-05:00',
  arrivalAt: '2026-09-01T11:20:00-05:00',
  durationMinutes: 200,
  cabin: 'economy',
  bookingClass: 'Y',
};

describe('ProviderRefSchema — campos aditivos para el ACL de Sabre', () => {
  it('sigue aceptando una oferta sin raw ni source (regresión cero)', () => {
    expect(OfferSchema.safeParse(legacyOffer).success).toBe(true);
  });

  it('acepta los tres carriles de contenido de Sabre', () => {
    for (const source of ['ATPCO', 'NDC', 'LCC']) {
      const parsed = OfferSchema.safeParse({
        ...legacyOffer,
        provider: { ...legacyOffer.provider, name: 'sabre', source },
      });
      expect(parsed.success, `source ${source} debería validar`).toBe(true);
    }
  });

  it('rechaza un source que no sea token en mayúsculas', () => {
    for (const source of ['atpco', 'NDC LCC', 'N', '']) {
      const parsed = OfferSchema.safeParse({
        ...legacyOffer,
        provider: { ...legacyOffer.provider, source },
      });
      expect(parsed.success, `source ${JSON.stringify(source)} no debería validar`).toBe(false);
    }
  });

  it('transporta ids crudos anidados: el peor caso de Sabre no cabe en un string', () => {
    // 9 offerItemIds del largo máximo del contrato + un itinerario ATPCO de 16 vuelos:
    // codificado con pipes estilo LATAM son 526 caracteres, el doble del techo de offerRef.
    const offerItemIds = Array.from({ length: 9 }, (_, i) => `dx369rfr7jt8dnd2i0-${i + 1}-1`);
    const flights = Array.from({ length: 16 }, (_, i) => ({
      carrier: 'AV',
      number: String(600 + i),
      origin: 'BOG',
      destination: 'LIM',
    }));

    const parsed = OfferSchema.safeParse({
      ...legacyOffer,
      provider: {
        name: 'sabre',
        offerRef: 'sabre:atpco:3f1a1b6c-2b0a-4c3d-9f2e-8a1b2c3d4e5f',
        source: 'ATPCO',
        raw: { offerId: 'dx369rfr7jt8dnd2i0-1', offerItemIds, flightDetails: { flights } },
      },
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.provider.raw?.['offerItemIds']).toHaveLength(9);
    }
  });

  it('rechaza en raw lo que no sobrevive un JSON.stringify', () => {
    const withDate = OfferSchema.safeParse({
      ...legacyOffer,
      provider: { ...legacyOffer.provider, raw: { fetchedAt: new Date() } },
    });
    expect(withDate.success).toBe(false);

    const withUndefined = OfferSchema.safeParse({
      ...legacyOffer,
      provider: { ...legacyOffer.provider, raw: { offerId: undefined } },
    });
    expect(withUndefined.success).toBe(false);
  });

  it('mantiene el techo de 255 caracteres de offerRef', () => {
    const parsed = OfferSchema.safeParse({
      ...legacyOffer,
      provider: { ...legacyOffer.provider, offerRef: 'x'.repeat(256) },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('OfferSchema.expiresAtSource — procedencia del vencimiento', () => {
  it('acepta los dos orígenes declarables y ninguno más', () => {
    expect(OfferSchema.safeParse({ ...legacyOffer, expiresAtSource: 'provider' }).success).toBe(
      true,
    );
    expect(
      OfferSchema.safeParse({ ...legacyOffer, expiresAtSource: 'platform-policy' }).success,
    ).toBe(true);
    // Una oferta ATPCO no trae timeToLive: su vencimiento es política nuestra o no se declara.
    // Inventar un tercer valor ("aerolínea", "cache") volvería a difuminar esa diferencia.
    expect(OfferSchema.safeParse({ ...legacyOffer, expiresAtSource: 'cache' }).success).toBe(false);
  });

  it('no lo rellena solo: ausente significa no declarado', () => {
    const parsed = OfferSchema.parse(legacyOffer);
    expect(parsed.expiresAtSource).toBeUndefined();
  });
});

describe('SegmentSchema.operatingFlightNumber — dedupe de codeshares', () => {
  it('sigue aceptando un segmento sin el campo', () => {
    expect(SegmentSchema.safeParse(validSegment).success).toBe(true);
  });

  it('acepta el número operado que devuelve Sabre y rechaza basura', () => {
    expect(
      SegmentSchema.safeParse({
        ...validSegment,
        operatingCarrier: 'LA',
        operatingFlightNumber: '576',
      }).success,
    ).toBe(true);
    expect(
      SegmentSchema.safeParse({ ...validSegment, operatingFlightNumber: 'LA576' }).success,
    ).toBe(false);
    expect(SegmentSchema.safeParse({ ...validSegment, operatingFlightNumber: 576 }).success).toBe(
      false,
    );
  });
});

describe('order-create.port — aditivos del puerto de reserva', () => {
  it('providerPaxId y OrderCreateOutcome existen y son opcionales (chequeo de tipos)', () => {
    const passenger: Pick<Passenger, 'paxId' | 'providerPaxId'> = { paxId: 'PAX1' };
    const conProveedor: Pick<Passenger, 'paxId' | 'providerPaxId'> = {
      paxId: 'PAX1',
      providerPaxId: 'dx369rfr7jt8dnd2i0-1-1-1',
    };
    const outcomes: OrderCreateOutcome[] = ['CONFIRMED', 'PARTIAL', 'PENDING', 'FAILED'];

    expect(passenger.providerPaxId).toBeUndefined();
    expect(conProveedor.providerPaxId).toBe('dx369rfr7jt8dnd2i0-1-1-1');
    expect(outcomes).toHaveLength(4);
  });
});
