import { expect, test } from '@playwright/test';
import { anonimoDesde, como, nodo, olvidar, sql, type Api } from './support/cliente';
import { API_PASSWORD, PERSONAS, type PersonaKey } from './support/personas';

/**
 * Soporte a un miembro desde Equipo (docs/qa/01 §2 EQU) por HTTP, sobre e2e-agencia-equipo. Actúa
 * el jefe (agency_admin); el que recibe es `soporteEquipo` (vendedor), salvo el 2FA, que se le
 * restablece al admin del nodo. El seed los deja como al principio en cada corrida.
 *
 * - EQU-09: enviar el enlace de restablecer: 3 en 15 minutos, el 4.º es 429
 *   PASSWORD_RESET_RATE_LIMITED; con su acceso al nodo suspendido, 409 MEMBERSHIP_SUSPENDED.
 * - EQU-10: forzar el cambio (step-up): cierra sus sesiones y el ingreso es 403 PASSWORD_RESET_REQUIRED.
 * - EQU-11: desbloquear una cuenta bloqueada (y no otra vez); cerrar todas sus sesiones.
 * - EQU-12: restablecer el 2FA (step-up): el admin vuelve a tener que enrolarse.
 * - EQU-13: puestos: el medidor lo ve, desconectar a alguien libera su puesto, a uno mismo no.
 * - EQU-15: exportar el equipo (step-up): las columnas y sólo gente del nodo.
 * - EQU-04: invitar dos veces al mismo correo → 409 con la pendiente; reenviar no abre otra; ya
 *   miembro → 409.
 *
 * En serie: el cambio forzado va al final porque deja la cuenta sin poder entrar.
 */
test.describe.configure({ mode: 'serial' });

let tenantId: string;
const ids: Partial<Record<PersonaKey, string>> = {};

async function idDe(key: PersonaKey): Promise<string> {
  ids[key] ??= (
    await sql<{ id: string }>('SELECT id FROM users WHERE email = $1', [PERSONAS[key].email])
  )[0]!.id;
  return ids[key]!;
}

const ruta = async (accion: string, key: PersonaKey = 'soporteEquipo') =>
  `/tenants/${tenantId}/members/${await idDe(key)}/${accion}`;

/** Con el 2FA de la sesión envejecido, la acción pide step-up; después del step-up, pasa. */
async function conStepUpExigido(api: Api, key: PersonaKey, pedir: () => ReturnType<Api['pedir']>) {
  await sql(
    `UPDATE sessions SET mfa_verified_at = now() - interval '2 hours'
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [await idDe(key)],
  );
  const sin = await pedir();
  expect(sin.status, sin.text.slice(0, 200)).toBe(403);
  expect(sin.text).toContain('MFA_RECENT_REQUIRED');
  await api.stepUp();
  return pedir();
}

async function sesionesAbiertas(key: PersonaKey): Promise<{ id: string }[]> {
  return sql<{ id: string }>(
    'SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL ORDER BY issued_at',
    [await idDe(key)],
  );
}

test.beforeAll(async () => {
  tenantId = await nodo('e2e-agencia-equipo');
});

test('EQU-11 desbloquear una cuenta bloqueada y cerrar todas sus sesiones', async () => {
  const jefe = await como('jefeEquipo');
  await sql(`UPDATE users SET locked_until = now() + interval '10 minutes' WHERE id = $1`, [
    await idDe('soporteEquipo'),
  ]);
  const uno = await jefe.post<{ unlocked: boolean }>(await ruta('unlock'));
  expect(uno.status, uno.text.slice(0, 200)).toBe(200);
  expect(uno.body.unlocked).toBe(true);
  const dos = await jefe.post<{ unlocked: boolean }>(await ruta('unlock'));
  expect(dos.body.unlocked, 'ya no estaba bloqueada').toBe(false);

  const soporte = await como('soporteEquipo');
  expect((await soporte.get('/auth/session')).status).toBe(200);
  const cerrar = await jefe.post<{ revoked: number }>(await ruta('revoke-sessions'));
  expect(cerrar.status, cerrar.text.slice(0, 200)).toBe(200);
  expect(cerrar.body.revoked).toBeGreaterThanOrEqual(1);
  expect((await soporte.get('/auth/session')).status).toBe(401);
  expect(await sesionesAbiertas('soporteEquipo')).toHaveLength(0);
  olvidar('soporteEquipo');

  const propio = await jefe.post(await ruta('unlock', 'jefeEquipo'));
  expect(propio.status, 'sobre uno mismo, no').toBe(403);
});

test('EQU-13 puestos: el medidor, desconectar a alguien libera su puesto; a uno mismo no', async () => {
  const jefe = await como('jefeEquipo');
  const soporte = await como('soporteEquipo');
  const vista = await jefe.get(`/tenants/${tenantId}/seats`);
  expect(vista.status, vista.text.slice(0, 200)).toBe(200);
  expect(vista.text).toContain(PERSONAS.soporteEquipo.email);

  const [suya] = await sesionesAbiertas('soporteEquipo');
  const liberar = await jefe.post(`/tenants/${tenantId}/seats/sessions/${suya!.id}/release`);
  expect(liberar.status, liberar.text.slice(0, 200)).toBe(200);
  expect((await soporte.get('/auth/session')).status).toBe(401);
  olvidar('soporteEquipo');
  const otraVez = await jefe.post(`/tenants/${tenantId}/seats/sessions/${suya!.id}/release`);
  expect(otraVez.status, 'ya liberada').toBe(404);

  const [mia] = await sesionesAbiertas('jefeEquipo');
  const propia = await jefe.post(`/tenants/${tenantId}/seats/sessions/${mia!.id}/release`);
  expect(propia.status, propia.text.slice(0, 200)).toBeGreaterThanOrEqual(400);
  expect((await jefe.get('/auth/session')).status, 'el jefe sigue adentro').toBe(200);

  const vendedor = await como('vendedorEquipo');
  const ajeno = await vendedor.get(`/tenants/${tenantId}/seats`);
  expect(ajeno.status, 'un vendedor no ve los puestos').toBe(403);
});

test('EQU-09 enlace de restablecer: 3 cada 15 minutos; no con el acceso suspendido', async () => {
  const jefe = await como('jefeEquipo');
  const enviar = async () =>
    jefe.post<{ sent: boolean; expiresAt: string }>(await ruta('send-password-reset'));
  for (let i = 1; i <= 3; i++) {
    const r = await enviar();
    expect(r.status, `envío ${i}: ${r.text.slice(0, 200)}`).toBe(200);
    expect(r.text, 'la respuesta nunca trae el enlace').not.toMatch(/token|https?:\/\//i);
  }
  const cuarto = await enviar();
  expect(cuarto.status, cuarto.text.slice(0, 200)).toBe(429);
  expect(cuarto.text).toContain('PASSWORD_RESET_RATE_LIMITED');

  // Con su acceso al nodo suspendido: MEMBERSHIP_SUSPENDED, antes de mirar el límite.
  await sql(`DELETE FROM password_reset_tokens WHERE user_id = $1`, [await idDe('soporteEquipo')]);
  const body = { userId: await idDe('soporteEquipo'), tenantId };
  expect(
    (await jefe.patch('/admin/memberships/status', { ...body, status: 'suspended' })).status,
  ).toBe(200);
  try {
    const suspendido = await enviar();
    expect(suspendido.status, suspendido.text.slice(0, 200)).toBe(409);
    expect(suspendido.text).toContain('MEMBERSHIP_SUSPENDED');
  } finally {
    await jefe.patch('/admin/memberships/status', { ...body, status: 'active' });
  }
});

test('EQU-12 restablecer el 2FA del admin pide step-up y lo devuelve a enrolarse', async () => {
  const jefe = await como('jefeEquipo');
  await como('adminEquipo');
  const r = await conStepUpExigido(jefe, 'jefeEquipo', async () =>
    jefe.post(await ruta('reset-mfa', 'adminEquipo')),
  );
  expect(r.status, r.text.slice(0, 200)).toBe(200);
  const [u] = await sql<{ mfa: Date | null }>(
    'SELECT mfa_enabled_at AS mfa FROM users WHERE id = $1',
    [await idDe('adminEquipo')],
  );
  expect(u!.mfa).toBeNull();
  expect(await sesionesAbiertas('adminEquipo')).toHaveLength(0);
  olvidar('adminEquipo');

  const login = await (
    await anonimoDesde(PERSONAS.adminEquipo.ip)
  ).post<Record<string, unknown>>('/auth/login', {
    email: PERSONAS.adminEquipo.email,
    password: API_PASSWORD,
  });
  expect(login.status, login.text.slice(0, 200)).toBe(200);
  expect(login.body['mfaEnrollmentRequired'], 'su rol exige 2FA: vuelve a enrolarse').toBe(true);
  // El arnés lo enrola de nuevo la próxima vez que lo necesite (equipo.api.ts).
  await sql(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [
    await idDe('adminEquipo'),
  ]);
});

test('EQU-15 exportar el equipo: step-up, columnas y sólo gente del nodo', async () => {
  const jefe = await como('jefeEquipo');
  const r = await conStepUpExigido(jefe, 'jefeEquipo', () =>
    jefe.get(`/tenants/${tenantId}/members-export`),
  );
  expect(r.status, r.text.slice(0, 200)).toBe(200);
  expect(r.headers['content-type']).toMatch(/text\/csv/);
  const csv = r.text.replace(/^﻿/, '');
  const [cabecera, ...filas] = csv.trim().split(/\r?\n/);
  for (const col of ['Correo', 'Nombre', 'Nodo', 'Rol', 'Estado en el nodo', '2FA']) {
    expect(cabecera, `columna ${col}`).toContain(col);
  }
  expect(csv).toContain(PERSONAS.soporteEquipo.email);
  const correos = filas.map((f) => f.match(/[\w.+-]+@[\w.-]+/)?.[0]).filter(Boolean);
  const delNodo = new Set(
    (
      await sql<{ email: string }>(
        `SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.tenant_id = $1 AND m.status <> 'removed'`,
        [tenantId],
      )
    ).map((x) => x.email),
  );
  const ajenos = correos.filter((c) => !delNodo.has(c!));
  expect(ajenos, 'sólo gente del nodo').toEqual([]);

  const ajeno = await (await como('adminB')).get(`/tenants/${tenantId}/members-export`);
  expect([403, 401]).toContain(ajeno.status);
});

test('EQU-10 forzar el cambio de contraseña: cierra sus sesiones y el ingreso lo exige', async () => {
  const jefe = await como('jefeEquipo');
  const soporte = await como('soporteEquipo');
  expect((await soporte.get('/auth/session')).status).toBe(200);
  await sql(`DELETE FROM password_reset_tokens WHERE user_id = $1`, [await idDe('soporteEquipo')]);
  const r = await conStepUpExigido(jefe, 'jefeEquipo', async () =>
    jefe.post<{ sent: boolean; revokedSessions: number }>(await ruta('require-password-reset')),
  );
  expect(r.status, r.text.slice(0, 200)).toBe(200);
  expect((r.body as { revokedSessions: number }).revokedSessions).toBeGreaterThanOrEqual(1);
  expect((await soporte.get('/auth/session')).status).toBe(401);
  olvidar('soporteEquipo');

  const login = await (
    await anonimoDesde(PERSONAS.soporteEquipo.ip)
  ).post('/auth/login', {
    email: PERSONAS.soporteEquipo.email,
    password: API_PASSWORD,
  });
  expect(login.status, login.text.slice(0, 200)).toBe(403);
  expect(login.text).toContain('PASSWORD_RESET_REQUIRED');
});

test('EQU-04 invitación repetida: 409 con la pendiente para reenviarla; ya miembro, 409', async () => {
  const jefe = await como('jefeEquipo');
  const email = `equ04-${Date.now().toString(36)}@e2e.test`;
  const invitar = (correo: string) =>
    jefe.post<{ publicDetails?: { invitationId?: string }; invitationId?: string }>(
      '/invitations',
      {
        email: correo,
        tenantId,
        role: 'vendedor',
      },
    );

  const primera = await invitar(email);
  expect(primera.status, primera.text.slice(0, 200)).toBeLessThan(300);
  const [pendiente] = await sql<{ id: string }>(
    `SELECT id FROM user_invitations
      WHERE email = $1 AND tenant_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
    [email, tenantId],
  );

  const otra = await invitar(email);
  expect(otra.status, otra.text.slice(0, 200)).toBe(409);
  expect(otra.text).toContain('INVITATION_ALREADY_PENDING');
  expect(otra.text, 'trae la pendiente para «Reenviar»').toContain(pendiente!.id);

  const reenviar = await jefe.post(`/invitations/${pendiente!.id}/resend?tenantId=${tenantId}`);
  expect(reenviar.status, reenviar.text.slice(0, 200)).toBeLessThan(300);
  const vigentes = await sql<{ n: string }>(
    `SELECT count(*) AS n FROM user_invitations
      WHERE email = $1 AND tenant_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
    [email, tenantId],
  );
  expect(Number(vigentes[0]!.n), 'reenviar no abre otra').toBe(1);

  const miembro = await invitar(PERSONAS.vendedorEquipo.email);
  expect(miembro.status, miembro.text.slice(0, 200)).toBe(409);
  expect(miembro.text).toMatch(/ya es miembro/i);
});
