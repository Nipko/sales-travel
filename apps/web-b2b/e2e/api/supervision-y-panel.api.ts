import { expect, test, request } from '@playwright/test';
import { E2E } from '../support/env';
import { como, nodo, sql } from './support/cliente';

/**
 * SUP-20 (QA-H-25): el superadmin supervisado no puede dejar un nodo con perfil de gobierno sin pasar
 * por la aprobación de un pleno. Asignarlo a un nodo que ya existe pasa por la puerta
 * (`governance.*`); al crearlo, no pasaba.
 *
 * TRV-15 (QA-H-03): ninguna acción del panel (`POST/PATCH/PUT/DELETE /api/*` del BFF) se ejecuta si el
 * pedido viene de otro origen, aunque traiga la cookie de sesión de un admin: un subdominio hermano
 * (same-site) la manda igual con `SameSite=Lax`.
 */

async function perfilDeGobierno(): Promise<string> {
  const [fila] = await sql<{ id: string }>(
    'SELECT id FROM governance_profiles WHERE archived_at IS NULL ORDER BY created_at LIMIT 1',
  );
  if (fila) return fila.id;
  const sa = await como('superadmin');
  const body = { name: 'Perfil QA', items: [] };
  let r = await sa.post<{ id?: string; profile?: { id: string } }>(
    '/admin/governance/profiles',
    body,
  );
  if (r.status === 403 && r.text.includes('MFA_RECENT_REQUIRED')) {
    await sa.stepUp();
    r = await sa.post('/admin/governance/profiles', body);
  }
  const id = r.body?.id ?? r.body?.profile?.id;
  if (!id) throw new Error(`no pude crear un perfil de gobierno: ${r.status} ${r.text}`);
  return id;
}

test('SUP-20 el supervisado no asigna gobierno al crear un nodo sin aprobación (QA-H-25)', async () => {
  const api = await como('supervisado');
  const governanceProfileId = await perfilDeGobierno();
  const slug = `qa-sup20-${Date.now().toString(36)}`;
  const r = await api.post('/admin/tenants', {
    name: 'QA SUP-20',
    slug,
    countryCode: 'CO',
    defaultCurrency: 'COP',
    parentTenantId: await nodo('e2e-consolidador'),
    governanceProfileId,
  });
  const creado = await sql<{ id: string }>(
    `SELECT t.id FROM tenants t JOIN tenant_governance_profiles g ON g.tenant_id = t.id WHERE t.slug = $1`,
    [slug],
  );
  expect(creado, `el nodo ${slug} quedó con perfil de gobierno (${r.status})`).toEqual([]);
  expect([403, 409]).toContain(r.status);
});

test('TRV-15 el panel rechaza acciones que vienen de otro origen (QA-H-03)', async () => {
  const admin = await como('superadmin');
  const ctx = await request.newContext();
  const host = new URL(E2E.webUrl).host;
  const cookie = `st_session=${admin.token}`;
  // Cuerpos inválidos a propósito: si el panel no corta, la API los rechaza y no se crea nada.
  const acciones: [string, string][] = [
    ['POST', '/api/admin/tenants'],
    ['POST', `/api/admin/tenants/${await nodo('e2e-subagencia')}/move`],
    ['POST', '/api/pricing/rules'],
    ['POST', '/api/orders'],
    ['DELETE', '/api/pricing/rules/00000000-0000-4000-8000-000000000000'],
  ];
  const malas: string[] = [];
  for (const [method, ruta] of acciones) {
    const ajeno = await ctx.fetch(`${E2E.webUrl}${ruta}`, {
      method,
      headers: {
        cookie,
        origin: 'https://otro.planetour.cloud',
        'sec-fetch-site': 'same-site',
        'content-type': 'application/json',
      },
      data: {},
      failOnStatusCode: false,
      maxRedirects: 0,
    });
    const texto = await ajeno.text();
    if (ajeno.status() !== 403 || !texto.includes('CROSS_ORIGIN'))
      malas.push(`${method} ${ruta} desde otro origen → ${ajeno.status()} ${texto.slice(0, 90)}`);

    // Control: el mismo pedido desde el panel no lo corta el chequeo de origen.
    const propio = await ctx.fetch(`${E2E.webUrl}${ruta}`, {
      method,
      headers: {
        cookie,
        origin: `http://${host}`,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      data: {},
      failOnStatusCode: false,
      maxRedirects: 0,
    });
    if ((await propio.text()).includes('CROSS_ORIGIN'))
      malas.push(`${method} ${ruta} desde el panel quedó bloqueado`);
  }
  await ctx.dispose();
  expect(malas, malas.join(' | ')).toEqual([]);
});
