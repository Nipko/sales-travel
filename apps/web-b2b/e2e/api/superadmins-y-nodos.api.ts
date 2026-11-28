import { expect, test } from '@playwright/test';
import { hayBuzon, ultimoCorreo } from '../support/correo';
import { como, nodo, sql, type Api } from './support/cliente';
import { PERSONAS } from './support/personas';

/**
 * Tanda 32, consola de plataforma parte 3 (docs/qa/01 §5 SUP), por HTTP:
 *
 * - SUP-18: el supervisado pide dar acceso → 409 con el id de la solicitud; no decide la suya; el pleno
 *   valida la nota, aprueba (con step-up) y el cambio se aplica; ya decidida → 409; cancelar es sólo
 *   de quien la pidió.
 * - SUP-17: no se cambia el acceso propio; correo sin cuenta → 404 USER_NOT_FOUND; «crear cuenta» la
 *   crea y manda «Activa tu cuenta»; pasarla a supervisado y quitarle el acceso.
 * - SUP-16: el impacto de suspender a alguien cuenta sus sesiones; sobre uno mismo → 403; una cuenta
 *   que no existe → 404.
 * - SUP-23: suspender un nodo pide motivo (5–500), la plataforma no se suspende, el impacto cuenta su
 *   red, y reactivar lo devuelve.
 * - SUP-24: «Tarifas de vuelo en otra moneda» se enciende y se apaga; un nodo que no existe → 404.
 */

test.describe.configure({ mode: 'serial' });

const corrida = Date.now().toString(36);
interface ErrorApi {
  message: string;
  reason?: string;
  details?: { changeRequestId?: string };
}

let sa: Api;
let sup: Api;

async function conStepUp<T>(
  api: Api,
  pedir: () => Promise<{ status: number; text: string; body: T }>,
) {
  const r = await pedir();
  if (r.status === 403 && r.text.includes('MFA_RECENT_REQUIRED')) {
    await api.stepUp();
    return pedir();
  }
  return r;
}

async function cuentaNueva(sufijo: string): Promise<{ id: string; email: string }> {
  const email = `qa32-${corrida}-${sufijo}@e2e.test`;
  const [u] = await sql<{ id: string }>(
    `INSERT INTO users (email, name, password_hash, email_verified_at, password_changed_at)
     VALUES ($1, $2, crypt('Clave-QA32-2026!', gen_salt('bf', 4)), now(), now()) RETURNING id`,
    [email, `QA32 ${sufijo}`],
  );
  return { id: u!.id, email };
}

test.beforeAll(async () => {
  sa = await como('superadmin');
  sup = await como('supervisado');
});

test('SUP-18 solicitud del supervisado: el pleno la decide y se aplica', async () => {
  const otra = await cuentaNueva('solicitada');
  const pedida = await conStepUp(sup, () =>
    sup.post<ErrorApi>('/admin/platform-admins', {
      email: otra.email,
      supervised: true,
      reason: 'QA32 solicitud',
    }),
  );
  expect(pedida.status, pedida.text).toBe(409);
  expect(pedida.body.reason).toBe('CHANGE_REQUEST_PENDING');
  const id = pedida.body.details?.changeRequestId;
  expect(id, 'la respuesta trae el id de la solicitud').toBeTruthy();

  const suya = await conStepUp(sup, () =>
    sup.post<ErrorApi>(`/admin/change-requests/${id}/approve`, {}),
  );
  expect(suya.status).toBe(403);
  expect(suya.body.reason).toBe('FULL_SUPERADMIN_REQUIRED');

  const ajena = await sa.post<ErrorApi>(`/admin/change-requests/${id}/cancel`, {});
  expect(ajena.status).toBe(403);
  expect(ajena.body.reason).toBe('NOT_REQUESTER');

  const notaCorta = await conStepUp(sa, () =>
    sa.post<ErrorApi>(`/admin/change-requests/${id}/approve`, { note: 'ok' }),
  );
  expect(notaCorta.status).toBe(400);
  expect(notaCorta.text).toContain('la nota tiene que tener al menos 3 caracteres');

  const aprobada = await conStepUp(sa, () =>
    sa.post<ErrorApi>(`/admin/change-requests/${id}/approve`, { note: 'QA32 visto' }),
  );
  expect(aprobada.status, aprobada.text).toBe(200);
  const lista = await sa.get('/admin/platform-admins');
  expect(lista.text, 'el acceso se aplicó al aprobar').toContain(otra.email);

  const otraVez = await conStepUp(sa, () =>
    sa.post<ErrorApi>(`/admin/change-requests/${id}/approve`, {}),
  );
  expect(otraVez.status).toBe(409);
  expect(otraVez.body.reason).toBe('CHANGE_REQUEST_NOT_PENDING');

  const segunda = await conStepUp(sup, () =>
    sup.post<ErrorApi>(`/admin/platform-admins/${otra.id}/revoke`, { reason: 'QA32 otra' }),
  );
  expect(segunda.status).toBe(409);
  const cancelar = await sup.post(
    `/admin/change-requests/${segunda.body.details!.changeRequestId}/cancel`,
    {},
  );
  expect(cancelar.status, cancelar.text).toBeLessThan(300);

  const fin = await conStepUp(sa, () =>
    sa.post(`/admin/platform-admins/${otra.id}/revoke`, { reason: 'QA32 limpieza' }),
  );
  expect(fin.status, fin.text).toBe(200);
});

test('SUP-17 dar acceso: el propio no, sin cuenta → crearla con correo, cambiar y quitar', async () => {
  const [yo] = await sql<{ id: string }>('SELECT id FROM users WHERE email = $1', [
    PERSONAS.superadmin.email,
  ]);
  const propio = await conStepUp(sa, () =>
    sa.put<ErrorApi>(`/admin/platform-admins/${yo!.id}/supervision`, {
      supervised: true,
      reason: 'QA32 propio',
    }),
  );
  expect(propio.status).toBe(403);
  expect(propio.body.reason).toBe('SELF_PLATFORM_ADMIN_CHANGE');

  const email = `qa32-${corrida}-nueva@e2e.test`;
  const sinCuenta = await conStepUp(sa, () =>
    sa.post<ErrorApi>('/admin/platform-admins', { email, supervised: true }),
  );
  expect(sinCuenta.status).toBe(404);
  expect(sinCuenta.body.reason).toBe('USER_NOT_FOUND');

  const desde = new Date(Date.now() - 1_000);
  const creada = await conStepUp(sa, () =>
    sa.post<{ admins?: { userId: string; email: string }[] }>('/admin/platform-admins', {
      email,
      supervised: false,
      createAccount: true,
      name: 'QA32 Nueva',
      reason: 'QA32 alta',
    }),
  );
  expect(creada.status, creada.text).toBeLessThan(300);
  if (await hayBuzon()) {
    const correo = await ultimoCorreo(email, { desde, esperaMs: 15_000 });
    expect(correo?.asunto).toBe('Activa tu cuenta · PlaneTour');
  }
  const [nueva] = await sql<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);

  const supervisada = await conStepUp(sa, () =>
    sa.put(`/admin/platform-admins/${nueva!.id}/supervision`, {
      supervised: true,
      reason: 'QA32 a supervisado',
    }),
  );
  expect(supervisada.status, supervisada.text).toBeLessThan(300);
  const [m] = await sql<{ supervised: boolean }>(
    `SELECT m.platform_supervised AS supervised FROM memberships m JOIN tenants t ON t.id = m.tenant_id
      WHERE m.user_id = $1 AND t.tenant_type = 'platform'`,
    [nueva!.id],
  );
  expect(m?.supervised).toBe(true);

  const quitar = await conStepUp(sa, () =>
    sa.post(`/admin/platform-admins/${nueva!.id}/revoke`, { reason: 'QA32 quitar' }),
  );
  expect(quitar.status, quitar.text).toBe(200);
});

test('SUP-16 impacto de suspender una cuenta; uno mismo no; una que no existe', async () => {
  await como('vendedorB');
  const [vb] = await sql<{ id: string }>('SELECT id FROM users WHERE email = $1', [
    PERSONAS.vendedorB.email,
  ]);
  const impacto = await sa.get<{
    activeMemberships: number;
    liveSessions: number;
    invitationsToRevoke: number;
  }>(`/admin/users/${vb!.id}/impact`);
  expect(impacto.status, impacto.text).toBe(200);
  expect(impacto.body.activeMemberships).toBeGreaterThan(0);
  expect(impacto.body.liveSessions, 'su sesión del arnés').toBeGreaterThan(0);

  const [yo] = await sql<{ id: string }>('SELECT id FROM users WHERE email = $1', [
    PERSONAS.superadmin.email,
  ]);
  const propio = await sa.get<ErrorApi>(`/admin/users/${yo!.id}/impact`);
  expect(propio.status).toBe(403);
  expect(propio.body.message).toBe('no puedes suspender tu propio usuario');

  const nadie = await sa.get(`/admin/users/00000000-0000-4000-8000-0000000000aa/impact`);
  expect(nadie.status).toBe(404);
});

test('SUP-23 / SUP-24 suspender y reactivar un nodo; tarifas en otra moneda', async () => {
  const creado = await sa.post<{ tenant: { id: string } }>('/admin/tenants', {
    name: `QA32 Agencia ${corrida}`,
    slug: `qa32-${corrida}`,
    countryCode: 'CO',
    defaultCurrency: 'COP',
    tenantType: 'agency',
  });
  expect(creado.status, creado.text).toBe(201);
  const id = creado.body.tenant.id;

  const sinMotivo = await sa.patch<ErrorApi>(`/admin/tenants/${id}`, { status: 'suspended' });
  expect(sinMotivo.status).toBe(400);
  expect(sinMotivo.text).toContain('Indica el motivo de la suspensión (5 a 500 caracteres).');
  const corto = await sa.patch(`/admin/tenants/${id}`, { status: 'suspended', reason: 'abc' });
  expect(corto.status).toBe(400);

  const impacto = await sa.get<{ descendants: number; activeUsers: number }>(
    `/admin/tenants/${id}/impact`,
  );
  expect(impacto.status, impacto.text).toBe(200);
  expect(impacto.body).toMatchObject({ descendants: 0 });

  const suspender = await sa.patch(`/admin/tenants/${id}`, {
    status: 'suspended',
    reason: 'QA32 deuda vencida',
  });
  expect(suspender.status, suspender.text).toBeLessThan(300);
  const [fila] = await sql<{ status: string }>('SELECT status FROM tenants WHERE id = $1', [id]);
  expect(fila?.status).toBe('suspended');
  const volver = await sa.patch(`/admin/tenants/${id}`, { status: 'active' });
  expect(volver.status, volver.text).toBeLessThan(300);

  const plataforma = await sa.patch<ErrorApi>(`/admin/tenants/${await nodo('platform')}`, {
    status: 'suspended',
    reason: 'QA32 nunca',
  });
  expect(plataforma.status).toBe(409);
  expect(plataforma.body.reason).toBe('TENANT_PLATFORM_LOCKED');

  const ruta = `/admin/tenants/${id}/foreign-currency-fares`;
  for (const enabled of [true, false]) {
    const r = await sa.patch(ruta, { enabled });
    expect(r.status, r.text).toBeLessThan(300);
    const leido = await sa.get<{ enabled: boolean }>(ruta);
    expect(leido.body.enabled).toBe(enabled);
  }
  const nadie = await sa.get(
    `/admin/tenants/00000000-0000-4000-8000-0000000000ab/foreign-currency-fares`,
  );
  expect(nadie.status).toBe(404);
});
