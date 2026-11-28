import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { como } from './support/cliente';

/**
 * Tanda 22 (docs/qa/01 §5 HOT): HOT-09, el contacto de la reserva de hotel se valida en el borde de la
 * API antes de tocar al proveedor. El stack E2E no tiene hoteles falsos: un cuerpo válido pasa el borde y
 * lo frena el servicio con su `reason` (proveedor deshabilitado o prebook vencido); uno con el contacto
 * mal, 400 con el campo.
 */

interface ErrorApi {
  reason?: string;
  fields?: { field: string; message: string }[];
}

const reserva = (contacto: { email?: string; countryCode?: string; number?: string }) => ({
  providerCode: 'tbo-hotels',
  prebookRef: randomUUID(),
  acceptedTotal: { amountMinor: 10_000, currency: 'USD' },
  rooms: [{ guests: [{ paxType: 'ADT', title: 'Mr', firstName: 'Ana', lastName: 'Ruiz' }] }],
  contact: {
    email: contacto.email ?? 'cliente@correo.co',
    phone: { countryCode: contacto.countryCode ?? '+57', number: contacto.number ?? '3001234567' },
  },
});

test('HOT-09 correo, prefijo y teléfono (4–20, al menos 4 dígitos) → 400 en su campo', async () => {
  const api = await como('vendedorA');
  const reservar = (body: unknown) =>
    api.pedir<ErrorApi>('POST', '/hotels/book', {
      body,
      headers: { 'idempotency-key': randomUUID() },
    });

  const bien = await reservar(reserva({}));
  expect(bien.body.fields, `un contacto válido pasa el borde: ${bien.text}`).toBeUndefined();
  expect(bien.body.reason, 'lo frena el servicio (proveedor o prebook), no el borde').toBeTruthy();

  for (const [caso, contacto, campo] of [
    ['correo sin dominio', { email: 'cliente@' }, 'contact.email'],
    ['prefijo de 4 dígitos', { countryCode: '+5712' }, 'contact.phone.countryCode'],
    ['prefijo con letras', { countryCode: 'CO' }, 'contact.phone.countryCode'],
    ['teléfono de 3', { number: '123' }, 'contact.phone.number'],
    ['teléfono de 21', { number: '1'.repeat(21) }, 'contact.phone.number'],
    ['teléfono sin dígitos', { number: '----' }, 'contact.phone.number'],
    ['teléfono con 3 dígitos', { number: '1 2-3' }, 'contact.phone.number'],
    ['teléfono con letras', { number: '300ABC4567' }, 'contact.phone.number'],
  ] as const) {
    const r = await reservar(reserva(contacto));
    expect(r.status, caso).toBe(400);
    expect(
      r.body.fields?.map((f) => f.field),
      caso,
    ).toContain(campo);
  }
});
