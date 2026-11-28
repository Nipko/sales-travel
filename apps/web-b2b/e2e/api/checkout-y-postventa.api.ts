import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { correosPara, hayBuzon, ultimoCorreo } from '../support/correo';
import { como, nodo, sql, type Api } from './support/cliente';

/**
 * Tanda 35 (docs/qa/01 §5 CHK, POS y BYO), por HTTP con el proveedor falso:
 *
 * - CHK-22: una reserva del falso (tarifa de prueba) no manda el correo de confirmación automático.
 * - POS-15: reenviarlo a mano llega con «[PRUEBA]» y el PNR; de una cancelada → 409.
 * - CHK-07: la edad del niño según su nacimiento distinta de la buscada → 400 con su motivo; un niño
 *   fuera de 2–11 → 400 en su campo.
 * - BYO-05: una cuenta con reservas activas no se deshabilita ni deja de heredarse (409
 *   PROVIDER_ACCOUNT_IN_USE con el número); sin reservas sí.
 */

test.skip(process.env['E2E_REAL'] === '1', 'el proveedor falso sólo vive en el stack E2E');
test.describe.configure({ mode: 'serial' });

const corrida = Date.now().toString(36);
interface ErrorApi {
  message: string;
  reason?: string;
  details?: { activeOrders?: number };
  fields?: { field: string; message: string }[];
}
interface Oferta {
  provider: { name: string; offerRef: string };
}

let vendedor: Api;
const salida = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);

async function oferta(
  paxCount: Record<string, unknown>,
): Promise<{ offer: Oferta; searchCriteria: unknown }> {
  const searchCriteria = {
    origin: 'BOG',
    destination: 'MDE',
    departureDate: salida,
    paxCount,
    currency: 'COP',
  };
  const r = await vendedor.post<{ offers: Oferta[] }>('/search/flights', searchCriteria);
  expect(r.status, r.text).toBeLessThan(300);
  const offer = r.body.offers.find(
    (o) => o.provider.name === 'fake-flights' && o.provider.offerRef.startsWith('FAKE-FIJO'),
  );
  expect(offer).toBeDefined();
  return { offer: offer!, searchCriteria };
}

const adulto = {
  paxId: 'ADT_1',
  paxType: 'ADT',
  givenName: 'Postventa',
  surname: 'Prueba',
  birthdate: '1990-05-15',
  gender: 'F',
  citizenshipCountryCode: 'CO',
  identityDoc: { type: 'CC', number: '1020304050', issuingCountryCode: 'CO' },
};

async function reservar(email: string): Promise<{ id: string; orderNumber: number; pnr?: string }> {
  const { offer, searchCriteria } = await oferta({ adults: 1, children: 0, infants: 0 });
  const r = await vendedor.pedir<{ order: { id: string; orderNumber: number; pnr?: string } }>(
    'POST',
    '/orders',
    {
      headers: { 'idempotency-key': randomUUID() },
      body: {
        offer,
        searchCriteria,
        passengers: [adulto],
        contactInfo: { email, phone: '3001234567' },
      },
    },
  );
  expect(r.status, r.text).toBeLessThan(300);
  return r.body.order;
}

test.beforeAll(async () => {
  vendedor = await como('vendedorA');
});

test('CHK-22 / POS-15 sin correo automático en una tarifa de prueba; reenviarlo llega con [PRUEBA]', async () => {
  test.skip(!(await hayBuzon()), 'este stack no tiene Mailpit (INF-3)');
  const email = `qa35-${corrida}@e2e.test`;
  const desde = new Date(Date.now() - 1_000);
  const orden = await reservar(email);
  await new Promise((r) => setTimeout(r, 5_000));
  expect(await correosPara(email, desde), 'la tarifa de prueba no manda el correo solo').toBe(0);

  const envio = await vendedor.post<{ sent: boolean; to: string }>(
    `/orders/${orden.id}/send-confirmation`,
    {},
  );
  expect(envio.status, envio.text).toBe(200);
  expect(envio.body).toMatchObject({ sent: true, to: email });
  const correo = await ultimoCorreo(email, { desde, esperaMs: 15_000 });
  expect(correo?.asunto).toMatch(
    new RegExp(`^\\[PRUEBA\\] Reserva registrada #${orden.orderNumber} · PNR `),
  );
  expect(correo?.texto).toContain('Reserva de prueba: no es un tiquete válido para viajar.');

  const cancelada = await vendedor.post(`/orders/${orden.id}/cancel`, {});
  expect(cancelada.status, cancelada.text).toBeLessThan(300);
  const otra = await vendedor.post<ErrorApi>(`/orders/${orden.id}/send-confirmation`, {});
  expect(otra.status).toBe(409);
  expect(otra.body.message).toBe(
    'Sólo se puede enviar la confirmación de una reserva confirmada o emitida.',
  );
});

test('CHK-07 edad del niño según su nacimiento', async () => {
  const { offer, searchCriteria } = await oferta({
    adults: 1,
    children: 1,
    infants: 0,
    childAges: [8],
  });
  const nino = (birthdate: string) => ({
    ...adulto,
    paxId: 'CHD_1',
    paxType: 'CHD',
    givenName: 'Nino',
    birthdate,
  });
  const anios = (n: number) => {
    const d = new Date(`${salida}T00:00:00Z`);
    d.setUTCFullYear(d.getUTCFullYear() - n);
    d.setUTCMonth(d.getUTCMonth() - 1);
    return d.toISOString().slice(0, 10);
  };
  const pedir = (birthdate: string) =>
    vendedor.pedir<ErrorApi>('POST', '/orders', {
      headers: { 'idempotency-key': randomUUID() },
      body: {
        offer,
        searchCriteria,
        passengers: [adulto, nino(birthdate)],
        contactInfo: { email: `qa35-nino-${corrida}@e2e.test`, phone: '3001234567' },
      },
    });

  const otraEdad = await pedir(anios(5));
  expect(otraEdad.status).toBe(400);
  expect(otraEdad.body.message).toBe(
    'La edad de un niño según su fecha de nacimiento no coincide con la de la búsqueda. Vuelve a buscar con la edad que tendrá el día del viaje.',
  );

  const grande = await pedir(anios(13));
  expect(grande.status).toBe(400);
  expect(grande.body.message).toBe(
    'El pasajero 2 no tiene la edad de su tipo (CHD) el día del viaje.',
  );
  expect(grande.body.fields?.[0]?.field).toBe('passengers.1.birthdate');
});

test('BYO-05 una cuenta con reservas activas no se deshabilita ni deja de heredarse', async () => {
  const cons = await como('consolidador');
  const consolidador = await nodo('e2e-consolidador');
  const label = `qa35-${corrida}`;
  const cuenta = (extra: Record<string, unknown>) =>
    cons.post<ErrorApi>('/provider-accounts', {
      tenantId: consolidador,
      providerCode: 'agent-cars',
      label,
      config: {},
      ...extra,
    });
  expect(
    (
      await cuenta({
        credentials: { accessToken: `t-${corrida}` },
        status: 'active',
        isInheritable: true,
      })
    ).status,
  ).toBeLessThan(300);
  const [acc] = await sql<{ id: string }>(
    `SELECT id FROM provider_accounts WHERE tenant_id = $1 AND provider_code = 'agent-cars' AND label = $2`,
    [consolidador, label],
  );
  const orden = await reservar(`qa35-byo-${corrida}@e2e.test`);
  await sql('UPDATE orders SET provider_account_id = $1 WHERE id = $2', [acc!.id, orden.id]);
  try {
    const noHeredar = await cuenta({
      keepCredentials: true,
      status: 'active',
      isInheritable: false,
    });
    expect(noHeredar.status, noHeredar.text).toBe(409);
    expect(noHeredar.body.reason).toBe('PROVIDER_ACCOUNT_IN_USE');
    expect(noHeredar.body.details?.activeOrders).toBe(1);
    expect(noHeredar.body.message).toContain('No se puede dejar de heredar hasta que terminen');

    const apagar = await cuenta({ keepCredentials: true, status: 'disabled', isInheritable: true });
    expect(apagar.status).toBe(409);
    expect(apagar.body.message).toContain('No se puede desactivar hasta que terminen');
  } finally {
    await sql('UPDATE orders SET provider_account_id = NULL WHERE id = $1', [orden.id]);
  }
  const libre = await cuenta({ keepCredentials: true, status: 'disabled', isInheritable: true });
  expect(libre.status, 'sin reservas activas sí se deshabilita').toBeLessThan(300);
});
