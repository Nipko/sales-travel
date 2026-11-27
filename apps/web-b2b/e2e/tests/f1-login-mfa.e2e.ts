import { expect, test } from '@playwright/test';
import { enrollMfa, readMfa, submitCredentials, typeSixDigits, writeMfa } from '../support/auth';
import { freshTotp } from '../support/totp';
import { USERS } from '../support/users';

// F1 · Login + verificación en dos pasos (docs/platform/21 §8.2). Usa `mfaNuevo`, un admin que llega
// sin MFA en cada corrida (el globalSetup vuelve a sembrar la base). Los tests dependen entre sí: el
// alta del primero es la que usan los siguientes.
test.describe.configure({ mode: 'serial' });

test.describe('F1 · login y MFA', { tag: '@auth' }, () => {
  test('una contraseña errada no entra y lo dice', async ({ page }) => {
    await submitCredentials(page, USERS.mfaNuevo.email, 'no-es-la-clave');
    await expect(page.getByText('El correo o la contraseña no son correctos.')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('un admin sin MFA queda en el gate hasta activarlo, y recibe 10 códigos de recuperación', async ({
    page,
  }) => {
    await submitCredentials(page, USERS.mfaNuevo.email);
    const gate = page.getByRole('heading', { name: 'Activa la verificación en dos pasos' });
    await expect(gate).toBeVisible();

    // Ir directo a una pantalla de venta no saltea el gate.
    await page.goto('/cotizaciones');
    await expect(gate).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Buscar vuelos' })).toHaveCount(0);

    const state = await enrollMfa(page, 'mfaNuevo');
    expect(state.recoveryCodes).toHaveLength(10);
    await expect(page.getByRole('link', { name: 'Inicio', exact: true })).toBeVisible();
  });

  test('con MFA activo pide el código: uno errado se rechaza y el correcto entra', async ({
    page,
  }) => {
    await submitCredentials(page, USERS.mfaNuevo.email);
    const firstDigit = page.getByRole('textbox', { name: 'Dígito 1 de 6' });
    await expect(firstDigit).toBeVisible();

    await typeSixDigits(page, '000000');
    await expect(firstDigit).toHaveAttribute('aria-invalid', 'true');
    await expect(page).toHaveURL(/\/login/);

    const state = readMfa('mfaNuevo')!;
    const { code, step } = await freshTotp(state.secret, state.lastStep);
    await firstDigit.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await typeSixDigits(page, code);
    writeMfa('mfaNuevo', { ...state, lastStep: step });

    await expect(page.getByRole('link', { name: 'Inicio', exact: true })).toBeVisible();
  });

  test('un código de recuperación entra una sola vez', async ({ page, browser }) => {
    const state = readMfa('mfaNuevo')!;
    const [recoveryCode] = state.recoveryCodes;

    const useRecovery = async (p: typeof page) => {
      await submitCredentials(p, USERS.mfaNuevo.email);
      await p.getByRole('button', { name: 'Usar un código de recuperación' }).click();
      await p.getByLabel('Código de recuperación').fill(recoveryCode!);
      await p.getByRole('button', { name: 'Verificar' }).click();
    };

    await useRecovery(page);
    await expect(page.getByRole('link', { name: 'Inicio', exact: true })).toBeVisible();
    writeMfa('mfaNuevo', { ...state, recoveryCodes: state.recoveryCodes.slice(1) });

    const second = await browser.newContext({ baseURL: test.info().project.use.baseURL });
    const again = await second.newPage();
    await useRecovery(again);
    await expect(again.getByRole('link', { name: 'Inicio', exact: true })).toHaveCount(0);
    await expect(again).toHaveURL(/\/login/);
    await second.close();
  });
});
