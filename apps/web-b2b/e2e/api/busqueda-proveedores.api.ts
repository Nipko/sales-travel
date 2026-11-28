import { expect, test } from '@playwright/test';
import { como, nodo, sql, type Api } from './support/cliente';

/**
 * Tanda 34 (docs/qa/01 §5 VUE, BYO y AGE): qué dice la búsqueda de vuelos de cada proveedor, con el
 * falso como único proveedor activo del stack E2E (LATAM y Sabre no tienen credenciales).
 *
 * - BYO-11: sin cuenta usable, LATAM y Sabre salen `unavailable` con su motivo en castellano.
 * - VUE-14: un proveedor apagado para la agencia sale `skipped` con su motivo; el apagado de emergencia
 *   corta la búsqueda en el acto y al levantarlo vuelve.
 * - VUE-15: con la cuota por hora agotada → 403 con el límite.
 * - VUE-13: el falso caído (ADZ) → 502 con su motivo; con un solo proveedor no hay resultado parcial.
 * - AGE-02: las tarifas salen en la moneda de la agencia (COP en A, PEN en B).
 */

test.skip(process.env['E2E_REAL'] === '1', 'el proveedor falso sólo vive en el stack E2E');
test.describe.configure({ mode: 'serial' });

interface Busqueda {
  offers: { total: { currency: string } }[];
  saleCurrency: string;
  providers: {
    code: string;
    status: string;
    reason?: string;
    skipReason?: string;
    unavailableReason?: string;
  }[];
  message?: string;
}

const criterio = (destination: string, dias = 70) => ({
  origin: 'BOG',
  destination,
  departureDate: new Date(Date.now() + dias * 86_400_000).toISOString().slice(0, 10),
  paxCount: { adults: 1, children: 0, infants: 0 },
});
const buscar = (api: Api, destination = 'MDE', dias = 70) =>
  api.post<Busqueda>('/search/flights', criterio(destination, dias));

test('BYO-11 / AGE-02 sin credenciales LATAM y Sabre dicen por qué; la moneda es la de la agencia', async () => {
  const a = await buscar(await como('vendedorA'));
  expect(a.status, a.text).toBe(201);
  const de = (code: string) => a.body.providers.find((p) => p.code === code);
  expect(de('fake-flights')).toMatchObject({ status: 'ok' });
  for (const code of ['latam-ndc', 'sabre']) {
    expect(de(code), code).toMatchObject({
      status: 'unavailable',
      unavailableReason: 'no-credentials',
    });
    expect(de(code)?.reason).toContain('no tiene credenciales propias ni heredadas');
  }
  expect(a.body.saleCurrency).toBe('COP');
  expect(new Set(a.body.offers.map((o) => o.total.currency))).toEqual(new Set(['COP']));

  const b = await buscar(await como('vendedorB'));
  expect(b.status, b.text).toBe(201);
  expect(b.body.saleCurrency).toBe('PEN');
  expect(new Set(b.body.offers.map((o) => o.total.currency))).toEqual(new Set(['PEN']));
});

test('VUE-14 apagado para la agencia → skipped con motivo; apagado de emergencia corta y vuelve', async () => {
  const sa = await como('superadmin');
  const vendedor = await como('vendedorEquipo');
  const equipo = await nodo('e2e-agencia-equipo');
  try {
    const off = await sa.put(`/admin/providers/fake-flights/tenants/${equipo}`, {
      enabled: false,
      reason: 'QA34 apagado para la agencia',
    });
    expect(off.status, off.text).toBeLessThan(300);
    await expect(async () => {
      const r = await buscar(vendedor, 'MDE', 71);
      const fake = r.body.providers?.find((p) => p.code === 'fake-flights');
      expect(fake).toMatchObject({ status: 'skipped', skipReason: 'platform-disabled' });
      expect(fake?.reason).toBe('Deshabilitado por la plataforma para esta agencia.');
      expect(r.body.offers).toHaveLength(0);
    }).toPass({ timeout: 20_000 });
  } finally {
    await sa.delete(`/admin/providers/fake-flights/tenants/${equipo}`);
  }

  try {
    const corte = await sa.put('/admin/providers/fake-flights/kill-switch', {
      level: 'sales',
      reason: 'QA34 apagado de emergencia',
      expiresInMinutes: 60,
    });
    expect(corte.status, corte.text).toBeLessThan(300);
    const r = await buscar(vendedor, 'MDE', 72);
    expect(r.status, 'en el acto: el falso es el único proveedor activo').toBe(502);
    expect(r.text).toContain('temporalmente deshabilitado');
  } finally {
    const clear = await sa.post('/admin/providers/fake-flights/kill-switch/clear', {
      reason: 'QA34 vuelve',
    });
    expect(clear.status, clear.text).toBeLessThan(300);
  }
  await expect(async () => {
    expect((await buscar(vendedor, 'MDE', 73)).status).toBe(201);
  }).toPass({ timeout: 20_000 });
});

test('VUE-15 cuota por hora agotada → 403 con el límite', async () => {
  const vendedor = await como('vendedorEquipo');
  expect((await buscar(vendedor, 'MDE', 74)).status).toBe(201);
  await sql(`UPDATE tenants SET search_quota_per_hour = 1 WHERE slug = 'e2e-agencia-equipo'`);
  try {
    const r = await buscar(vendedor, 'MDE', 75);
    expect(r.status).toBe(403);
    expect(r.body.message).toBe(
      'Se alcanzó el límite de 1 búsqueda por hora de esta agencia. Vuelve a intentarlo más tarde.',
    );
  } finally {
    await sql(`UPDATE tenants SET search_quota_per_hour = NULL WHERE slug = 'e2e-agencia-equipo'`);
  }
});

test('VUE-13 el proveedor caído responde con su motivo', async () => {
  const r = await buscar(await como('vendedorA'), 'ADZ', 76);
  expect(r.status, 'el falso es el único activo: sin parcial').toBe(502);
  expect(r.body.message).toBe('fake-flights: el proveedor no responde (perilla ADZ)');
});
