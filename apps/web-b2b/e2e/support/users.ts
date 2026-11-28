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
  /** ACC-16/17: e2e-agencia-cupo tiene un solo puesto. */
  cupoUno: { email: 'cupo-uno@e2e.test', tenant: 'e2e-agencia-cupo', mfa: false },
  cupoDos: { email: 'cupo-dos@e2e.test', tenant: 'e2e-agencia-cupo', mfa: false },
  cupoAdmin: { email: 'cupo-admin@e2e.test', tenant: 'e2e-agencia-cupo', mfa: true },
  /** CTA-03/05: activa el MFA sin que su rol lo exija, y después cambia de teléfono. */
  voluntario: { email: 'voluntario@e2e.test', tenant: 'e2e-agencia-b', mfa: false },
  /** ACC-26: su correo nunca está verificado al empezar. */
  sinVerificar: { email: 'sin-verificar@e2e.test', tenant: 'e2e-agencia-b', mfa: false },
  /** CTA-08: cambia su contraseña (el seed la devuelve en cada corrida). */
  clave: { email: 'clave@e2e.test', tenant: 'e2e-agencia-b', mfa: false },
  /** ACC-22/ACC-23: la restablece con el enlace del correo. */
  restablecer: { email: 'restablecer@e2e.test', tenant: 'e2e-agencia-b', mfa: false },
  /** CTA-06: activa el 2FA y regenera sus códigos de recuperación. */
  codigos: { email: 'codigos@e2e.test', tenant: 'e2e-agencia-b', mfa: false },
  /** CTA-01: cambia su nombre (el seed lo devuelve a «Vendedor Perfil»). */
  perfil: { email: 'perfil@e2e.test', tenant: 'e2e-agencia-b', mfa: false },
  /** CTA-07: activa y desactiva el 2FA. */
  desactiva: { email: 'desactiva@e2e.test', tenant: 'e2e-agencia-b', mfa: false },
} as const;

export type UserKey = keyof typeof USERS;
