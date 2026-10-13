import { describe, expect, it } from 'vitest';
import { isNonIdempotentSabrePath } from '../http/sabre-http.client';
import {
  SABRE_ANCILLARIES_SHOP_PATH,
  SabreAncillaryRequestError,
  SabreAncillaryShopRequestSchema,
  buildSabreAncillaryShopRequest,
} from './shop.request.builder';

/**
 * `/shop` por PNR (`stateless-ancillaries-api-1.0.yml:28-46`, modo «for all segments in the PNR»
 * de `help/stateless-ancillaries-api-1.0/1.0-index.txt`). Sólo viaja el localizador.
 */

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('se esperaba una excepción');
}

describe('buildSabreAncillaryShopRequest', () => {
  it('manda sólo el PNR, a /v1/dc/ancillaries/shop', () => {
    expect(buildSabreAncillaryShopRequest({ pnrLocator: 'SXZRGJ' })).toEqual({
      path: '/v1/dc/ancillaries/shop',
      body: { pnrLocator: 'SXZRGJ' },
    });
  });

  it('es una lectura: el cliente HTTP la puede reintentar', () => {
    expect(isNonIdempotentSabrePath(SABRE_ANCILLARIES_SHOP_PATH)).toBe(false);
  });

  it.each([
    ['minúsculas', 'sxzrgj'],
    ['corto', 'ABC12'],
    ['largo (un id de orden NDC)', '1SXXXXXXXXXXX'],
    ['con espacios', 'SXZ RGJ'],
    ['PAN', '4111111111111111'],
  ])('rechaza un localizador %s sin mandarlo y sin citarlo', (_label, pnrLocator) => {
    const error = thrown(() => buildSabreAncillaryShopRequest({ pnrLocator }));
    expect(error).toBeInstanceOf(SabreAncillaryRequestError);
    expect((error as SabreAncillaryRequestError).operation).toBe('shop');
    expect((error as Error).message).not.toContain(pnrLocator);
  });

  it('el esquema es estricto: nada de clientContext, pasajeros ni segmentos', () => {
    for (const extra of [
      { clientContext: { pseudoCityCode: 'ZZZ' } },
      { passengers: [{ id: 'PAX-1', nameNumber: '01.01', givenName: 'TEST MR' }] },
      { segments: [] },
    ]) {
      expect(
        SabreAncillaryShopRequestSchema.safeParse({ pnrLocator: 'SXZRGJ', ...extra }).success,
      ).toBe(false);
    }
  });
});
