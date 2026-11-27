import { expect, test } from '@playwright/test';
import { como, nodo, sql, type Api } from './support/cliente';
import { PERSONAS } from './support/personas';

/**
 * TRV-12 (docs/qa/01 §3): el superadmin supervisado, en cada uno de los 17 cambios con puerta, deja
 * una solicitud (409 CHANGE_REQUEST_PENDING) y el cambio NO se aplica. Las solicitudes que deja la
 * prueba se cancelan al final.
 */

async function idDe(email: string): Promise<string> {
  const [u] = await sql<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
  return u!.id;
}

async function conStepUp(api: Api, pedir: () => ReturnType<Api['pedir']>) {
  const r = await pedir();
  if (r.status === 403 && r.text.includes('MFA_RECENT_REQUIRED')) {
    await api.stepUp();
    return pedir();
  }
  return r;
}

test('TRV-12 los 17 cambios con puerta: el supervisado deja solicitud y nada cambia', async () => {
  const sup = await como('supervisado');
  const nodoB = await nodo('e2e-agencia-b');
  const consolidador = await nodo('e2e-consolidador');
  const pleno = await idDe(PERSONAS.superadmin.email);
  const vendedorB = await idDe(PERSONAS.vendedorB.email);
  const [perfil] = await sql<{ id: string }>(
    'SELECT id FROM governance_profiles WHERE archived_at IS NULL ORDER BY created_at LIMIT 1',
  );
  const antes = new Date();
  const [estadoAntes] = await sql<{ status: string }>('SELECT status FROM tenants WHERE id = $1', [
    nodoB,
  ]);

  const G = '/admin/governance';
  const P = '/admin/providers';
  const cambios: [string, string, unknown][] = [
    ['POST', `${G}/profiles`, { name: `QA TRV-12 ${Date.now()}`, items: [] }],
    ['PUT', `${G}/profiles/${perfil!.id}`, { name: `QA TRV-12 renombrado ${Date.now()}` }],
    ['POST', `${G}/profiles/${perfil!.id}/archive`, {}],
    ['PUT', `${G}/profiles/${perfil!.id}/default`, { isDefault: false }],
    [
      'PUT',
      `${G}/rules`,
      { tenantId: nodoB, provider: 'latam-ndc', method: 'cash', enabled: false },
    ],
    ['PUT', `${G}/tenants/${nodoB}/profile`, { profileId: null }],
    [
      'POST',
      '/admin/platform-admins',
      { email: PERSONAS.vendedorB.email, supervised: true, reason: null },
    ],
    ['PUT', `/admin/platform-admins/${pleno}/supervision`, { supervised: true, reason: null }],
    ['POST', `/admin/platform-admins/${pleno}/revoke`, { reason: null }],
    ['POST', `${P}/latam-ndc/kill-switch/clear`, { reason: 'QA TRV-12' }],
    ['PUT', `${P}/latam-ndc/global`, { enabled: false, reason: 'QA TRV-12' }],
    ['DELETE', `${P}/latam-ndc/global`, undefined],
    ['PUT', `${P}/latam-ndc/tenants/${nodoB}`, { enabled: false, reason: 'QA TRV-12' }],
    ['DELETE', `${P}/latam-ndc/tenants/${nodoB}`, undefined],
    ['PATCH', `/admin/tenants/${nodoB}`, { status: 'suspended', reason: 'QA TRV-12 suspender' }],
    ['POST', `/admin/tenants/${nodoB}/move`, { parentTenantId: consolidador }],
    ['PATCH', '/admin/users/status', { userId: vendedorB, status: 'suspended' }],
  ];
  expect(cambios).toHaveLength(17);

  const malas: string[] = [];
  try {
    for (const [method, path, body] of cambios) {
      const r = await conStepUp(sup, () =>
        sup.pedir(method, path, body === undefined ? {} : { body }),
      );
      if (r.status !== 409 || !r.text.includes('CHANGE_REQUEST_PENDING')) {
        malas.push(`${method} ${path} → ${r.status} ${r.text.slice(0, 100)}`);
      }
    }
    expect(malas, malas.join('\n')).toEqual([]);

    // Nada se aplicó: el nodo sigue como estaba y la cuenta sigue activa.
    const [estadoDespues] = await sql<{ status: string; parent: string }>(
      'SELECT status, parent_tenant_id AS parent FROM tenants WHERE id = $1',
      [nodoB],
    );
    expect(estadoDespues?.status).toBe(estadoAntes?.status);
    const [cuenta] = await sql<{ status: string }>('SELECT status FROM users WHERE id = $1', [
      vendedorB,
    ]);
    expect(cuenta?.status).toBe('active');
  } finally {
    const pendientes = await sql<{ id: string }>(
      `SELECT id FROM platform_change_requests
        WHERE requested_by = (SELECT id FROM users WHERE email = $1)
          AND status = 'pending' AND created_at >= $2`,
      [PERSONAS.supervisado.email, antes],
    );
    for (const p of pendientes) await sup.post(`/admin/change-requests/${p.id}/cancel`, {});
  }
});
