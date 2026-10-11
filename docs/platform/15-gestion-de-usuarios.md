# 15 — Gestión de usuarios: quién puede hacer qué

Matriz de cada acción sobre usuarios del frente "Gestión de usuarios por el superadmin" (2026-10).
Cada paquete actualiza su fila al cerrarse: **hecho** con el PR, o **pendiente** con lo que falta.

## Reglas que no cambian

- **Sólo invitación** (doc 14): nadie elige la contraseña de otra persona, tampoco el superadmin.
  Todo restablecimiento es un enlace de un solo uso que llega al buzón de la persona; el admin no ve
  el enlace, el token ni la contraseña, y la respuesta del API no los trae.
- **Puestos = sesiones simultáneas.** El superadmin fija el cupo de cada nodo.
- **2FA obligatorio** para `tenant_admin` y superiores.
- **Suspender una membership corta sólo ese nodo** (y cierra las sesiones de ese subárbol); suspender
  la cuenta es de toda la plataforma y sólo lo hace el superadmin.
- **Soporte a un miembro** (restablecer 2FA, cerrar sesiones, enviar el enlace, desbloquear): tocan la
  identidad global, así que el actor tiene que administrar **todos** los nodos donde la persona tiene
  membership activa y superarla en rango en cada uno, o ser superadmin. Nunca sobre uno mismo
  (`assertCanSupportMember`, `apps/api/src/tenants/tenant-admin.policy.ts`).

"Admin de nodo" = `consolidator_admin`, `tenant_admin`, `agency_admin` o `admin` sobre ese nodo o un
ancestro (`AGENCY_ADMIN_ROLES`). "Supera en rango" = rol estrictamente mayor (`ROLE_RANK`).

## Matriz

| Acción                                                               | Dónde                                     | Quién puede                                                                     | Estado                                              |
| -------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------- |
| Invitar a alguien a un nodo                                          | Equipo → Invitar                          | Admin del nodo, con un rol menor al suyo; superadmin                            | Hecho (doc 14)                                      |
| Reenviar una invitación (token nuevo, 7 días)                        | Equipo → Invitaciones                     | Admin del nodo que supere el rol invitado; superadmin                           | Hecho (doc 14); avisar si el correo no salió: USR-8 |
| Revocar una invitación                                               | Equipo → Invitaciones                     | Admin del nodo; superadmin                                                      | Hecho; validar rango y entrada: USR-8               |
| Cambiar el rol en un nodo                                            | Equipo → fila                             | Admin del nodo que supere el rol actual y el nuevo; superadmin. Nunca el propio | Hecho                                               |
| Suspender / reactivar el acceso a un nodo                            | Equipo → acciones                         | Admin del nodo que supere su rol; superadmin. Nunca el propio                   | Hecho (PR #14)                                      |
| Cerrar todas sus sesiones                                            | Equipo → acciones → Seguridad             | Soporte a un miembro                                                            | Hecho                                               |
| Restablecer su 2FA                                                   | Equipo → acciones → Seguridad             | Soporte a un miembro                                                            | Hecho                                               |
| **Enviarle un enlace para restablecer la contraseña**                | Equipo → acciones → Acceso                | Soporte a un miembro. 409 si su cuenta o su acceso al nodo están suspendidos    | **Hecho (USR-2)**                                   |
| **Desbloquear la cuenta** (bloqueo por intentos fallidos)            | Equipo → acciones → Acceso (si bloqueada) | Soporte a un miembro                                                            | **Hecho (USR-2)**                                   |
| Liberar un puesto (cerrar una sesión que ocupa cupo)                 | Equipo → Puestos                          | Admin del nodo de esa sesión; superadmin. Nunca la propia                       | Hecho (PR #12)                                      |
| Fijar puestos e inactividad de un nodo                               | Gestión de Agencias                       | Superadmin                                                                      | Hecho (PR #12)                                      |
| Forzar cambio de contraseña en el próximo ingreso                    | Equipo → acciones → Acceso                | Soporte a un miembro                                                            | Pendiente (USR-3)                                   |
| Suspender / reactivar la cuenta en toda la plataforma                | Plataforma → Usuarios                     | Superadmin. Nunca la propia                                                     | API hecha; directorio y pantalla: USR-4             |
| Buscar a cualquier persona de la red                                 | Plataforma → Usuarios                     | Superadmin                                                                      | Pendiente (USR-4)                                   |
| Ver la ficha de una persona y cerrar una sesión puntual              | Ficha del usuario                         | Admin de su subárbol (lo suyo); superadmin (todo)                               | Pendiente (USR-5, USR-7)                            |
| Ver el historial de una persona y la actividad de la red             | Ficha / Mi Red → Actividad                | Admin de su subárbol; superadmin (también eventos sin nodo)                     | Pendiente (USR-6)                                   |
| Invitar o promover a un admin de consolidador                        | Equipo                                    | Superadmin                                                                      | Pendiente (USR-9)                                   |
| Filtrar el equipo (2FA pendiente, bloqueados, nunca ingresaron, rol) | Equipo                                    | Admin del nodo; superadmin                                                      | Pendiente (USR-10)                                  |
| Quitar a una persona de un nodo (baja blanda)                        | Equipo → acciones                         | —                                                                               | Pendiente: decisión del founder D2 (USR-11)         |
| Avisarle por correo cada cambio de seguridad hecho por un admin      | Automático                                | —                                                                               | Pendiente (USR-12)                                  |
| Reconfirmar el 2FA antes de las acciones de alto impacto             | Automático                                | —                                                                               | Pendiente: decisión del founder D1 (USR-13)         |
| Forzar cambio de contraseña en bloque a cuentas heredadas            | Plataforma                                | Superadmin                                                                      | Pendiente: decisión del founder D3 (USR-14)         |
| Ver invitaciones pendientes y vencidas de toda la red                | Plataforma → Invitaciones                 | Superadmin                                                                      | Pendiente (USR-15)                                  |
| Exportar usuarios a CSV                                              | Plataforma → Usuarios / Equipo            | Superadmin (toda la red); admin del nodo (su equipo). Auditado                  | Pendiente (USR-16)                                  |
| Editar el propio nombre                                              | Mi cuenta → Perfil                        | Cada usuario, sobre sí mismo                                                    | Pendiente (USR-18)                                  |

## Enviar el enlace y desbloquear (USR-2)

### API

- `POST /tenants/:id/members/:userId/send-password-reset` → `200 { sent, expiresAt }`. En una
  transacción que bloquea la fila del usuario: da por usados sus enlaces pendientes, emite uno nuevo
  (60 minutos, sólo el SHA-256 en `password_reset_tokens`) y registra
  `auth.password_reset.sent_by_admin` (`{ targetUserId, expiresAt }`). El correo sale después del
  commit por el correo del nodo de la ruta (propio o heredado) o el del sistema; si no sale,
  `sent: false` y `auth.password_reset.email_failed` (`{ targetUserId, via: 'admin' }`). La
  contraseña actual sigue valiendo hasta que la persona la cambie.
  - 409 `MEMBER_ACCOUNT_SUSPENDED` (cuenta suspendida en la plataforma) o `MEMBERSHIP_SUSPENDED` (su
    acceso a ese nodo), siempre después de autorizar.
  - 429 `PASSWORD_RESET_RATE_LIMITED` con 3 o más enlaces de esa persona en los últimos 15 minutos;
    cuentan también los que pidió ella desde "Olvidé mi contraseña". Además, 10 envíos por minuto por
    IP (`@Throttle`).
- `POST /tenants/:id/members/:userId/unlock` → `200 { unlocked }`. Si había un bloqueo vigente, pone
  el contador en 0 y `locked_until` en `NULL` y registra `auth.lockout.cleared_by_admin`
  (`{ targetUserId, lockedUntil }`); si no, `unlocked: false` sin cambios ni evento. No toca la
  contraseña, el 2FA ni el estado.
- `PasswordResetService` expone `issueToken`, `resetLink` y `sendResetEmail` (los reusa USR-3);
  "Olvidé mi contraseña" sigue respondiendo siempre `{ sent: true }`. Las plantillas están en
  `auth/password-reset-email.ts`, con el nombre del nodo escapado.

### Panel

- Equipo → menú de cada miembro agrupado en **Acceso** (Enviar enlace para restablecer contraseña;
  Desbloquear cuenta, sólo con un bloqueo vigente) y **Seguridad** (Cerrar sus sesiones, Restablecer
  2FA), y aparte Suspender / Reactivar. Con el acceso suspendido, "Enviar enlace…" se ve
  deshabilitado con el motivo.
- Las dos confirmaciones son neutras (no destructivas). Si el correo no salió, el aviso es una
  advertencia que pide revisar el correo del nodo.
- Rutas del panel con chequeo de mismo origen: `/api/tenants/[tenantId]/members/[userId]/send-password-reset`
  y `/unlock`.

### Tests

- `apps/api/src/auth/password-reset.service.test.ts`: hash y vencimiento del token, invalidación de
  los anteriores, "Olvidé mi contraseña" sin enumerar, plantillas escapadas y en tú.
- `apps/api/src/tenants/member-support.service.test.ts`: autorización reusada (403), 409, 429, orden
  transacción → correo, desbloqueo que sólo audita cuando levanta un bloqueo.
- `apps/api/src/tenants/member-support.integration.test.ts` (se salta sin `PGHOST`): enlace y evento en
  la misma transacción, sólo vale el último enlace y con él la persona elige su contraseña, 409/429
  contra Postgres, desbloqueo que limpia `locked_until` sin tocar contraseña ni 2FA.
- Web: `tenant-admin-proxy.test.ts`, `tenant-admin-proxy-route.test.ts`, `tenant-admin-team.test.ts`,
  `tenant-admin-seats-client.test.ts` y `team.render.test.ts` (menú agrupado, "Desbloquear cuenta"
  sólo con bloqueo).
