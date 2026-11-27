import { expect, test } from '@playwright/test';
import { correosPara, hayBuzon, ultimoCorreo } from '../support/correo';
import { anonimoDesde, sql, type Api } from './support/cliente';
import { API_PASSWORD } from './support/personas';

/**
 * Tanda 10 (docs/qa/01 §5.1 ACC), con el buzón de INF-3:
 *
 * - ACC-22: «olvidé mi contraseña» responde lo mismo exista o no el correo; sólo el que existe recibe
 *   el enlace; el 6.º pedido en un minuto desde la misma IP es 429.
 * - ACC-05: restablecer la contraseña con ese enlace desbloquea la cuenta.
 *
 * Usa `api-bloqueo@e2e.test` (seed.sql): el seed de cada corrida le devuelve la contraseña.
 */

test.describe.configure({ mode: 'serial' });

const EMAIL = 'api-bloqueo@e2e.test';
const NUEVA = 'Restablecida-E2E-2026!';
/**
 * Una IP propia por caso y rangos que no se pisan: ACC-22 gasta el cupo de 5 pedidos por minuto
 * de la suya, y si ACC-05 sorteaba la misma, recibía 429.
 */
const ip = (desde: number) => `198.51.100.${desde + Math.floor(Math.random() * 20)}`;

test.beforeEach(async () => {
  test.skip(!(await hayBuzon()), 'este stack no tiene Mailpit (INF-3)');
});

const olvide = (api: Api, email: string) =>
  api.post<{ sent?: boolean }>('/auth/forgot-password', { email });

test('ACC-22 olvidé mi contraseña: misma respuesta exista o no, enlace sólo al que existe, 6.º → 429', async () => {
  const api = await anonimoDesde(ip(10));
  const desde = new Date(Date.now() - 1_000);
  const nadie = `nadie-${Date.now()}@e2e.test`;

  const existe = await olvide(api, EMAIL);
  const noExiste = await olvide(api, nadie);
  expect(existe.status, existe.text).toBe(200);
  expect(noExiste.status).toBe(existe.status);
  expect(noExiste.body).toEqual(existe.body);

  const correo = await ultimoCorreo(EMAIL, { desde });
  expect(correo, 'el que existe recibe el correo').toBeDefined();
  expect(correo!.enlaces.some((e) => /\/restablecer\?token=/.test(e))).toBe(true);
  expect(await correosPara(nadie, desde)).toBe(0);

  const estados: number[] = [];
  for (let i = 0; i < 4; i++) estados.push((await olvide(api, nadie)).status);
  expect(estados.slice(0, 3)).toEqual([200, 200, 200]);
  expect(estados[3], 'el 6.º en un minuto').toBe(429);
});

test('ACC-05 restablecer con el enlace del correo desbloquea la cuenta', async () => {
  await sql(
    `UPDATE users SET locked_until = now() + interval '15 minutes', failed_login_attempts = 0
      WHERE email = $1`,
    [EMAIL],
  );
  const api = await anonimoDesde(ip(30));
  const bloqueada = await api.post('/auth/login', { email: EMAIL, password: API_PASSWORD });
  expect(bloqueada.status, 'bloqueada no entra').toBe(401);

  const desde = new Date(Date.now() - 1_000);
  expect((await olvide(api, EMAIL)).status).toBe(200);
  const correo = await ultimoCorreo(EMAIL, { desde });
  const enlace = correo?.enlaces.find((e) => /\/restablecer\?token=/.test(e));
  expect(enlace, 'enlace en el correo').toBeDefined();
  const token = new URL(enlace!).searchParams.get('token');

  const r = await api.post('/auth/reset-password', { token, newPassword: NUEVA });
  expect(r.status, r.text).toBe(200);
  const [u] = await sql<{ locked_until: Date | null }>(
    'SELECT locked_until FROM users WHERE email = $1',
    [EMAIL],
  );
  const hasta = u?.locked_until ?? null;
  expect(hasta === null || new Date(hasta).getTime() <= Date.now()).toBe(true);
  const entra = await api.post<{ token?: string }>('/auth/login', {
    email: EMAIL,
    password: NUEVA,
  });
  expect(entra.status, entra.text).toBe(200);
  // El mismo enlace no sirve dos veces.
  const otraVez = await api.post('/auth/reset-password', { token, newPassword: `${NUEVA}x` });
  expect(otraVez.status).toBeGreaterThanOrEqual(400);
});
