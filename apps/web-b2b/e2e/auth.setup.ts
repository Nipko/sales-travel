import { test as setup } from '@playwright/test';
import { loginAs, storageStateFile } from './support/auth';
import type { UserKey } from './support/users';

// Una sesión por usuario, guardada para el resto de la corrida. Los que tienen rol de administración
// activan aquí su MFA (la base llega recién sembrada, sin MFA). `mfaNuevo` queda sin tocar: lo usa F1.
const USERS_WITH_SESSION: UserKey[] = ['superadmin', 'adminA', 'vendedorA', 'vendedorB'];

for (const key of USERS_WITH_SESSION) {
  setup(`sesión de ${key}`, async ({ page }) => {
    await loginAs(page, key);
    await page.context().storageState({ path: storageStateFile(key) });
  });
}
