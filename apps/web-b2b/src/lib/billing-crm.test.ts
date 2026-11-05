import { describe, expect, it } from 'vitest';
import type { Billing } from './billing';
import {
  BILLER_LABEL,
  billingWithSavedCustomer,
  crmSaveNote,
  crmUpsertPlan,
  upsertedCustomerId,
  type CrmPassenger,
} from './billing-crm';

const ID = '3f1c2b4a-1d2e-4f5a-8b6c-7d8e9f0a1b2c';
const NEW_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

function pax(n: number, over: Partial<CrmPassenger> = {}): CrmPassenger {
  return {
    label: `Adulto ${n}`,
    givenName: `Nombre${n}`,
    surname: `Apellido${n}`,
    birthdate: '1990-01-01',
    gender: 'F',
    citizenshipCountryCode: 'CO',
    identityDoc: { type: 'CC', number: `10${n}0000`, issuingCountryCode: 'CO' },
    ...over,
  };
}

const PASAJERO_FACTURA: Billing = {
  mode: 'passenger',
  customerId: null,
  customerType: 'person',
  name: 'Nombre1 Apellido1',
  documentType: 'CC',
  documentNumber: '1010000',
  email: 'uno@example.com',
  phone: '3001234567',
  address: 'Calle 1',
  city: null,
  countryCode: 'CO',
};

const EMPRESA: Billing = {
  mode: 'other',
  customerId: null,
  customerType: 'company',
  name: 'Viajes Andinos S.A.S.',
  documentType: 'NIT',
  documentNumber: '900123456',
  email: 'fact@andinos.co',
  phone: '6011234567',
  address: null,
  city: 'Bogotá',
  countryCode: null,
};

describe('crmUpsertPlan', () => {
  it('desmarcado no guarda a nadie', () => {
    expect(
      crmUpsertPlan({
        enabled: false,
        passengers: [pax(1)],
        customerIds: [null],
        billing: EMPRESA,
      }),
    ).toEqual({ items: [], skipped: [] });
  });

  it('guarda a los pasajeros tecleados; el pasajero 1 que factura lleva su contacto', () => {
    const plan = crmUpsertPlan({
      enabled: true,
      passengers: [
        pax(1),
        pax(2, {
          identityDoc: {
            type: 'P',
            number: 'AB1',
            issuingCountryCode: 'PE',
            expiryDate: '2030-01-01',
          },
        }),
      ],
      customerIds: [null, null],
      billing: PASAJERO_FACTURA,
    });
    expect(plan.skipped).toEqual([]);
    expect(plan.items.map((i) => i.body)).toEqual([
      {
        customerType: 'person',
        firstName: 'Nombre1',
        lastName: 'Apellido1',
        documentType: 'CC',
        documentNumber: '1010000',
        documentIssuingCountry: 'CO',
        birthdate: '1990-01-01',
        gender: 'F',
        nationality: 'CO',
        email: 'uno@example.com',
        phone: '3001234567',
        address: 'Calle 1',
        countryCode: 'CO',
      },
      {
        customerType: 'person',
        firstName: 'Nombre2',
        lastName: 'Apellido2',
        documentType: 'PASAPORTE',
        documentNumber: 'AB1',
        documentIssuingCountry: 'PE',
        birthdate: '1990-01-01',
        gender: 'F',
        nationality: 'CO',
        passportExpiry: '2030-01-01',
      },
    ]);
  });

  it('no repite a quien salió del CRM ni dos veces el mismo documento', () => {
    const plan = crmUpsertPlan({
      enabled: true,
      passengers: [pax(1), pax(2), pax(3, { identityDoc: pax(2).identityDoc })],
      customerIds: [ID, null, null],
      billing: null,
    });
    expect(plan.items.map((i) => i.label)).toEqual(['Adulto 2']);
  });

  it('una empresa que factura se guarda como empresa, con el país del pasajero si no tiene', () => {
    const plan = crmUpsertPlan({
      enabled: true,
      passengers: [pax(1)],
      customerIds: [ID],
      billing: EMPRESA,
    });
    expect(plan.items).toEqual([
      {
        label: BILLER_LABEL,
        role: { kind: 'biller' },
        body: {
          customerType: 'company',
          firstName: 'Viajes Andinos S.A.S.',
          lastName: '',
          documentType: 'NIT',
          documentNumber: '900123456',
          documentIssuingCountry: 'CO',
          email: 'fact@andinos.co',
          phone: '6011234567',
          city: 'Bogotá',
        },
      },
    ]);
  });

  it('una persona que factura sin viajar no se puede guardar y se dice', () => {
    const plan = crmUpsertPlan({
      enabled: true,
      passengers: [pax(1)],
      customerIds: [ID],
      billing: { ...EMPRESA, customerType: 'person', documentType: 'CC', documentNumber: '555' },
    });
    expect(plan).toEqual({ items: [], skipped: [BILLER_LABEL] });
  });

  it('quien factura elegido del CRM, o que es uno de los pasajeros, no se guarda otra vez', () => {
    expect(
      crmUpsertPlan({
        enabled: true,
        passengers: [pax(1)],
        customerIds: [ID],
        billing: { ...EMPRESA, customerId: ID },
      }).items,
    ).toEqual([]);
    expect(
      crmUpsertPlan({
        enabled: true,
        passengers: [pax(1)],
        customerIds: [ID],
        billing: {
          ...EMPRESA,
          customerType: 'person',
          documentType: 'CC',
          documentNumber: '1010000',
        },
      }),
    ).toEqual({ items: [], skipped: [] });
  });
});

describe('después de guardar', () => {
  const plan = crmUpsertPlan({
    enabled: true,
    passengers: [pax(1), pax(2)],
    customerIds: [null, null],
    billing: PASAJERO_FACTURA,
  });

  it('lee el id de la respuesta del API', () => {
    expect(upsertedCustomerId({ customer: { id: NEW_ID }, created: true })).toBe(NEW_ID);
    expect(upsertedCustomerId({ customer: null })).toBeNull();
    expect(upsertedCustomerId('html')).toBeNull();
  });

  it('la facturación queda apuntando a la ficha recién guardada', () => {
    expect(billingWithSavedCustomer(PASAJERO_FACTURA, plan, [NEW_ID, null])?.customerId).toBe(
      NEW_ID,
    );
    expect(billingWithSavedCustomer(PASAJERO_FACTURA, plan, [null, NEW_ID])?.customerId).toBeNull();
    const empresaPlan = crmUpsertPlan({
      enabled: true,
      passengers: [pax(1)],
      customerIds: [ID],
      billing: EMPRESA,
    });
    expect(billingWithSavedCustomer(EMPRESA, empresaPlan, [NEW_ID])?.customerId).toBe(NEW_ID);
  });

  it('la nota cuenta lo guardado y nombra lo que falló, sin frenar nada', () => {
    expect(crmSaveNote(plan, [NEW_ID, NEW_ID])).toBe('Se guardaron 2 personas en Clientes.');
    expect(crmSaveNote(plan, [NEW_ID, null])).toBe(
      'Se guardó 1 persona en Clientes. No se pudo guardar en Clientes a: Adulto 2. Puedes agregarlos desde Clientes.',
    );
    expect(crmSaveNote({ items: [], skipped: [] }, [])).toBeNull();
    expect(crmSaveNote({ items: [], skipped: [BILLER_LABEL] }, [])).toContain(
      'Quien factura no se guardó en Clientes',
    );
  });
});
