import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { OfferSchema } from '@sales-travel/canonical';
import type { FlightSearchCriteria } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import { mapAirShoppingResponse } from './airshopping/response.mapper';
import { parseLatamXml } from './http/latam-http.client';
import { mapOfferPriceResponse } from './offerprice/response.mapper';
import { mapOrderCreateResponse } from './ordercreate/response.mapper';
import { mapOrderCancelResponse, mapOrderRetrieveResponse } from './ordermanage/response.mappers';

/**
 * LAT-08 (docs/qa/01): el mapeo contra respuestas REALES del sandbox de LATAM, grabadas con
 * tools/latam/capture.mjs (GRU → GIG, 1 adulto, BRL, sin pago) y redactadas: sin credenciales,
 * nombres, documentos, correos ni teléfonos. Una venta completa: búsqueda, revalidación, reserva
 * BNPL, relectura y cancelación; más un rechazo real de la creación.
 */
const DIR = join(__dirname, '__fixtures__', 'real');
const TENANT = '00000000-0000-4000-8000-000000000001';
const leer = (name: string): unknown =>
  parseLatamXml(
    name.endsWith('.gz')
      ? gunzipSync(readFileSync(join(DIR, name))).toString('utf8')
      : readFileSync(join(DIR, name), 'utf8'),
  );

const criteria: FlightSearchCriteria = {
  origin: 'GRU',
  destination: 'GIG',
  departureDate: '2027-01-06',
  paxCount: { adults: 1, children: 0, infants: 0 },
  currency: 'BRL',
};

describe('LATAM NDC con respuestas reales del sandbox (LAT-08)', () => {
  const { offers } = mapAirShoppingResponse(leer('01-airshopping-200.xml.gz'), criteria, TENANT);

  it('AirShopping: muchas ofertas, todas canónicas válidas, en BRL y de GRU a GIG', () => {
    expect(offers.length).toBeGreaterThan(50);
    for (const o of offers) {
      expect(OfferSchema.safeParse(o).success, o.provider.offerRef).toBe(true);
      expect(o.total.currency).toBe('BRL');
      const segs = o.itineraries?.[0]?.segments ?? [];
      expect(segs[0]?.origin).toBe('GRU');
      expect(segs[segs.length - 1]?.destination).toBe('GIG');
      expect(o.total.amountMinor).toBe(
        o.baseFare.amountMinor + o.taxes.amountMinor + (o.fees?.amountMinor ?? 0),
      );
    }
  });

  it('OfferPrice: revalida la primera oferta sin cambio de precio', () => {
    const priced = mapOfferPriceResponse(leer('02-offerPrice-200.xml'), offers[0]!);
    expect(priced.priceChanged).toBe(false);
    expect(priced.offer.total.currency).toBe('BRL');
    expect(OfferSchema.safeParse(priced.offer).success).toBe(true);
  });

  it('OrderCreate: reserva confirmada con localizador, sin incidencias', () => {
    const created = mapOrderCreateResponse(leer('03-order-create-200.xml'));
    expect(created.outcome).toBe('CONFIRMED');
    expect(created.orderId).toBeTruthy();
    // `pnr` lleva el OrderID a propósito (la llave de la postventa); el localizador de 6 letras
    // sale en la relectura como airlineLocators (ordercreate/response.mapper.ts).
    expect(created.pnr).toBe(created.orderId);
    expect(created.issues.filter((i) => i.severity === 'ERROR')).toEqual([]);
  });

  it('OrderRetrieve: la misma orden, confirmada', () => {
    const created = mapOrderCreateResponse(leer('03-order-create-200.xml'));
    const view = mapOrderRetrieveResponse(leer('04-order-retrieve-200.xml'));
    expect(view.found).toBe(true);
    expect(view.status).toBe('confirmed');
    expect(view.orderId).toBe(created.orderId);
    expect(view.airlineLocators.map((l) => l.locator)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^[A-Z0-9]{6}$/)]),
    );
  });

  it('cancelación BNPL: éxito', () => {
    expect(mapOrderCancelResponse(leer('05-order-cancel-bnpl-200.xml')).success).toBe(true);
  });

  it('un rechazo real de la creación (400112020) sale como FAILED con su código', () => {
    const r = mapOrderCreateResponse(leer('90-order-create-400-pax-id.xml'));
    expect(r.outcome).toBe('FAILED');
    expect(r.issues.map((i) => i.type)).toContain('400112020');
  });

  it('las fixtures no traen datos personales ni de la agencia', () => {
    for (const f of [
      '02-offerPrice-200.xml',
      '03-order-create-200.xml',
      '04-order-retrieve-200.xml',
    ]) {
      const text = readFileSync(join(DIR, f), 'utf8');
      expect(text, f).not.toMatch(/PRUEBA|SANDBOX|pasajero-sandbox|3001234567|AB1234567/);
    }
  });
});
