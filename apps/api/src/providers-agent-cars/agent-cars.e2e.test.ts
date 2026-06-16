/**
 * Harness E2E contra el API REAL de AgentCars (entorno dev).
 *
 * Ejerce el flujo de búsqueda de solo-lectura:
 *   suggest → getRates → getMatrix → getSelection → getRateDetail
 *
 * NO ejecuta confirm/book/cancel/release: nunca crea reservas reales contra el proveedor.
 *
 * Está gateado con `describe.skipIf(!AGENT_CARS_ACCESS_TOKEN)`, por lo que en CI (sin token)
 * la suite completa se SALTA y no rompe el pipeline. Para correrlo localmente:
 *
 *   AGENT_CARS_ACCESS_TOKEN=<token-dev> \
 *   AGENT_CARS_SOURCE=CO \
 *   pnpm --filter @sales-travel/api test agent-cars.e2e
 *
 * Variables de entorno (mismas que la factory BYOC / .env):
 *   AGENT_CARS_ACCESS_TOKEN   (requerido — gatea la suite)
 *   AGENT_CARS_SOURCE         país origen alpha-2 del agente (default: CO)
 *   AGENT_CARS_BASE_URL       override de base URL (default: AGENT_CARS_BASE_URLS.development)
 *   AGENT_CARS_SUGGEST_URL    override del endpoint suggest (default: AGENT_CARS_SUGGEST_URL)
 *   AGENT_CARS_LANGUAGE       idioma ISO (default: es)
 *   AGENT_CARS_E2E_COUNTRY    país destino alpha-2 (default: US)
 *   AGENT_CARS_E2E_PICKUP     ubicación pickup/dropoff (default: MIA)
 */
import {
  AgentCarsAdapter,
  AGENT_CARS_BASE_URLS,
  AGENT_CARS_SUGGEST_URL,
  type AgentCarsConfig,
  type CarOffer,
  type CarSearchQuery,
} from '@sales-travel/agent-cars';
import { describe, expect, it } from 'vitest';

const TOKEN = process.env['AGENT_CARS_ACCESS_TOKEN'];

const cfg: AgentCarsConfig = {
  accessToken: TOKEN ?? '',
  baseUrl: process.env['AGENT_CARS_BASE_URL'] ?? AGENT_CARS_BASE_URLS.development,
  suggestUrl: process.env['AGENT_CARS_SUGGEST_URL'] ?? AGENT_CARS_SUGGEST_URL,
  sourceCountry: process.env['AGENT_CARS_SOURCE'] ?? 'CO',
  language: process.env['AGENT_CARS_LANGUAGE'] ?? 'es',
};

const COUNTRY = process.env['AGENT_CARS_E2E_COUNTRY'] ?? 'US';
const PICKUP = process.env['AGENT_CARS_E2E_PICKUP'] ?? 'MIA';

/** Devuelve `yyyy-mm-dd` para hoy + `days`. Fechas relativas: no caducan con el tiempo. */
function dateInDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isMoney(v: unknown): v is { amountMinor: number; currency: string } {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return typeof m['amountMinor'] === 'number' && typeof m['currency'] === 'string';
}

// Pickup ~30 días en el futuro, dropoff +5 días. Relativo → siempre válido.
const PICKUP_DATE = dateInDays(30);
const DROPOFF_DATE = dateInDays(35);

const baseSearch: CarSearchQuery = {
  pickUpLocation: PICKUP,
  dropOffLocation: PICKUP,
  pickUpDate: PICKUP_DATE,
  dropOffDate: DROPOFF_DATE,
  pickUpHour: '1000',
  dropOffHour: '1000',
  rateType: 'best',
  country: COUNTRY,
  source: cfg.sourceCountry,
};

describe.skipIf(!TOKEN)('AgentCars E2E (API real dev) — flujo de búsqueda read-only', () => {
  const adapter = new AgentCarsAdapter(cfg);

  it('suggest() devuelve CarLocation con iata/countryCode', async () => {
    const results = await adapter.suggest({ query: 'miami', lang: cfg.language });

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);

    const loc = results[0];
    expect(loc).toBeDefined();
    if (!loc) return;
    // countryCode siempre presente (alpha-2); iata sólo en aeropuertos/ciudades con código.
    expect(typeof loc.countryCode).toBe('string');
    expect(loc.countryCode.length).toBeGreaterThan(0);
    expect(typeof loc.value).toBe('string');

    const airportWithIata = results.find((r) => r.airport && r.iata);
    expect(airportWithIata).toBeDefined();
    expect(typeof airportWithIata?.iata).toBe('string');
  });

  it('getRates() devuelve tipos de tarifa con id/name', async () => {
    const rates = await adapter.getRates({
      country: COUNTRY,
      source: cfg.sourceCountry,
      language: cfg.language,
    });

    expect(Array.isArray(rates)).toBe(true);
    for (const r of rates) {
      expect(typeof r.id).toBe('string');
      expect(typeof r.name).toBe('string');
    }
  });

  it('getMatrix() devuelve CarOffer con rateAmount Money y sippCode', async () => {
    const offers = await adapter.getMatrix(baseSearch);

    expect(Array.isArray(offers)).toBe(true);
    expect(offers.length).toBeGreaterThan(0);

    const offer = offers[0];
    expect(offer).toBeDefined();
    if (!offer) return;

    expect(typeof offer.sippCode).toBe('string');
    expect(offer.sippCode.length).toBeGreaterThan(0);
    expect(typeof offer.companyCode).toBe('string');

    // rateAmount/base/tax mapeados a Money canónico { amountMinor, currency }.
    expect(isMoney(offer.rateAmount)).toBe(true);
    expect(isMoney(offer.base)).toBe(true);
    expect(isMoney(offer.tax)).toBe(true);
    expect(offer.rateAmount.amountMinor).toBeGreaterThanOrEqual(0);
    expect(offer.rateAmount.currency.length).toBe(3);

    expect(offer.paymentOption === 'ppd' || offer.paymentOption === 'pod').toBe(true);
  });

  it('getSelection() → getRateDetail(): selección trae uniqid y detalle con base/tax Money', async () => {
    const offers = await adapter.getMatrix(baseSearch);
    // Preferimos una oferta con ccrc (token requerido por GetSelection en la mayoría de tarifas).
    const offer: CarOffer | undefined = offers.find((o) => o.ccrc) ?? offers[0];
    expect(offer).toBeDefined();
    if (!offer) return;

    const selection = await adapter.getSelection({
      ...baseSearch,
      companyCode: offer.companyCode,
      sippCode: offer.sippCode,
      ...(offer.ccrc && { ccrc: offer.ccrc }),
    });

    expect(typeof selection.uniqid).toBe('string');
    expect(selection.uniqid.length).toBeGreaterThan(0);
    expect(selection.sippCode).toBe(offer.sippCode);

    const detail = await adapter.getRateDetail({
      uniqid: selection.uniqid,
      paymentType: offer.paymentOption,
      rateType: baseSearch.rateType,
    });

    expect(isMoney(detail.base)).toBe(true);
    expect(isMoney(detail.tax)).toBe(true);
    expect(Array.isArray(detail.charges)).toBe(true);
  });
});
