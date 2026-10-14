import { describe, expect, it } from 'vitest';
import { publicOrderPassengers } from './public-order-passengers.js';

/**
 * Los pasajeros de una orden en la respuesta HTTP: el documento y el viajero frecuente por sus
 * últimos caracteres, nunca enteros; el resto, igual.
 */

const PASAPORTE = 'AB1234567';
const VIAJERO = '9988776655';

const VUELO = {
  paxId: 'P1',
  paxType: 'ADT',
  givenName: 'Ana',
  surname: 'Pérez',
  gender: 'F',
  birthdate: '1990-01-01',
  citizenshipCountryCode: 'CO',
  identityDoc: { type: 'P', number: PASAPORTE, issuingCountryCode: 'CO', expiryDate: '2031-05-01' },
  loyaltyProgramAccount: { accountNumber: VIAJERO, airlineDesigCode: 'AV' },
};

describe('publicOrderPassengers', () => {
  it('el número del documento y el del viajero frecuente salen por sus últimos caracteres', () => {
    const [out] = publicOrderPassengers([VUELO]) as Record<string, unknown>[];
    expect(out).toEqual({
      paxId: 'P1',
      paxType: 'ADT',
      givenName: 'Ana',
      surname: 'Pérez',
      gender: 'F',
      birthdate: '1990-01-01',
      citizenshipCountryCode: 'CO',
      identityDoc: {
        type: 'P',
        numberLast4: '4567',
        issuingCountryCode: 'CO',
        expiryDate: '2031-05-01',
      },
      loyaltyProgramAccount: { accountNumberLast4: '6655', airlineDesigCode: 'AV' },
    });
    const json = JSON.stringify(out);
    expect(json).not.toContain(PASAPORTE);
    expect(json).not.toContain('1234567');
    expect(json).not.toContain(VIAJERO);
  });

  it('nunca más de la mitad del número; uno de 4 o menos no deja ver nada', () => {
    const out = publicOrderPassengers([
      { identityDoc: { type: 'CC', number: '123456' } },
      { identityDoc: { type: 'CC', number: '1234' } },
    ]) as { identityDoc: Record<string, unknown> }[];
    expect(out[0]?.identityDoc).toEqual({ type: 'CC', numberLast4: '56' });
    expect(out[1]?.identityDoc).toEqual({ type: 'CC', numberLast4: '' });
  });

  it('una orden corregida (SAB-25) ya trae lo enmascarado y sale igual', () => {
    const corregida = {
      paxType: 'ADT',
      identityDoc: { type: 'P', numberLast4: '4567', issuingCountryCode: 'CO' },
      loyaltyProgramAccount: { airlineDesigCode: 'AV', accountNumberLast4: '6655' },
    };
    expect(publicOrderPassengers([corregida])).toEqual([corregida]);
  });

  it('un «último» que no tiene forma de últimos caracteres no sale', () => {
    const out = publicOrderPassengers([{ identityDoc: { type: 'P', numberLast4: PASAPORTE } }]) as {
      identityDoc: Record<string, unknown>;
    }[];
    expect(out[0]?.identityDoc).toEqual({ type: 'P' });
  });

  it('un documento que no es un objeto no sale; los huéspedes de hotel y lo que no es lista, igual', () => {
    expect(publicOrderPassengers([{ paxType: 'ADT', identityDoc: PASAPORTE }])).toEqual([
      { paxType: 'ADT' },
    ]);
    const hotel = [{ room: 0, guests: [{ firstName: 'Ana', lastName: 'Pérez', paxType: 'ADT' }] }];
    expect(publicOrderPassengers(hotel)).toEqual(hotel);
    expect(publicOrderPassengers(null)).toBeNull();
    expect(publicOrderPassengers(['x', 1])).toEqual(['x', 1]);
  });

  it('no toca la fila: la base sigue con su documento', () => {
    const fila = structuredClone(VUELO);
    publicOrderPassengers([fila]);
    expect(fila).toEqual(VUELO);
  });
});
