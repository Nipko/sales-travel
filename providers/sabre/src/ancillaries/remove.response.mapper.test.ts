import { describe, expect, it } from 'vitest';
import { mapSabreAncillaryRemoveResponse } from './remove.response.mapper';
import { SabreAncillaryMappingError, SabreAncillaryRejectedError } from './shop.response.mapper';

/**
 * `AncillaryRemoveResponse` (`stateless-ancillaries-api-1.0.yml:314-325`): un `airExtraId` por
 * servicio quitado. SAB-22: sin test hasta ahora. Las respuestas son las del contrato, con los ids
 * de su `example` ('12', '17').
 */

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('se esperaba una excepción');
}

describe('mapSabreAncillaryRemoveResponse', () => {
  it('cada id devuelto queda quitado; el que no vuelve, sin confirmar (nunca fallido)', () => {
    const mapped = mapSabreAncillaryRemoveResponse({ results: [{ airExtraId: '12' }] }, [
      '12',
      '17',
    ]);
    expect(mapped).toEqual({ removed: ['12'], unverified: ['17'], warnings: [] });
  });

  it('sin `results` nada se da por quitado', () => {
    expect(mapSabreAncillaryRemoveResponse({}, ['12'])).toEqual({
      removed: [],
      unverified: ['12'],
      warnings: [],
    });
  });

  it('un id que no se pidió no entra en lo quitado: queda el aviso', () => {
    const mapped = mapSabreAncillaryRemoveResponse(
      { results: [{ airExtraId: '12' }, { airExtraId: '99' }] },
      ['12'],
    );
    expect(mapped.removed).toEqual(['12']);
    expect(mapped.warnings).toEqual(['remove-result-unrequested']);
  });

  it('avisos del proveedor: se cuentan, no se copian', () => {
    const mapped = mapSabreAncillaryRemoveResponse(
      { results: [{ airExtraId: '12' }], warnings: [{ message: 'algo' }] },
      ['12'],
    );
    expect(mapped.warnings).toEqual(['provider-warning']);
    expect(JSON.stringify(mapped)).not.toContain('algo');
  });

  it('con `errors` el proveedor rechazó: no se afirma nada quitado', () => {
    expect(
      thrown(() =>
        mapSabreAncillaryRemoveResponse(
          { results: [{ airExtraId: '12' }], errors: [{ type: 'X' }] },
          ['12'],
        ),
      ),
    ).toBeInstanceOf(SabreAncillaryRejectedError);
  });

  it('una respuesta con otra forma es un error de lectura, no un «quitado»', () => {
    expect(
      thrown(() => mapSabreAncillaryRemoveResponse({ results: [{ id: '12' }] }, ['12'])),
    ).toBeInstanceOf(SabreAncillaryMappingError);
    expect(thrown(() => mapSabreAncillaryRemoveResponse('nada', ['12']))).toBeInstanceOf(
      SabreAncillaryMappingError,
    );
  });
});
