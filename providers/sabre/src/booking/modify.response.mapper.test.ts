import { describe, expect, it } from 'vitest';
import {
  SabreTravelersMappingError,
  mapSabreModifyBookingResponse,
  maskSabreTravelers,
  readSabreTravelersState,
  sabreLast4,
  sabreSupportedModifications,
  specialServicesOf,
  verifySabreTravelerChanges,
} from './modify.response.mapper';

/**
 * La lectura de los pasajeros para modificarlos (SAB-25): lo que sale enmascarado, lo que se
 * verifica y lo que se descarta de la respuesta de `modifyBooking`.
 */

const BOOKING = {
  travelers: [
    {
      givenName: 'ANA',
      surname: 'PEREZ',
      passengerCode: 'ADT',
      identityDocuments: [
        {
          documentType: 'PASSPORT',
          documentNumber: 'AB1234567',
          expiryDate: '2034-05-31',
          issuingCountryCode: 'CO',
          citizenshipCountryCode: 'CO',
        },
        { documentType: 'VISA', documentNumber: 'V998877', issuingCountryCode: 'US' },
        { documentType: 'NATIONAL_ID_CARD', documentNumber: '1020304050', expiryDate: 'mañana' },
      ],
      loyaltyPrograms: [
        { supplierCode: 'AV', programNumber: '12345678901' },
        { supplierCode: 'HZ', programType: 'FREQUENT_RENTER', programNumber: 'R555' },
      ],
    },
    { givenName: 'LEO', surname: 'PEREZ', passengerCode: 'INF' },
  ],
  specialServices: [
    {
      code: 'DOCS',
      travelerIndices: [1],
      message: '/P/CO/AB1234567/CO/01JAN1990/F/31MAY2034/PEREZ/ANA',
    },
    { code: 'WCHR', travelerIndices: [1], statusCode: 'NN' },
    { code: 'VGML', travelerIndices: [1, 2] },
    { code: 'OTHS', message: 'TEXTO LIBRE DE LA AEROLINEA' },
  ],
  flights: [{ itemId: '1', sourceType: 'ATPCO' }],
};

describe('readSabreTravelersState', () => {
  it('lee pasajeros, documentos, programas, SSR y carriles; un elemento roto se salta y se avisa', () => {
    const state = readSabreTravelersState({
      ...BOOKING,
      specialServices: [...BOOKING.specialServices, { message: 'sin código' }],
    });
    expect(state.travelers).toHaveLength(2);
    expect(state.travelers[0]?.documents).toHaveLength(3);
    expect(state.lanes).toEqual(['ATPCO']);
    expect(state.warnings).toEqual(['special-service-malformed']);
    expect(specialServicesOf(state, 0)).toEqual(['WCHR', 'VGML']);
    expect(specialServicesOf(state, 1)).toEqual(['VGML']);
  });

  it('una lectura sin la forma del contrato lanza con rutas, nunca con valores', () => {
    expect(() => readSabreTravelersState({ travelers: 'AB1234567' })).toThrow(
      SabreTravelersMappingError,
    );
    try {
      readSabreTravelersState({ travelers: 'AB1234567' });
    } catch (error) {
      expect(String(error)).not.toContain('AB1234567');
    }
  });
});

describe('maskSabreTravelers', () => {
  it('nunca un número entero: pasaporte y viajero frecuente por sus últimos caracteres', () => {
    const view = maskSabreTravelers(readSabreTravelersState(BOOKING), 2, 'ATPCO');
    expect(view.travelers[0]).toEqual({
      index: 0,
      documents: [
        {
          type: 'PASSPORT',
          numberLast4: '4567',
          issuingCountry: 'CO',
          nationality: 'CO',
          expiryDate: '2034-05-31',
        },
        // Fecha ilegible: se omite el campo, el documento sigue.
        { type: 'NATIONAL_ID', numberLast4: '4050' },
      ],
      // La visa y el programa de autos no se editan desde aquí: no se muestran.
      loyalty: [{ carrierCode: 'AV', numberLast4: '8901' }],
      specialServices: ['WCHR', 'VGML'],
    });
    expect(view.travelers[1]).toEqual({
      index: 1,
      documents: [],
      loyalty: [],
      specialServices: ['VGML'],
    });
    const text = JSON.stringify(view);
    for (const secret of ['AB1234567', '1020304050', '12345678901', 'V998877', 'PEREZ', 'ANA']) {
      expect(text).not.toContain(secret);
    }
  });

  it('nunca más de la mitad del número', () => {
    expect(sabreLast4('AB1234567')).toBe('4567');
    expect(sabreLast4('123456')).toBe('56');
    expect(sabreLast4('12345')).toBe('5');
    expect(sabreLast4('1234')).toBe('');
    // Los separadores no cuentan: 'AB123456' tiene ocho caracteres.
    expect(sabreLast4('ab-12.34-56')).toBe('3456');
  });

  it('una orden con más pasajeros que la reserva lo avisa y no inventa datos', () => {
    const view = maskSabreTravelers(readSabreTravelersState(BOOKING), 3, 'ATPCO');
    expect(view.travelers[2]).toEqual({
      index: 2,
      documents: [],
      loyalty: [],
      specialServices: [],
    });
    expect(view.warnings).toContain('traveler-count-mismatch');
  });

  it('servicios especiales sólo con todos los vuelos ATPCO, o con la orden ATPCO si no hay carril', () => {
    expect(sabreSupportedModifications(['ATPCO'], undefined)).toContain('specialServices');
    expect(sabreSupportedModifications(['ATPCO', 'NDC'], 'ATPCO')).not.toContain('specialServices');
    expect(sabreSupportedModifications([], 'atpco')).toContain('specialServices');
    expect(sabreSupportedModifications([], 'NDC')).not.toContain('specialServices');
    expect(sabreSupportedModifications([], undefined)).toEqual(['identityDocuments', 'loyalty']);
  });
});

describe('verifySabreTravelerChanges', () => {
  const state = readSabreTravelersState(BOOKING);

  it('aplicado sólo si la reserva lo trae exactamente como se pidió', () => {
    expect(
      verifySabreTravelerChanges(state, [
        {
          index: 0,
          identityDocument: {
            type: 'PASSPORT',
            number: 'AB1234567',
            issuingCountry: 'CO',
            nationality: 'CO',
            expiryDate: '2034-05-31',
          },
          loyalty: { carrierCode: 'AV', number: '12345678901' },
          specialServices: ['VGML', 'WCHR'],
        },
      ]),
    ).toEqual({
      applied: [
        { index: 0, field: 'identityDocuments' },
        { index: 0, field: 'loyalty' },
        { index: 0, field: 'specialServices' },
      ],
      pending: [],
    });
  });

  it('otro vencimiento, otro programa o un SSR de más: pendiente', () => {
    expect(
      verifySabreTravelerChanges(state, [
        {
          index: 0,
          identityDocument: {
            type: 'PASSPORT',
            number: 'AB1234567',
            issuingCountry: 'CO',
            nationality: 'CO',
            expiryDate: '2035-05-31',
          },
          loyalty: { carrierCode: 'LA', number: '12345678901' },
          specialServices: ['WCHR'],
        },
      ]).pending,
    ).toEqual([
      { index: 0, field: 'identityDocuments' },
      { index: 0, field: 'loyalty' },
      { index: 0, field: 'specialServices' },
    ]);
  });
});

describe('mapSabreModifyBookingResponse', () => {
  it('se queda con la reserva y el instante; el eco de la request no sale', () => {
    const mapped = mapSabreModifyBookingResponse({
      timestamp: '2026-10-14T12:00:01Z',
      booking: BOOKING,
      request: { before: { travelers: [{ documentNumber: 'OLD123456' }] } },
    });
    expect(mapped).toEqual({ booking: BOOKING, timestamp: '2026-10-14T12:00:01Z' });
    expect(JSON.stringify(mapped)).not.toContain('OLD123456');
    expect(mapSabreModifyBookingResponse({})).toEqual({});
    expect(() => mapSabreModifyBookingResponse('no')).toThrow(SabreTravelersMappingError);
  });
});
