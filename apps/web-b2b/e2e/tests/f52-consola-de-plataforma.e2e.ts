import { expect, test, type Page } from '@playwright/test';
import { como, sql } from '../api/support/cliente';
import { storageStateFile } from '../support/auth';

/**
 * Tanda 27 en el navegador, consola del superadmin (docs/qa/01 §5 SUP):
 *
 * - SUP-03: Resumen guarda el período en la URL (?periodo=7d) y lo relee; Salud y Estado cargan.
 * - SUP-05: un anuncio valida título y fechas, se ve en el panel de un vendedor, «Ocultar aviso» lo
 *   esconde; uno crítico no se puede ocultar; archivarlo (con confirmación) lo saca.
 * - SUP-10: el apagado de emergencia pide motivo (≥5) y el código; queda en la ficha y en «Requiere tu
 *   atención»; «Reanudar» lo levanta. Se hace con Sabre, que el stack E2E no usa (sus pruebas son @real).
 * - SUP-12: una excepción por nodo (Deshabilitado) y vuelta a Heredar.
 * - SUP-04: Actividad filtra por «Proveedores» y muestra el apagado; la API rechaza 93 días y fechas
 *   al revés.
 */

test.use({ storageState: storageStateFile('superadmin') });
test.describe.configure({ mode: 'serial' });

const corrida = Date.now().toString(36);
const AVISO = `QA27 aviso ${corrida}`;
const CRITICO = `QA27 crítico ${corrida}`;

test.afterAll(async () => {
  await sql(
    `UPDATE system_announcements SET archived_at = now() WHERE title LIKE 'QA27 %' AND archived_at IS NULL`,
  );
  const sa = await como('superadmin');
  await sa.post('/admin/providers/sabre/kill-switch/clear', { reason: 'QA27 limpieza' });
  await sa.delete(`/admin/providers/sabre/tenants/${await idDe('e2e-agencia-a')}`);
});

async function idDe(slug: string): Promise<string> {
  const [f] = await sql<{ id: string }>('SELECT id FROM tenants WHERE slug = $1', [slug]);
  return f!.id;
}

test.describe('SUP-03 tableros', { tag: '@desktop' }, () => {
  test('Resumen: el período va en la URL; Salud y Estado cargan', async ({ page }) => {
    await page.goto('/admin/plataforma/resumen');
    await expect(page.getByRole('heading', { name: 'Resumen de la plataforma' })).toBeVisible();
    const periodo = page.getByRole('group', { name: 'Período del resumen' });
    await periodo.getByText('7 días', { exact: true }).click();
    await expect(page).toHaveURL(/[?&]periodo=7d/);
    await page.reload();
    await expect(periodo.getByRole('radio', { name: '7 días' })).toBeChecked();
    await expect(page.getByRole('heading', { name: 'Requiere tu atención' })).toBeVisible({
      timeout: 30_000,
    });

    await page.goto('/admin/plataforma/salud');
    await expect(page.getByRole('heading', { name: 'Salud', level: 1 })).toBeVisible();
    await expect(page.getByRole('table').or(page.getByText(/No hubo búsquedas/))).toBeVisible({
      timeout: 20_000,
    });

    await page.goto('/admin/plataforma/estado');
    await expect(page.getByRole('heading', { name: 'Estado', level: 1 })).toBeVisible();
    await expect(
      page.getByText(/^(Todo en orden|Hay cosas para revisar|Hay algo roto o urgente)/).first(),
    ).toBeVisible();
  });
});

test.describe('SUP-05 anuncios', { tag: '@desktop' }, () => {
  test.setTimeout(150_000);

  async function nuevo(page: Page, titulo: string, gravedad: RegExp): Promise<void> {
    await page.getByRole('button', { name: 'Nuevo anuncio' }).click();
    const hoja = page.getByRole('dialog', { name: 'Nuevo anuncio' });
    await hoja.getByRole('radio', { name: gravedad }).check();
    await hoja.getByLabel('Título').fill(titulo);
    await hoja.getByRole('button', { name: 'Publicar' }).click();
    await expect(page.getByText('Anuncio publicado.')).toBeVisible();
  }

  test('valida, se ve en el panel, se oculta, el crítico no; archivar lo saca', async ({
    page,
    browser,
  }) => {
    await page.goto('/admin/plataforma/sistema/anuncios');
    await page.getByRole('button', { name: 'Nuevo anuncio' }).click();
    const hoja = page.getByRole('dialog', { name: 'Nuevo anuncio' });
    await hoja.getByLabel('Título').fill('ab');
    await hoja.getByRole('button', { name: 'Publicar' }).click();
    await expect(hoja.getByText('Escribe un título de al menos 3 caracteres.')).toBeVisible();
    const desde = await hoja.getByLabel('Desde').inputValue();
    await hoja.getByLabel('Hasta').fill(desde);
    await hoja.getByLabel('Título').fill(AVISO);
    await hoja.getByRole('button', { name: 'Publicar' }).click();
    await expect(hoja.getByText('Tiene que terminar después de empezar.')).toBeVisible();
    await hoja.getByRole('button', { name: 'Cancelar' }).click();
    await page
      .getByRole('dialog', { name: '¿Descartar los cambios?' })
      .getByRole('button', { name: 'Descartar cambios' })
      .click();
    await expect(hoja).toBeHidden();

    await nuevo(page, AVISO, /^Información/);
    await nuevo(page, CRITICO, /^Crítico/);
    const lista = page.getByRole('list', { name: 'Anuncios' });
    await expect(lista.getByText(AVISO)).toBeVisible();

    const ctx = await browser.newContext({
      baseURL: test.info().project.use.baseURL,
      storageState: storageStateFile('vendedorA'),
    });
    const vendedor = await ctx.newPage();
    await vendedor.goto('/');
    const avisos = vendedor.getByRole('region', { name: 'Avisos de la plataforma' });
    const aviso = avisos
      .locator('li, div')
      .filter({ hasText: AVISO })
      .filter({ hasNotText: CRITICO });
    const critico = avisos
      .locator('li, div')
      .filter({ hasText: CRITICO })
      .filter({ hasNotText: AVISO });
    await expect(avisos.getByText(AVISO)).toBeVisible({ timeout: 20_000 });
    await expect(avisos.getByText(CRITICO)).toBeVisible();
    await expect(critico.getByRole('button', { name: 'Ocultar aviso' })).toHaveCount(0);
    await aviso.getByRole('button', { name: 'Ocultar aviso' }).first().click();
    await expect(avisos.getByText(AVISO)).toHaveCount(0);
    await vendedor.reload();
    await expect(avisos.getByText(CRITICO)).toBeVisible({ timeout: 20_000 });
    await expect(avisos.getByText(AVISO), 'oculto sigue oculto').toHaveCount(0);

    await page.getByRole('button', { name: `Archivar: ${CRITICO}` }).click();
    const confirmar = page.getByRole('dialog', { name: '¿Archivar este anuncio?' });
    await confirmar.getByRole('button', { name: 'Archivar' }).click();
    await expect(page.getByText('Anuncio archivado.')).toBeVisible();
    await vendedor.reload();
    await expect(vendedor.getByText(CRITICO)).toHaveCount(0);
    await ctx.close();
  });
});

test.describe('SUP-10 / SUP-12 / SUP-04 proveedores y actividad', { tag: '@desktop' }, () => {
  test.setTimeout(150_000);

  test('apagado de emergencia, excepción por nodo y su rastro en Actividad', async ({ page }) => {
    await page.goto('/admin/plataforma/proveedores');
    await expect(page.getByRole('heading', { name: 'Proveedores de la plataforma' })).toBeVisible({
      timeout: 20_000,
    });
    const apagar = page.getByRole('button', { name: /^Apagado de emergencia de Sabre/ });
    await apagar.click();
    const dialogo = page.getByRole('dialog', { name: /^Apagado de emergencia de / });
    const nombre = (await dialogo.getByRole('heading').first().innerText()).replace(
      'Apagado de emergencia de ',
      '',
    );
    await dialogo.getByRole('radio', { name: /^Solo ventas/ }).check();
    await dialogo.getByRole('radio', { name: /^En 1 hora/ }).check();
    await dialogo.getByLabel('Motivo').fill('QA');
    const confirmar = dialogo.getByRole('button', { name: `Apagar ${nombre}` });
    await expect(confirmar).toHaveAttribute('aria-disabled', 'true');
    await confirmar.dispatchEvent('click');
    await expect(
      dialogo.getByText('El motivo tiene que tener al menos 5 caracteres.'),
    ).toBeVisible();
    await dialogo.getByLabel('Motivo').fill(`QA27 prueba ${corrida}`);
    await dialogo.getByRole('textbox', { name: /para confirmar/ }).fill('otro');
    await confirmar.dispatchEvent('click');
    await expect(dialogo.getByText(/tal cual para poder apagarlo/)).toBeVisible();
    await dialogo.getByRole('textbox', { name: /para confirmar/ }).fill('SABRE');
    await confirmar.click();
    await expect(page.getByText(`${nombre} quedó apagado (solo ventas).`)).toBeVisible();
    await expect(
      page.getByText(
        new RegExp(`Apagado desde el panel \\(solo ventas\\).*QA27 prueba ${corrida}`),
      ),
    ).toBeVisible();

    await page.goto('/admin/plataforma/resumen');
    await expect(
      page.getByText(new RegExp(`${nombre}: apagado de emergencia \\(solo ventas\\)`)),
    ).toBeVisible({
      timeout: 30_000,
    });

    await page.goto('/admin/plataforma/proveedores');
    await page.getByRole('button', { name: `Reanudar proveedor ${nombre}` }).click();
    const reanudar = page.getByRole('dialog', { name: `¿Reanudar ${nombre}?` });
    await reanudar.getByRole('button', { name: 'Reanudar proveedor' }).click();
    await expect(page.getByText(`${nombre} volvió a operar.`)).toBeVisible();

    // SUP-12
    const tarjeta = page
      .locator('section, article, div')
      .filter({ has: page.getByRole('switch', { name: `${nombre} para todos los tenants` }) })
      .filter({ has: page.getByRole('button', { name: 'Agregar excepción' }) })
      .last();
    await tarjeta.getByRole('button', { name: 'Agregar excepción' }).click();
    const agregar = page.getByRole('dialog', { name: `Agregar excepción de ${nombre}` });
    await agregar.getByPlaceholder('Buscar por nombre o slug…').fill('e2e-agencia-a');
    await agregar
      .getByRole('list', { name: 'Tenants que coinciden' })
      .getByText('Agencia E2E A')
      .first()
      .click();
    await agregar
      .getByRole('group', { name: `Estado de ${nombre} para el tenant` })
      .getByText('Deshabilitado', { exact: true })
      .click();
    await agregar
      .getByRole('button', { name: /^(Agregar|Deshabilitar)$/ })
      .last()
      .click();
    await expect(page.getByText(`${nombre}: deshabilitado para Agencia E2E A.`)).toBeVisible();

    const fila = page.getByRole('group', { name: `${nombre} para Agencia E2E A` });
    await fila.getByText('Heredar', { exact: true }).click();
    const volver = page.getByRole('dialog', { name: /^¿Volver a heredar / });
    await volver.getByRole('button', { name: 'Heredar' }).click();
    await expect(page.getByText(`${nombre}: Agencia E2E A vuelve a heredar.`)).toBeVisible();

    // SUP-04
    await page.goto('/admin/plataforma/actividad');
    await page
      .getByRole('group', { name: 'Categoría de los eventos' })
      .getByRole('button', { name: 'Proveedores', exact: true })
      .click();
    await expect(page).toHaveURL(/[?&]categoria=proveedores/);
    await expect(
      page
        .getByRole('region', { name: 'Eventos encontrados' })
        .getByText(/Apagado de emergencia de un proveedor/)
        .first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  test('SUP-04 la API rechaza más de 92 días y fechas al revés', async () => {
    const sa = await como('superadmin');
    const largo = await sa.get<{ fields?: { message: string }[] }>(
      '/admin/audit?from=2026-01-01&to=2026-06-30',
    );
    expect(largo.status).toBe(400);
    expect(largo.text).toContain('el período puede tener hasta 92 días');
    const reves = await sa.get('/admin/audit?from=2026-11-20&to=2026-11-10');
    expect(reves.status).toBe(400);
    expect(reves.text).toContain('no puede ser anterior');
    const raro = await sa.get('/admin/audit?category=ventas');
    expect(raro.status).toBe(400);
    expect(raro.text).toContain('categoría inválida');
  });
});
