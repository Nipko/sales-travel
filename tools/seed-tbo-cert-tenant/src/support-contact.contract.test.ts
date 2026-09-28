import { beforeAll, describe, expect, it } from 'vitest';
import { isInternationalPhone, resolveSeedEnv, type SeedEnv } from './env.js';

/**
 * El contacto de soporte que siembra el seed es el que el Book del api acepta (D-TBO-23 A;
 * apps/api/src/hotels/hotel-booking-contact.ts) y el que _Mi Agencia_ guarda sin corregir
 * (apps/api/src/tenants/branding.schemas.ts). Se prueba contra los módulos del api, importados por
 * ruta en tiempo de ejecución como en `crypto.contract.test.ts`: si el api endurece la regla, falla
 * aquí y no en el primer _Confirmar reserva_ de un tester de TBO.
 */
const API_SRC = new URL('../../../apps/api/src/', import.meta.url);

interface ApiPhone {
  readonly countryCode: string;
  readonly number: string;
}

interface ApiBookingContact {
  agencyBookingContact(support: {
    email: string | null;
    phone: string | null;
  }): { email: string; phone: ApiPhone } | undefined;
  parseInternationalPhone(raw: string | null): ApiPhone | undefined;
}

interface ApiBrandingSchemas {
  readonly UpdateBrandingSchema: { safeParse(input: unknown): { success: boolean } };
}

let api: { contact: ApiBookingContact; branding: ApiBrandingSchemas };

beforeAll(async () => {
  api = {
    contact: (await import(
      new URL('hotels/hotel-booking-contact.ts', API_SRC).href
    )) as ApiBookingContact,
    branding: (await import(
      new URL('tenants/branding.schemas.ts', API_SRC).href
    )) as ApiBrandingSchemas,
  };
});

function env(overrides: Record<string, string> = {}): SeedEnv {
  return {
    PGHOST: 'postgres',
    PGUSER: 'postgres',
    PGPASSWORD: 'pg-admin-password',
    PROVIDER_CREDENTIALS_KEY: Buffer.alloc(32, 3).toString('base64'),
    CERT_TBO_USERNAME: 'tbo-test-user',
    CERT_TBO_PASSWORD: 'tbo-test-password',
    CERT_VENDEDOR_PASSWORD: 'vendedor-Cert-2026!',
    ...overrides,
  };
}

function contactOf(overrides: Record<string, string> = {}): { email: string; phone: string } {
  const { tenant } = resolveSeedEnv(env(overrides));
  return { email: tenant.supportEmail, phone: tenant.supportPhone };
}

describe('contacto de soporte compartido con el api', () => {
  it('el de por defecto lo acepta el Book, con el prefijo de país separado', () => {
    const { email, phone } = contactOf();
    expect(api.contact.agencyBookingContact({ email, phone })).toEqual({
      email,
      phone: { countryCode: '1', number: '2025550100' },
    });
  });

  it.each([
    '+1 202 555 0100',
    '+57 300 000 0000',
    '+57 (601) 000-0000',
    '+57.300.000.0000',
    ' +51 1 000 0000 ',
    '+55 11 0000 0000',
    '+123456',
    '+1234567',
    '+123456789012345',
    '573000000000',
    '+0 300 000 0000',
    '++57 300 000 0000',
    '+57 300',
    '+1234567890123456',
    '+57 300 000 0000 ext 1',
    '+57/300/000/0000',
    '+',
    '',
  ])('%j: el seed lo acepta sólo si el Book lo acepta', (raw) => {
    expect(isInternationalPhone(raw)).toBe(api.contact.parseInternationalPhone(raw) !== undefined);
  });

  it.each<Record<string, string>>([
    {},
    { CERT_SUPPORT_EMAIL: 'Reservas.QA@Example.com', CERT_SUPPORT_PHONE: '+57 (601) 000-0000' },
    { CERT_SUPPORT_EMAIL: 'ops+tbo@planetour.cloud', CERT_SUPPORT_PHONE: '+51 1 000 0000' },
  ])('lo que el seed acepta (%j) lo acepta el Book y lo guarda Mi Agencia', (overrides) => {
    const contact = contactOf(overrides);
    expect(api.contact.agencyBookingContact(contact)).toBeDefined();
    expect(
      api.branding.UpdateBrandingSchema.safeParse({
        supportEmail: contact.email,
        supportPhone: contact.phone,
      }).success,
    ).toBe(true);
  });
});
