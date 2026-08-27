import { OfferSchema, type Offer } from '@sales-travel/canonical';
import type { FlightSearchCriteria, SearchContext } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import adultFixture from '../__fixtures__/v5-roundtrip-adult-200.json';
import type { SabreFetch, SabreTokenProvider } from '../auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from '../config';
import { SabreFlightSearchAdapter } from '../sabre-flight-search.adapter';
import { SABRE_SHOP_PATH } from './request.builder';
import { mapSabreShopResponse } from './response.mapper';

/**
 * La moneda, de punta a punta: lo que SALE al cable y lo que se acepta de VUELTA.
 *
 * En producción convivían `BRL 1.286` y `$ 859.100` en la misma lista de resultados. Las dos
 * mitades del arreglo se prueban acá porque cualquiera de ellas sola deja el fallo vivo:
 *
 * - Pedir bien sin defenderse ⇒ el proveedor ignora la petición y la tarifa ajena llega igual.
 *   Es EXACTAMENTE lo que hace el ejemplo oficial de Sabre: se le pide COP y devuelve USD.
 * - Defenderse sin pedir bien ⇒ se descarta todo y la agencia se queda sin vuelos.
 *
 * El cuerpo se afirma sobre el JSON **serializado que recibe `fetch`**, no sobre lo que devuelve
 * el builder: entre el builder y el cable hay un cliente HTTP, y un test contra el objeto no ve
 * lo que ese cliente haga con él.
 */

const TENANT_ID = '11111111-2222-4333-8444-555555555555';
const FETCHED_AT = '2026-08-26T12:00:00.000Z';
const NOW_MS = Date.parse(FETCHED_AT);

/** La moneda del ejemplo oficial de respuesta de BFM v5 (`v5.yml:139-591`). */
const MONEDA_DEL_FIXTURE = 'USD';

const fakeTokens: SabreTokenProvider = {
  getToken: () => Promise.resolve('ATK-SUPERSECRETO'),
  invalidate: () => Promise.resolve(),
};

/** `ZZZZ` es el PCC falso del criterio de salida §6.4: ningún PCC de tercero vive en el código. */
function config(): SabreConfig {
  return {
    host: SABRE_HOSTS.cert.rest,
    epr: '500001',
    homePcc: 'ZZZZ',
    password: 'Pa55w0rd!',
    conversationIdPrefix: 'sales-travel',
  };
}

function criteria(currency: string): FlightSearchCriteria {
  return {
    origin: 'BOG',
    destination: 'LIM',
    departureDate: '2026-09-11',
    returnDate: '2026-09-18',
    paxCount: { adults: 1, children: 0, infants: 0 },
    currency,
  };
}

const CTX: SearchContext = { tenantId: TENANT_ID };

interface Cable {
  buscar: (currency: string) => Promise<Offer[]>;
  /** Cuerpos tal como los recibió `fetch`, ya serializados. */
  cuerpos: string[];
}

function cable(): Cable {
  const cuerpos: string[] = [];
  const fetch: SabreFetch = (url, init) => {
    const body = init?.body;
    if (url.includes(SABRE_SHOP_PATH) && typeof body === 'string') cuerpos.push(body);
    return Promise.resolve(new Response(JSON.stringify(adultFixture), { status: 200 }));
  };
  const adapter = new SabreFlightSearchAdapter(config(), {
    tokens: fakeTokens,
    now: () => NOW_MS,
    uuid: () => 'conv-fijo',
    sleep: () => Promise.resolve(),
    jitter: () => 0,
    fetch,
    // Este guard es sobre la MONEDA. Las marcas se apagan a propósito: con ellas encendidas, una
    // respuesta que el mapper deja en cero —que es justo lo que pasa acá, porque el fixture está
    // en USD y se pide COP— dispara el reintento sin marcas del adapter y salen dos cuerpos. El
    // reintento es correcto; mezclarlo aquí convertiría este test en uno de otra cosa.
    shopOptions: { brandedUpsells: false },
  });
  return { cuerpos, buscar: (currency) => adapter.search(criteria(currency), CTX) };
}

/** El `CurrencyCode` que de verdad viajó, leído del JSON del cable. */
function currencyCodeDelCable(body: string): unknown {
  const parsed: unknown = JSON.parse(body);
  const rq = (parsed as Record<string, Record<string, Record<string, Record<string, unknown>>>>)[
    'OTA_AirLowFareSearchRQ'
  ];
  return rq?.['TravelerInfoSummary']?.['PriceRequestInformation']?.['CurrencyCode'];
}

// ---------------------------------------------------------------------------
// (a) PEDIR: la moneda del tenant sale al cable
// ---------------------------------------------------------------------------

describe('el cuerpo que sale al cable lleva la moneda del tenant', () => {
  it.each([['COP'], ['BRL'], ['PEN'], ['USD']])(
    '%s viaja en PriceRequestInformation.CurrencyCode',
    async (moneda) => {
      const c = cable();
      await c.buscar(moneda);

      expect(c.cuerpos).toHaveLength(1);
      expect(currencyCodeDelCable(c.cuerpos[0] ?? '')).toBe(moneda);
    },
  );

  it('dos tenants con monedas distintas mandan cuerpos distintos', async () => {
    // Sin esto, una moneda "pegada" (constante, o la del primer tenant cacheada en algún sitio)
    // pasaría el test de arriba y seguiría cotizándole a toda la red en la misma unidad.
    const c = cable();
    await c.buscar('COP');
    await c.buscar('BRL');

    expect(c.cuerpos.map((b) => currencyCodeDelCable(b))).toEqual(['COP', 'BRL']);
  });
});

// ---------------------------------------------------------------------------
// (b) DEFENDERSE: lo que vuelve en otra moneda no sale del ACL
// ---------------------------------------------------------------------------

describe('una respuesta en otra moneda no acaba en la lista', () => {
  it('se le pide COP, el ejemplo oficial devuelve USD, y el adapter no entrega nada', async () => {
    // Este es el fallo de producción reproducido: pedir y que te ignoren. Antes de la puerta,
    // esa oferta en USD salía del adapter y aterrizaba junto a las de COP.
    const c = cable();
    const offers = await c.buscar('COP');

    expect(currencyCodeDelCable(c.cuerpos[0] ?? '')).toBe('COP');
    expect(offers).toEqual([]);
  });

  it('se le pide la moneda que el ejemplo devuelve y las ofertas pasan enteras', async () => {
    const offers = await cable().buscar(MONEDA_DEL_FIXTURE);

    expect(offers.length).toBeGreaterThan(0);
    for (const offer of offers) {
      expect(offer.total.currency).toBe(MONEDA_DEL_FIXTURE);
      expect(OfferSchema.safeParse(offer).success).toBe(true);
    }
  });

  it('el descarte deja rastro: warning `currency-mismatch` con las dos monedas', () => {
    // Descartar en silencio sería el mismo fallo con otra cara: nadie podría distinguir
    // "Sabre no tiene vuelos" de "Sabre los tiene y te los estamos escondiendo".
    const result = mapSabreShopResponse(structuredClone(adultFixture), {
      tenantId: TENANT_ID,
      fetchedAt: FETCHED_AT,
      currency: 'COP',
    });

    expect(result.offers).toEqual([]);
    const mismatch = result.warnings.filter((w) => w.code === 'currency-mismatch');
    expect(mismatch.length).toBeGreaterThan(0);
    expect(mismatch[0]?.detail).toBe(`COP!=${MONEDA_DEL_FIXTURE}`);
    expect(mismatch[0]?.path).toMatch(/^itineraryGroups\[\d+]\.itineraries\[\d+]/);
  });

  it('la comparación no distingue mayúsculas ni espacios de la moneda pedida', () => {
    // `tenants.default_currency` es CHAR(3): Postgres la devuelve rellena con espacios.
    const result = mapSabreShopResponse(structuredClone(adultFixture), {
      tenantId: TENANT_ID,
      fetchedAt: FETCHED_AT,
      currency: ' usd ',
    });

    expect(result.offers.length).toBeGreaterThan(0);
    expect(result.warnings.filter((w) => w.code === 'currency-mismatch')).toEqual([]);
  });

  it('sin moneda declarada el mapper no filtra: no hay referencia contra la que comparar', () => {
    const result = mapSabreShopResponse(structuredClone(adultFixture), {
      tenantId: TENANT_ID,
      fetchedAt: FETCHED_AT,
    });

    expect(result.offers.length).toBeGreaterThan(0);
    expect(result.warnings.filter((w) => w.code === 'currency-mismatch')).toEqual([]);
  });
});
