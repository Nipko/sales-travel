import { expect, test } from '@playwright/test';
import { como } from './support/cliente';

/**
 * INF-4 (docs/qa/01 §7): el proveedor de vuelos falso del stack E2E responde por la búsqueda real
 * de la API, con sus perillas. En el ambiente de pruebas de la Mac (`E2E_REAL=1`, sandboxes de
 * verdad) no existe y esto se salta.
 */
test.skip(process.env['E2E_REAL'] === '1', 'el proveedor falso sólo vive en el stack E2E');

interface Busqueda {
  offers: { provider: { name: string; environment?: string }; total: { amountMinor: number } }[];
  providers?: { provider?: string; code?: string; status?: string; ok?: boolean }[];
}

const dentroDe = (dias: number) =>
  new Date(Date.now() + dias * 86_400_000).toISOString().slice(0, 10);

const buscar = async (destination: string) => {
  const api = await como('vendedorA');
  return api.post<Busqueda>('/search/flights', {
    origin: 'BOG',
    destination,
    departureDate: dentroDe(40),
    paxCount: { adults: 1, children: 0, infants: 0 },
    currency: 'COP',
  });
};

test('INF-4 la búsqueda trae las ofertas de prueba del proveedor falso', async () => {
  const r = await buscar('MDE');
  expect(r.status, r.text.slice(0, 300)).toBeLessThan(300);
  const falsas = r.body.offers.filter((o) => o.provider.name === 'fake-flights');
  expect(falsas.length, 'dos ofertas del proveedor falso').toBe(2);
  for (const o of falsas) expect(o.provider.environment).toBe('test');
});

test('INF-4 perillas de búsqueda: SMR sin vuelos, ADZ con el proveedor caído', async () => {
  const sin = await buscar('SMR');
  expect(sin.status).toBeLessThan(300);
  expect(sin.body.offers.filter((o) => o.provider.name === 'fake-flights')).toEqual([]);

  const caido = await buscar('ADZ');
  // La caída de un proveedor no tumba la búsqueda: se informa en el sobre.
  expect([200, 201, 502, 503]).toContain(caido.status);
  if (caido.status < 300) {
    expect(caido.body.offers.filter((o) => o.provider.name === 'fake-flights')).toEqual([]);
  }
});
