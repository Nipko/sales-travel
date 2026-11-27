import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { como, sql, type Api } from './support/cliente';

/**
 * Ola 4 del plan de QA (docs/qa/01 §5 CHK, POS, TRV) por HTTP, contra el proveedor de vuelos FALSO
 * del stack E2E (INF-4). En la Mac (`E2E_REAL=1`) no existe y se salta.
 *
 * - CHK-05: la tarifa cambió y el cliente no lo aceptó → 409, no se reserva.
 * - CHK-06: un total tocado en el navegador no pasa: el servidor revalida con el proveedor.
 * - CHK-07: pasajeros que no son los de la búsqueda → 400.
 * - CHK-14 / TRV-11: Idempotency-Key obligatoria y UUID; la misma clave no crea otra reserva.
 * - CHK-20: `payment` en el cuerpo → 400 (strict).
 * - POS-03: los pasajeros salen enmascarados en la lista y en el detalle.
 * - POS-06: cancelar una confirmada; cancelarla otra vez no hace nada nuevo.
 */
test.skip(process.env['E2E_REAL'] === '1', 'el proveedor falso sólo vive en el stack E2E');

interface Oferta {
  provider: { name: string; offerRef: string };
  total: { amountMinor: number; currency: string };
}

const dentroDe = (dias: number) =>
  new Date(Date.now() + dias * 86_400_000).toISOString().slice(0, 10);

const criterio = () => ({
  origin: 'BOG',
  destination: 'MDE',
  departureDate: dentroDe(50),
  paxCount: { adults: 1, children: 0, infants: 0 },
  currency: 'COP',
});

const pasajero = (surname = 'Arnes') => ({
  paxId: 'ADT_1',
  paxType: 'ADT',
  givenName: 'Prueba',
  surname,
  birthdate: '1990-05-15',
  gender: 'F',
  citizenshipCountryCode: 'CO',
  identityDoc: { type: 'CC', number: '1020304050', issuingCountryCode: 'CO' },
});

async function ofertas(api: Api, searchCriteria = criterio()) {
  const r = await api.post<{ offers: Oferta[] }>('/search/flights', searchCriteria);
  expect(r.status, r.text.slice(0, 200)).toBeLessThan(300);
  const falsas = r.body.offers.filter((o) => o.provider.name === 'fake-flights');
  const fija = falsas.find((o) => o.provider.offerRef.startsWith('FAKE-FIJO'))!;
  const cambia = falsas.find((o) => o.provider.offerRef.startsWith('FAKE-CAMBIA'))!;
  return { fija, cambia, searchCriteria };
}

const reservar = (api: Api, body: Record<string, unknown>, key: string | null = randomUUID()) =>
  api.pedir<{ order?: { id: string; status: string }; message?: string }>('POST', '/orders', {
    body,
    ...(key === null ? {} : { headers: { 'idempotency-key': key } }),
  });

const cuerpo = (offer: Oferta, searchCriteria: unknown, extra: Record<string, unknown> = {}) => ({
  offer,
  searchCriteria,
  passengers: [pasajero()],
  contactInfo: { email: 'pasajero-arnes@e2e.test', phone: '3001234567' },
  ...extra,
});

test('CHK-20 / CHK-07 / TRV-11 lo que el servidor rechaza antes de tocar al proveedor', async () => {
  const api = await como('vendedorA');
  const { fija, searchCriteria } = await ofertas(api);
  const malas: string[] = [];
  const casos: [string, Record<string, unknown>, string | null][] = [
    ['con payment', cuerpo(fija, searchCriteria, { payment: { type: 'Cash' } }), randomUUID()],
    [
      'dos pasajeros para una búsqueda de uno',
      cuerpo(fija, searchCriteria, {
        passengers: [pasajero(), { ...pasajero('Otra'), paxId: 'ADT_2' }],
      }),
      randomUUID(),
    ],
    ['sin Idempotency-Key', cuerpo(fija, searchCriteria), null],
    ['Idempotency-Key que no es UUID', cuerpo(fija, searchCriteria), 'clave-123'],
  ];
  for (const [caso, body, key] of casos) {
    const r = await reservar(api, body, key);
    if (r.status !== 400) malas.push(`${caso} → ${r.status} ${r.text.slice(0, 120)}`);
  }
  expect(malas, malas.join(' | ')).toEqual([]);
});

test('CHK-05 la tarifa cambió y no se aceptó: 409, sin reserva', async () => {
  const api = await como('vendedorA');
  const { cambia, searchCriteria } = await ofertas(api);
  const antes = await sql<{ n: string }>(
    `SELECT count(*) AS n FROM orders WHERE provider = 'fake-flights'`,
  );
  const r = await reservar(api, cuerpo(cambia, searchCriteria));
  expect(r.status, r.text.slice(0, 200)).toBe(409);
  expect(r.text).toMatch(/precio cambió/i);
  const despues = await sql<{ n: string }>(
    `SELECT count(*) AS n FROM orders WHERE provider = 'fake-flights' AND status NOT IN ('failed')`,
  );
  expect(Number(despues[0]!.n)).toBeLessThanOrEqual(Number(antes[0]!.n));
});

test('CHK-06 un total tocado en el navegador no se reserva a ese precio', async () => {
  const api = await como('vendedorA');
  const { fija, searchCriteria } = await ofertas(api);
  const tocada = { ...fija, total: { ...fija.total, amountMinor: 100 } };
  const r = await reservar(api, cuerpo(tocada, searchCriteria));
  if (r.status < 300) {
    const [o] = await sql<{ total_amount: string }>(
      'SELECT total_amount FROM orders WHERE id = $1',
      [r.body.order!.id],
    );
    expect(Number(o!.total_amount), 'el total lo pone el servidor').not.toBe(100);
  } else {
    expect(r.status, r.text.slice(0, 200)).toBe(409);
  }
});

test('CHK-14 la misma Idempotency-Key dos veces: una sola reserva', async () => {
  const api = await como('vendedorA');
  const { fija, searchCriteria } = await ofertas(api);
  const key = randomUUID();
  const body = cuerpo(fija, searchCriteria);
  const [a, b] = await Promise.all([reservar(api, body, key), reservar(api, body, key)]);
  const ok = [a, b].filter((r) => r.status < 300);
  expect(ok.length, `${a.status} / ${b.status}`).toBeGreaterThanOrEqual(1);
  const filas = await sql<{ n: string }>(
    `SELECT count(*) AS n FROM orders WHERE create_request_key = $1`,
    [`c:${key}`],
  );
  expect(Number(filas[0]!.n)).toBe(1);
  // El segundo envío no abre otra: o devuelve la misma o un 409 de duplicado.
  for (const r of [a, b]) expect([200, 201, 409]).toContain(r.status);
});

test('POS-03 / POS-06 pasajeros enmascarados; cancelar una confirmada y otra vez', async () => {
  const api = await como('vendedorA');
  const { fija, searchCriteria } = await ofertas(api);
  const r = await reservar(
    api,
    cuerpo(fija, searchCriteria, { passengers: [pasajero('Enmascarada')] }),
  );
  expect(r.status, r.text.slice(0, 200)).toBeLessThan(300);
  const id = r.body.order!.id;

  const lista = await api.get<{ orders: { id: string; passengers: unknown }[] }>('/orders');
  const enLista = JSON.stringify(lista.body.orders.find((o) => o.id === id)?.passengers ?? []);
  const detalle = await api.get(`/orders/${id}`);
  for (const [donde, texto] of [
    ['lista', enLista],
    ['detalle', detalle.text],
  ] as const) {
    // El número del documento (y el de viajero frecuente) sale por sus últimos 4: public-order-passengers.ts.
    expect(texto, donde).not.toContain('1020304050');
    expect(texto, donde).toContain('4050');
  }

  const cancelar = await api.post(`/orders/${id}/cancel`, {});
  expect(cancelar.status, cancelar.text.slice(0, 200)).toBeLessThan(300);
  const [fila] = await sql<{ status: string }>('SELECT status FROM orders WHERE id = $1', [id]);
  expect(fila?.status).toBe('cancelled');
  const otraVez = await api.post(`/orders/${id}/cancel`, {});
  expect(otraVez.status, 'cancelar dos veces no es un éxito nuevo').toBeGreaterThanOrEqual(400);
});
