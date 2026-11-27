/**
 * Usuarios de la red de PRUEBA que crea e2e/env/seed.sql. La contraseña sólo existe en ese stack.
 * `mfa: true` = su rol exige verificación en dos pasos (ADMIN_ROLES en apps/api/src/auth/roles.ts).
 */
export const E2E_PASSWORD = 'E2e-Prueba-2026!';

export const USERS = {
  superadmin: { email: 'superadmin@e2e.test', tenant: 'platform', mfa: true },
  adminA: { email: 'admin-a@e2e.test', tenant: 'e2e-agencia-a', mfa: true },
  mfaNuevo: { email: 'mfa-nuevo@e2e.test', tenant: 'e2e-agencia-a', mfa: true },
  vendedorA: { email: 'vendedor-a@e2e.test', tenant: 'e2e-agencia-a', mfa: false },
  vendedorB: { email: 'vendedor-b@e2e.test', tenant: 'e2e-agencia-b', mfa: false },
  /** Sólo para los casos de ingreso (ACC-12/13): nadie más usa su sesión. */
  acceso: { email: 'acceso@e2e.test', tenant: 'e2e-agencia-b', mfa: false },
  /** Sólo para equipos de confianza y sesiones abiertas (f36): abre y cierra varias a la vez. */
  confianza: { email: 'confianza@e2e.test', tenant: 'e2e-agencia-b', mfa: true },
} as const;

export type UserKey = keyof typeof USERS;
