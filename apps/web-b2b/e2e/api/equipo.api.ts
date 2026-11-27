import { expect, test } from '@playwright/test';
import { correosPara, hayBuzon } from '../support/correo';
import { como, nodo, olvidar, sql, type Api } from './support/cliente';
import { PERSONAS, type PersonaKey } from './support/personas';

/**
 * Equipo (docs/qa/01 §2 EQU) por HTTP, sobre e2e-agencia-equipo, que sólo usa este archivo:
 * jefe (agency_admin), admin y vendedor. El seed los deja como al principio en cada corrida.
 *
 * - EQU-06: cambiar rol. No a sí mismo; hay que superar el rol actual y el nuevo; el último admin
 *   activo no se degrada; degradar revoca las invitaciones que ya no podría enviar, y la vista
 *   previa (`/admin/memberships/impact`) lo cuenta antes.
 * - EQU-07: suspender y reactivar. Cierra sus sesiones en el nodo, revoca sus invitaciones, el
 *   último admin no se suspende, y la persona recibe el aviso por correo.
 * - EQU-08: quitar del nodo. Baja blanda (la fila queda), después todo es 409 MEMBERSHIP_REMOVED;
 *   quitar a un admin pide el 2FA reciente.
 *
 * Los pasos dependen unos de otros: van en serie y en ese orden.
 */
test.describe.configure({ mode: 'serial' });

const M = '/admin/memberships';
let tenantId: string;
const ids: Partial<Record<PersonaKey, string>> = {};

async function idDe(key: PersonaKey): Promise<string> {
  ids[key] ??= (
    await sql<{ id: string }>('SELECT id FROM users WHERE email = $1', [PERSONAS[key].email])
  )[0]!.id;
  return ids[key]!;
}

async function membresia(key: PersonaKey) {
  const [m] = await sql<{ role: string; status: string; removed_at: Date | null }>(
    'SELECT role, status, removed_at FROM memberships WHERE tenant_id = $1 AND user_id = $2',
    [tenantId, await idDe(key)],
  );
  return m!;
}

/** Una invitación pendiente enviada por `key`, a un correo que nadie más usa. */
async function invitarComo(key: PersonaKey): Promise<string> {
  const api = await como(key);
  const r = await api.post<{ id?: string; invitation?: { id: string } }>('/invitations', {
    email: `equ-${Date.now()}-${Math.floor(Math.random() * 1e6)}@e2e.test`,
    tenantId,
    role: 'vendedor',
  });
  expect(r.status, r.text.slice(0, 200)).toBeLessThan(300);
  const [inv] = await sql<{ id: string }>(
    `SELECT id FROM user_invitations
      WHERE invited_by = $1 AND tenant_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [await idDe(key), tenantId],
  );
  return inv!.id;
}

async function revocada(invitationId: string): Promise<boolean> {
  const [i] = await sql<{ revoked: boolean }>(
    'SELECT revoked_at IS NOT NULL AS revoked FROM user_invitations WHERE id = $1',
    [invitationId],
  );
  return i!.revoked;
}

const rol = (api: Api, key: PersonaKey, role: string) =>
  idDe(key).then((userId) =>
    api.patch<{ revokedInvitations?: number }>(`${M}/role`, { userId, tenantId, role }),
  );
const estado = (api: Api, key: PersonaKey, status: 'active' | 'suspended') =>
  idDe(key).then((userId) =>
    api.patch<{ revokedSessions?: number; revokedInvitations?: number }>(`${M}/status`, {
      userId,
      tenantId,
      status,
    }),
  );
const quitar = (api: Api, key: PersonaKey) =>
  idDe(key).then((userId) =>
    api.post<{ status?: string; revokedSessions?: number }>(`${M}/remove`, { userId, tenantId }),
  );

test.beforeAll(async () => {
  tenantId = await nodo('e2e-agencia-equipo');
});

test('EQU-06 cambiar rol: reglas de rango, vista previa y revocación de invitaciones', async () => {
  const jefe = await como('jefeEquipo');
  const admin = await como('adminEquipo');
  const malas: string[] = [];
  const esperar403 = (caso: string, r: { status: number; text: string }) => {
    if (r.status !== 403) malas.push(`${caso} → ${r.status} ${r.text.slice(0, 100)}`);
  };

  esperar403('el jefe se cambia su propio rol', await rol(jefe, 'jefeEquipo', 'vendedor'));
  esperar403(
    'el jefe da un rol que no supera (tenant_admin)',
    await rol(jefe, 'vendedorEquipo', 'tenant_admin'),
  );
  esperar403(
    'el jefe da su mismo rango (agency_admin)',
    await rol(jefe, 'vendedorEquipo', 'agency_admin'),
  );
  esperar403('el admin toca a quien lo supera', await rol(admin, 'jefeEquipo', 'vendedor'));
  esperar403('el admin se cambia su propio rol', await rol(admin, 'adminEquipo', 'vendedor'));
  const vista = await admin.get(
    `${M}/impact?userId=${await idDe('jefeEquipo')}&tenantId=${tenantId}&role=vendedor`,
  );
  esperar403('el admin pide la vista previa sobre el jefe', vista);
  expect(malas, malas.join('\n')).toEqual([]);

  // Degradar al admin a vendedor: su invitación pendiente queda huérfana y se revoca.
  const inv = await invitarComo('adminEquipo');
  const previa = await jefe.get<{ invitationsToRevoke: number }>(
    `${M}/impact?userId=${await idDe('adminEquipo')}&tenantId=${tenantId}&role=vendedor`,
  );
  expect(previa.status, previa.text.slice(0, 200)).toBe(200);
  expect(previa.body.invitationsToRevoke).toBeGreaterThanOrEqual(1);
  expect(await revocada(inv), 'la vista previa no revoca nada').toBe(false);

  const degradar = await rol(jefe, 'adminEquipo', 'vendedor');
  expect(degradar.status, degradar.text.slice(0, 200)).toBe(200);
  expect(degradar.body.revokedInvitations).toBe(previa.body.invitationsToRevoke);
  expect(await revocada(inv)).toBe(true);
  expect((await membresia('adminEquipo')).role).toBe('vendedor');

  // Con el admin degradado, el jefe es el último admin activo: el consolidador no puede degradarlo.
  const cons = await como('consolidador');
  const ultimo = await rol(cons, 'jefeEquipo', 'vendedor');
  expect(ultimo.status, ultimo.text.slice(0, 200)).toBe(403);
  expect(ultimo.text).toMatch(/último administrador/i);
  expect((await membresia('jefeEquipo')).role).toBe('agency_admin');

  // Vuelve a ser admin, para lo que sigue.
  const devolver = await rol(jefe, 'adminEquipo', 'admin');
  expect(devolver.status, devolver.text.slice(0, 200)).toBe(200);
  olvidar('adminEquipo');
});

test('EQU-07 suspender y reactivar: sesiones, invitaciones, último admin y aviso', async () => {
  const jefe = await como('jefeEquipo');
  const cons = await como('consolidador');
  // Holgura por el reloj del contenedor de la API, que en la Mac se adelanta o atrasa unos ms.
  const desde = new Date(Date.now() - 5_000);

  // El vendedor tiene una sesión abierta en el nodo; suspenderlo la cierra.
  const vendedor = await como('vendedorEquipo');
  expect((await vendedor.get('/auth/session')).status).toBe(200);
  const propia = await estado(jefe, 'jefeEquipo', 'suspended');
  expect(propia.status, 'suspenderse a sí mismo').toBe(403);

  const suspender = await estado(jefe, 'vendedorEquipo', 'suspended');
  expect(suspender.status, suspender.text.slice(0, 200)).toBe(200);
  expect(suspender.body.revokedSessions).toBeGreaterThanOrEqual(1);
  expect((await membresia('vendedorEquipo')).status).toBe('suspended');
  expect((await vendedor.get('/auth/session')).status, 'la sesión quedó cerrada').toBe(401);
  olvidar('vendedorEquipo');

  const reactivar = await estado(jefe, 'vendedorEquipo', 'active');
  expect(reactivar.status, reactivar.text.slice(0, 200)).toBe(200);
  expect((await membresia('vendedorEquipo')).status).toBe('active');

  if (await hayBuzon()) {
    await expect
      .poll(() => correosPara(PERSONAS.vendedorEquipo.email, desde), {
        message: 'avisos de suspensión y de reactivación',
        timeout: 20_000,
      })
      .toBeGreaterThanOrEqual(2);
  }

  // Suspender al admin revoca sus invitaciones; con él suspendido, el jefe es el último admin.
  const inv = await invitarComo('adminEquipo');
  const susAdmin = await estado(cons, 'adminEquipo', 'suspended');
  expect(susAdmin.status, susAdmin.text.slice(0, 200)).toBe(200);
  expect(susAdmin.body.revokedInvitations).toBeGreaterThanOrEqual(1);
  expect(await revocada(inv)).toBe(true);
  olvidar('adminEquipo');

  const ultimo = await estado(cons, 'jefeEquipo', 'suspended');
  expect(ultimo.status, ultimo.text.slice(0, 200)).toBe(403);
  expect(ultimo.text).toMatch(/último administrador/i);
  expect((await membresia('jefeEquipo')).status).toBe('active');

  const vuelve = await estado(cons, 'adminEquipo', 'active');
  expect(vuelve.status, vuelve.text.slice(0, 200)).toBe(200);
});

test('EQU-08 quitar del nodo: baja blanda, después 409; quitar a un admin pide el 2FA reciente', async () => {
  const jefe = await como('jefeEquipo');
  const vendedor = await como('vendedorEquipo');
  expect((await vendedor.get('/auth/session')).status).toBe(200);

  expect((await quitar(jefe, 'jefeEquipo')).status, 'quitarse a sí mismo').toBe(403);
  expect(
    (await quitar(await como('adminEquipo'), 'jefeEquipo')).status,
    'quitar a quien te supera',
  ).toBe(403);

  const fuera = await quitar(jefe, 'vendedorEquipo');
  expect(fuera.status, fuera.text.slice(0, 200)).toBe(200);
  expect(fuera.body.status).toBe('removed');
  expect(fuera.body.revokedSessions).toBeGreaterThanOrEqual(1);
  const m = await membresia('vendedorEquipo');
  expect(m.status, 'la fila queda: baja blanda').toBe('removed');
  expect(m.removed_at).not.toBeNull();
  expect((await vendedor.get('/auth/session')).status).toBe(401);
  olvidar('vendedorEquipo');

  const malas: string[] = [];
  for (const [caso, r] of [
    ['quitarla otra vez', await quitar(jefe, 'vendedorEquipo')],
    ['reactivarla', await estado(jefe, 'vendedorEquipo', 'active')],
    ['cambiarle el rol', await rol(jefe, 'vendedorEquipo', 'admin')],
  ] as const) {
    if (r.status !== 409 || !r.text.includes('MEMBERSHIP_REMOVED')) {
      malas.push(`${caso} → ${r.status} ${r.text.slice(0, 100)}`);
    }
  }
  expect(malas, malas.join('\n')).toEqual([]);

  // Quitar a un admin con un 2FA viejo: 403 MFA_RECENT_REQUIRED y nada cambia; con step-up, sale.
  await sql(
    `UPDATE sessions SET mfa_verified_at = now() - interval '2 hours'
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [await idDe('jefeEquipo')],
  );
  const viejo = await quitar(jefe, 'adminEquipo');
  expect(viejo.status, viejo.text.slice(0, 200)).toBe(403);
  expect(viejo.text).toContain('MFA_RECENT_REQUIRED');
  expect((await membresia('adminEquipo')).status).toBe('active');
  await jefe.stepUp();
  const conPaso = await quitar(jefe, 'adminEquipo');
  expect(conPaso.status, conPaso.text.slice(0, 200)).toBe(200);
  expect((await membresia('adminEquipo')).status).toBe('removed');
  olvidar('adminEquipo');
});
