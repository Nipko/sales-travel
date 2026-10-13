import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifySabreEnvelope } from '../errors';
import { isNonIdempotentSabrePath } from '../http/sabre-http.client';
import {
  SABRE_ANCILLARIES_REMOVE_PATH,
  SABRE_ANCILLARY_MAX_REMOVALS,
  SabreAncillaryRemoveRequestSchema,
  buildSabreAncillaryRemoveRequest,
} from './remove.request.builder';
import { mapSabreAncillaryRemoveResponse } from './remove.response.mapper';
import { SabreAncillaryRequestError } from './shop.request.builder';
import { SabreAncillaryMappingError, SabreAncillaryRejectedError } from './shop.response.mapper';

/**
 * `/remove` (`stateless-ancillaries-api-1.0.yml:66-84`, `:219-242` y `:314-325`). Los cuerpos son
 * los dos ejemplos de la ayuda («Remove single ancillary» y «Remove Multiple Ancillaries»,
 * `help/stateless-ancillaries-api-1.0/1.0-index.txt`) más el commit explícito; la respuesta,
 * `stateless-ancillaries-remove-200.derived.json`, sale del `example` de `RemovedAncillaryItem`.
 */

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('se esperaba una excepción');
}

describe('buildSabreAncillaryRemoveRequest', () => {
  it('los dos ejemplos de la ayuda, con commit explícito', () => {
    expect(buildSabreAncillaryRemoveRequest({ pnrLocator: 'SXZRGJ', airExtraIds: ['11'] })).toEqual(
      {
        path: '/v1/dc/ancillaries/remove',
        body: { pnrLocator: 'SXZRGJ', isCommitEnabled: true, airExtraIds: ['11'] },
      },
    );
    expect(
      buildSabreAncillaryRemoveRequest({ pnrLocator: 'SXZRGJ', airExtraIds: ['11', '13'] }).body
        .airExtraIds,
    ).toEqual(['11', '13']);
  });

  it('escribe en la reserva: nunca se reintenta', () => {
    expect(isNonIdempotentSabrePath(SABRE_ANCILLARIES_REMOVE_PATH)).toBe(true);
  });

  it('no es la ruta de Manage Ancillary: aquí un cuerpo vacío NO es éxito', () => {
    expect(SABRE_ANCILLARIES_REMOVE_PATH).not.toBe('/v1/ancillaries/remove');
    expect(classifySabreEnvelope({}, { path: SABRE_ANCILLARIES_REMOVE_PATH }).ok).toBe(false);
    // La excepción del contrato de Manage Ancillary sigue en su sitio, y sólo allí.
    expect(classifySabreEnvelope({}, { path: '/v1/ancillaries/remove' }).ok).toBe(true);
  });

  it.each([
    ['vacío', []],
    ['repetido', ['11', '11']],
    ['con forma de PAN', ['4111111111111111']],
    ['con espacios', ['1 1']],
    ['demasiados', Array.from({ length: SABRE_ANCILLARY_MAX_REMOVALS + 1 }, (_, i) => String(i))],
  ])('rechaza un airExtraIds %s sin mandarlo', (_label, airExtraIds) => {
    const error = thrown(() =>
      buildSabreAncillaryRemoveRequest({ pnrLocator: 'SXZRGJ', airExtraIds }),
    );
    expect(error).toBeInstanceOf(SabreAncillaryRequestError);
    expect((error as SabreAncillaryRequestError).operation).toBe('remove');
    expect((error as Error).message).not.toContain('4111111111111111');
  });

  it('rechaza un PNR inválido', () => {
    expect(
      thrown(() => buildSabreAncillaryRemoveRequest({ pnrLocator: 'abc', airExtraIds: ['11'] })),
    ).toBeInstanceOf(SabreAncillaryRequestError);
  });

  it('el esquema es estricto y exige el commit', () => {
    const base = { pnrLocator: 'SXZRGJ', isCommitEnabled: true, airExtraIds: ['11'] };
    expect(SabreAncillaryRemoveRequestSchema.safeParse(base).success).toBe(true);
    expect(
      SabreAncillaryRemoveRequestSchema.safeParse({ ...base, isCommitEnabled: false }).success,
    ).toBe(false);
    expect(
      SabreAncillaryRemoveRequestSchema.safeParse({
        ...base,
        clientContext: { pseudoCityCode: 'ZZZ' },
      }).success,
    ).toBe(false);
  });
});

describe('mapSabreAncillaryRemoveResponse', () => {
  const fixture = (): unknown =>
    JSON.parse(
      readFileSync(
        join(__dirname, '..', '__fixtures__', 'stateless-ancillaries-remove-200.derived.json'),
        'utf8',
      ),
    ) as unknown;

  it('los ids que vuelven se quitaron', () => {
    expect(mapSabreAncillaryRemoveResponse(fixture(), ['12', '17'])).toEqual({
      removed: ['12', '17'],
      unverified: [],
      warnings: [],
    });
  });

  it('un id pedido que no vuelve queda sin confirmar; uno que no se pidió se ignora', () => {
    expect(mapSabreAncillaryRemoveResponse(fixture(), ['12', '30'])).toEqual({
      removed: ['12'],
      unverified: ['30'],
      warnings: ['remove-result-unrequested'],
    });
  });

  it('sin results nada se da por quitado', () => {
    expect(mapSabreAncillaryRemoveResponse({ warnings: [{}] }, ['12'])).toEqual({
      removed: [],
      unverified: ['12'],
      warnings: ['provider-warning'],
    });
  });

  it('errors[] es un rechazo y una forma rota un error de contrato', () => {
    expect(thrown(() => mapSabreAncillaryRemoveResponse({ errors: [{}] }, ['12']))).toBeInstanceOf(
      SabreAncillaryRejectedError,
    );
    expect(
      thrown(() => mapSabreAncillaryRemoveResponse({ results: [{ airExtraId: 12 }] }, ['12'])),
    ).toBeInstanceOf(SabreAncillaryMappingError);
  });
});
