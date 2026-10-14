import type { OrderModifyResult } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import {
  TRAVELERS_MESSAGES,
  auditableTravelerIssueTypes,
  fieldNames,
  last4,
  passengersAfterChange,
  publicTravelersView,
  requestedFields,
  travelerCount,
  travelersMessageOf,
  travelersOperationPolicy,
} from './order-travelers.plan.js';

/** Las decisiones puras de SAB-25: qué se dice, qué se guarda y cómo sale en el historial. */

function resultado(extra: Partial<OrderModifyResult>): OrderModifyResult {
  return {
    outcome: 'FAILED',
    unchanged: false,
    applied: [],
    pending: [],
    attempts: 1,
    issues: [],
    ...extra,
  };
}

const DOC = [{ index: 0, field: 'identityDocuments' as const }];
const FF = [{ index: 1, field: 'loyalty' as const }];
const SSR = [{ index: 0, field: 'specialServices' as const }];

describe('el texto del desenlace', () => {
  it('rechazos: por el tipo del error si lo dice, si no por lo pedido', () => {
    const issue = (type: string, fieldPath?: string) =>
      resultado({
        issues: [
          {
            severity: 'ERROR',
            category: 'APPLICATION_ERROR',
            type,
            ...(fieldPath === undefined ? {} : { fieldPath }),
          },
        ],
      });
    expect(travelersMessageOf(issue('UNABLE_TO_UPDATE_RESERVATION_WRONG_LOYALTY_DATA'), DOC)).toBe(
      TRAVELERS_MESSAGES.rejectedLoyalty,
    );
    expect(
      travelersMessageOf(issue('UNABLE_TO_MODIFY_BOOKING_SPECIAL_SERVICE_CODE_NOT_SUPPORTED'), DOC),
    ).toBe(TRAVELERS_MESSAGES.rejectedSpecialServices);
    expect(travelersMessageOf(issue('INVALID_VALUE', 'after.specialServices[2].code'), DOC)).toBe(
      TRAVELERS_MESSAGES.rejectedSpecialServices,
    );
    expect(travelersMessageOf(issue('INVALID_VALUE'), DOC)).toBe(
      TRAVELERS_MESSAGES.rejectedDocument,
    );
    expect(travelersMessageOf(issue('INVALID_VALUE'), FF)).toBe(TRAVELERS_MESSAGES.rejectedLoyalty);
    expect(travelersMessageOf(issue('INVALID_VALUE'), SSR)).toBe(
      TRAVELERS_MESSAGES.rejectedSpecialServices,
    );
    expect(travelersMessageOf(issue('INVALID_VALUE'), [...FF, ...SSR])).toBe(
      TRAVELERS_MESSAGES.rejected,
    );
  });

  it('hecho, ya estaba, cambio concurrente, en duda y a medias', () => {
    expect(travelersMessageOf(resultado({ outcome: 'MODIFIED' }), DOC)).toBe(
      TRAVELERS_MESSAGES.saved,
    );
    expect(travelersMessageOf(resultado({ outcome: 'MODIFIED', unchanged: true }), DOC)).toBe(
      TRAVELERS_MESSAGES.unchanged,
    );
    expect(travelersMessageOf(resultado({ failureReason: 'CONCURRENT_CHANGE' }), DOC)).toBe(
      TRAVELERS_MESSAGES.concurrent,
    );
    expect(travelersMessageOf(resultado({ outcome: 'UNVERIFIED' }), DOC)).toBe(
      TRAVELERS_MESSAGES.unverified,
    );
    expect(travelersMessageOf(resultado({ outcome: 'UNVERIFIED', applied: DOC }), DOC)).toBe(
      TRAVELERS_MESSAGES.partial,
    );
  });
});

describe('el historial', () => {
  it('pendiente es «en duda»; fallida sólo si la operación lo dice; nunca se reintenta desde ahí', () => {
    expect(travelersOperationPolicy('pending', {})).toEqual({
      retryable: false,
      reconciliationRequired: true,
    });
    expect(travelersOperationPolicy('failed', { reconciliationRequired: true })).toEqual({
      retryable: false,
      reconciliationRequired: true,
    });
    expect(travelersOperationPolicy('failed', { reconciliationRequired: false })).toEqual({
      retryable: false,
      reconciliationRequired: false,
    });
    expect(travelersOperationPolicy('success', null).reconciliationRequired).toBe(false);
  });
});

describe('lo que queda en la orden', () => {
  const PASAJEROS = [
    {
      paxType: 'ADT',
      identityDoc: { type: 'CC', number: '1020304050', issuingCountryCode: 'CO' },
    },
    'roto',
  ];

  it('sólo lo aplicado, enmascarado; una cédula conserva su tipo', () => {
    const next = passengersAfterChange(
      PASAJEROS,
      [
        {
          index: 0,
          identityDocument: {
            type: 'NATIONAL_ID',
            number: '99887766',
            issuingCountry: 'CO',
            nationality: 'CO',
            expiryDate: '2040-01-01',
          },
          loyalty: { carrierCode: 'AV', number: '123456789' },
        },
      ],
      DOC,
    );
    expect(next?.[0]).toEqual({
      paxType: 'ADT',
      citizenshipCountryCode: 'CO',
      identityDoc: {
        type: 'CC',
        numberLast4: '7766',
        issuingCountryCode: 'CO',
        expiryDate: '2040-01-01',
      },
    });
    expect(next?.[1]).toBe('roto');
  });

  it('sin nada aplicado, o sin pasajeros legibles, no hay nada que escribir', () => {
    expect(passengersAfterChange(PASAJEROS, [{ index: 0, specialServices: [] }], SSR)).toBe(
      undefined,
    );
    expect(passengersAfterChange(null, [{ index: 0, specialServices: [] }], DOC)).toBeUndefined();
  });

  it('nunca más de la mitad del número', () => {
    expect(last4('AB1234567')).toBe('4567');
    expect(last4('123456')).toBe('56');
    expect(last4('1234')).toBe('');
  });
});

describe('el rastro y la pantalla', () => {
  it('nombres de campo sin repetir, pasajeros distintos y sólo tipos con forma de código', () => {
    const fields = requestedFields([
      { index: 0, specialServices: ['WCHR'], loyalty: { carrierCode: 'AV', number: '1234' } },
      { index: 2, loyalty: { carrierCode: 'LA', number: '5678' } },
    ]);
    expect(fieldNames(fields)).toEqual(['loyalty', 'specialServices']);
    expect(travelerCount(fields)).toBe(2);
    expect(
      auditableTravelerIssueTypes([
        { severity: 'ERROR', category: 'X', type: 'INVALID_VALUE' },
        { severity: 'ERROR', category: 'X', type: 'texto libre con AB1234567' },
      ]),
    ).toEqual(['INVALID_VALUE']);
  });

  it('la vista lleva los nombres de la orden recortados y lo enmascarado de la reserva', () => {
    const view = publicTravelersView(
      [{ givenName: '  Ana ', surname: 'Pérez', paxType: 'ADT', identityDoc: { number: 'X1' } }],
      {
        travelers: [{ index: 0, documents: [], loyalty: [], specialServices: ['VGML'] }],
        supported: ['identityDocuments'],
        warnings: ['traveler-count-mismatch'],
      },
      { testContent: true, blocked: null },
    );
    expect(view).toEqual({
      kind: 'travelers',
      testContent: true,
      supported: ['identityDocuments'],
      blocked: null,
      travelers: [
        {
          index: 0,
          givenName: 'Ana',
          surname: 'Pérez',
          paxType: 'ADT',
          documents: [],
          loyalty: [],
          specialServices: ['VGML'],
        },
      ],
      warnings: ['traveler-count-mismatch'],
    });
  });
});
