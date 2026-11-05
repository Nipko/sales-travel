import { describe, expect, it } from 'vitest';
import {
  billingDraftFromCustomer,
  billingDraftFromQuotation,
  billingProblems,
  emptyBillingDraft,
  passengerBillingLabel,
  quotationCustomerPatch,
  resolveBilling,
  type BillingDraft,
  type BillingPassenger,
} from './billing';
import type { CrmCustomer } from './customer-search';

const ID = '3f1c2b4a-1d2e-4f5a-8b6c-7d8e9f0a1b2c';
const PAX_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

const PAX1: BillingPassenger = {
  givenName: 'Juan Carlos',
  surname: 'Pérez Gómez',
  identityDoc: { type: 'P', number: 'AB123456', issuingCountryCode: 'PE' },
};

const LEGACY_EMPTY = { customerName: null, customerEmail: null, customerPhone: null };

function draft(over: Partial<BillingDraft> = {}): BillingDraft {
  return { ...emptyBillingDraft(), email: 'juan@example.com', phone: '3001234567', ...over };
}

describe('billingDraftFromQuotation', () => {
  it('sin nada guardado arranca facturando al pasajero 1', () => {
    expect(billingDraftFromQuotation(null, LEGACY_EMPTY)).toEqual(emptyBillingDraft());
  });

  it('una cotización de antes sólo con cliente se abre como «otra persona» con sus datos', () => {
    expect(
      billingDraftFromQuotation(null, {
        customerName: ' Ana Ruiz ',
        customerEmail: 'ana@example.com',
        customerPhone: '300',
      }),
    ).toMatchObject({ mode: 'other', name: 'Ana Ruiz', email: 'ana@example.com', phone: '300' });
  });

  it('lee la facturación guardada, con nulos como vacío', () => {
    const out = billingDraftFromQuotation(
      {
        mode: 'other',
        customerId: ID,
        customerType: 'company',
        name: 'Viajes Andinos S.A.S.',
        documentType: 'NIT',
        documentNumber: '900123456',
        email: 'fact@andinos.co',
        phone: '6011234567',
        address: null,
        city: 'Medellín',
        countryCode: 'CO',
      },
      { customerName: 'Otro', customerEmail: null, customerPhone: null },
    );
    expect(out).toEqual({
      mode: 'other',
      customerId: ID,
      customerType: 'company',
      name: 'Viajes Andinos S.A.S.',
      documentType: 'NIT',
      documentNumber: '900123456',
      email: 'fact@andinos.co',
      phone: '6011234567',
      address: '',
      city: 'Medellín',
      countryCode: 'CO',
    });
    expect(
      billingDraftFromQuotation({ mode: 'other', customerId: 'no-uuid' }, LEGACY_EMPTY).customerId,
    ).toBeNull();
  });
});

describe('resolveBilling', () => {
  it('con el pasajero 1, nombre y documento salen del pasajero y el país de su documento', () => {
    const { billing, missing } = resolveBilling(draft(), PAX1, PAX_ID);
    expect(missing).toEqual([]);
    expect(billing).toEqual({
      mode: 'passenger',
      customerId: PAX_ID,
      customerType: 'person',
      name: 'Juan Carlos Pérez Gómez',
      documentType: 'PASAPORTE',
      documentNumber: 'AB123456',
      email: 'juan@example.com',
      phone: '3001234567',
      address: null,
      city: null,
      countryCode: 'PE',
    });
  });

  it('con otra persona, ignora al pasajero y exige sus propios datos', () => {
    const other = draft({ mode: 'other', customerId: ID });
    expect(resolveBilling(other, PAX1, PAX_ID).missing).toEqual(['name', 'documentNumber']);
    const { billing } = resolveBilling(
      {
        ...other,
        customerType: 'company',
        name: 'Andinos',
        documentType: 'NIT',
        documentNumber: '900123',
        countryCode: 'col',
      },
      PAX1,
      PAX_ID,
    );
    expect(billing).toMatchObject({
      mode: 'other',
      customerId: ID,
      customerType: 'company',
      countryCode: 'CO',
    });
  });

  it('marca email inválido, teléfono corto y un país que no es código', () => {
    const { billing, missing } = resolveBilling(
      draft({ email: 'juan@', phone: '12', countryCode: 'Colombia' }),
      PAX1,
    );
    expect(billing).toBeNull();
    expect(missing).toEqual(['email', 'phone', 'countryCode']);
  });

  it('sin pasajero 1 todavía, falta su nombre y documento', () => {
    expect(resolveBilling(draft(), undefined).missing).toEqual(['name', 'documentNumber']);
  });
});

describe('billingProblems', () => {
  it('apunta a «Facturación»; con el pasajero 1, su nombre y documento los reclama su ficha', () => {
    expect(billingProblems('passenger', ['name', 'documentNumber', 'email', 'phone'])).toEqual([
      'Facturación: completa email válido, teléfono.',
    ]);
    expect(billingProblems('passenger', ['name'])).toEqual([]);
    expect(billingProblems('other', ['name', 'documentNumber'])).toEqual([
      'Facturación: completa nombre o razón social, número de documento.',
    ]);
  });
});

describe('billingDraftFromCustomer', () => {
  const empresa: CrmCustomer = {
    id: ID,
    customerType: 'company',
    firstName: 'Viajes Andinos S.A.S.',
    lastName: '',
    email: null,
    phone: '6011234567',
    documentType: 'NIT',
    documentNumber: '900123456',
    documentIssuingCountry: 'CO',
    birthdate: null,
    gender: null,
    nationality: null,
    passportExpiry: null,
    address: 'Cra 7 # 1-1',
    city: 'Bogotá',
    countryCode: 'COL',
  };

  it('toma razón social, documento y dirección; el correo tecleado sigue si la ficha no tiene', () => {
    expect(billingDraftFromCustomer(draft(), empresa)).toEqual({
      mode: 'other',
      customerId: ID,
      customerType: 'company',
      name: 'Viajes Andinos S.A.S.',
      documentType: 'NIT',
      documentNumber: '900123456',
      email: 'juan@example.com',
      phone: '6011234567',
      address: 'Cra 7 # 1-1',
      city: 'Bogotá',
      countryCode: 'CO',
    });
  });

  it('el pasaporte del CRM se nombra igual en la factura', () => {
    expect(
      billingDraftFromCustomer(draft(), { ...empresa, customerType: 'person', documentType: 'P' })
        .documentType,
    ).toBe('PASAPORTE');
  });
});

describe('quotationCustomerPatch', () => {
  it('refleja nombre, correo y teléfono de quien factura y adjunta la facturación completa', () => {
    const { patch, missing } = quotationCustomerPatch(draft(), PAX1, '  ventana ', PAX_ID);
    expect(missing).toEqual([]);
    expect(patch).toMatchObject({
      customerName: 'Juan Carlos Pérez Gómez',
      customerEmail: 'juan@example.com',
      customerPhone: '3001234567',
      notes: 'ventana',
      billing: { mode: 'passenger', customerId: PAX_ID },
    });
  });

  it('a medias guarda el contacto y no toca la facturación', () => {
    const { patch, missing } = quotationCustomerPatch(
      draft({ mode: 'other', name: 'Ana', email: 'ana@' }),
      PAX1,
      '',
    );
    expect(patch).toEqual({
      customerName: 'Ana',
      customerEmail: null,
      customerPhone: '3001234567',
      notes: null,
    });
    expect(missing).toEqual(['documentNumber', 'email']);
  });
});

describe('passengerBillingLabel', () => {
  it('nombra al pasajero 1 cuando ya tiene nombre', () => {
    expect(passengerBillingLabel(PAX1)).toBe('Pasajero 1 (Juan Carlos Pérez Gómez)');
    expect(passengerBillingLabel(undefined)).toBe('Pasajero 1');
  });
});
