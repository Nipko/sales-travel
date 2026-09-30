import { SetMetadata } from '@nestjs/common';

export const ALLOW_WITHOUT_MFA_KEY = 'allowWithoutMfa';

/**
 * Deja pasar una ruta autenticada aunque la sesión todavía no cumpla el MFA obligatorio de su rol.
 *
 * `MfaEnforcementGuard` corta con 403 `MFA_ENROLLMENT_REQUIRED` a quien tiene un rol de
 * `MFA_REQUIRED_ROLES` sin MFA activo, y con 401 `MFA_STEP_UP_REQUIRED` a la sesión que no pasó el
 * segundo factor. Sin excepciones el panel no podría ni saber quién es el usuario para mostrarle la
 * pantalla de enrolamiento, ni el usuario podría enrolarse o cerrar sesión. Por eso se marcan sólo
 * las rutas que hacen falta para salir de ese estado: `GET /me`, `GET /me/memberships`,
 * `GET /tenants/:id/branding`, todo `/auth/mfa*`, `/auth/logout*`, `GET /auth/session` y
 * `GET /auth/sessions`. Cualquier otra ruta marcada abre la API entera a una sesión sin segundo
 * factor: no se agrega sin esa justificación.
 *
 * No hace pública la ruta: sigue exigiendo sesión válida (eso es `@Public()`).
 */
export const AllowWithoutMfa = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_WITHOUT_MFA_KEY, true);
