import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { como, nodo, sql } from '../api/support/cliente';
import { storageStateFile } from '../support/auth';
import { apiComo, elegirDias, elegirLugar, fechaEn } from '../support/venta';

/**
 * Tanda 21 en el navegador (docs/qa/01 §5 PAQ, INI y CAR):
 *
 * - PAQ-03: el constructor de paquetes no busca sin servicio, destino, origen, fechas ni con más de 9
 *   pasajeros de vuelo, y dice cada motivo.
 * - PAQ-05: en la cotización guardada, «Copiar texto» y «Enviar por WhatsApp» llevan el mismo texto
 *   (wa.me sin número), WhatsApp pasa el borrador a «Enviada», «Marcar aceptada» la acepta e «Imprimir»
 *   abre la impresión; la lista muestra cada estado y la vencida se ve «Vencida» también en el detalle.
 * - INI-03: «Ventas del mes» va una línea por moneda, cada una con su código.
 * - CAR-13: los movimientos se filtran por moneda; «Reservas de tu red» sólo la ve un admin cuyo nodo
 *   financia a otros, no un vendedor.
 */

const corrida = Date.now().toString(36);

test.describe('PAQ-03 validaciones del constructor', { tag: '@desktop' }, () => {
  test.use({ storageState: storageStateFile('vendedorA') });
  test.setTimeout(90_000);

  test('cada dato que falta tiene su motivo', async ({ page }) => {
    await page.goto('/paquetes');
    const servicios = page.getByRole('group', { name: 'Qué incluye el paquete' });
    const servicio = (n: string) => servicios.getByRole('button', { name: n, exact: true });
    const buscar = page.getByRole('button', { name: 'Buscar paquete' });
    const motivo = page.locator('form').getByRole('alert');

    for (const s of ['Vuelo', 'Hotel', 'Auto']) {
      if ((await servicio(s).getAttribute('aria-pressed')) === 'true') await servicio(s).click();
    }
    await buscar.click();
    await expect(motivo).toHaveText('Elige al menos un servicio para el paquete.');

    await servicio('Vuelo').click();
    await buscar.click();
    await expect(motivo).toHaveText('Elige el destino.');

    await elegirLugar(page, 'Destino', 'CTG', /CTG/);
    await buscar.click();
    await expect(motivo).toHaveText('Elige desde dónde viajan.');

    await elegirLugar(page, 'Desde', 'BOG', /BOG/);
    await buscar.click();
    await expect(motivo).toHaveText('Elige las fechas de ida y vuelta.');

    await page.getByRole('button', { name: /^Ida/ }).click();
    await elegirDias(page, fechaEn(40), fechaEn(44));

    await page.getByRole('button', { name: /^Habitaciones/ }).click();
    const huespedes = page.getByRole('dialog', { name: 'Habitaciones y huéspedes' });
    for (let i = 0; i < 6; i++) {
      await huespedes.getByRole('button', { name: 'Agregar un adulto a la habitación 1' }).click();
    }
    for (let i = 0; i < 2; i++) {
      await huespedes.getByRole('button', { name: 'Agregar un niño a la habitación 1' }).click();
    }
    await page.keyboard.press('Escape');
    await buscar.click();
    await expect(motivo).toHaveText('Máximo 9 pasajeros por reserva de vuelo.');
  });
});

test.describe('PAQ-05 cotización guardada', { tag: '@desktop' }, () => {
  test.use({ storageState: storageStateFile('vendedorA') });
  test.setTimeout(90_000);

  const TITULO = `QA21 Cartagena ${corrida}`;
  const VENCIDO = `QA21 Vencido ${corrida}`;
  let id = '';

  async function crear(titulo: string): Promise<string> {
    const api = await apiComo('vendedorA');
    try {
      const r = await api.post('packages', {
        data: {
          title: titulo,
          currency: 'COP',
          searchCriteria: {
            departureDate: fechaEn(40).toISOString().slice(0, 10),
            returnDate: fechaEn(43).toISOString().slice(0, 10),
            rooms: [{ adults: 2, childrenAges: [] }],
            destinationLabel: 'Cartagena, Colombia',
          },
          items: [
            {
              vertical: 'transfers',
              providerName: 'manual',
              providerItemId: `manual-${randomUUID()}`,
              rawDetails: { kind: 'manual', title: 'Traslado al hotel' },
              baseFareMinor: 15_000_000,
              taxesMinor: 0,
              currency: 'COP',
            },
          ],
        },
      });
      expect(r.ok(), await r.text()).toBeTruthy();
      return ((await r.json()) as { package: { id: string } }).package.id;
    } finally {
      await api.dispose();
    }
  }

  test.beforeAll(async () => {
    id = await crear(TITULO);
    const vencido = await crear(VENCIDO);
    await sql(`UPDATE package_quotations SET expires_at = now() - interval '1 day' WHERE id = $1`, [
      vencido,
    ]);
  });

  const estado = (page: Page) => page.getByText(/^(Borrador|Enviada|Aceptada|Vencida)$/).first();

  test('copiar, WhatsApp, imprimir y aceptar; la lista muestra cada estado', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.addInitScript(() => {
      const w = window as unknown as { __abiertas: string[]; __impresiones: number };
      w.__abiertas = [];
      w.__impresiones = 0;
      window.open = (url?: string | URL) => {
        w.__abiertas.push(String(url));
        return null;
      };
      window.print = () => {
        w.__impresiones++;
      };
    });

    await page.goto('/paquetes/guardados');
    const fila = (t: string) => page.getByRole('link').filter({ hasText: t });
    await expect(fila(TITULO)).toContainText('Borrador');
    await expect(fila(VENCIDO)).toContainText('Vencida');

    await fila(VENCIDO).click();
    await expect(estado(page), 'el detalle también la ve vencida').toHaveText('Vencida');

    await page.goto(`/paquetes/${id}`);
    await expect(estado(page)).toHaveText('Borrador');

    await page.getByRole('button', { name: 'Copiar texto' }).click();
    await expect(page.getByRole('button', { name: 'Copiado' })).toBeVisible();
    const texto = await page.evaluate(() => navigator.clipboard.readText());
    expect(texto.split('\n')[0]).toBe(`*${TITULO}*`);
    expect(texto).toContain('✨ Traslado al hotel');
    expect(texto).toMatch(/\*Total: .+\*/);
    expect(texto).toContain('Sujeta a disponibilidad.');

    await page.getByRole('button', { name: 'Enviar por WhatsApp' }).click();
    const abiertas = await page.evaluate(
      () => (window as unknown as { __abiertas: string[] }).__abiertas,
    );
    expect(abiertas).toHaveLength(1);
    expect(abiertas[0]).toBe(`https://wa.me/?text=${encodeURIComponent(texto)}`);
    await expect(estado(page), 'enviar por WhatsApp la marca enviada').toHaveText('Enviada');

    await page.getByRole('button', { name: 'Imprimir' }).click();
    expect(
      await page.evaluate(() => (window as unknown as { __impresiones: number }).__impresiones),
    ).toBe(1);

    await page.getByRole('button', { name: 'Marcar aceptada' }).click();
    await expect(estado(page)).toHaveText('Aceptada');
    await expect(page.getByRole('button', { name: 'Marcar aceptada' })).toHaveCount(0);

    await page.goto('/paquetes/guardados');
    await expect(fila(TITULO)).toContainText('Aceptada');
  });
});

test.describe('INI-03 ventas del mes por moneda', { tag: '@desktop' }, () => {
  test.use({ storageState: storageStateFile('vendedorA') });

  test('cada moneda en su línea y con su código, sin sumarlas', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Inicio', level: 1 })).toBeVisible();
    const tarjeta = page
      .locator('div')
      .filter({ has: page.getByText('Ventas del mes', { exact: true }) })
      .filter({ hasText: /Confirmadas y emitidas|Sin ventas este mes/ })
      .last();
    await expect(tarjeta).toBeVisible();
    const lineas = (await tarjeta.locator('span.block').allInnerTexts()).map((t) => t.trim());
    if (lineas.length === 0) {
      await expect(tarjeta).toContainText('Sin ventas este mes');
      return;
    }
    for (const l of lineas) expect(l, 'monto y código').toMatch(/^[\d.,]+ [A-Z]{3}$/);
    const codigos = lineas.map((l) => l.slice(-3));
    expect(new Set(codigos).size, 'una línea por moneda').toBe(codigos.length);
    await expect(tarjeta).toContainText('Confirmadas y emitidas');
  });
});

test.describe('CAR-13 cartera por moneda y la pestaña de la red', { tag: '@desktop' }, () => {
  const USD = `QA21 depósito USD ${corrida}`;
  const COP = `QA21 ajuste COP ${corrida}`;

  test.beforeAll(async () => {
    const cons = await como('consolidador');
    const nodoA = await nodo('e2e-agencia-a');
    const base = `/tenants/${nodoA}/portfolios`;
    for (const currency of ['USD', 'COP']) {
      const r = await cons.post(base, { currency, creditLimitMinor: 0, reason: 'QA21 CAR-13' });
      expect(r.status < 300 || r.text.includes('PORTFOLIO_ALREADY_ENABLED'), r.text).toBe(true);
    }
    const lista = await cons.get<{ portfolios?: { id: string; currency: string }[] }>(base);
    const de = (c: string) => lista.body.portfolios?.find((p) => p.currency === c)?.id;
    const dep = await cons.pedir('POST', `${base}/${de('USD')}/deposits`, {
      body: { amountMinor: 2_500, reason: USD },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(dep.status, dep.text).toBeLessThan(300);
    const aj = await cons.pedir('POST', `${base}/${de('COP')}/adjustments`, {
      body: { amountMinor: 1_000_000, reason: COP },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(aj.status, aj.text).toBeLessThan(300);
  });

  test.describe('admin de un nodo que financia', () => {
    test.use({ storageState: storageStateFile('adminA') });

    test('filtra movimientos por moneda y ve «Reservas de tu red»', async ({ page }) => {
      await page.goto('/carteras');
      await expect(page.getByRole('heading', { name: 'Cartera B2B', level: 1 })).toBeVisible();
      const pestañas = page.getByRole('tablist', { name: 'Detalle de las carteras' });
      await expect(pestañas.getByRole('tab', { name: /Reservas de tu red/ })).toBeVisible();

      await pestañas.getByRole('tab', { name: /^Movimientos/ }).click();
      const moneda = page.getByRole('group', { name: 'Moneda de los movimientos' });
      await expect(page.getByText(USD)).toBeVisible();
      await expect(page.getByText(COP)).toBeVisible();

      await moneda.getByText('USD', { exact: true }).click();
      await expect(moneda.getByRole('radio', { name: 'USD', exact: true })).toBeChecked();
      await expect(page.getByText(USD)).toBeVisible();
      await expect(page.getByText(COP)).toHaveCount(0);

      await moneda.getByText('COP', { exact: true }).click();
      await expect(moneda.getByRole('radio', { name: 'COP', exact: true })).toBeChecked();
      await expect(page.getByText(COP)).toBeVisible();
      await expect(page.getByText(USD)).toHaveCount(0);

      await pestañas.getByRole('tab', { name: /Reservas de tu red/ }).click();
      await expect(
        page.getByText(
          'Lo que tu red tiene retenido o cobrado en tus carteras, al costo de tu nivel.',
        ),
      ).toBeVisible();
    });
  });

  test.describe('vendedor', () => {
    test.use({ storageState: storageStateFile('vendedorA') });

    test('no ve la pestaña de la red', async ({ page }) => {
      await page.goto('/carteras');
      const pestañas = page.getByRole('tablist', { name: 'Detalle de las carteras' });
      await expect(pestañas.getByRole('tab', { name: /^Movimientos/ })).toBeVisible();
      await expect(pestañas.getByRole('tab', { name: /Reservas de tu red/ })).toHaveCount(0);
    });
  });
});
