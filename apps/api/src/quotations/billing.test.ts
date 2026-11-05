import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CreateCustomerSchema } from '../customers/dto.js';
import { BillingSchema, decodeBilling, encodeBilling } from './billing.js';

process.env['PROVIDER_CREDENTIALS_KEY'] ??= randomBytes(32).toString('base64');

const empresa = {
  mode: 'other' as const,
  customerType: 'company' as const,
  name: 'Viajes Andinos SAS',
  documentType: 'NIT',
  documentNumber: '900123456-7',
  email: 'facturas@andinos.co',
  phone: '6015551234',
  address: 'Calle 100 # 10-20',
  city: 'Bogotá',
  countryCode: 'CO',
};

describe('facturación de la cotización (0091)', () => {
  it('el documento se guarda cifrado y se lee igual', () => {
    const billing = BillingSchema.parse(empresa);
    const stored = encodeBilling(billing);
    expect(stored).not.toContain('900123456-7');
    expect(decodeBilling(JSON.parse(stored))).toEqual(billing);
  });

  it('un registro roto se lee como «sin facturación», sin tumbar la cotización', () => {
    expect(decodeBilling({ mode: 'other' })).toBeNull();
    expect(decodeBilling(null)).toBeNull();
  });
});

describe('cliente persona o empresa', () => {
  it('una empresa no pide nacimiento, género ni nacionalidad', () => {
    expect(
      CreateCustomerSchema.safeParse({
        customerType: 'company',
        firstName: 'Viajes Andinos SAS',
        lastName: '',
        documentType: 'NIT',
        documentNumber: '900123456-7',
        documentIssuingCountry: 'CO',
      }).success,
    ).toBe(true);
  });

  it('una persona los sigue exigiendo', () => {
    const r = CreateCustomerSchema.safeParse({
      firstName: 'Ana',
      lastName: 'Paz',
      documentType: 'CC',
      documentNumber: '123',
      documentIssuingCountry: 'CO',
    });
    expect(r.success).toBe(false);
  });
});
