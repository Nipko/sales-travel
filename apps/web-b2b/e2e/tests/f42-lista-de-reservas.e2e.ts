import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { storageStateFile } from '../support/auth';
import { apiComo, fechaEn } from '../support/venta';

/**
 * Mis Reservas (docs/qa/01 §5 POS) en el navegador, con dos reservas que el test crea por la API
 * contra el proveedor de vuelos FALSO (INF-4): una confirmada y una cancelada, con apellidos únicos.
 *
 * - POS-01: buscar por pasajero y por número; los chips de estado filtran; `?orden=<id>` abre esa
 *   reserva.
 * - QA-H-48: el detalle y los dos formularios de Clientes son diálogos de verdad (role="dialog",
 *   nombre, Escape los cierra).
 */
test.skip(process.env['E2E_REAL'] === '1', 'el proveedor falso sólo vive en el stack E2E');
test.use({ storageState: storageStateFile('vendedorA') });

interface Oferta {
  provider: { name: string; offerRef: string };
}
interface Orden {
  id: string;
  orderNumber: number;
  status: string;
}

const sufijo = Date.now().toString(36).toUpperCase().replace(/[0-9]/g, 'X');

async function reservarPorApi(apellido: string): Promise<Orden> {
  const api = await apiComo('vendedorA');
  try {
    const searchCriteria = {
      origin: 'BOG',
      destination: 'MDE',
      departureDate: fechaEn(47).toISOString().slice(0, 10),
      paxCount: { adults: 1, children: 0, infants: 0 },
      currency: 'COP',
    };
    const busqueda = await api.post('search/flights', { data: searchCriteria });
    expect(busqueda.ok(), await busqueda.text()).toBeTruthy();
    const { offers } = (await busqueda.json()) as { offers: Oferta[] };
    const offer = offers.find(
      (o) => o.provider.name === 'fake-flights' && o.provider.offerRef.startsWith('FAKE-FIJO'),
    );
    expect(offer, 'el falso da su tarifa fija').toBeDefined();
    const r = await api.post('orders', {
      headers: { 'idempotency-key': randomUUID() },
      data: {
        offer,
        searchCriteria,
        passengers: [
          {
            paxId: 'ADT_1',
            paxType: 'ADT',
            givenName: 'Lista',
            surname: apellido,
            birthdate: '1990-05-15',
            gender: 'F',
            citizenshipCountryCode: 'CO',
            identityDoc: { type: 'CC', number: '1020304050', issuingCountryCode: 'CO' },
          },
        ],
        contactInfo: { email: 'pasajero-lista@e2e.test', phone: '3001234567' },
      },
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    return ((await r.json()) as { order: Orden }).order;
  } finally {
    await api.dispose();
  }
}

async function cancelarPorApi(id: string): Promise<void> {
  const api = await apiComo('vendedorA');
  try {
    const r = await api.post(`orders/${id}/cancel`, { data: {} });
    expect(r.ok(), await r.text()).toBeTruthy();
  } finally {
    await api.dispose();
  }
}

const buscador = (page: Page) => page.getByPlaceholder('Buscar por #, código, pasajero o ruta');

test.describe('lista de reservas', { tag: '@desktop' }, () => {
  test.setTimeout(120_000);
  let confirmada: Orden;
  let cancelada: Orden;

  test.beforeAll(async () => {
    confirmada = await reservarPorApi(`CONF${sufijo}`);
    cancelada = await reservarPorApi(`CANC${sufijo}`);
    await cancelarPorApi(cancelada.id);
  });

  test('POS-01 búsqueda por pasajero y por número, y chips de estado', async ({ page }) => {
    await page.goto('/reservas');
    await buscador(page).fill(sufijo);
    const filas = page.getByText(
      new RegExp(`#(${confirmada.orderNumber}|${cancelada.orderNumber})\\b`),
    );
    await expect(filas).toHaveCount(2);

    await page.getByRole('button', { name: 'Canceladas', exact: true }).click();
    await expect(page.getByText(`#${cancelada.orderNumber}`, { exact: false })).toBeVisible();
    await expect(page.getByText(`#${confirmada.orderNumber} `, { exact: false })).toHaveCount(0);
    await page.getByRole('button', { name: 'Confirmadas', exact: true }).click();
    await expect(page.getByText(`#${confirmada.orderNumber} `, { exact: false })).toBeVisible();
    await expect(page.getByText(`#${cancelada.orderNumber} `, { exact: false })).toHaveCount(0);
    await page.getByRole('button', { name: 'Todas', exact: true }).click();

    await buscador(page).fill(String(confirmada.orderNumber));
    await expect(page.getByText(`#${confirmada.orderNumber} `, { exact: false })).toBeVisible();
    await expect(page.getByText(`#${cancelada.orderNumber} `, { exact: false })).toHaveCount(0);

    await buscador(page).fill(`NADIE${sufijo}ZZ`);
    await expect(page.getByText('Sin resultados')).toBeVisible();
  });

  test('POS-01 / QA-H-48 ?orden= abre la reserva en un diálogo que Escape cierra', async ({
    page,
  }) => {
    await page.goto(`/reservas?orden=${confirmada.id}`);
    const detalle = page.getByRole('dialog', { name: `Reserva #${confirmada.orderNumber}` });
    await expect(detalle).toBeVisible({ timeout: 30_000 });
    await expect(detalle).toHaveAttribute('aria-modal', 'true');
    await expect(detalle.getByText(`CONF${sufijo}`, { exact: false })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(detalle).toHaveCount(0);
  });
});

test.describe('diálogos de Clientes', { tag: '@desktop' }, () => {
  test('QA-H-48 «Nuevo Viajero» y «Nueva Oportunidad» son diálogos que Escape cierra', async ({
    page,
  }) => {
    await page.goto('/clientes');
    await page.getByRole('button', { name: 'Directorio Viajeros' }).click();
    await page.getByRole('button', { name: 'Nuevo Viajero' }).click();
    const viajero = page.getByRole('dialog', { name: 'Registrar Nuevo Viajero' });
    await expect(viajero).toBeVisible();
    await expect(viajero.getByRole('button', { name: 'Cerrar' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(viajero).toHaveCount(0);

    await page.getByRole('button', { name: 'Pipeline Kanban' }).click();
    await page.getByRole('button', { name: 'Nueva Oportunidad' }).click();
    const oportunidad = page.getByRole('dialog', { name: 'Crear Oportunidad de Viaje' });
    await expect(oportunidad).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(oportunidad).toHaveCount(0);
  });
});
