import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { sql } from '../api/support/cliente';
import { storageStateFile } from '../support/auth';
import { USERS } from '../support/users';

/**
 * Tanda 20 en el navegador (docs/qa/01 §5 AUT, BYO, JOB y EQU):
 *
 * - AUT-08: Oficinas pide distancia, una ciudad de la lista o coordenadas; coordenadas vacías o fuera
 *   de rango no se buscan (antes iban a 0,0).
 * - BYO-01: conectar Sabre, Despegar, LATAM y AgentCars sin lo obligatorio muestra cada error y el
 *   resumen «Revisa N campos»; el foco va al primer campo marcado. TBO lo carga el consolidador.
 * - JOB-06: Sistema → Procesos marca «Atrasada» la conciliación que no terminó en 36 h.
 * - EQU-16: la ficha del miembro muestra sus sesiones, las invitaciones que envió y la actividad en
 *   páginas de 30 con «Cargar más».
 */

const corrida = Date.now().toString(36);

test.describe('AUT-08 oficinas de autos', { tag: '@desktop' }, () => {
  test.use({ storageState: storageStateFile('vendedorA') });

  test('distancia, ciudad y coordenadas se validan antes de buscar', async ({ page }) => {
    await page.goto('/autos/oficinas');
    await expect(page.getByRole('heading', { name: 'Oficinas de autos' })).toBeVisible();
    const buscar = page.getByRole('button', { name: 'Buscar oficinas' });

    await page.getByLabel('Distancia (millas)').fill('');
    await buscar.click();
    await expect(page.getByText('Escribe una distancia válida (en millas).')).toBeVisible();

    await page.getByLabel('Distancia (millas)').fill('25');
    await buscar.click();
    await expect(
      page.getByText('Elige una ciudad de la lista o escribe un código IATA.'),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Por coordenadas' }).click();
    const coordenadas = page.getByText(
      'Escribe coordenadas válidas: latitud entre -90 y 90 y longitud entre -180 y 180.',
    );
    await buscar.click();
    await expect(coordenadas, 'vacías no son 0,0').toBeVisible();

    await page.getByLabel('Latitud').fill('95');
    await page.getByLabel('Longitud').fill('-74.1');
    await buscar.click();
    await expect(coordenadas).toBeVisible();
  });

  test('el reporte diario ofrece la fecha opcional', async ({ page }) => {
    await page.goto('/autos/reporte');
    await expect(page.getByRole('heading', { name: 'Reporte diario de autos' })).toBeVisible();
    await expect(page.getByLabel('Fecha (opcional)')).toHaveAttribute('type', 'date');
    await expect(page.getByRole('button', { name: 'Ver reporte' })).toBeEnabled();
  });
});

test.describe('BYO-01 conectar proveedores', { tag: '@desktop' }, () => {
  test.use({ storageState: storageStateFile('adminA') });
  test.setTimeout(90_000);

  const hoja = (page: Page, titulo: string) => page.getByRole('dialog', { name: titulo });

  async function abrir(page: Page, boton: string, titulo: string) {
    await page.getByRole('button', { name: boton }).click();
    const h = hoja(page, titulo);
    await expect(h).toBeVisible();
    return h;
  }

  async function guardar(page: Page, titulo: string) {
    await hoja(page, titulo)
      .getByRole('button', { name: /^Guardar/ })
      .click();
    return hoja(page, titulo).getByRole('alert');
  }

  test('cada obligatorio vacío tiene su error y el resumen los cuenta', async ({ page }) => {
    await page.goto('/admin/proveedores');
    await expect(page.getByRole('heading', { name: 'Proveedores y Conectividad' })).toBeVisible();

    const sabre = await abrir(page, 'Conectar Sabre GDS', 'Conectar Sabre');
    await expect(await guardar(page, 'Conectar Sabre')).toContainText(
      'Revisa 3 campos antes de guardar. El EPR es obligatorio',
    );
    const epr = sabre.getByLabel('EPR (usuario de la oficina)');
    await expect(epr).toBeFocused();
    await expect(epr).toHaveAttribute('aria-invalid', 'true');
    await expect(sabre.locator('#byoc-credentials-password')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    await expect(sabre.getByLabel('PCC de la oficina')).toHaveAttribute('aria-invalid', 'true');

    await epr.fill('QA20');
    await sabre.locator('#byoc-credentials-password').fill('clave-de-prueba');
    await sabre.getByLabel('PCC de la oficina').fill('AB');
    await expect(await guardar(page, 'Conectar Sabre')).toHaveText(
      'PCC de la oficina necesita al menos 3 caracteres.',
    );
    await sabre.getByRole('button', { name: 'Cancelar' }).click();
    const descartar = page.getByRole('dialog', { name: '¿Descartar los cambios?' });
    await expect(descartar, 'con datos cargados, cancelar pide confirmación').toBeVisible();
    await descartar.getByRole('button', { name: 'Descartar cambios' }).click();
    await expect(sabre).toBeHidden();

    await abrir(page, 'Conectar Despegar Hotels', 'Conectar Despegar Hoteles (HotelDO)');
    await expect(await guardar(page, 'Conectar Despegar Hoteles (HotelDO)')).toHaveText(
      'La API key es obligatoria: Despegar rechaza cada llamada sin ella.',
    );
    await hoja(page, 'Conectar Despegar Hoteles (HotelDO)')
      .getByRole('button', { name: 'Cancelar' })
      .click();

    await abrir(page, 'Conectar LATAM NDC', 'Conectar LATAM NDC');
    await expect(await guardar(page, 'Conectar LATAM NDC')).toContainText(
      'Carga al menos una credencial',
    );
    await hoja(page, 'Conectar LATAM NDC').getByRole('button', { name: 'Cancelar' }).click();

    const autos = await abrir(page, 'Conectar AgentCars', 'Conectar AgentCars');
    await autos.locator('#byoc-credentials-accessToken').fill(`token-${corrida}`);
    await autos.getByLabel('Base URL (opcional)').fill('no-es-una-url');
    await expect(await guardar(page, 'Conectar AgentCars')).toHaveText(
      'Base URL (opcional) tiene que ser una URL completa (https://…).',
    );
    await expect(autos.getByLabel('Base URL (opcional)')).toBeFocused();
    await autos.getByRole('button', { name: 'Cancelar' }).click();
    await page
      .getByRole('dialog', { name: '¿Descartar los cambios?' })
      .getByRole('button', { name: 'Descartar cambios' })
      .click();

    await expect(page.getByText('La carga el consolidador')).toBeVisible();
    const cuentas = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM provider_accounts pa JOIN tenants t ON t.id = pa.tenant_id
        WHERE t.slug = 'e2e-agencia-a' AND pa.provider_code <> 'email'`,
    );
    expect(cuentas[0]?.n, 'nada se guardó').toBe('0');
  });
});

test.describe('JOB-06 conciliación atrasada', { tag: '@desktop' }, () => {
  test.use({ storageState: storageStateFile('superadmin') });

  const VIEJA = `qa20-vieja-${corrida}`;
  const AL_DIA = `qa20-al-dia-${corrida}`;

  test.beforeAll(async () => {
    for (const [codigo, horas] of [
      [VIEJA, 40],
      [AL_DIA, 2],
    ] as const) {
      await sql(
        `WITH p AS (SELECT id FROM tenants WHERE tenant_type = 'platform' LIMIT 1),
              a AS (INSERT INTO provider_accounts (tenant_id, provider_code, label, credentials_enc, status)
                    SELECT id, $1, 'qa20', '\\x00'::bytea, 'disabled' FROM p RETURNING id, tenant_id)
         INSERT INTO provider_reconciliation_runs
           (tenant_id, account_id, provider_code, trigger, status, started_at, finished_at)
         SELECT tenant_id, id, $1, 'scheduled', 'completed',
                now() - make_interval(hours => $2::int) - interval '5 minutes',
                now() - make_interval(hours => $2::int)
           FROM a`,
        [codigo, horas],
      );
    }
  });

  test.afterAll(async () => {
    await sql(`DELETE FROM provider_reconciliation_runs WHERE provider_code = ANY($1)`, [
      [VIEJA, AL_DIA],
    ]);
    await sql(`DELETE FROM provider_accounts WHERE provider_code = ANY($1)`, [[VIEJA, AL_DIA]]);
  });

  test('la que no terminó en 36 h dice «Atrasada»; la de hace 2 h no', async ({ page }) => {
    await page.goto('/admin/plataforma/sistema');
    const card = page.getByRole('region', { name: 'Conciliación diaria' });
    await expect(card).toBeVisible({ timeout: 20_000 });
    const vieja = card.getByRole('row').filter({ hasText: VIEJA });
    const alDia = card.getByRole('row').filter({ hasText: AL_DIA });
    await expect(vieja).toContainText('Atrasada');
    await expect(vieja).toContainText('Correcta');
    await expect(alDia).toContainText('Correcta');
    await expect(alDia).not.toContainText('Atrasada');
  });
});

test.describe('EQU-16 ficha del miembro', { tag: '@desktop' }, () => {
  test.use({ storageState: storageStateFile('adminA') });

  const INVITADO = `qa20-${corrida}-invitado@e2e.test`;
  const MARCA = `qa20-${corrida}`;

  test.beforeAll(async () => {
    await sql(
      `WITH u AS (SELECT id FROM users WHERE email = $1),
            t AS (SELECT id FROM tenants WHERE slug = 'e2e-agencia-a')
       INSERT INTO domain_events (tenant_id, actor_user_id, event_type, aggregate_type, aggregate_id,
                                  payload, occurred_at)
       SELECT t.id, u.id, 'auth.login.success', 'user', u.id::text, jsonb_build_object('qa', $2::text),
              now() - make_interval(days => 400) + make_interval(mins => g)
         FROM u, t, generate_series(1, 35) g`,
      [USERS.vendedorA.email, MARCA],
    );
    await sql(
      `INSERT INTO user_invitations (tenant_id, email, role, token_hash, invited_by, expires_at)
       SELECT t.id, $1, 'vendedor', $2, u.id, now() + interval '7 days'
         FROM tenants t, users u WHERE t.slug = 'e2e-agencia-a' AND u.email = $3`,
      [INVITADO, randomUUID(), USERS.vendedorA.email],
    );
  });

  test.afterAll(async () => {
    await sql(`DELETE FROM user_invitations WHERE email = $1`, [INVITADO]);
    await sql(`DELETE FROM domain_events WHERE payload ->> 'qa' = $1`, [MARCA]).catch(() => []);
  });

  test('sesiones, invitaciones que envió y actividad de a 30', async ({ page }) => {
    await page.goto('/admin/usuarios');
    await page
      .locator('tr, li')
      .filter({ has: page.getByText(USERS.vendedorA.email, { exact: true }) })
      .getByRole('button', { name: /^Ver la ficha de / })
      .first()
      .click();
    const ficha = page.getByRole('dialog');
    await expect(ficha.getByText(USERS.vendedorA.email).first()).toBeVisible();

    await expect(ficha.getByRole('heading', { name: /^Sesiones abiertas \(\d+\)$/ })).toBeVisible();

    const invitaciones = ficha.getByRole('region', { name: 'Invitaciones que envió' });
    await expect(invitaciones.getByText(INVITADO)).toBeVisible();
    await expect(invitaciones.getByText(/^\d+ pendientes?$/)).toBeVisible();

    const actividad = ficha.getByRole('region', { name: 'Actividad' });
    const items = actividad.getByRole('listitem');
    await expect(items).toHaveCount(30, { timeout: 20_000 });
    await actividad.getByRole('button', { name: 'Cargar más' }).click();
    await expect.poll(() => items.count(), { timeout: 20_000 }).toBeGreaterThan(30);
  });
});
