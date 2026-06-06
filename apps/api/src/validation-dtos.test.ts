import { describe, expect, it } from 'vitest';
import { CreateCustomerSchema, UpdateCustomerSchema } from './customers/dto.js';
import { CreateOrderSchema } from './orders/dto.js';
import { CreateQuotationSchema, QuotationStatusSchema } from './quotations/dto.js';
import { UpsertProviderAccountSchema } from './provider-credentials/dto.js';

const validCustomer = {
  firstName: 'Ana',
  lastName: 'García',
  documentType: 'PASAPORTE',
  documentNumber: 'AB1234567',
  documentIssuingCountry: 'COL',
  birthdate: '1990-05-12',
  gender: 'F',
  nationality: 'COL',
  passportExpiry: '2030-01-01',
};

describe('CreateCustomerSchema', () => {
  it('accepts a valid customer (client real payload: COL / PASAPORTE)', () => {
    expect(CreateCustomerSchema.safeParse(validCustomer).success).toBe(true);
  });

  it('rejects a missing document number', () => {
    const { documentNumber, ...rest } = validCustomer;
    void documentNumber;
    expect(CreateCustomerSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects a malformed email and an unparseable birthdate', () => {
    expect(
      CreateCustomerSchema.safeParse({ ...validCustomer, email: 'not-an-email' }).success,
    ).toBe(false);
    expect(CreateCustomerSchema.safeParse({ ...validCustomer, birthdate: 'nope' }).success).toBe(
      false,
    );
  });

  it('strips unknown top-level keys but keeps preferences object verbatim', () => {
    const parsed = CreateCustomerSchema.parse({
      ...validCustomer,
      preferences: { seat: 'window', meal: 'VGML' },
      injected: 'x',
    });
    expect(parsed.preferences).toEqual({ seat: 'window', meal: 'VGML' });
    expect('injected' in parsed).toBe(false);
  });

  it('UpdateCustomerSchema accepts an empty patch', () => {
    expect(UpdateCustomerSchema.safeParse({}).success).toBe(true);
  });
});

describe('CreateOrderSchema', () => {
  const base = {
    offer: { id: 'off_1', price: { totalMinor: 1000 } },
    searchCriteria: { origin: 'BOG', destination: 'MDE' },
    passengers: [{ firstName: 'Ana', lastName: 'García', documentNumber: 'AB1' }],
    contactInfo: { email: 'ana@example.com', phone: '+57300' },
  };

  it('accepts a valid order and preserves nested provider keys', () => {
    const parsed = CreateOrderSchema.parse(base);
    expect((parsed.offer as { id: string }).id).toBe('off_1');
    expect(parsed.passengers[0]).toMatchObject({ documentNumber: 'AB1' });
  });

  it('rejects zero passengers and a non-object offer', () => {
    expect(CreateOrderSchema.safeParse({ ...base, passengers: [] }).success).toBe(false);
    expect(CreateOrderSchema.safeParse({ ...base, offer: 'oops' }).success).toBe(false);
  });

  it('rejects an invalid contact email', () => {
    expect(CreateOrderSchema.safeParse({ ...base, contactInfo: { email: 'bad' } }).success).toBe(
      false,
    );
  });
});

describe('CreateQuotationSchema / QuotationStatusSchema', () => {
  const base = {
    searchCriteria: { origin: 'BOG' },
    selectedOffer: { id: 'off_1' },
    expiresAt: '2030-01-01T00:00:00.000Z',
  };

  it('accepts a valid quotation', () => {
    expect(CreateQuotationSchema.safeParse(base).success).toBe(true);
  });

  it('rejects an unparseable expiresAt and a bad customer email', () => {
    expect(CreateQuotationSchema.safeParse({ ...base, expiresAt: 'soon' }).success).toBe(false);
    expect(CreateQuotationSchema.safeParse({ ...base, customerEmail: 'x' }).success).toBe(false);
  });

  it('status enum accepts known values and rejects others', () => {
    expect(QuotationStatusSchema.safeParse('sent').success).toBe(true);
    expect(QuotationStatusSchema.safeParse('bogus').success).toBe(false);
  });
});

describe('UpsertProviderAccountSchema', () => {
  const base = {
    tenantId: '11111111-1111-1111-1111-111111111111',
    providerCode: 'latam-ndc',
    credentials: { apiKey: 'k', apiSecret: 's' },
  };

  it('accepts a valid upsert', () => {
    expect(UpsertProviderAccountSchema.safeParse(base).success).toBe(true);
  });

  it('rejects empty credentials, a bad providerCode and a non-uuid tenantId', () => {
    expect(UpsertProviderAccountSchema.safeParse({ ...base, credentials: {} }).success).toBe(false);
    expect(
      UpsertProviderAccountSchema.safeParse({ ...base, providerCode: 'BAD_CODE' }).success,
    ).toBe(false);
    expect(UpsertProviderAccountSchema.safeParse({ ...base, tenantId: 'nope' }).success).toBe(
      false,
    );
  });
});
