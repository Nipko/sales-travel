import { ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { BrandingService } from '../branding/branding.service.js';
import type { MailerService } from '../mail/mailer.service.js';
import { TEST_CONTENT_NOTICE } from '../mail/templates.js';
import type { HotelOrderReadsService } from './hotel-order-reads.service.js';
import {
  OrderConfirmationService,
  contactEmail,
  isTestContent,
} from './order-confirmation.service.js';
import type { OrderRow } from './orders.service.js';

/**
 * El correo de confirmación, fuera de OrdersController: el mismo para Reservas de la agencia y para
 * el reenvío del superadmin desde Reservas de la red. Las salidas son las de antes (los tests del
 * controlador, `orders.controller.*.test.ts`, siguen pasando por aquí); esto prueba el servicio
 * solo y lo que cambia según el nodo.
 */

const AGENCIA = '11111111-1111-4111-8111-111111111111';
const OTRA = '33333333-3333-4333-8333-333333333333';

function fila(extra: Partial<OrderRow> = {}): OrderRow {
  return {
    id: 'o1',
    tenant_id: AGENCIA,
    user_id: 'u1',
    quotation_id: null,
    provider: 'stub-air',
    provider_order_id: 'PNR001',
    status: 'confirmed',
    search_criteria: { origin: 'BOG', destination: 'LIM', departureDate: '2026-12-01' },
    selected_offer: { provider: { name: 'stub-air', offerRef: 'R-1' } },
    passengers: [{ givenName: 'Ana', surname: 'Ríos' }],
    contact_info: { email: 'ana@x.test' },
    total_amount: 34012,
    currency: 'USD',
    order_number: 7,
    provider_raw: null,
    error_message: null,
    create_request_key: null,
    provider_booking_ref: null,
    provider_account_id: null,
    created_at: new Date('2026-09-26T00:00:00Z'),
    updated_at: new Date('2026-09-26T00:00:00Z'),
    ...extra,
  };
}

function banco(opts: { hotel?: boolean; sent?: boolean } = {}) {
  const sendToTenant = vi.fn(
    (_tenantId: string, _mail: { to: string; subject: string; html: string; text: string }) =>
      Promise.resolve(opts.sent ?? true),
  );
  const resolve = vi.fn((tenantId: string) =>
    Promise.resolve({
      name: tenantId === AGENCIA ? 'Agencia Sur' : 'Otra Agencia',
      color: null,
    }),
  );
  const hotelReads = { handles: () => opts.hotel ?? false } as unknown as HotelOrderReadsService;
  const service = new OrderConfirmationService(
    { sendToTenant } as unknown as MailerService,
    { resolve } as unknown as BrandingService,
    hotelReads,
  );
  return { service, sendToTenant, resolve };
}

describe('OrderConfirmationService.send', () => {
  it('con la marca y el correo del nodo que se le pasa, al contacto de la reserva', async () => {
    const b = banco();

    await expect(b.service.send(AGENCIA, fila())).resolves.toEqual({
      sent: true,
      to: 'ana@x.test',
    });

    expect(b.resolve).toHaveBeenCalledWith(AGENCIA);
    expect(b.sendToTenant).toHaveBeenCalledTimes(1);
    const [tenant, mail] = b.sendToTenant.mock.calls[0]!;
    expect(tenant).toBe(AGENCIA);
    expect(mail.to).toBe('ana@x.test');
    expect(mail.subject).toBe('Reserva registrada #7 · PNR PNR001');
    expect(mail.html).toContain('Agencia Sur');
  });

  it('otro nodo, otra marca: el correo sale con la de quien se le pasa', async () => {
    const b = banco();
    await b.service.send(OTRA, fila());
    expect(b.sendToTenant.mock.calls[0]?.[0]).toBe(OTRA);
    expect(b.sendToTenant.mock.calls[0]?.[1].html).toContain('Otra Agencia');
  });

  it('sin correo de contacto no manda nada', async () => {
    const b = banco();
    await expect(b.service.send(AGENCIA, fila({ contact_info: {} }))).resolves.toEqual({
      sent: false,
      to: '',
    });
    expect(b.sendToTenant).not.toHaveBeenCalled();
    expect(b.resolve).not.toHaveBeenCalled();
  });

  it('si el correo no sale, lo dice', async () => {
    const b = banco({ sent: false });
    await expect(b.service.send(AGENCIA, fila())).resolves.toEqual({
      sent: false,
      to: 'ana@x.test',
    });
  });

  it('una reserva de hotel lleva su plantilla, con el localizador', async () => {
    const b = banco({ hotel: true });
    await b.service.send(
      AGENCIA,
      fila({ provider: 'tbo-hotels', provider_order_id: 'TBO-9', search_criteria: {} }),
    );
    const mail = b.sendToTenant.mock.calls[0]?.[1];
    expect(mail?.subject).toContain('#7');
    expect(mail?.html).toContain('TBO-9');
    expect(mail?.subject).not.toContain('PNR');
  });

  it('una emitida dice emitida; una de pruebas va marcada', async () => {
    const b = banco();
    await b.service.send(
      AGENCIA,
      fila({
        status: 'ticketed',
        selected_offer: { provider: { name: 'stub-air', offerRef: 'R', environment: 'test' } },
      }),
    );
    const mail = b.sendToTenant.mock.calls[0]?.[1];
    expect(mail?.subject.startsWith('[PRUEBA] ')).toBe(true);
    expect(mail?.html).toContain(TEST_CONTENT_NOTICE);
  });
});

describe('OrderConfirmationService.resend: las reglas del reenvío', () => {
  it('confirmada o emitida, con correo: la manda', async () => {
    for (const status of ['confirmed', 'ticketed'] as const) {
      const b = banco();
      await expect(b.service.resend(AGENCIA, fila({ status }))).resolves.toEqual({
        sent: true,
        to: 'ana@x.test',
      });
    }
  });

  it('sin correo de contacto, 404 antes de mirar el estado', async () => {
    const b = banco();
    await expect(
      b.service.resend(AGENCIA, fila({ contact_info: null, status: 'pending' })),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(b.sendToTenant).not.toHaveBeenCalled();
  });

  it('pendiente, fallida o cancelada: 409, no se le confirma al cliente lo que no existe', async () => {
    for (const status of ['pending', 'failed', 'cancelled'] as const) {
      const b = banco();
      await expect(b.service.resend(AGENCIA, fila({ status }))).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(b.sendToTenant).not.toHaveBeenCalled();
    }
  });
});

describe('lo que lee de la fila', () => {
  it('contactEmail: sólo un texto en contact_info.email', () => {
    expect(contactEmail({ contact_info: { email: 'a@b.co' } })).toBe('a@b.co');
    expect(contactEmail({ contact_info: { email: 7 } })).toBe('');
    expect(contactEmail({ contact_info: { phone: '1' } })).toBe('');
    expect(contactEmail({ contact_info: null })).toBe('');
    expect(contactEmail({ contact_info: 'a@b.co' })).toBe('');
  });

  it('isTestContent: el entorno que estampó el servidor en la oferta', () => {
    expect(isTestContent({ selected_offer: { provider: { environment: 'test' } } })).toBe(true);
    expect(isTestContent({ selected_offer: { provider: { environment: 'live' } } })).toBe(false);
    expect(isTestContent({ selected_offer: null })).toBe(false);
  });
});
