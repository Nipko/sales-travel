import { expect, test } from '@playwright/test';
import { anonimoDesde, nodo, sql, type Api } from './support/cliente';
import { API_PASSWORD } from './support/personas';

/**
 * Tanda 5 (docs/qa/01 §5.1 ACC): ingreso de las cuentas de casos especiales que siembra
 * e2e/env/seed.sql (INF-2). Cada caso usa su propia IP para no gastar el cupo de logins de otro.
 *
 * - ACC-04: bloqueo tras 5 fallos.
 * - ACC-21: usuario suspendido, nodo suspendido, membresía suspendida.
 * - ACC-33: cambio de nodo activo.
 * - ACC-32: registro público cerrado.
 * - EQU-10: quien tiene que cambiar la contraseña no entra.
 * - TRV-02: logout-all cierra todas las sesiones.
 */

test.describe.configure({ mode: 'serial' });

const login = (api: Api, email: string, password = API_PASSWORD) =>
  api.post<{ token?: string; reason?: string }>('/auth/login', { email, password });

const conToken = (token: string) => ({ authorization: `Bearer ${token}` });

/** El nodo activo de una sesión: el claim `tid` del token (JWT). */
function nodoActivo(_api: Api, token: string): string | undefined {
  const payload = token.split('.')[1] ?? '';
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    tid?: string;
  };
  return claims.tid;
}

test('ACC-04 cinco fallos seguidos bloquean la cuenta, también para la contraseña correcta', async () => {
  // IP nueva en cada corrida: el cupo de 10 logins por minuto es por IP y esta prueba gasta 6.
  const api = await anonimoDesde(`198.51.100.${100 + Math.floor(Math.random() * 99)}`);
  const email = 'api-bloqueo@e2e.test';
  const malas: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const r = await login(api, email, `Mala-${i}-2026!`);
    if (r.status !== 401) malas.push(`fallo ${i} → ${r.status}`);
  }
  const sexto = await login(api, email);
  if (sexto.status !== 401) malas.push(`la correcta tras 5 fallos → ${sexto.status}`);
  const [u] = await sql<{ locked_until: Date | null }>(
    'SELECT locked_until FROM users WHERE email = $1',
    [email],
  );
  const minutos = u?.locked_until ? (new Date(u.locked_until).getTime() - Date.now()) / 60_000 : 0;
  if (minutos < 10 || minutos > 16) malas.push(`locked_until a ${minutos.toFixed(1)} min`);
  const ev = await sql(
    `SELECT 1 FROM domain_events e JOIN users u ON u.id::text = e.aggregate_id::text
      WHERE u.email = $1 AND e.event_type = 'auth.login.blocked'`,
    [email],
  );
  if (ev.length === 0) malas.push('sin evento auth.login.blocked');
  expect(malas, malas.join(' | ')).toEqual([]);
});

test('ACC-21 suspendidos: usuario, nodo y membresía', async () => {
  const api = await anonimoDesde('198.51.100.61');
  const malas: string[] = [];

  const suspendido = await login(api, 'api-suspendido@e2e.test');
  if (suspendido.status !== 401) malas.push(`usuario suspendido → ${suspendido.status}`);

  // Por diseño el ingreso se abre aunque su único nodo esté suspendido (default-tenant.ts: el panel le
  // explica por qué no opera). Lo que no puede es operar: sin rol bajo un nodo suspendido.
  const nodoSusp = await login(api, 'api-nodo-susp@e2e.test');
  if (nodoSusp.status !== 200 || !nodoSusp.body.token) {
    malas.push(`único nodo suspendido → ${nodoSusp.status}`);
  } else {
    for (const ruta of ['/customers', '/quotations', '/crm/opportunities']) {
      const r = await api.get(ruta, conToken(nodoSusp.body.token));
      if (r.status !== 403) malas.push(`con el nodo suspendido, GET ${ruta} → ${r.status}`);
    }
  }

  const memb = await login(api, 'api-memb-susp@e2e.test');
  if (memb.status !== 200 || !memb.body.token) {
    malas.push(`membresía suspendida en A, activa en B → ${memb.status}`);
  } else {
    const activo = nodoActivo(api, memb.body.token);
    if (activo !== (await nodo('e2e-agencia-b'))) malas.push(`entró a ${activo}, no a B`);
    const aA = await api.post(
      '/auth/switch-tenant',
      { tenantId: await nodo('e2e-agencia-a') },
      conToken(memb.body.token),
    );
    if (aA.status !== 403) malas.push(`cambia al nodo de la membresía suspendida → ${aA.status}`);
  }
  expect(malas, malas.join(' | ')).toEqual([]);
});

test('ACC-33 cambio de nodo activo: sólo a uno con membresía, con token nuevo', async () => {
  const api = await anonimoDesde('198.51.100.62');
  const r = await login(api, 'api-multi@e2e.test');
  expect(r.status, r.text).toBe(200);
  const token = r.body.token!;
  const nodoB = await nodo('e2e-agencia-b');
  const malas: string[] = [];

  const ajeno = await api.post(
    '/auth/switch-tenant',
    { tenantId: await nodo('e2e-consolidador') },
    conToken(token),
  );
  if (ajeno.status !== 403) malas.push(`a un nodo sin membresía → ${ajeno.status}`);

  const sw = await api.post<{ token?: string }>(
    '/auth/switch-tenant',
    { tenantId: nodoB },
    conToken(token),
  );
  if (sw.status !== 200 || !sw.body.token) {
    malas.push(`a B → ${sw.status} ${sw.text.slice(0, 80)}`);
  } else {
    if (sw.body.token === token) malas.push('devolvió el mismo token');
    if (nodoActivo(api, sw.body.token) !== nodoB) malas.push('el token nuevo no es de B');
    const viejo = await api.get('/me', conToken(token));
    if (viejo.status !== 401) malas.push(`el token anterior sigue vivo → ${viejo.status}`);
  }
  expect(malas, malas.join(' | ')).toEqual([]);
});

test('ACC-32 el registro público está cerrado', async () => {
  const api = await anonimoDesde('198.51.100.63');
  const r = await api.post('/auth/register', {
    email: 'qa-registro@e2e.test',
    password: 'Otra-Clave-2026!',
    name: 'QA Registro',
    tenantName: 'QA',
  });
  expect([400, 403], `${r.status} ${r.text.slice(0, 80)}`).toContain(r.status);
  const creado = await sql("SELECT id FROM users WHERE email = 'qa-registro@e2e.test'");
  expect(creado).toEqual([]);
});

test('EQU-10 quien tiene que cambiar la contraseña no entra hasta cambiarla', async () => {
  const api = await anonimoDesde('198.51.100.64');
  const r = await login(api, 'api-reset@e2e.test');
  expect(r.status, r.text).toBe(403);
  expect(r.text).toContain('PASSWORD_RESET_REQUIRED');
  expect(r.body.token).toBeUndefined();
});

test('TRV-02 sesión reemplazada y logout-all: los tokens viejos dan 401 con su motivo', async () => {
  const api = await anonimoDesde('198.51.100.65');
  const email = 'api-multi@e2e.test';
  // La agencia tiene un puesto simultáneo: el segundo ingreso reemplaza al primero.
  const t1 = (await login(api, email)).body.token!;
  const t2 = (await login(api, email)).body.token!;
  const reemplazada = await api.get('/me', conToken(t1));
  expect(reemplazada.status).toBe(401);
  expect(reemplazada.text).toContain('SESSION_REPLACED');
  expect((await api.get('/me', conToken(t2))).status).toBe(200);

  const out = await api.post<{ revoked: number }>('/auth/logout-all', {}, conToken(t2));
  expect(out.status, out.text).toBe(200);
  expect(out.body.revoked).toBeGreaterThanOrEqual(1);
  expect((await api.get('/me', conToken(t2))).status).toBe(401);
  const vivas = await sql(
    `SELECT s.id FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE u.email = $1 AND s.revoked_at IS NULL`,
    [email],
  );
  expect(vivas, 'quedaron sesiones sin revocar').toEqual([]);
});
