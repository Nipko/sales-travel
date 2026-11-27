import { expect, test } from '@playwright/test';
import { como, sql, type Api } from './support/cliente';
import { PERSONAS, type PersonaKey } from './support/personas';
import rutasJson from './rutas.generated.json';

/**
 * TRV-04 (docs/qa/01 §3): las rutas con `@RequireRecentMfa` responden 403 MFA_RECENT_REQUIRED a
 * una sesión cuyo segundo factor es viejo, ANTES de mirar el cuerpo. La lista sale del inventario
 * de rutas (tools/qa/rutas-api.mjs): una ruta nueva con la marca entra sola.
 *
 * Se envejece en la base el 2FA de la sesión (INF-5, sin esperar) y al final se reconfirma, para
 * que los casos que vienen después no paguen el step-up.
 */
interface Ruta {
  method: string;
  path: string;
  roles: string;
  recentMfa: boolean;
  superadmin: boolean;
}

const RUTAS = (rutasJson as Ruta[]).filter((r) => r.recentMfa);
const UUID = '00000000-0000-4000-8000-000000000000';

async function envejecer(key: PersonaKey): Promise<void> {
  await sql(
    `UPDATE sessions SET mfa_verified_at = now() - interval '2 hours'
      WHERE user_id = (SELECT id FROM users WHERE email = $1) AND revoked_at IS NULL`,
    [PERSONAS[key].email],
  );
}

async function revisar(api: Api, rutas: Ruta[]): Promise<string[]> {
  const malas: string[] = [];
  for (const r of rutas) {
    const path = r.path.replace(/^\/api/, '').replace(/:[A-Za-z]+/g, UUID);
    const res = await api.pedir(r.method, path, r.method === 'GET' ? {} : { body: {} });
    if (res.status !== 403 || !res.text.includes('MFA_RECENT_REQUIRED')) {
      malas.push(`${r.method} ${r.path} → ${res.status} ${res.text.slice(0, 80)}`);
    }
  }
  return malas;
}

test('TRV-04 cada ruta @RequireRecentMfa pide reconfirmar el 2FA con una sesión vieja', async () => {
  expect(RUTAS.length, 'el inventario trae las rutas marcadas').toBeGreaterThanOrEqual(11);
  const superadmin = await como('superadmin');
  const admin = await como('adminA');
  await envejecer('superadmin');
  await envejecer('adminA');
  try {
    const malas = [
      ...(await revisar(
        superadmin,
        RUTAS.filter((r) => r.superadmin),
      )),
      ...(await revisar(
        admin,
        RUTAS.filter((r) => !r.superadmin),
      )),
    ];
    expect(malas, malas.join('\n')).toEqual([]);
  } finally {
    await superadmin.stepUp();
    await admin.stepUp();
  }
});

test('TRV-03 con 2FA activo pero sesión sin verificar: 401 MFA_STEP_UP_REQUIRED', async () => {
  const admin = await como('adminA');
  await sql(
    `UPDATE sessions SET mfa_verified_at = NULL
      WHERE user_id = (SELECT id FROM users WHERE email = $1) AND revoked_at IS NULL`,
    [PERSONAS.adminA.email],
  );
  try {
    const r = await admin.get('/tenants/network');
    expect(r.status, r.text.slice(0, 120)).toBe(401);
    expect(r.text).toContain('MFA_STEP_UP_REQUIRED');
  } finally {
    // Se devuelve la sesión como estaba, para los casos que siguen con esta persona.
    await sql(
      `UPDATE sessions SET mfa_verified_at = now()
        WHERE user_id = (SELECT id FROM users WHERE email = $1) AND revoked_at IS NULL`,
      [PERSONAS.adminA.email],
    );
  }
  expect((await admin.get('/tenants/network')).status).toBe(200);
});
