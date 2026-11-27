import { expect, test } from '@playwright/test';
import { anonimoDesde, como, sql } from './support/cliente';
import { API_PASSWORD, PERSONAS } from './support/personas';
import { vencer } from '../support/reloj';

/**
 * Tanda 9 (docs/qa/01 §5 ACC): ACC-09, el reto del segundo factor vencido. El panel ya traduce
 * `MFA_CHALLENGE_EXPIRED` a «la verificación venció» y vuelve a la contraseña (login-state.test.ts);
 * acá, que la API lo diga así y que el intento no le cueste a la cuenta.
 *
 * Sólo el paso de la contraseña: sin canjear el reto no se emite sesión, así que no le reemplaza
 * la suya a la persona que usan los demás tests.
 */
test('ACC-09 un reto de 2FA vencido: 401 MFA_CHALLENGE_EXPIRED, sin gastar intentos de la cuenta', async () => {
  const p = PERSONAS.adminA;
  // Asegura que ya enroló el 2FA (en una base recién sembrada lo hace su primer ingreso).
  await como('adminA');
  const api = await anonimoDesde(`198.51.100.${150 + Math.floor(Math.random() * 50)}`);
  const login = await api.post<{ mfaRequired?: boolean; mfaToken?: string }>('/auth/login', {
    email: p.email,
    password: API_PASSWORD,
  });
  expect(login.status, login.text).toBe(200);
  expect(login.body.mfaRequired, 'adminA tiene 2FA').toBe(true);

  const fallosAntes = async () =>
    (
      await sql<{ n: number }>('SELECT failed_login_attempts AS n FROM users WHERE email = $1', [
        p.email,
      ])
    )[0]!.n;
  const antes = await fallosAntes();

  // Lo que harían cinco minutos de espera.
  await vencer(
    'mfa_challenges',
    'user_id = (SELECT id FROM users WHERE email = $1) AND consumed_at IS NULL',
    [p.email],
  );

  const r = await api.post('/auth/mfa/verify', { mfaToken: login.body.mfaToken, code: '000000' });
  expect(r.status, r.text).toBe(401);
  expect(r.text).toContain('MFA_CHALLENGE_EXPIRED');
  expect(r.text).toMatch(/venció/);
  expect(await fallosAntes(), 'el reto vencido no cuenta como fallo').toBe(antes);
});
