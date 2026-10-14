import { describe, expect, it, vi } from 'vitest';
import type { BrandingService } from '../branding/branding.service.js';
import type { DatabaseService } from '../database/database.service.js';
import type { MailerService } from '../mail/mailer.service.js';
import { TEST_QUOTE_NOTICE } from '../mail/templates.js';
import type { ActiveTenantService } from '../request-context/active-tenant.service.js';
import { QuotationsController } from './quotations.controller.js';
import type { QuotationRow, QuotationsService } from './quotations.service.js';

/**
 * Una cotización con una tarifa de la cuenta de pruebas del proveedor, enviada al cliente: el
 * correo lo dice. La marca es la que escribió la búsqueda en `selected_offer.provider.environment`.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

function fila(environment?: 'test' | 'live'): QuotationRow {
  return {
    id: 'q1',
    tenant_id: TENANT,
    user_id: USER,
    status: 'draft',
    search_criteria: { origin: 'BOG', destination: 'LIM', departureDate: '2026-12-01' },
    selected_offer: {
      provider: {
        name: 'stub-air',
        offerRef: 'R-1',
        ...(environment === undefined ? {} : { environment }),
      },
      total: { amountMinor: 50_000, currency: 'USD' },
    },
    customer_name: 'Ana',
    customer_email: 'ana@x.test',
    customer_phone: null,
    notes: null,
    quote_number: 31,
    expires_at: new Date('2026-12-01T00:00:00Z'),
    created_at: new Date('2026-09-26T00:00:00Z'),
    updated_at: new Date('2026-09-26T00:00:00Z'),
  };
}

function enviar(row: QuotationRow) {
  const sendToTenant = vi.fn(
    (_tenantId: string, _mail: { to: string; subject: string; html: string; text: string }) =>
      Promise.resolve(true),
  );
  const controller = new QuotationsController(
    { findById: () => Promise.resolve(row) } as unknown as QuotationsService,
    {} as unknown as DatabaseService,
    { sendToTenant } as unknown as MailerService,
    {
      resolve: () => Promise.resolve({ name: 'Agencia Sur', color: null }),
    } as unknown as BrandingService,
    { resolve: () => Promise.resolve(TENANT) } as unknown as ActiveTenantService,
  );
  return { send: () => controller.sendEmail(USER, row.id), sendToTenant };
}

describe('POST /quotations/:id/send-email con una tarifa de pruebas', () => {
  it('sale con «[PRUEBA] » en el asunto y el aviso en el cuerpo', async () => {
    const b = enviar(fila('test'));

    await b.send();

    const mail = b.sendToTenant.mock.calls[0]?.[1];
    expect(mail?.subject.startsWith('[PRUEBA] ')).toBe(true);
    expect(mail?.html).toContain(TEST_QUOTE_NOTICE);
  });

  it.each([
    ['sin marca', undefined],
    ['live', 'live' as const],
  ])('una tarifa real (%s) sale como siempre', async (_caso, environment) => {
    const b = enviar(fila(environment));

    await b.send();

    const mail = b.sendToTenant.mock.calls[0]?.[1];
    expect(mail?.subject).toBe('Tu cotización de vuelo #31 · BOG → LIM');
    expect(mail?.html).not.toContain(TEST_QUOTE_NOTICE);
  });
});
