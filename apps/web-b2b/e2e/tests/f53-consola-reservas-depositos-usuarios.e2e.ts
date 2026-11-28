import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { como, nodo, sql } from '../api/support/cliente';
import { readMfa, storageStateFile, typeSixDigits, writeMfa } from '../support/auth';
import { hayBuzon, ultimoCorreo } from '../support/correo';
import { freshTotp } from '../support/totp';
import { apiComo, fechaEn } from '../support/venta';

/**
 * Tanda 28, consola del superadmin parte 2 (docs/qa/01 §5 SUP):
 *
 * - SUP-07: Reservas de la red busca (≥2 caracteres) por n.º de orden, abre la ficha y «Requieren
 *   atención» trae una pendiente de más de 30 minutos.
 * - SUP-08: sobre una reserva del falso: reenviar confirmación (llega a Mailpit), consultar al proveedor
 *   y cancelar escribiendo el n.º de orden; el motivo pide 5 caracteres.
 * - SUP-09: la cola de depósitos que financia Planetour: aprobar uno y rechazar otro (motivo ≥3).
 * - SUP-11: con el circuito del falso abierto (5 búsquedas a ADZ), «Cerrar circuito» con motivo.
 * - SUP-15: Usuarios de la plataforma busca y filtra; suspender en toda la plataforma pide el código
 *   de la app y reactivar devuelve la cuenta.
 */

test.skip(process.env['E2E_REAL'] === '1', 'el proveedor falso sólo vive en el stack E2E');
test.use({ storageState: storageStateFile('superadmin') });
test.describe.configure({ mode: 'serial' });

const corrida = Date.now().toString(36);
const CONTACTO = `qa28-${corrida}@e2e.test`;

interface Orden {
  id: string;
  orderNumber: number;
}

async function reservar(destino = 'MDE'): Promise<Orden> {
  const api = await apiComo('vendedorA');
  try {
    const searchCriteria = {
      origin: 'BOG',
      destination: destino,
      departureDate: fechaEn(52).toISOString().slice(0, 10),
      paxCount: { adults: 1, children: 0, infants: 0 },
      currency: 'COP',
    };
    const busqueda = await api.post('search/flights', { data: searchCriteria });
    const { offers } = (await busqueda.json()) as {
      offers: { provider: { name: string; offerRef: string } }[];
    };
    const offer = offers.find(
      (o) => o.provider.name === 'fake-flights' && o.provider.offerRef.startsWith('FAKE-FIJO'),
    );
    expect(offer).toBeDefined();
    const r = await api.post('orders', {
      headers: { 'idempotency-key': randomUUID() },
      data: {
        offer,
        searchCriteria,
        passengers: [
          {
            paxId: 'ADT_1',
            paxType: 'ADT',
            givenName: 'Consola',
            surname: 'Plataforma',
            birthdate: '1990-05-15',
            gender: 'F',
            citizenshipCountryCode: 'CO',
            identityDoc: { type: 'CC', number: '1020304050', issuingCountryCode: 'CO' },
          },
        ],
        contactInfo: { email: CONTACTO, phone: '3001234567' },
      },
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    return ((await r.json()) as { order: Orden }).order;
  } finally {
    await api.dispose();
  }
}

/** Si la acción pide el 2FA reciente, escribe el código de la app del superadmin. */
async function pasarStepUp(page: Page): Promise<void> {
  const dialogo = page.getByRole('dialog', { name: 'Confirma que eres tú' });
  if (!(await dialogo.isVisible({ timeout: 5_000 }).catch(() => false))) return;
  const mfa = readMfa('superadmin')!;
  const paso = await freshTotp(mfa.secret, mfa.lastStep);
  await typeSixDigits(page, paso.code);
  writeMfa('superadmin', { ...mfa, lastStep: paso.step });
  if (await dialogo.isVisible()) await dialogo.getByRole('button', { name: 'Confirmar' }).click();
  await expect(dialogo).toBeHidden();
}

test.describe('SUP-07 / SUP-08 reservas de la red', { tag: '@desktop' }, () => {
  test.setTimeout(180_000);

  test('buscar, abrir la ficha, reenviar, consultar, cancelar y «Requieren atención»', async ({
    page,
  }) => {
    test.skip(!(await hayBuzon()), 'este stack no tiene Mailpit (INF-3)');
    const orden = await reservar();
    const atascada = await reservar();
    await sql(
      `UPDATE orders SET status = 'pending', created_at = now() - interval '31 minutes'
        WHERE id = $1`,
      [atascada.id],
    );

    await page.goto('/admin/plataforma/reservas');
    await expect(page.getByRole('heading', { name: 'Reservas de la red', level: 1 })).toBeVisible();
    const buscar = page.getByRole('searchbox', {
      name: 'Buscar por PNR, localizador, n.º de orden o correo del cliente',
    });
    await buscar.fill('a');
    await expect(page.getByText('Escribe al menos 2 caracteres para buscar.')).toBeVisible();

    await page.getByRole('button', { name: 'Requieren atención' }).click();
    await expect(page).toHaveURL(/[?&]atencion=1/);
    await expect(
      page.getByRole('link', { name: `#${atascada.orderNumber} · abrir la ficha de la reserva` }),
    ).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Requieren atención' }).click();

    await buscar.fill(CONTACTO);
    const enlace = page.getByRole('link', {
      name: `#${orden.orderNumber} · abrir la ficha de la reserva`,
    });
    await expect(enlace).toBeVisible({ timeout: 20_000 });
    await enlace.click();
    const ficha = page.getByRole('dialog', {
      name: new RegExp(`^Reserva #${orden.orderNumber} · `),
    });
    await expect(ficha).toBeVisible();
    await expect(ficha.getByText('queda registrado en la auditoría')).toBeVisible();

    const accion = page.getByRole('dialog').last();
    const motivo = () => accion.getByLabel('Motivo (queda en la auditoría)');

    // Reenviar
    await ficha.getByRole('button', { name: 'Reenviar confirmación' }).click();
    await motivo().fill('abc');
    await accion.getByRole('button', { name: 'Reenviar confirmación' }).click();
    await expect(accion.getByText('Escribe al menos 5 caracteres.')).toBeVisible();
    const desde = new Date(Date.now() - 1_000);
    await motivo().fill('QA28 el cliente no recibió el correo');
    await accion.getByRole('button', { name: 'Reenviar confirmación' }).click();
    await expect(page.getByText(`Confirmación enviada a ${CONTACTO}.`)).toBeVisible();
    expect(
      await ultimoCorreo(CONTACTO, { desde, esperaMs: 15_000 }),
      'llega a Mailpit',
    ).toBeDefined();

    // Consultar
    await ficha.getByRole('button', { name: 'Consultar al proveedor' }).click();
    await motivo().fill('QA28 revisar estado');
    await accion.getByRole('button', { name: 'Consultar', exact: true }).click();
    await expect(
      page
        .getByText('Estado actualizado con el proveedor.')
        .or(page.getByText(/El proveedor no encuentra esta reserva/)),
    ).toBeVisible();

    // Cancelar
    await ficha.getByRole('button', { name: 'Cancelar reserva' }).click();
    await motivo().fill('QA28 la agencia lo pidió por teléfono');
    const cancelar = accion.getByRole('button', { name: 'Cancelar reserva' });
    await accion.getByLabel('Número de la orden').fill(String(orden.orderNumber + 1));
    await expect(cancelar).toBeDisabled();
    await accion.getByLabel('Número de la orden').fill(`#${orden.orderNumber}`);
    await cancelar.click();
    await expect(
      page.getByText(
        new RegExp(
          `Reserva #${orden.orderNumber} cancelada|Cancelación de la reserva #${orden.orderNumber} en curso`,
        ),
      ),
    ).toBeVisible({ timeout: 30_000 });
    const [fila] = await sql<{ status: string }>('SELECT status FROM orders WHERE id = $1', [
      orden.id,
    ]);
    expect(fila?.status).toMatch(/cancel/);
  });
});

test.describe('SUP-09 cola de depósitos', { tag: '@desktop' }, () => {
  const OK = `QA28-OK-${corrida}`;
  const NO = `QA28-NO-${corrida}`;

  test.beforeAll(async () => {
    const sa = await como('superadmin');
    const b = await nodo('e2e-agencia-b');
    const r = await sa.post(`/tenants/${b}/portfolios`, {
      currency: 'PEN',
      creditLimitMinor: 0,
      reason: 'QA28 cola de depósitos',
    });
    expect(r.status < 300 || r.text.includes('PORTFOLIO_ALREADY_ENABLED'), r.text).toBe(true);
    const admin = await como('adminB');
    for (const reference of [OK, NO]) {
      const d = await admin.pedir('POST', '/portfolios/deposit-reports', {
        body: { currency: 'PEN', amountMinor: 10_000, reference, depositedOn: null, notes: null },
        headers: { 'idempotency-key': randomUUID() },
      });
      expect(d.status, d.text).toBeLessThan(300);
    }
  });

  test('aprobar uno y rechazar otro desde la cola de Planetour', async ({ page }) => {
    await page.goto('/admin/plataforma/carteras');
    await expect(page.getByRole('heading', { name: 'Carteras de la red', level: 1 })).toBeVisible();
    const buscar = page.getByRole('searchbox', { name: 'Buscar por agencia o referencia' });

    await buscar.fill(OK);
    await page.getByRole('button', { name: new RegExp(`^Aprobar el depósito ${OK} de `) }).click();
    const aprobar = page.getByRole('dialog', { name: 'Aprobar el depósito informado' });
    await aprobar.getByLabel('Comentario (opcional)').fill('QA28 verificado en el extracto');
    await aprobar.getByRole('button', { name: /^Aprobar y acreditar / }).click();
    await expect(page.getByText(/^Depósito aprobado: se acreditaron /)).toBeVisible();

    await buscar.fill(NO);
    await page.getByRole('button', { name: new RegExp(`^Rechazar el depósito ${NO} de `) }).click();
    const rechazar = page.getByRole('dialog', { name: 'Rechazar el depósito informado' });
    await rechazar.getByLabel('Motivo del rechazo').fill('no');
    await rechazar.getByRole('button', { name: 'Rechazar depósito' }).click();
    await expect(rechazar.getByText(/al menos 3 caracteres/)).toBeVisible();
    await rechazar.getByLabel('Motivo del rechazo').fill('QA28 la referencia no aparece');
    await rechazar.getByRole('button', { name: 'Rechazar depósito' }).click();
    await expect(page.getByText(/rechazado: .* ve el motivo\./)).toBeVisible();

    await page
      .getByRole('group', { name: 'Estado de los depósitos' })
      .getByText('Aprobados')
      .click();
    await expect(page).toHaveURL(/[?&]estado=aprobados/);
    await buscar.fill(OK);
    await expect(page.getByText(`Ref. ${OK}`)).toBeVisible();
  });
});

test.describe('SUP-11 cerrar circuito', { tag: '@desktop' }, () => {
  test.setTimeout(150_000);

  test('con el circuito del falso abierto, se cierra con motivo', async ({ page }) => {
    const api = await apiComo('vendedorA');
    try {
      for (let i = 0; i < 5; i++) {
        await api.post('search/flights', {
          data: {
            origin: 'BOG',
            destination: 'ADZ',
            departureDate: fechaEn(60 + i)
              .toISOString()
              .slice(0, 10),
            paxCount: { adults: 1, children: 0, infants: 0 },
            currency: 'COP',
          },
        });
      }
    } finally {
      await api.dispose();
    }
    await page.goto('/admin/plataforma/proveedores');
    const cerrar = page.getByRole('button', { name: 'Cerrar circuito de fake-flights' });
    await expect(async () => {
      await page.reload();
      await expect(cerrar).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 60_000 });
    await expect(page.getByText('No responde: circuito abierto').first()).toBeVisible();

    await cerrar.click();
    const dialogo = page.getByRole('dialog', { name: '¿Cerrar el circuito de fake-flights?' });
    await dialogo.getByLabel('Motivo').fill('QA');
    await dialogo.getByRole('button', { name: 'Cerrar circuito' }).click();
    await expect(
      dialogo.getByText('El motivo tiene que tener al menos 5 caracteres.'),
    ).toBeVisible();
    await dialogo.getByLabel('Motivo').fill('QA28 el falso volvió');
    await dialogo.getByRole('button', { name: 'Cerrar circuito' }).click();
    await expect(page.getByText('fake-flights: circuito cerrado.')).toBeVisible();
    await expect(cerrar).toHaveCount(0);
  });
});

test.describe('SUP-15 usuarios de la plataforma', { tag: '@desktop' }, () => {
  test.setTimeout(120_000);

  test('buscar, filtrar, suspender con el código de la app y reactivar', async ({ page }) => {
    await page.goto('/admin/plataforma/usuarios');
    await expect(
      page.getByRole('heading', { name: 'Usuarios de la plataforma', level: 1 }),
    ).toBeVisible();
    const rapidos = page.getByRole('group', { name: 'Filtros rápidos' });
    await rapidos.getByRole('button', { name: 'Sin 2FA' }).click();
    await expect(rapidos.getByRole('button', { name: 'Sin 2FA' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByLabel('Buscar').fill('perfil@e2e.test');
    const fila = page
      .locator('tr, li')
      .filter({ has: page.getByText('perfil@e2e.test', { exact: true }) });
    await expect(fila.first()).toBeVisible({ timeout: 20_000 });

    await fila
      .first()
      .getByRole('button', { name: /^Acciones sobre / })
      .click();
    await page.getByRole('menuitem', { name: 'Suspender en toda la plataforma' }).click();
    const confirmar = page.getByRole('dialog', { name: /^Suspender a .+ en toda la plataforma$/ });
    await confirmar.getByRole('button', { name: 'Suspender en toda la plataforma' }).click();
    await pasarStepUp(page);
    await expect(page.getByText(/quedó suspendido en toda la plataforma\./)).toBeVisible({
      timeout: 20_000,
    });
    await expect(fila.first()).toContainText('Suspendido en toda la plataforma');

    await fila
      .first()
      .getByRole('button', { name: /^Acciones sobre / })
      .click();
    await page.getByRole('menuitem', { name: 'Reactivar cuenta' }).click();
    await page
      .getByRole('dialog', { name: /^Reactivar la cuenta de / })
      .getByRole('button', { name: 'Reactivar' })
      .click();
    await pasarStepUp(page);
    await expect(page.getByText(/^Reactivamos la cuenta de /)).toBeVisible({ timeout: 20_000 });
  });
});
