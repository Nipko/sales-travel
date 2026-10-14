import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SabreAncillarySentLine } from './add.request.builder';
import { mapSabreAncillaryAddResponse } from './add.response.mapper';
import { SabreAncillaryMappingError, SabreAncillaryRejectedError } from './shop.response.mapper';

/**
 * `AncillaryAddResponse` (`stateless-ancillaries-api-1.0.yml:302-313`, `AddedAncillaryItem`
 * `:697-716`). El fixture `stateless-ancillaries-add-200.derived.json` es el `example` de cada
 * propiedad: `ancillaryId: 'ancillary_ancillary_1'`, `airExtraIds: ['12', '17']`.
 */

const SENT: readonly SabreAncillarySentLine[] = [
  { serviceOfferItemId: 'SA1.a.b', passengerIndex: 0, ancillaryId: 'ancillary_ancillary_1' },
  { serviceOfferItemId: 'SA1.a.b', passengerIndex: 1, ancillaryId: 'ancillary_ancillary_1' },
  { serviceOfferItemId: 'SA1.c.d', passengerIndex: 0, ancillaryId: 'ancillary_ancillary_2' },
];

function fixture(): unknown {
  return JSON.parse(
    readFileSync(
      join(__dirname, '..', '__fixtures__', 'stateless-ancillaries-add-200.derived.json'),
      'utf8',
    ),
  ) as unknown;
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('se esperaba una excepción');
}

describe('mapSabreAncillaryAddResponse', () => {
  it('el servicio confirmado queda agregado con sus airExtraIds; el que no vuelve, sin confirmar', () => {
    const mapped = mapSabreAncillaryAddResponse(fixture(), SENT);
    expect(mapped.added).toEqual([
      { ...SENT[0], airExtraIds: ['12', '17'], airExtraIdsShared: true },
      { ...SENT[1], airExtraIds: ['12', '17'], airExtraIdsShared: true },
    ]);
    expect(mapped.unverified).toEqual([SENT[2]]);
    expect(mapped.warnings).toEqual([]);
  });

  it('una sola línea por servicio: los ids son sólo suyos', () => {
    const mapped = mapSabreAncillaryAddResponse(
      { results: [{ ancillaryId: 'ancillary_ancillary_2', airExtraIds: ['21'] }] },
      [SENT[2]!],
    );
    expect(mapped.added).toEqual([{ ...SENT[2], airExtraIds: ['21'], airExtraIdsShared: false }]);
  });

  it('la misma definición en dos ítems (ida y vuelta) también comparte ids', () => {
    const outbound: SabreAncillarySentLine = {
      serviceOfferItemId: 'SA1.ida.x',
      passengerIndex: 0,
      ancillaryId: 'ancillary_ancillary_1',
    };
    const inbound: SabreAncillarySentLine = { ...outbound, serviceOfferItemId: 'SA1.vuelta.x' };
    const mapped = mapSabreAncillaryAddResponse(fixture(), [outbound, inbound]);
    expect(mapped.added.map((line) => line.airExtraIdsShared)).toEqual([true, true]);
  });

  it('menos airExtraIds que líneas: alguna no quedó, y todas las del servicio quedan en duda', () => {
    const mapped = mapSabreAncillaryAddResponse(
      {
        results: [
          { ancillaryId: 'ancillary_ancillary_1', airExtraIds: ['12'] },
          { ancillaryId: 'ancillary_ancillary_2', airExtraIds: ['21'] },
        ],
      },
      SENT,
    );
    expect(mapped.unverified).toEqual([SENT[0], SENT[1]]);
    expect(mapped.added).toEqual([{ ...SENT[2], airExtraIds: ['21'], airExtraIdsShared: false }]);
    expect(mapped.warnings).toEqual(['add-result-incomplete']);
  });

  it('el mismo servicio en dos results suma sus ids sin repetirlos', () => {
    const mapped = mapSabreAncillaryAddResponse(
      {
        results: [
          { ancillaryId: 'ancillary_ancillary_1', airExtraIds: ['12'] },
          { ancillaryId: 'ancillary_ancillary_1', airExtraIds: ['12', '17'] },
        ],
      },
      SENT.slice(0, 2),
    );
    expect(mapped.added.map((line) => line.airExtraIds)).toEqual([
      ['12', '17'],
      ['12', '17'],
    ]);
    expect(mapped.unverified).toEqual([]);
  });

  it('sin results nada se da por agregado', () => {
    const mapped = mapSabreAncillaryAddResponse({ warnings: [{ category: 'X', type: 'Y' }] }, SENT);
    expect(mapped.added).toEqual([]);
    expect(mapped.unverified).toEqual(SENT);
    expect(mapped.warnings).toEqual(['provider-warning']);
  });

  it('confirmado sin airExtraIds: agregado, y se avisa de que hay que leerlos de la orden', () => {
    const mapped = mapSabreAncillaryAddResponse(
      { results: [{ ancillaryId: 'ancillary_ancillary_2' }] },
      SENT,
    );
    expect(mapped.added).toEqual([{ ...SENT[2], airExtraIds: [], airExtraIdsShared: false }]);
    expect(mapped.warnings).toEqual(['add-result-without-air-extra-ids']);
  });

  it('un servicio que no se mandó se ignora con aviso', () => {
    const mapped = mapSabreAncillaryAddResponse(
      { results: [{ ancillaryId: 'otro', airExtraIds: ['99'] }] },
      SENT,
    );
    expect(mapped.added).toEqual([]);
    expect(mapped.warnings).toEqual(['add-result-unrequested']);
  });

  it('errors[] es un rechazo y una forma rota un error de contrato', () => {
    expect(thrown(() => mapSabreAncillaryAddResponse({ errors: [{}] }, SENT))).toBeInstanceOf(
      SabreAncillaryRejectedError,
    );
    expect(thrown(() => mapSabreAncillaryAddResponse({ results: 'ok' }, SENT))).toBeInstanceOf(
      SabreAncillaryMappingError,
    );
  });

  it('un airExtraId con forma de PAN no se acepta (luego viajaría en /remove)', () => {
    expect(
      thrown(() =>
        mapSabreAncillaryAddResponse(
          {
            results: [{ ancillaryId: 'ancillary_ancillary_1', airExtraIds: ['4111111111111111'] }],
          },
          SENT,
        ),
      ),
    ).toBeInstanceOf(SabreAncillaryMappingError);
  });
});
