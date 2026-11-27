import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E } from './env';
import { freshTotp } from './totp';
import { E2E_PASSWORD, USERS, type UserKey } from './users';

/** Lo que el E2E sabe del segundo factor de un usuario: se guarda en e2e/.auth/<usuario>.mfa.json. */
export interface MfaState {
  secret: string;
  lastStep?: number;
  recoveryCodes: string[];
}

function mfaFile(key: UserKey): string {
  return path.join(E2E.authDir, `${key}.mfa.json`);
}

export function storageStateFile(key: UserKey): string {
  return path.join(E2E.authDir, `${key}.state.json`);
}

export function readMfa(key: UserKey): MfaState | undefined {
  const file = mfaFile(key);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as MfaState) : undefined;
}

export function writeMfa(key: UserKey, state: MfaState): void {
  mkdirSync(E2E.authDir, { recursive: true });
  writeFileSync(mfaFile(key), JSON.stringify(state, null, 2));
}

/** Escribe un código en las seis casillas «Dígito N de 6» (se envía solo al completar la sexta). */
export async function typeSixDigits(page: Page, code: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Dígito 1 de 6' }).click();
  await page.keyboard.type(code);
}

const RATE_LIMITED = 'Hiciste muchos intentos seguidos';

/**
 * Correo + contraseña en /login, y espera a que el panel responda. El api limita /auth/login a 10 por
 * minuto por IP (auth.controller.ts) y todo el E2E sale de la misma IP: si responde «muchos intentos»,
 * espera el minuto y reintenta una vez, en vez de dar el test por fallido.
 */
export async function submitCredentials(
  page: Page,
  email: string,
  password = E2E_PASSWORD,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto('/login');
    await page.getByLabel('Correo electrónico').fill(email);
    await page.getByLabel('Contraseña', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Iniciar sesión' }).click();

    const rateLimited = page.getByText(RATE_LIMITED);
    const settled = rateLimited
      .or(page.getByRole('textbox', { name: 'Dígito 1 de 6' }))
      .or(page.getByText('El correo o la contraseña no son correctos.'))
      .or(page.getByRole('heading', { name: 'Activa la verificación en dos pasos' }));
    await Promise.race([
      settled.first().waitFor({ timeout: 30_000 }),
      page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 }),
    ]);
    if (!(await rateLimited.isVisible())) return;
    await page.waitForTimeout(61_000);
  }
  throw new Error(
    `/auth/login siguió limitado por tasa para ${email} después de esperar un minuto`,
  );
}

/**
 * Alta de la verificación en dos pasos desde el gate «Activa la verificación en dos pasos». Lee la
 * clave manual, confirma con contraseña + código, guarda los códigos de recuperación y cierra el gate.
 */
export async function enrollMfa(page: Page, key: UserKey): Promise<MfaState> {
  await expect(
    page.getByRole('heading', { name: 'Activa la verificación en dos pasos' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Empezar' }).click();
  await page.getByText('¿No puedes escanear? Ingresa la clave a mano').click();

  const secret = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('code, kbd, [class*="mono"]'));
    const hit = candidates
      .map((e) => (e.textContent ?? '').trim())
      .find((t) => /^[A-Z2-7 ]{16,}$/.test(t));
    return hit?.replace(/\s/g, '') ?? null;
  });
  expect(secret, 'la clave manual de TOTP tiene que verse en pantalla').toBeTruthy();

  await page.getByLabel('Tu contraseña').fill(E2E_PASSWORD);
  const { code, step } = await freshTotp(secret!, undefined);
  await typeSixDigits(page, code);

  await expect(
    page.getByRole('heading', { name: 'Verificación en dos pasos activada' }),
  ).toBeVisible();
  const recoveryCodes = [
    ...new Set(
      (await page.locator('li').allInnerTexts())
        .map((t) => t.replace(/^\d+\.\s*/, '').trim())
        .filter((t) => /^[0-9A-F]{5}-[0-9A-F]{5}$/.test(t)),
    ),
  ];
  expect(recoveryCodes).toHaveLength(10);

  await page.getByRole('checkbox', { name: 'Los guardé en un lugar seguro' }).check();
  await page.getByRole('button', { name: 'Listo' }).click();

  const state: MfaState = { secret: secret!, lastStep: step, recoveryCodes };
  writeMfa(key, state);
  return state;
}

/** Paso del código de la app en /login, para un usuario con MFA ya activo. */
export async function passMfaChallenge(page: Page, key: UserKey): Promise<void> {
  const state = readMfa(key);
  if (!state)
    throw new Error(
      `No hay clave TOTP guardada para ${key}: corre el setup con la base recién sembrada.`,
    );
  const { code, step } = await freshTotp(state.secret, state.lastStep);
  await typeSixDigits(page, code);
  writeMfa(key, { ...state, lastStep: step });
}

/**
 * Deja la sesión iniciada para `key` en `page`. Si su rol exige MFA y todavía no lo tiene (base recién
 * sembrada), lo activa; si ya lo tiene, pasa el desafío con la clave guardada.
 */
export async function loginAs(page: Page, key: UserKey): Promise<void> {
  const user = USERS[key];
  await submitCredentials(page, user.email);
  const gate = page.getByRole('heading', { name: 'Activa la verificación en dos pasos' });
  const challenge = page.getByRole('textbox', { name: 'Dígito 1 de 6' });
  // El menú lateral sólo existe con la sesión completa (el gate de MFA no lo muestra).
  const appShell = page.getByRole('link', { name: 'Inicio', exact: true });

  await expect(gate.or(challenge).or(appShell).first()).toBeVisible({ timeout: 45_000 });
  if (await gate.isVisible()) {
    await enrollMfa(page, key);
    // BUG-E2E-04 (intermitente): a veces «Listo» no sale de la pantalla de códigos y el render de `/`
    // loguea «SyntaxError: Unexpected end of JSON input». El MFA ya quedó activo, así que acá se
    // recarga como haría la persona; F1 sí lo exige sin recarga.
    const advanced = await appShell
      .waitFor({ timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    if (!advanced) {
      test.info().annotations.push({
        type: 'bug',
        description: `BUG-E2E-04: «Listo» no avanzó tras activar MFA de ${key}; se recargó.`,
      });
      await page.goto('/');
    }
  } else if (await challenge.isVisible()) {
    await passMfaChallenge(page, key);
  }
  await expect(appShell).toBeVisible({ timeout: 45_000 });
}
