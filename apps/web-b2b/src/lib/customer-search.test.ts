import { describe, expect, it } from 'vitest';
import {
  crmCustomerDetail,
  crmCustomerName,
  crmDocType,
  customerSearchTerm,
  customerSearchUrl,
  isTravelerCandidate,
  linkedCustomerId,
  parseCrmCustomer,
  parseCustomerSearchResponse,
  passengerDocType,
  passengerFromCustomer,
  type CrmCustomer,
} from './customer-search';

const ID = '3f1c2b4a-1d2e-4f5a-8b6c-7d8e9f0a1b2c';

function fila(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID,
    customerType: 'person',
    firstName: 'Ana María',
    lastName: 'Ruiz Toro',
    email: 'ana@example.com',
    phone: '3001112233',
    documentType: 'CC',
    documentNumber: '1020304050',
    documentIssuingCountry: 'COL',
    birthdate: '1985-03-09',
    gender: 'F',
    nationality: 'COL',
    passportExpiry: null,
    address: 'Calle 1',
    city: 'Bogotá',
    countryCode: 'CO',
    preferences: {},
    createdAt: '2026-01-01',
    ...over,
  };
}

function cliente(over: Record<string, unknown> = {}): CrmCustomer {
  return parseCrmCustomer(fila(over))!;
}

describe('customerSearchTerm', () => {
  it('no busca con menos de dos letras y normaliza los espacios', () => {
    expect(customerSearchTerm('')).toBeNull();
    expect(customerSearchTerm(' a ')).toBeNull();
    expect(customerSearchTerm('  ana   ruiz ')).toBe('ana ruiz');
    expect(customerSearchTerm('x'.repeat(300))).toHaveLength(120);
  });

  it('arma la URL del proxy con el término codificado', () => {
    expect(customerSearchUrl('ana & co')).toBe('/api/customers/search?q=ana%20%26%20co&limit=8');
  });
});

describe('parseCustomerSearchResponse', () => {
  it('lee las filas válidas y descarta las rotas', () => {
    const out = parseCustomerSearchResponse({
      customers: [fila(), { id: 'x' }, null, fila({ id: 'otro', documentNumber: '' })],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: ID, firstName: 'Ana María', city: 'Bogotá' });
  });

  it('una empresa sin nacimiento, género ni nacionalidad se lee igual', () => {
    const [empresa] = parseCustomerSearchResponse({
      customers: [
        fila({
          customerType: 'company',
          firstName: 'Viajes Andinos S.A.S.',
          lastName: '',
          documentType: 'NIT',
          birthdate: null,
          gender: null,
          nationality: null,
        }),
      ],
    });
    expect(empresa).toMatchObject({
      customerType: 'company',
      lastName: '',
      birthdate: null,
      gender: null,
      nationality: null,
    });
    expect(crmCustomerName(empresa!)).toBe('Viajes Andinos S.A.S.');
    expect(crmCustomerDetail(empresa!)).toBe('Empresa · NIT 1020304050 · ana@example.com');
    expect(isTravelerCandidate(empresa!)).toBe(false);
  });

  it('cualquier otra forma es «sin resultados»', () => {
    for (const body of [null, 'html', {}, { customers: 'no' }, []]) {
      expect(parseCustomerSearchResponse(body)).toEqual([]);
    }
  });
});

describe('passengerFromCustomer', () => {
  it('convierte los códigos de país del CRM (alfa-3) y recorta las fechas ISO', () => {
    const fill = passengerFromCustomer(
      cliente({
        documentType: 'PASAPORTE',
        birthdate: '1985-03-09T05:00:00.000Z',
        passportExpiry: '2031-01-31T00:00:00.000Z',
      }),
    );
    expect(fill).toEqual({
      givenName: 'Ana María',
      surname: 'Ruiz Toro',
      birthdate: '1985-03-09',
      gender: 'F',
      citizenshipCountryCode: 'CO',
      identityDoc: {
        type: 'P',
        number: '1020304050',
        issuingCountryCode: 'CO',
        expiryDate: '2031-01-31',
      },
    });
  });

  it('lo que no se entiende queda fuera en vez de inventarse', () => {
    const fill = passengerFromCustomer(
      cliente({ nationality: 'Colombia', gender: 'X', birthdate: 'ayer', documentType: 'NIT' }),
    );
    expect(fill).not.toHaveProperty('citizenshipCountryCode');
    expect(fill).not.toHaveProperty('gender');
    expect(fill).not.toHaveProperty('birthdate');
    expect(fill.identityDoc.type).toBe('CC');
    // Una cédula no lleva vencimiento aunque la ficha tenga uno.
    expect(
      passengerFromCustomer(cliente({ passportExpiry: '2030-01-01' })).identityDoc,
    ).not.toHaveProperty('expiryDate');
  });

  it('traduce los tipos de documento en los dos sentidos', () => {
    expect(passengerDocType('pasaporte')).toBe('P');
    expect(passengerDocType('CE')).toBe('CE');
    expect(passengerDocType('NIT')).toBeNull();
    expect(crmDocType('P')).toBe('PASAPORTE');
    expect(crmDocType('CC')).toBe('CC');
  });
});

describe('linkedCustomerId', () => {
  it('se mantiene mientras el documento sea el de la ficha elegida', () => {
    const link = { customerId: ID, documentNumber: '1020304050' };
    expect(linkedCustomerId(link, ' 1020304050 ')).toBe(ID);
    expect(linkedCustomerId(link, '999')).toBeNull();
    expect(linkedCustomerId(undefined, '1020304050')).toBeNull();
  });
});
