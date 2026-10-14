# 15 — Gestión de usuarios: quién puede hacer qué

Matriz de cada acción sobre usuarios del frente "Gestión de usuarios por el superadmin" (2026-10).
Cada paquete actualiza su fila al cerrarse: **hecho** con el PR, o **pendiente** con lo que falta.

## Reglas que no cambian

- **Sólo invitación** (doc 14): nadie elige la contraseña de otra persona, tampoco el superadmin.
  Todo restablecimiento es un enlace de un solo uso que llega al buzón de la persona; el admin no ve
  el enlace, el token ni la contraseña, y la respuesta del API no los trae. Quien ya tiene cuenta
  acepta una invitación con su propia sesión, y sólo si es la cuenta del correo invitado (USR-17).
- **Puestos = sesiones simultáneas.** El superadmin fija el cupo de cada nodo.
- **2FA obligatorio** para `tenant_admin` y superiores.
- **Suspender una membership corta sólo ese nodo** (y cierra las sesiones de ese subárbol); suspender
  la cuenta es de toda la plataforma y sólo lo hace el superadmin.
- **Quitar a alguien de un nodo es una baja blanda** (D2 = A): la membership queda como `removed`,
  sale de Equipo y deja de dar acceso, pero su historial y sus reservas quedan. La única vuelta es
  una invitación nueva.
- **Soporte a un miembro** (restablecer 2FA, cerrar sesiones, enviar el enlace, forzar el cambio de
  contraseña, desbloquear): tocan la identidad global, así que el actor tiene que administrar
  **todos** los nodos donde la persona tiene membership activa y superarla en rango en cada uno, o
  ser superadmin. Nunca sobre uno mismo (`assertCanSupportMember`,
  `apps/api/src/tenants/tenant-admin.policy.ts`).

"Admin de nodo" = `consolidator_admin`, `tenant_admin`, `agency_admin` o `admin` sobre ese nodo o un
ancestro (`AGENCY_ADMIN_ROLES`). "Supera en rango" = rol estrictamente mayor (`ROLE_RANK`).

## Matriz

| Acción                                                                         | Dónde                                     | Quién puede                                                                               | Estado                                                                    |
| ------------------------------------------------------------------------------ | ----------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Invitar a alguien a un nodo (una pendiente por correo y nodo)                  | Equipo → Invitar                          | Admin del nodo, con un rol menor al suyo; superadmin                                      | **Hecho (doc 14, USR-8)**                                                 |
| Aceptar una invitación: crear la cuenta, o con la propia si ya existe          | /invitacion                               | Quien recibió el enlace; con cuenta, sólo con la sesión de la cuenta invitada             | **Hecho (USR-17)**: dice nodo y rol; con cuenta, no pide contraseña       |
| Reenviar una invitación (token nuevo, 7 días)                                  | Equipo → Invitaciones / Invitar (409)     | Admin del nodo que supere el rol invitado; superadmin                                     | **Hecho (doc 14, USR-8)**: avisa si el correo falla                       |
| Revocar una invitación                                                         | Equipo → Invitaciones                     | Admin del nodo que supere el rol invitado; superadmin                                     | **Hecho (USR-8)**                                                         |
| Cambiar el rol en un nodo                                                      | Equipo → fila                             | Admin del nodo que supere el rol actual y el nuevo; superadmin. Nunca el propio           | Hecho                                                                     |
| Suspender / reactivar el acceso a un nodo                                      | Equipo → acciones                         | Admin del nodo que supere su rol; superadmin. Nunca el propio                             | Hecho (PR #14)                                                            |
| Cerrar todas sus sesiones                                                      | Equipo → acciones → Seguridad             | Soporte a un miembro                                                                      | Hecho                                                                     |
| Restablecer su 2FA                                                             | Equipo → acciones → Seguridad             | Soporte a un miembro                                                                      | Hecho                                                                     |
| **Enviarle un enlace para restablecer la contraseña**                          | Equipo → acciones → Acceso                | Soporte a un miembro. 409 si su cuenta o su acceso al nodo están suspendidos              | **Hecho (USR-2)**                                                         |
| **Desbloquear la cuenta** (bloqueo por intentos fallidos)                      | Equipo → acciones → Acceso (si bloqueada) | Soporte a un miembro                                                                      | **Hecho (USR-2)**                                                         |
| Liberar un puesto (cerrar una sesión que ocupa cupo)                           | Equipo → Puestos                          | Admin del nodo de esa sesión; superadmin. Nunca la propia                                 | Hecho (PR #12)                                                            |
| Fijar puestos e inactividad de un nodo                                         | Gestión de Agencias                       | Superadmin                                                                                | Hecho (PR #12)                                                            |
| **Forzar cambio de contraseña en el próximo ingreso**                          | Equipo → acciones → Acceso                | Soporte a un miembro. Los mismos 409 que enviar el enlace                                 | **Hecho (USR-3)**: el login responde 403 hasta que la elija               |
| Suspender / reactivar la cuenta en toda la plataforma                          | Plataforma → Usuarios → acciones          | Superadmin. Nunca la propia ni la del último superadmin activo                            | **Hecho (USR-4)**: la confirmación dice lo que corta                      |
| Buscar a cualquier persona de la red (nombre, correo, filtros)                 | Plataforma → Usuarios                     | Superadmin                                                                                | **Hecho (USR-4)**                                                         |
| Ver la ficha de una persona (perfil, seguridad, nodos, sesiones, invitaciones) | Ficha del usuario                         | Admin del nodo, sobre alguien de su subárbol (también uno mismo); superadmin (todo)       | **Hecho (USR-5, USR-7)**: panel lateral desde Equipo y el directorio      |
| Cerrar una sesión puntual                                                      | Ficha del usuario → Sesiones              | Admin del nodo que supere su rol sobre el nodo de esa sesión; superadmin. Nunca la propia | **Hecho (USR-5, USR-7)**: desde la ficha, con confirmación                |
| Ver el historial de una persona y la actividad de la red                       | Ficha / Mi Red → Actividad                | Admin de su subárbol; superadmin (también eventos sin nodo)                               | **Hecho (USR-6, USR-7)**: Actividad filtrable e historial en la ficha     |
| Invitar o promover a un admin de consolidador                                  | Equipo, en un nodo consolidador           | Superadmin                                                                                | **Hecho (USR-9)**: no se ofrece en la raíz ni en agencias                 |
| Ir a los usuarios de un nodo                                                   | Gestión de Agencias → fila / Usuarios     | Superadmin                                                                                | **Hecho (USR-9)**: abre Equipo en ese nodo                                |
| Filtrar el equipo (2FA pendiente, bloqueados, nunca ingresaron, rol)           | Equipo                                    | Admin del nodo; superadmin                                                                | **Hecho (USR-10)**: en la URL, con orden por último acceso y columna Alta |
| Quitar a una persona de un nodo (baja blanda)                                  | Equipo → acciones → Membresía / ficha     | Admin del nodo que supere su rol; superadmin. Nunca el propio ni el último admin activo   | **Hecho (USR-11; D2 = A)**: vuelve sólo con una invitación nueva          |
| Avisarle por correo cada cambio de seguridad (de un admin o de su contraseña)  | Automático, a su buzón                    | —                                                                                         | **Hecho (USR-12)**: después del commit, sin enlaces                       |
| Reconfirmar el 2FA antes de las acciones de alto impacto                       | Automático                                | —                                                                                         | **Hecho (USR-13; D1 = C)**: pide el código si pasaron 10 minutos          |
| Activar el 2FA por primera vez (o tras un restablecimiento) pide la contraseña | Seguridad / pantalla de 2FA obligatoria   | Cada usuario, sobre sí mismo                                                              | **Hecho (USR-13b)**: suma al bloqueo y avisa por correo                   |
| Forzar cambio de contraseña en bloque a cuentas heredadas                      | Plataforma                                | Superadmin                                                                                | Pendiente (USR-14; founder D3 = B)                                        |
| Ver invitaciones pendientes y vencidas de toda la red                          | Plataforma → Usuarios → Invitaciones      | Superadmin                                                                                | **Hecho (USR-15)**: reenviar y revocar desde la lista                     |
| Exportar usuarios a CSV                                                        | Plataforma → Usuarios / Equipo            | Superadmin (toda la red); admin del nodo (su equipo). Auditado                            | Pendiente (USR-16)                                                        |
| Editar el propio nombre                                                        | Mi cuenta → Perfil                        | Cada usuario, sobre sí mismo                                                              | **Hecho (USR-18)**: con historial; sólo la propia cuenta (0069)           |

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

## Forzar el cambio de contraseña (USR-3)

Para cuando se sospecha que la contraseña de alguien está comprometida: a diferencia de enviarle el
enlace, la vieja deja de servir en el acto. Nadie elige la contraseña nueva por la persona.

### Base

- `0062_password_reset_required.sql`: `users.password_reset_required_at` (desde cuándo tiene que elegir
  una contraseña nueva). `user_admin_overview` se borra y se vuelve a crear con la columna
  `password_reset_required`, el `search_path` endurecido de 0060 y los permisos de 0055 (sólo
  `app_user`). La API vieja la consulta por nombre de columna: la migración puede correr antes que la
  API nueva.

### API

- `POST /tenants/:id/members/:userId/require-password-reset` → `200 { sent, revokedSessions }`.
  Soporte a un miembro (`assertCanSupportMember`) y los mismos 409 que enviar el enlace
  (`MEMBER_ACCOUNT_SUSPENDED`, `MEMBERSHIP_SUSPENDED`). En una transacción que bloquea la fila del
  usuario, `PasswordResetService.requireReset` marca la cuenta (si ya estaba, conserva desde cuándo),
  cierra todas sus sesiones (`revoke_user_sessions`, motivo `password_reset_required`), deja sin efecto
  sus enlaces pendientes, emite uno nuevo y registra `auth.password_reset.required_by_admin`
  (`{ targetUserId, revokedSessions }`). El correo ("Elige una contraseña nueva · PlaneTour") sale
  después del commit; si no sale, `sent: false` y `auth.password_reset.email_failed`
  (`{ targetUserId, via: 'required' }`). Volver a forzarlo a quien ya lo tiene pendiente sólo reenvía
  el enlace y cuenta para el 429 de 3 enlaces en 15 minutos; la primera vez nunca. `@Throttle` de 10
  por minuto.
- **Login**: después de verificar la contraseña (el bloqueo, la cuenta suspendida y la contraseña
  incorrecta siguen dando el 401 de siempre) y antes del 2FA y del equipo de confianza, si la cuenta
  está marcada responde 403 `PASSWORD_RESET_REQUIRED` ("Tienes que elegir una contraseña nueva: te
  enviamos un enlace a tu correo."). No cuenta como fallo, no emite sesión ni ocupa puesto, y registra
  `auth.login.password_reset_required` (`{ linkSent }`). Si no tiene un enlace pendiente de los
  últimos 10 minutos, le envía uno nuevo (sin invalidar el anterior) por el correo de su nodo más
  antiguo. El código del 2FA y liberar un puesto también responden el 403 si el admin lo forzó en el
  medio; liberar un puesto lo mira antes de desconectar a la otra persona.
- Mientras la marca está, `SessionService.validate` no acepta ninguna sesión de la persona: un login
  que pasó la contraseña justo antes de forzarlo no deja una sesión viva.
- La marca la levantan el canje del enlace (el del admin o el de "Olvidé mi contraseña") y el cambio
  de contraseña, en el mismo `UPDATE` que fija la contraseña nueva. Con la marca puesta, el canje
  rechaza la misma contraseña de antes (400 `PASSWORD_REUSED`, el enlace sigue vigente): el admin la
  forzó porque pudo quedar expuesta, y aceptarla la dejaría servir otra vez. `/restablecer` lo dice
  ("Elige una contraseña distinta de la anterior…") en vez de "el enlace venció".
- El canje toma la fila del usuario antes que la del enlace, en el mismo orden que forzar el cambio y
  enviar el enlace: al revés, canjear mientras un admin lo forzaba terminaba en deadlock (500).
- "Enviar enlace" a quien tiene el cambio pendiente usa el correo de "Elige una contraseña nueva" (el
  otro dice que la actual sigue funcionando). "Olvidé mi contraseña" ahora busca el nodo de la persona
  con su id en el contexto: antes la RLS de `memberships` no lo dejaba ver y el correo salía siempre
  por el del sistema.
- `GET /tenants/network/users` suma `passwordResetRequired`.

### Panel

- Equipo → menú de cada miembro → **Acceso** → **Forzar cambio de contraseña** (después de "Enviar
  enlace…"), con confirmación destructiva: "Se cierran todas sus sesiones y no puede volver a ingresar
  hasta que elija una contraseña nueva con el enlace que le enviamos a su correo. Úsalo si crees que
  su contraseña está comprometida." Con el acceso suspendido se ve deshabilitado con el motivo. Si el
  correo no salió, el aviso es una advertencia que pide revisar el correo del nodo y enviarle el
  enlace de nuevo.
- La fila de quien lo tiene pendiente muestra **Cambio de contraseña pendiente**.
- Login: el 403 vuelve a la contraseña con el aviso "Tienes que elegir una contraseña nueva. Te
  enviamos un enlace a tu correo: ábrelo y elige una contraseña para volver a ingresar." y el enlace
  **¿No te llegó? Pide otro enlace** (a `/olvide-password`). Igual desde el paso del código o de
  liberar un puesto.
- Ruta del panel con chequeo de mismo origen:
  `/api/tenants/[tenantId]/members/[userId]/require-password-reset`.

### Tests

- `apps/api/src/auth/auth.service.password-reset-required.test.ts`: 403 tipado, sin contar el fallo,
  sin desafío ni equipo de confianza, sin sesión; suspendida, bloqueada o con la contraseña incorrecta
  da el 401; forzado en medio del paso del código o antes de liberar un puesto (sin desconectar a
  nadie).
- `apps/api/src/auth/password-reset.service.test.ts`: `requireReset` (orden y transacción), el
  reenvío a lo sumo cada 10 minutos, `reset` y `change` levantan la marca, `reset` toma el usuario
  antes que el enlace y rechaza la misma contraseña sólo con la marca, la plantilla nueva en tú y
  escapada.
- `apps/api/src/tenants/member-support.service.test.ts`: autorización reusada, 409, 429 sólo al
  volver a forzarlo, correo después del commit y su fallo auditado.
- `apps/api/src/auth/password-reset-required.integration.test.ts` (se salta sin `PGHOST`): forzar →
  login 403 → canjear el enlace → login con la nueva; reenvío a los 10 minutos; 2FA sin desafío;
  sesión emitida tarde que no vale; "Olvidé mi contraseña" levanta la marca; la misma contraseña no
  sirve y el enlace sigue vigente; canjear mientras otro lo fuerza no se traba; `user_admin_overview`
  como `app_user`.
- Web: `login-state.test.ts`, `login-steps.render.test.ts`, `tenant-admin-team.test.ts`,
  `tenant-admin-proxy.test.ts`, `tenant-admin-proxy-route.test.ts`, `team.render.test.ts` y
  `restablecer/actions.test.ts`.

## Invitaciones confiables (USR-8)

### Base

- `0066_invitation_pending_unique.sql`: una invitación pendiente (ni aceptada ni revocada, venza o
  no) por correo y nodo, con el índice único parcial `uq_user_invitations_pending` sobre
  `(tenant_id, email)` (`email` es CITEXT: no distingue mayúsculas). Antes del índice limpia las
  duplicadas que ya existían: de cada grupo deja la del enlace más reciente (`expires_at`, que es el
  último envío más 7 días) y revoca las demás, cada una con su `UserInvitationRevoked`
  (`{ cause: 'duplicate_cleanup', role, source }`, sin actor). Los enlaces revocados dejan de
  funcionar; el que queda sigue vigente y se puede reenviar.

### API

- `POST /invitations` → `200 { id, expiresAt, emailSent }`. La invitación y su `UserInvited` van en
  una transacción; el correo sale después. Si ya hay una pendiente para ese correo en el nodo, 409
  `INVITATION_ALREADY_PENDING` ("Ya hay una invitación pendiente para ese correo en este nodo:
  reenvíala.") con `details.invitationId`; la carrera que pierde contra el índice (23505) sale como el
  mismo 409, con el id de la que ganó.
- `POST /invitations/:id/resend?tenantId=` → `200 { id, expiresAt, emailSent }`.
- Si el correo no sale (no hay correo configurado para el nodo o el envío falló): `emailSent: false`
  y `UserInvitationEmailFailed` (`{ invitationId, via: 'invite' | 'resend' }`), nunca la dirección.
- `POST /invitations/:id/revoke?tenantId=`: `:id` y `tenantId` pasan por Zod; el rango se mide con
  el rol con que el actor administra el nodo (403 "Ese nodo no está en tu red." si no lo administra).
  En una transacción: toma la fila (`FOR UPDATE`), 404 `INVITATION_NOT_PENDING` sin rastro si ya no
  está pendiente, 403 `ROLE_NOT_GRANTABLE` si el rol invitado es igual o superior al del actor, y
  `UserInvitationRevoked` (`{ role, cause: 'manual' }`) junto con el cambio.
- `GET /invitations?tenantId=` valida el nodo con Zod.
- Throttle de 20 por minuto en `POST /invitations` y `/:id/resend`.
- Alta de un nodo: si el correo al admin inicial no sale, `admin.status` es `invited_email_failed`,
  con `invitationId` y `expiresAt`.

### Panel

- Las rutas `/api/invitations` (GET y POST), `/api/invitations/[id]/resend`, `/revoke`,
  `/api/admin/memberships/role` y `/status` pasan por los planes de `lib/tenant-admin-proxy.ts`
  (`invitationsListTarget`, `invitePlan`, `invitationActionTarget`, `membershipRolePlan`,
  `membershipStatusPlan`): chequeo de mismo origen, ids y roles validados, cuerpo reconstruido campo
  por campo, `reason` hasta la pantalla y 400 (no 500) ante un JSON roto. De los `details` del API
  sólo pasa `invitationId`.
- "Invitar usuario" vive en `invite-dialog.tsx`. Ante el 409 muestra "Ya hay una invitación pendiente
  para {correo}." con **Reenviar la invitación**, que reenvía la existente. Reenviar conserva el rol
  con que se emitió, que puede no ser el elegido ahora: el aviso lo dice ("Está pendiente como
  {rol}", si la fila está en la lista cargada) y que para darle otro rol hay que revocarla e invitar
  de nuevo.
- Reenviar o revocar una invitación que ya no está pendiente (404 `INVITATION_NOT_PENDING`: la
  aceptaron o la revocaron desde otra sesión) muestra el mensaje y recarga la lista, para que la fila
  vieja no quede.
- Con `emailSent: false` el aviso es una advertencia: "Creamos la invitación, pero no pudimos enviar
  el correo. Revisa el correo configurado para este nodo y reenvíala." (al reenviar: "Generamos un
  enlace nuevo, pero…"). Al crear un nodo: "Creamos el nodo y la invitación de su admin, pero no
  pudimos enviar el correo. Reenvíala desde Equipo cuando el correo funcione."
- Una invitación vencida lleva la marca **Vencida** y **Reenviar** sigue habilitado (y destacado).

### Tests

- `apps/api/src/tenants/invitations.service.test.ts`: 409 con el id, carrera del 23505, otra
  violación que no se disfraza, `emailSent: false` auditado sin la dirección, revocar: 404 sin
  rastro, 403 por rango y evento en la transacción.
- `apps/api/src/tenants/onboarding-invitation.integration.test.ts` (se salta sin `PGHOST`): 409 con
  vencida y otra mayúscula, el índice que frena una carrera real (insert bloqueado por otra
  transacción), la limpieza de 0066 corrida tal cual dentro de una transacción que se deshace,
  revocar con rango, alta de nodo con `invited_email_failed`.
- Web: `tenant-admin-proxy.test.ts`, `tenant-admin-proxy-route.test.ts` (mismo origen y JSON roto
  en las cinco rutas), `tenant-admin-seats-client.resend.test.ts`, `invitation-notice.test.ts`,
  `tenant-admin-client.test.ts`, `tenant-admin-form.test.ts` y `team.render.test.ts` (Vencida, aviso
  de la pendiente).

## Directorio de la plataforma y suspensión global (USR-4)

### Base

- `0063_platform_user_directory.sql`: `platform_user_session_stats(uuid[])` devuelve por usuario su
  última actividad (`max(last_seen_at)`, revocadas incluidas) y cuántas sesiones vivas tiene (no
  revocadas, no vencidas, dentro de su inactividad, como `user_admin_overview`), nunca las sesiones
  ni su IP o equipo. Es `SECURITY DEFINER` porque la RLS de `sessions` es de cada usuario; sólo la
  ejecuta `app_user` y, además del chequeo de la API, no devuelve filas si `app.current_user_id` no
  es superadmin. Índice `idx_users_created_id` para el orden y el cursor del directorio.

### API

- `GET /admin/users` (sólo superadmin; 401 sin sesión, 403 a cualquier otro) → `{ users, nextCursor }`,
  una fila por persona con todos sus nodos (`tenantId`, `tenantName`, `tenantType`, `isBranch`,
  `role`, `status`), también quien no tiene ninguno. Filtros combinables y validados con Zod
  (`.strict()`): `q` (nombre o correo, `%` y `_` literales), `status`, `role` (asignables o
  `superadmin`), `tenantId` (el nodo con su subárbol; con `role`, una membership con ese rol ahí),
  `mfa=on|off`, `locked=true` (bloqueo vigente), `neverLoggedIn=true`, `limit` (1-100, 50 por
  defecto) y `cursor`: base64url de `{ createdAt, id }` con microsegundos, orden `(created_at, id)`
  descendente. Lee con el contexto del superadmin (RLS de memberships); las sesiones, sólo por la
  función de 0063.
- `GET /admin/users/:userId/impact` → `{ activeMemberships, liveSessions, invitationsToRevoke }`.
  Las invitaciones salen de la misma consulta que usa la suspensión, en una transacción que se
  deshace. 403 sobre uno mismo, 404 `USER_NOT_FOUND` si la cuenta no existe.
- `PATCH /admin/users/status`: 404 `USER_NOT_FOUND` si la cuenta no existe (antes respondía como si
  la hubiera cambiado y dejaba el evento); al suspender, 409 `LAST_SUPERADMIN` si es el último
  superadmin activo. La guarda bloquea las filas de los superadmins activos en orden de id dentro de
  la transacción, para que dos superadmins que se suspenden uno al otro a la vez no dejen la
  plataforma sin ninguno.

### Panel

- **Plataforma → Usuarios de la plataforma** (`/admin/plataforma/usuarios`, en el menú del
  superadmin): búsqueda con espera de 300 ms, filtros rápidos (Activos, Suspendidos, Sin 2FA,
  Bloqueados, Nunca ingresaron), Rol y Nodo (en el orden del árbol, incluye su subárbol), "Cargar
  más" y "Limpiar filtros". Columnas Usuario (con "Correo sin verificar"), Nodos y roles (chips
  "Nodo · Rol", dos y "+N"; un acceso suspendido va tachado), Último acceso ("En línea" con una
  sesión viva), 2FA y Estado (Activo, Suspendido en toda la plataforma, Bloqueado hasta las HH:MM).
  En el teléfono cada persona es una tarjeta.
- Menú de cada persona: **Ver en Equipo** (su primer nodo activo) y **Suspender en toda la
  plataforma**, que primero pide el impacto y lo dice en la confirmación ("Pierde el acceso a sus
  {n} nodos de inmediato: se cierran sus {s} sesiones y se revocan {i} invitaciones que envió…"),
  o **Reactivar cuenta** (los accesos suspendidos por nodo siguen suspendidos). Nunca sobre uno
  mismo. Los errores (409 del último superadmin, 401, 5xx) quedan en la fila.
- Rutas del panel: `GET /api/admin/users` (consulta reconstruida parámetro por parámetro; lo
  desconocido es 400 sin llegar al API), `GET /api/admin/users/[userId]/impact` y
  `PATCH /api/admin/users/status` (mismo origen, cuerpo `{ userId, status }` reconstruido), todas con
  el estado y el motivo del API.
- Suspender o reactivar en toda la plataforma pide el 2FA de los últimos 10 minutos (USR-13).

### Tests

- `apps/api/src/tenants/platform-users.service.test.ts`: filtros y orden del SQL, escape de la
  búsqueda, una fila por persona, cursor de ida y vuelta, guarda del último superadmin.
- `apps/api/src/tenants/platform-users.integration.test.ts` (se salta sin `PGHOST`): el superadmin ve
  todas las redes y un admin de red recibe 403, cada filtro, el cursor sin saltos con altas del mismo
  milisegundo, la función de 0063 (sólo `app_user`, vacía para quien no es superadmin), 404, 409 e
  impacto sin escribir nada.
- `apps/api/src/tenants/admin.controller.test.ts`: autorización, orden de la suspensión, esquemas.
- Web: `platform-users.test.ts`, `platform-users-proxy.test.ts` y `platform-users.render.test.ts`
  (columnas, chips, estados, menú, filtros, en tú).

## Ficha del usuario y cierre de una sesión (USR-5)

La API de la ficha de una persona: lo que el admin necesita para dar soporte con datos reales. El
panel lateral que la muestra es USR-7.

### Base

- `0064_admin_user_detail.sql`: dos funciones `SECURITY DEFINER STABLE` (las tablas de sesiones,
  códigos de recuperación y equipos de confianza tienen RLS por usuario), con el `search_path`
  endurecido, sólo para `app_user`. No autorizan: la API decide antes. Como 0063, además callan ante
  quien no podría verlo aunque la API lo olvide.
  - `admin_user_sessions(p_user, p_root)`: las sesiones vivas (no revocadas, no vencidas, dentro de
    su inactividad, como `user_admin_overview`) con nodo, IP (`host()`), navegador, si pasaron el
    2FA y el cupo que ocupan. Con `p_root`, sólo las del subárbol de ese nodo y sólo si quien llama
    lo administra (`can_read_membership`); con `NULL`, todas y sólo para un superadmin.
  - `admin_user_security(p_user)`: desde cuándo tiene 2FA, códigos de recuperación sin usar, equipos
    de confianza que de verdad le ahorran el código (no revocados, no vencidos y posteriores al último
    cambio de contraseña y al último enrolamiento, como `TrustedDeviceService`), último cambio de
    contraseña, intentos fallidos y bloqueo vigente. Sólo para la persona, un superadmin o quien
    administra algún nodo donde ella tiene membership.

### API

- `GET /tenants/:id/members/:userId` → `MemberDetail`. Primero que el actor administre `:id`
  (`roleOver`; 403 `TENANT_NOT_MANAGED` sin leer nada de la persona), después que la persona tenga una
  membership (de cualquier estado) en el subárbol de `:id`, leída con la RLS del actor (404
  `MEMBER_NOT_FOUND`). Uno mismo puede verse.
  - `user`: `id`, `email`, `name`, `status`, `createdAt`, `emailVerified`, `lastLoginAt`,
    `passwordChangedAt` y `passwordResetRequired` (USR-3).
  - `security`: `mfaEnabled`, `mfaEnabledAt`, `recoveryCodesLeft`, `trustedDevices`, `lockedUntil`
    (sólo vigente), `failedLoginAttempts`.
  - `memberships[]` (`tenantId`, `tenantName`, `tenantType`, `role`, `status`, `createdAt`): las que
    la RLS le deja ver, filtradas a los nodos que de verdad administra (`rolesOver`, que como
    `canManageTenant` no cuenta un nodo bajo uno suspendido). El superadmin, todas.
  - `sessions[]`: las de `admin_user_sessions(persona, :id)`, con `current` en la propia sesión de
    quien se mira a sí mismo.
  - `invitedBy`: `{ email, at }` de la última invitación aceptada para su correo en el subárbol
    (`email` es `null` si quien invitó ya no existe), o `null`.
  - `invitationsSent`: `{ pending, items }`, las pendientes que envió en el subárbol (ni aceptadas ni
    revocadas, venzan o no) y hasta 20 de ellas, de la más nueva a la más vieja.
- `GET /admin/users/:userId` → la misma forma con todo: todas sus memberships, sesiones sin raíz,
  invitaciones de toda la plataforma. Sólo superadmin (403 `SUPERADMIN_ONLY` "Esta acción es sólo
  para el superadmin." antes de leer nada; el chequeo vive en `MemberDetailService.platformDetail`);
  404 `USER_NOT_FOUND` si la cuenta no existe. No choca con `GET /admin/users/:userId/impact` ni con
  `PATCH /admin/users/status`.
- `POST /tenants/:id/members/:userId/sessions/:sessionId/revoke` → `200 { ok: true }`. Nunca la propia
  (403 `MEMBER_SELF_ACTION`: "Tus propias sesiones se cierran desde Mi cuenta → Seguridad…", sin leer
  nada); 403 `TENANT_NOT_MANAGED` si no administra `:id`; 404 `SESSION_NOT_FOUND` ("Esa sesión ya no
  está abierta.") si la sesión no está entre las abiertas de esa persona en el subárbol (cerrada, de
  otra persona o de un nodo hermano: un solo motivo). Salvo el superadmin, el actor tiene que superar
  en rango, sobre el nodo de ESA sesión, al rol con que la persona opera ahí (sus memberships
  **activas** en el nodo o en un ancestro, o un rol de plataforma; leídas con la persona en el
  contexto, como el soporte a un miembro): si no, 403 `ROLE_NOT_GRANTABLE`. `revoke_session(id,
'revoked_by_admin')` y `auth.session.revoked_by_admin` (`{ targetUserId, sessionId, viaTenantId }`,
  nodo de la sesión) en una transacción; si se cerró en el medio, el mismo 404. Su próximo request
  responde `SESSION_REVOKED`.
  - Es más estricto que **liberar un puesto** (Equipo → Puestos), que sólo pide administrar el nodo
    de la sesión: liberar un puesto es gestionar el cupo; acá se elige a una persona, y un admin no
    le corta la sesión a otro de su rango (un `tenant_admin` no cierra la de otro `tenant_admin`, ni
    la de un `consolidator_admin` que opera en su agencia).
  - Un acceso suspendido no da rango, igual que al cerrar todas sus sesiones: quien fue
    `tenant_admin` de la agencia (suspendido) y hoy sólo vende en una sub-agencia es un vendedor ahí,
    y el admin de la agencia le puede cerrar esa sesión.
  - Desde Plataforma → Usuarios no hay ruta propia: el superadmin cierra una sesión por la de Equipo
    con `:id` = el nodo de esa sesión (`sessions[].tenantId`). Una sesión sin nodo (`tenantId: null`,
    sólo en su ficha) no se cierra de a una: "Cerrar todas sus sesiones".
- Nunca salen hashes de tokens, secretos de MFA ni contraseñas: de los códigos y los equipos, sólo
  cuántos hay. La IP y el navegador de cada sesión sí, como en Puestos.

### Tests

- `apps/api/src/tenants/member-detail.service.test.ts`: orden de la autorización (403 sin leer a la
  persona, 404 leído con la RLS del actor y nada más), alcance de cada consulta (subárbol de la ruta o
  toda la plataforma), filtro de nodos administrados, pase del superadmin, rango sobre el nodo de la
  sesión con el rol leído en el contexto de la persona, revocación y evento en la misma transacción,
  respuesta sin secretos.
- `apps/api/src/tenants/member-detail.controller.test.ts`: 401 sin sesión, ids con Zod, 200 al
  cerrar, `RolesGuard` con la metadata real.
- `apps/api/src/tenants/member-detail.integration.test.ts` (se salta sin `PGHOST`): un admin de nodo
  no ve sesiones ni nodos del hermano o del padre, el del consolidador sí; las funciones de 0064 sólo
  para `app_user` y mudas ante quien no podría verlo; códigos sin usar y equipos válidos;
  invitaciones acotadas al subárbol; evento en la misma transacción (si no entra, la sesión sigue
  abierta), no se cierra dos veces, rango (un acceso suspendido no lo da) y pase del superadmin;
  ninguna contraseña ni hash en la
  respuesta.

## Historial por usuario y Actividad de la red (USR-6)

Responder "qué hizo esta persona y qué le hicieron" con el audit log (`domain_events`, 0015), y que
la Actividad de Mi Red se lea en castellano, se filtre y se pagine. La API del historial está; el
panel que lo muestra en la ficha es USR-7.

Un evento es **de la persona** si lo hizo ella (`actor_user_id`), si el agregado es su cuenta
(`aggregate_type = 'user'`, `aggregate_id`) o si la nombra como objetivo (`payload.targetUserId`, lo
que dejan las acciones de un admin sobre un miembro; comparado en minúsculas porque algunos bordes lo
guardan como lo mandó el cliente).

### Base

- `0065_user_audit_trail.sql` (`domain_events` es una tabla plana, no una hypertable):
  - `idx_domain_events_actor_time (actor_user_id, occurred_at DESC)` e
    `idx_domain_events_target_user` sobre `lower(payload->>'targetUserId')` y `occurred_at`, parcial
    (sólo los eventos que traen `targetUserId`, que son pocos).
  - `audit_event_target_user(payload, aggregate_type, aggregate_id, actor)` (`IMMUTABLE`): la cuenta
    sobre la que se hizo el evento si no es la de quien lo hizo (`targetUserId`, o la cuenta del
    agregado); `NULL` si no hay o no tiene forma de UUID, para no romper la consulta. Es el "a quién"
    del historial y de la Actividad.
  - `platform_user_audit_trail(p_user, p_before, p_before_id, p_limit)` (`SECURITY DEFINER STABLE`,
    `search_path` endurecido, sólo `app_user`): el historial en toda la plataforma, **eventos sin
    nodo incluidos** (login fallido, pedir restablecer la contraseña, la suspensión global), que la
    RLS de `domain_events` (0029) no le deja leer a nadie. Del más nuevo al más viejo, hasta 101 filas
    (100 + 1 para saber si hay otra página). Sin `meta`. La API comprueba antes que quien pregunta es
    superadmin; además la función no devuelve filas si `app.current_user_id` no lo es (como 0063).

### API

- `GET /tenants/:id/members/:userId/audit?before=&limit=` → `{ events, nextBefore }`. Primero que el
  actor administre `:id` (`canManageTenant`; 403 `TENANT_NOT_MANAGED` sin leer nada de la persona),
  después que la persona tenga una membership (de cualquier estado) en el subárbol, leída con la RLS
  del actor (404 `MEMBER_NOT_FOUND`). Se lee con el contexto del actor (RLS por subárbol) y acotado
  al subárbol de `:id`: un evento sin nodo o de otra red nunca entra. `limit` de 1 a 100, 30 por
  defecto.
- `GET /admin/users/:userId/audit?before=&limit=` → la misma forma, por la función de 0065. Sólo
  superadmin (403 `SUPERADMIN_ONLY` antes de leer nada); 404 `USER_NOT_FOUND` si la cuenta no existe.
- `GET /tenants/network/audit?tenantId=&limit=&before=&category=&actorUserId=` → la misma forma. La
  consulta pasa por Zod (`NetworkAuditQuerySchema`, `.strict()`: un parámetro de más es 400; sin
  `tenantId` también, antes era 403). 403 `TENANT_NOT_MANAGED` ("No administras este
  nodo.") si no administra el nodo. `limit` de 1 a 200, 50 por defecto. Filtros, por el prefijo de
  `event_type`:
  - `users`: `auth.%`, `users.%`, `User%`, `Membership%`;
  - `credentials`: `ProviderCredentials%`;
  - `pricing`: `Markup%`;
  - `network`: `Tenant%` y `tenant.%` (marca, configuración, puestos);
  - `actorUserId`: sólo lo que hizo esa persona.
- Cada evento (`AuditEntry`): `id`, `occurredAt`, `eventType`, `tenantId`, `tenantName`,
  `actorEmail`, **`targetEmail`** (nuevo: "a quién") y `payload` tal cual se guardó (nunca lleva
  secretos). Nunca sale `meta` (IP, navegador, sesión).
- Desde Equipo y desde Mi Red, `targetEmail` sólo se nombra si esa persona tiene una membership (de
  cualquier estado) en el subárbol que se mira: un evento del subárbol puede apuntar a alguien de
  otra red (la suspensión global queda con el nodo de la sesión del superadmin), y ese correo no es
  de esta red. El historial del superadmin lo nombra siempre.
- El cursor `before` es el `nextBefore` de la página anterior: base64url de `{ occurredAt, id }`, con
  el instante en microsegundos. El orden es `(occurred_at, id)` descendente: los eventos de una misma
  transacción comparten `now()`, y un corte sólo por tiempo saltaba o repetía los del borde.

### Panel

- **Mi Red → Actividad** (`red/page.tsx`): filtros _Todo_, _Usuarios_, _Credenciales_, _Precios_ y
  _Red_ (botones con `aria-pressed`); cada evento con su frase ("Cambio de rol"), el detalle ("a
  ana@agencia.com · de Vendedor a Admin agencia"), el nodo y quién lo hizo, y la hora; _Cargar más_
  por `before`; vacío "Sin actividad para este filtro." (o "Sin actividad registrada todavía." en
  _Todo_); un error se dice con su motivo y _Reintentar_.
- `apps/web-b2b/src/lib/audit-format.ts`: `eventLabel` (un tipo sin frase se muestra con su código en
  monoespaciada), `eventDetail` (sólo correos, roles y estados, nunca ids), `categoryOf` (espejo de
  los filtros del API), `parseAuditPage` (nunca lanza) y `auditLoadError`. Las frases de los eventos
  de USR-11 (`MembershipRemoved`) y USR-16 (`users.exported`) ya están.
- BFF `GET /api/tenants/network/audit`: `networkAuditTarget` reconstruye la consulta parámetro por
  parámetro (nodo, tamaño, cursor, categoría, persona; uno desconocido o repetido es 400) y
  `forwardRead` devuelve el estado y el motivo del API.

### Tests

- `apps/api/src/audit/audit.service.test.ts`: con el compilador real de Kysely, el contexto de quien
  mira, el predicado de cada categoría, el de "de la persona" y el del subárbol, el cursor con
  desempate por id, el tamaño acotado, la fila de más que decide `nextBefore` y que sin membership en
  el subárbol (o sin cuenta) no se lee el historial.
- `apps/api/src/audit/audit.schemas.test.ts`: las consultas de la Actividad y del historial (tamaños,
  categorías, cursor emitido por el API, parámetros de más).
- `apps/api/src/audit/user-audit.controller.test.ts`: 401, 403 sin leer nada (nodo no administrado;
  `/admin` a quien no es superadmin), 404 fuera del subárbol o sin cuenta, el cursor llega leído, Zod
  en la ruta y la consulta, `RolesGuard` con la metadata real.
- `apps/api/src/audit/user-audit.integration.test.ts` (se salta sin `PGHOST`): el admin de un nodo
  nunca ve un evento sin nodo ni de otra red o del nodo hermano, el del consolidador sí ve el del
  hermano (con el id en mayúsculas); el superadmin ve el login fallido y la suspensión global; la
  función no le responde a otro ni la ejecuta `PUBLIC`; el cursor no salta ni repite cinco eventos de
  una misma transacción; los filtros y el "a quién" de la Actividad; nada de lo que sale trae el
  enlace de restablecer, su hash, contraseñas ni `meta`.
- `apps/web-b2b/src/lib/audit-format.test.ts` y `tenant-admin-proxy.test.ts`: las frases y los
  detalles, la lectura tolerante de la página, los mensajes de error y la consulta reconstruida del
  BFF.

## Admins de consolidador y los usuarios desde Gestión de Agencias (USR-9)

Sólo panel: el API ya asignaba `consolidator_admin` (está en `ASSIGNABLE_ROLES` y `canGrantRole` sólo
deja darlo a quien lo supera), pero Equipo no lo ofrecía y el superadmin no tenía cómo darlo sin
tocar la base.

### Panel

- `admin/usuarios/_components/roles.ts`: _Admin de consolidador_ entra en `INVITABLE_ROLES` (entre
  _Admin_ y _Cliente_, la escala de menor a mayor) con su aviso de 2FA. `grantableRoles` lo deja sólo
  a quien lo supera: en la práctica, el superadmin.
- `offeredRoleLabel(rol)`: la confirmación de un cambio de rol, su aviso de éxito y el de una
  invitación pendiente nombran el rol como la opción del selector (_Admin de consolidador_), no como
  la insignia (_Consolidador_), que en "Promover a Consolidador" se lee como el tipo de nodo.
- `invitableRolesIn(tipo)`: el de consolidador se ofrece sólo si el nodo elegido en Equipo es un
  consolidador, tanto al invitar como en el selector de rol de cada fila (Equipo calcula la lista una
  vez y se la pasa a los dos). En una agencia su descripción no sería cierta y en la raíz
  administraría toda la plataforma. El API no lo impide: es una guía, como el resto de lo que ofrece
  Equipo.
- **Gestión de Agencias**: el "3 usuarios" de cada fila es un enlace a Equipo abierto en ese nodo
  (nombre accesible "Ver 3 usuarios de …", que contiene el texto visible para el control por voz), y
  la barra de secciones de un nodo suma la pestaña _Usuarios_ al final, que lleva al mismo lugar.
  Equipo ignora un `?tenant=` fuera de la red de quien mira. El enlace sale de `teamHrefFor`
  (`lib/tenant-admin-team.ts`).

### Tests

- `roles.test.ts`: `INVITABLE_ROLES` es exactamente `ASSIGNABLE_ROLES`, leído como texto de
  `apps/api/src/auth/roles.ts` (si la lectura se rompe, el test falla en vez de comparar dos vacíos);
  cada rol tiene etiqueta; el aviso de 2FA aparece justo en los roles que lo exigen; sólo el
  superadmin da el de consolidador y sólo en un consolidador.
- `team.render.test.ts`: la fila ofrece _Admin de consolidador_ al superadmin en un consolidador, no
  en una agencia ni a un admin de consolidador; la invitación pendiente dice _Admin de consolidador_.
  En `roles.test.ts`, además, la confirmación de ese ascenso con `offeredRoleLabel`.
- `node-section-nav.render.test.ts` y `node-users-link.render.test.ts`: la pestaña y el enlace llevan
  a `/admin/usuarios?tenant=<id>`, la pestaña nunca es la sección actual y el nombre accesible del
  enlace (singular, cero, nombre escapado).

## Filtros del equipo y columna Alta (USR-10)

Sólo panel: el equipo de un nodo ya llega entero de `GET /tenants/network/users` y es chico, así
que los filtros corren en el navegador, sin otra consulta ni cambios de API.

### Panel

- `lib/team-filters.ts` (sin I/O, con `now` explícito): los predicados `pendingMfa` (su rol en el
  nodo exige 2FA y no lo activó, el mismo "2FA pendiente" de la fila), `locked` (bloqueo vigente),
  `neverLoggedIn` (`lastLoginAt` null; si el API no manda el dato no se cuenta), `suspended` (en el
  nodo o en toda la plataforma) y `resetPending`; `byRole`; la búsqueda por nombre o correo (salió
  de `member-list.tsx`); los conteos; el orden por último acceso y la URL.
- **Filtros rápidos**: _Todos_, _2FA pendiente (n)_, _Bloqueados (n)_, _Nunca ingresaron (n)_ y
  _Cambio de contraseña pendiente (n)_. Uno a la vez (tocar el elegido vuelve a _Todos_). El número
  de cada chip se cuenta con la búsqueda, el rol y "Ocultar suspendidos" ya aplicados: es el de filas
  que deja al elegirla. Son botones con `aria-pressed` dentro de un grupo "Filtrar miembros"; en el
  teléfono van en una fila que se desliza de lado (en tres renglones empujaban la lista fuera de la
  pantalla).
- **Rol** (_Todos los roles_ y los roles que hay en el nodo, del más alto al más bajo, con el nombre
  del selector de la fila) y **Ocultar suspendidos (n)**, que se suman al filtro rápido. Su (n) son
  las filas que esconde con lo demás puesto, filtro rápido incluido.
- **Orden por último acceso**: en pantalla ancha, el título de la columna es un botón que alterna
  más reciente → más antiguo → sin ordenar (el del API, por alta en el nodo). Quien nunca ingresó
  cuenta como el acceso más antiguo. La lista no es una tabla (en el teléfono cada miembro es una
  tarjeta), así que el orden no va en `aria-sort`, que sólo vale en un encabezado de tabla: lo dice el
  nombre del botón ("Último acceso, más reciente primero"). En el teléfono, donde no hay títulos de
  columna, el orden se elige con "Ordenar por" en la barra.
- **Columna Alta**: hace cuánto se sumó al nodo (la membership, no la cuenta), con la fecha exacta
  al pasar el mouse. Se suma desde `xl`: entre `md` y `lg`, con la barra lateral, una séptima columna
  dejaba "Nunca ingresó" sin lugar. La grilla cambia de seis a siete columnas en el mismo punto que la
  celda y su título aparecen.
- **Lista vacía**: si la búsqueda sola no deja a nadie, "Ningún usuario coincide con la búsqueda."; si
  son los filtros, "Nadie coincide con estos filtros." con _Quitar filtros_ (también en la barra
  mientras haya alguno puesto). Quitar filtros conserva el orden y devuelve el foco a _Todos_, porque
  el botón que se tocó desaparece. El título dice "Miembros (3 de 12)" y un `role="status"` anuncia
  cuántos se ven.
- **URL**: `?filtro=2fa-pendiente|bloqueados|nunca-ingresaron|cambio-de-contrasena`, `?rol=<rol>`,
  `?suspendidos=ocultos` y `?orden=acceso-reciente|acceso-antiguo`, sin tocar los demás parámetros;
  lo que está por defecto no se escribe y un valor desconocido se ignora. Se leen al montar y se
  escriben con `replaceState` (con espera, por el límite de Safari). Equipo también escribe
  `?tenant=` al elegir otro nodo, así una recarga o un enlace abren el mismo nodo con los mismos
  filtros. Al montar, el nodo sale del `?tenant=` del navegador y no sólo del que leyó el servidor:
  al volver con "atrás", Next pinta la página de su caché, con el nodo de antes de elegir otro.

### Tests

- `lib/team-filters.test.ts`: cada predicado (también sin el dato del API), los filtros combinados,
  que el número de cada chip sea el de filas que deja, el orden con quien nunca ingresó y los empates,
  la URL de ida y vuelta (nombres legibles, valores por defecto no escritos, `?tenant=` intacto,
  valores desconocidos ignorados) y el `?tenant=` que escribe Equipo.
- `team.render.test.ts`: la barra con sus conteos y `aria-pressed`, un filtro rápido, rol y
  suspendidos juntos, la lista vacía por filtros y por búsqueda, el orden y el nombre del botón, la
  columna Alta (relativa, exacta en el `title`, sólo desde `xl`), sin barra mientras carga, con error
  o sin miembros, y todo en tú.

## Ficha del usuario en el panel lateral (USR-7)

Sólo panel: la API de la ficha es USR-5 y la del historial USR-6 (`user.passwordResetRequired` ya
viene desde USR-5). El nombre de cada persona, en Equipo y en Plataforma → Usuarios, es un botón
("Ver la ficha de {nombre}", `aria-haspopup="dialog"`) que abre su ficha.

### Panel

- **Panel lateral** (`Sheet`, el mismo de `FormSheet`, que ahora lo comparte): a la derecha en
  escritorio, pantalla completa en el teléfono; diálogo modal nombrado por la persona y descrito por
  su correo; Escape, la X, el fondo o _Cerrar_ lo cierran y el foco vuelve al nombre que lo abrió.
- **Cabecera**: nombre, correo y marcas: _Cuenta suspendida_, _Suspendido en este nodo_ (desde
  Equipo), _Bloqueado_, _Cambio de contraseña pendiente_, _2FA pendiente_ (si un acceso activo lo
  exige); sin nada de eso, _Activo_. En la propia ficha, _Tú_.
- **Perfil**: correo verificado o sin verificar, alta, último acceso e "Invitado por {correo} ·
  {hace…}" (sin invitación registrada, la fila no se muestra).
- **Nodos y roles**: "{Nodo} · {Rol} · {Activo|Suspendido}". Desde Equipo, sólo los nodos que
  administra quien mira (lo filtra el API).
- **Seguridad**: "2FA activo desde el {fecha}" o "Sin 2FA" (con "su rol lo exige…" si corresponde);
  códigos de recuperación y equipos de confianza sólo con 2FA; "Bloqueado hasta las {HH:MM}" con
  _Desbloquear_ al lado (la misma acción del menú); intentos fallidos sin bloqueo; "Contraseña cambiada
  {hace…}" y el cambio pendiente. Un dato que el API no manda no se muestra: nunca un "0" inventado.
- **Sesiones abiertas ({n})**: equipo legible (el mismo resumen del user-agent que Puestos), IP, nodo
  y "Activa {hace…}", con _Cerrar esta sesión_. Confirmación "Cerrar esta sesión de {nombre}" y aviso
  "Cerramos esa sesión de {nombre}."; un 404 es que ya no estaba abierta y la ficha se relee. Nunca
  sobre la propia (en la propia ficha se dice que se cierran desde Mi cuenta → Seguridad) ni a quien
  quien mira no supera en rango (el API decide; el panel no lo ofrece si `canActOn` dice que no).
  Desde el directorio, el cierre va por la ruta de Equipo con el nodo de la sesión; una sesión sin
  nodo no se cierra de a una. Vacío: "No tiene sesiones abiertas en los nodos que administras."
  (Equipo) o "No tiene sesiones abiertas." (directorio).
- **Invitaciones que envió**: cuántas pendientes y hasta 20, con rol, nodo y vencimiento.
- **Actividad**: el historial con las frases de `lib/audit-format`, dónde y quién, y _Cargar más_
  (`aria-disabled` mientras carga, para no soltar el foco). Vacío: "Sin actividad registrada."
- **Pie**: _Cerrar_ y _Acciones_, que abre hacia arriba el mismo menú agrupado de la fila: _Acceso_,
  _Seguridad_ y _Membresía_ (la fila ahora también nombra este último grupo). Lo corren los handlers
  de Equipo, que devuelven el resultado: pedido desde la fila, el error va en la fila; desde la ficha,
  en el pie de la ficha. Al salir bien, la ficha y su actividad se releen (y Equipo recarga la lista
  y los puestos). Mientras corre, _Acciones_ queda `aria-disabled`. El menú va sin portal, dentro del
  diálogo: con `aria-modal` un lector de pantalla no lo deja de lado, y `useModalBehavior` ahora
  respeta un Escape o un Tab que ya atendió Radix (`defaultPrevented`), así Escape cierra el menú y no
  también la ficha.
- **Directorio**: el menú suma el soporte de Equipo por uno de sus nodos (el primero activo; el
  superadmin puede por cualquiera y el API pide membership en ése), la cuenta (_Suspender en toda la
  plataforma_ / _Reactivar cuenta_, el handler de USR-4) y _Ver en Equipo_. Cada vez que la ficha se
  lee, su fila del directorio se pone al día (estado, bloqueo, 2FA, sesiones).
- **Estados**: cargando (el nombre de la fila en el título y un esqueleto), error con su motivo en tú
  y _Reintentar_ (403: no administras el nodo, o "sólo para el superadmin"; 404: ya no está en el
  nodo, o no encontramos la cuenta).

### BFF

- `GET /api/tenants/:tenantId/members/:userId` y `.../audit`, `GET /api/admin/users/:userId` y
  `.../audit`: `forwardRead` con los ids validados y la consulta del historial reconstruida (`before`
  con la forma del cursor del API, `limit` de 1 a 100; otro parámetro es 400).
- `POST /api/tenants/:tenantId/members/:userId/sessions/:sessionId/revoke`: `forwardAction`, sólo
  desde el mismo origen.

### Tests

- `lib/member-detail.test.ts`: la lectura tolerante (sin id o correo es error; lo raro queda sin dato;
  filas incompletas descartadas), las marcas, cada frase, el equipo legible, de qué nodo sale el
  cierre, el nodo de soporte del directorio, la fila puesta al día y las llamadas con sus errores.
- `lib/tenant-admin-proxy.test.ts`, `lib/platform-users-proxy.test.ts` y
  `lib/member-detail-routes.test.ts`: las rutas del API que arma el borde, la consulta reconstruida y
  las cinco rutas del panel (ids, mismo origen, estado y motivo del API).
- `member-sheet.render.test.ts`: el diálogo y su nombre, cada sección con su vacío, qué se ofrece
  (cerrar una sesión ajena, desbloquear, el menú), cargando y error, el pie, el botón del nombre en la
  lista y todo en tú. `platform-users.render.test.ts`: el nombre como botón y el menú del directorio.
  `team.render.test.ts`: el menú de la fila con _Membresía_.

## Invitaciones sin aceptar de toda la red (USR-15)

Antes, para ver quién quedó invitado sin aceptar había que abrir Equipo nodo por nodo. Sin cambios en
la base: la RLS de `user_invitations` (0028, `can_read_membership`) ya le deja al superadmin leerlas
todas.

### API

- `GET /admin/invitations` (`AdminInvitationsController` / `AdminInvitationsService`, aparte de
  `InvitationsController`, que sigue siendo la de un nodo y la del canje). Sólo superadmin: 401 sin
  sesión, 403 `SUPERADMIN_ONLY` a cualquier otro, antes de leer nada (el chequeo vive en el servicio).
- Filtros con Zod `.strict()`: `state` = `pending` (por defecto: `expires_at > now()`), `expired`
  (`expires_at <= now()`, el mismo corte del canje) o `all`; `q` (el correo, `%` y `_` literales);
  `tenantId` (el nodo con su subárbol); `limit` (1-100, 50 por defecto) y `cursor` (el mismo
  `{ createdAt, id }` con microsegundos del directorio, orden `(created_at, id)` descendente). Sólo
  las que no se aceptaron ni se revocaron.
- Respuesta `{ invitations, nextCursor, counts }`: cada una con `id`, `email`, `role`, `tenantId`,
  `tenantName`, `invitedByEmail` (quien la emitió o la reenvió por última vez; `null` si esa cuenta
  ya no existe), `createdAt`, `expiresAt` y `expired`. `counts = { pending, expired }` cuenta con la
  misma búsqueda y nodo, sin importar `state` ni el cursor, en la misma transacción que la página
  (comparten el `now()`). Nunca sale el hash del token.
- Reenviar y revocar no tienen ruta nueva: son `POST /invitations/:id/resend|revoke?tenantId=` con el
  nodo de la fila. El superadmin las supera en rango en cualquier nodo; con el nodo equivocado, 404
  `INVITATION_NOT_PENDING`.

### Panel

- **Plataforma → Usuarios** suma pestañas (`SectionTabs`): _Usuarios_ (el directorio de USR-4) e
  _Invitaciones_, con el número de pendientes de toda la red (un `GET /api/admin/invitations?limit=1`
  aparte, que se repite cada vez que una invitación cambia; sin número si falla, nunca un cero
  inventado; si salen dos seguidos, sólo pinta el último). Las dos quedan montadas al cambiar
  (`SectionTabPanel keepMounted`): cada una conserva sus filtros y lo que cargó. La de invitaciones
  se monta recién la primera vez que se abre. Suspender una cuenta en _Usuarios_ revoca las
  invitaciones que emitió: si revocó alguna, la lista de _Invitaciones_ (con sus mismos filtros) y el
  número de la pestaña se vuelven a pedir, para no seguir mostrándolas.
- **Filtros**: _Pendientes_, _Vencidas_ y _Todas_ con sus números, "Busca por correo" (espera de
  300 ms) y _Nodo_ (en el orden del árbol, con su subárbol), y _Limpiar filtros_.
- **Cada fila**: correo (con _Vencida_ si ya venció), "{Rol} · {Nodo} · Vence en {n} días / Vence hoy /
  Venció hace {…}" e "Invitado por {correo} · {hace…}" ("un usuario eliminado" si esa cuenta ya no
  existe). _Reenviar_ (destacado en una vencida) y _Revocar_, con la confirmación de Equipo ("Revocar
  la invitación a {correo}" / "El enlace que le enviamos deja de funcionar…").
- **Después de una acción** la fila cambia en el lugar, sin recargar, para no perder las páginas de
  _Cargar más_: reenviar deja el vencimiento nuevo y a quien reenvió como invitador (una vencida pasa a
  pendiente y sale de _Vencidas_); revocar la saca de la lista y de su contador. El aviso de reenvío es
  el de Equipo (`invitationNotice`, con la advertencia si el correo no salió). Si ya no estaba
  pendiente (la aceptaron o la revocaron desde otra sesión) sale de la lista con un aviso. Cuando la
  fila se va, el foco pasa al título de la lista; mientras corre una acción sus botones quedan
  `aria-disabled` (no `disabled`), para no soltar el foco. Los errores quedan en la fila.
- **Estados**: cargando, error con su motivo y _Reintentar_, y vacío ("No hay invitaciones
  pendientes.", "No hay invitaciones vencidas.", "No hay invitaciones sin aceptar." o, con búsqueda o
  nodo, "No encontramos invitaciones con esos filtros." y _Limpiar filtros_).
- **BFF**: `GET /api/admin/invitations`, `forwardRead` con la consulta reconstruida parámetro por
  parámetro (uno desconocido o repetido es 400 sin llegar al API), con el estado y el motivo del API.
- `SectionTabs` (también en Carteras) ya no muestra barra de desplazamiento: la regla `*` de
  `globals.css` le ganaba a `[scrollbar-width:none]` y el `-mb-px` de las pestañas dejaba una barra
  vertical en Windows.

### Tests

- `apps/api/src/tenants/admin-invitations.service.test.ts`: el borde (estados, búsqueda, nodo,
  cursor, límite, parámetros de más), el SQL de cada estado y de los contadores, el cursor de ida y
  vuelta, cómo sale cada fila y el 403 sin ninguna consulta.
- `apps/api/src/tenants/admin-invitations.integration.test.ts` (se salta sin `PGHOST`), como
  `app_user`: el superadmin ve todas las redes, nunca aceptadas ni revocadas; un admin de red recibe
  403 aunque pida su subárbol; cada estado, el nodo con su subárbol, la búsqueda sin comodines y los
  contadores; el cursor sin saltos con dos del mismo microsegundo; reenviar y revocar por las rutas de
  un nodo con el nodo de la fila (y 404 con otro nodo).
- `apps/api/src/auth/sales-operations.guard.test.ts`: la ruta clasificada como administración.
- Web: `lib/platform-invitations.test.ts` (lectura, consulta reconstruida, frases, la lista después
  de cada acción, las llamadas y la ruta del panel) y `platform-invitations.render.test.ts` (filas,
  vencida, en espera, error, estados, filtros, las pestañas sin barra), todo en tú.

## Avisos por correo de cada cambio de seguridad (USR-12)

Antes, si un admin le restablecía el 2FA, le cerraba las sesiones, le cambiaba el rol o le suspendía
el acceso, la persona se enteraba al próximo ingreso, o nunca. Ahora le llega un aviso a su propio
buzón (NIST 800-63B-4, OWASP), también cuando cambia su propia contraseña: si no lo esperaba, avisa.
Sin cambios en la base ni en el panel.

### Qué avisos hay

| Aviso                                             | Cuándo                                                              | Asunto                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------- |
| `mfa_reset`                                       | Restablecer su 2FA                                                  | Restablecimos tu verificación en dos pasos · PlaneTour     |
| `sessions_revoked`                                | Cerrar todas sus sesiones, si tenía alguna abierta                  | Cerramos tus sesiones abiertas · PlaneTour                 |
| `session_revoked`                                 | Cerrar una sesión desde la ficha                                    | Cerramos una de tus sesiones · PlaneTour                   |
| `unlocked`                                        | Desbloquear, si había un bloqueo vigente                            | Desbloqueamos tu cuenta · PlaneTour                        |
| `role_changed`                                    | Cambiar su rol en un nodo, si cambió                                | Tu rol en {nodo} cambió · PlaneTour                        |
| `membership_suspended` / `membership_reactivated` | Suspender o reactivar su acceso a un nodo, si cambió                | Tu acceso a {nodo} fue suspendido / reactivado · PlaneTour |
| `account_suspended` / `account_reactivated`       | Suspender o reactivar su cuenta en toda la plataforma, si cambió    | Tu cuenta de PlaneTour fue suspendida / reactivada         |
| `password_changed`                                | Canjear un enlace de restablecimiento o cambiarla desde Mi cuenta   | Tu contraseña cambió · PlaneTour                           |
| `membership_removed`                              | Quitarla de un nodo (USR-11)                                        | Ya no formas parte de {nodo} · PlaneTour                   |
| `mfa_enabled`                                     | Activar su 2FA por primera vez o tras un restablecimiento (USR-13b) | Activaste la verificación en dos pasos · PlaneTour         |
| `mfa_changed`                                     | Cambiar de teléfono (otra app de autenticación) (USR-13b)           | Cambiaste tu app de autenticación · PlaneTour              |
| `mfa_disabled`                                    | Desactivar su propio 2FA (USR-13b)                                  | Desactivaste la verificación en dos pasos · PlaneTour      |

- Enviarle el enlace y forzar el cambio de contraseña no suman un aviso: el correo del enlace ya lo
  es. Liberar un puesto (Equipo → Puestos) tampoco avisa: es operativo, de todos los días, y el panel
  ya le dice "Un administrador liberó tu puesto".
- "Si cambió": repetir un cambio que ya estaba hecho (reactivar a alguien activo, darle el rol que ya
  tenía, cerrar sesiones a quien no tenía ninguna) queda en la auditoría como siempre pero no avisa
  de algo que no pasó.

### API

- `SecurityNoticeService` (`apps/api/src/mail/security-notice.service.ts`, exportado por
  `MailerModule`, global): `notify(kind, { userId, tenantId, nodeName?, role? })`. Lo llaman
  `MemberSupportService` (`resetMfa`, `revokeSessions`, `unlock`), `MemberDetailService.revokeSession`,
  `AdminController` (`changeRole`, `setMembershipStatus`, `removeMembership`, `setUserStatus`),
  `PasswordResetService` (`reset`, `change`) y `MfaService` (`confirmEnrollment`, `disable`;
  USR-13b), siempre después del commit: un aviso de algo que se deshizo sería falso. Si la
  transacción falla, no hay aviso.
- La respuesta al admin no lo espera: el envío queda en `InflightWorkRegistry` (`security-notice`)
  para que un apagado ordenado lo deje salir. `send()` es el envío en sí: devuelve si salió y nunca
  lanza. Si no sale, el log dice el tipo y el id de la persona, nunca su correo ni el error (el de la
  base o el del SMTP puede citarlo).
- Por qué correo sale: el del nodo de la ruta (propio o heredado), que el aviso nombra ("Un
  administrador de {nodo}…"). Sin nodo de por medio (`tenantId: null`: su contraseña, su cuenta en
  toda la plataforma), el de su membership activa más antigua o el del sistema, sin nombrar ningún
  nodo. Esa membership se lee con su id en el contexto (`mail/mail-node.ts`, el mismo de "Olvidé mi
  contraseña", que antes era privado de `PasswordResetService`). A una cuenta suspendida también le
  llega: es a quien más le importa.
- "Si cambió" se decide con lo que había al tomar la fila (`FOR NO KEY UPDATE`) dentro de la
  transacción del cambio, no con una lectura anterior que otro admin pudo dejar vieja: dos cambios
  en paralelo no dan dos avisos ni uno que no es el último. `PATCH /admin/users/status` lee así el
  estado anterior de la cuenta (una cuenta que no existe es 404 antes del UPDATE), y
  `PATCH /admin/memberships/status` y `PATCH /admin/memberships/role`, el estado y el rol de la
  membership (403 si la RLS ya no la deja tomar, como el UPDATE).
- `MailerService` ya no escribe en el log el destinatario de un correo que no tiene por dónde salir,
  y el error del SMTP va con las direcciones reemplazadas (`redactAddresses`): un correo es un dato
  personal.

### Plantillas

- `apps/api/src/mail/security-notices.ts`: en tú, "Hola, {nombre}:" (o "Hola:"), lo que pasó y, al
  final de todas, "Si no lo esperabas, avísale a tu administrador de inmediato.". La contraseña
  cambiada suma "Si no fuiste tú, elige una nueva desde «¿Olvidaste tu contraseña?»…" (el texto del
  enlace de la pantalla de ingreso); restablecer el 2FA cuenta que los códigos de recuperación y los
  equipos de confianza ya no sirven (sin 2FA no queda un segundo paso que saltar); suspender el
  acceso a un nodo aclara que los demás no cambian.
- El rol va con el nombre con que Equipo lo ofrece (_Admin de agencia_, _Manager_, _Vendedor_…) y,
  si exige 2FA, lo dice.
- Nunca llevan enlaces ni tokens (el pie lo aclara: "no trae enlaces ni te pide datos"): un aviso de
  seguridad con un botón es justo lo que imita el phishing. El nombre del nodo y el de la persona van
  escapados en el HTML y sin caracteres de control en el asunto y el texto (`mail-text.ts`); sin
  nombre de nodo legible, "la plataforma".

### Tests

- `apps/api/src/mail/security-notices.test.ts`: asunto, saludo, cuerpo y línea final de cada aviso;
  todos en tú, sin enlaces ni tokens; el rol y su aviso de 2FA; nombres hostiles escapados, sin saltos
  de línea en el asunto y "la plataforma" sin nombre.
- `apps/api/src/mail/security-notice.service.test.ts`: por qué nodo sale y a quién, el nombre que ya
  trae el llamador, la membership leída en el contexto de la persona, el correo del sistema, `false`
  sin lanzar cuando el correo o la base fallan y el log sin el correo; `notify` no hace esperar y
  queda registrado para el apagado.
- `apps/api/src/mail/security-notice.integration.test.ts` (se salta sin `PGHOST`): el nodo de la
  ruta, la membership activa más antigua como `app_user` (una suspendida no cuenta) y el correo del
  sistema.
- Las llamadas, con dobles: `member-support.service.test.ts`, `member-detail.service.test.ts`,
  `admin.controller.test.ts` y `password-reset.service.test.ts` verifican un aviso por cambio, después
  del commit, ninguno si no cambió nada, en un 4xx o si la transacción falla, y ninguno extra al
  enviar o forzar el enlace. Contra Postgres, `platform-users.integration.test.ts` y
  `membership-revocation.integration.test.ts` (un aviso por cambio real, no por repetirlo).
- `apps/api/src/voseo-guard.test.ts` recorre también las plantillas de los avisos.

## Reconfirmar el 2FA antes de las acciones de alto impacto (USR-13)

Founder D1 = C: una sesión de admin robada sola no tiene que alcanzar para abrirle a nadie la puerta
de otra cuenta ni para golpear a toda la plataforma. Antes de esas acciones se pide el código del
2FA si la sesión no lo pasó en los últimos **10 minutos**; el soporte de todos los días no lo pide.
Sin cambios en la base: la ventana se mide con `sessions.mfa_verified_at`, que ya existía.

| Acción                                                    | Pide el código                         |
| --------------------------------------------------------- | -------------------------------------- |
| Suspender o reactivar una cuenta en toda la plataforma    | Siempre                                |
| Restablecer el 2FA de otra persona                        | Siempre                                |
| Forzar el cambio de contraseña                            | Siempre                                |
| Enviarle el enlace para restablecer la contraseña         | Si tiene un rol de admin en algún nodo |
| Quitarla de un nodo (USR-11)                              | Si su rol en ese nodo es de admin      |
| Exportar a CSV y forzar el cambio en bloque (USR-16, -14) | Siempre, cuando existan                |
| Desbloquear, cerrar sus sesiones, cerrar una sesión       | No                                     |

"Rol de admin" = `ADMIN_ROLES` (de `admin` para arriba, incluidos los de plataforma), en cualquiera
de sus nodos, no sólo en el de la ruta.

### API

- `RECENT_MFA_WINDOW_MINUTES = 10` (`apps/api/src/auth/recent-mfa.ts`). Una ruta se marca con
  `@RequireRecentMfa()` (o `@RequireRecentMfa(minutos)`), siempre en el handler; `RecentMfaGuard` es
  el último guard global (después de `MfaEnforcementGuard` y `RolesGuard`) y sólo opina en las rutas
  marcadas. Cuando la exigencia depende de los datos, el servicio llama a `assertRecentMfa()`
  después de autorizar (así lo hacen `MemberSupportService.sendPasswordReset` y
  `AdminController.removeMembership`): a quien no podía hacerlo igual no se le pide el código. Hoy
  llevan la marca `PATCH /admin/users/status`, `POST /tenants/:id/members/:userId/reset-mfa` y
  `.../require-password-reset`; un test fija esa lista contra la metadata real de `AppModule`.
- Sin el 2FA reciente: **403 `MFA_RECENT_REQUIRED`** ("Confirma con tu código de verificación en
  dos pasos para seguir."). 403 y no 401: la sesión sigue viva. Quien no tiene el 2FA activo (los
  roles que no lo exigen: `agency_admin`, `admin`) recibe **403 `MFA_REQUIRED_FOR_ACTION`** ("Para
  hacer esto necesitas la verificación en dos pasos. Actívala en Seguridad y vuelve a intentarlo."):
  no hay código que pedirle.
- **`POST /auth/step-up` `{ code }`** (6 dígitos, Zod estricto): `MfaService.stepUp` prueba el TOTP
  con el mismo bloqueo de la cuenta que el login (`withLockout`, acción `step_up`; cada fallo se
  audita como `auth.mfa.reauth_failed`) y el anti-replay del paso, y pone `mfa_verified_at = now()`
  en ESA sesión (no revocada). Audita `auth.mfa.step_up`. Errores: 400 `MFA_CODE_INVALID` (código
  incorrecto o ya usado), 429 `MFA_ACCOUNT_LOCKED`, 409 `MFA_NOT_ENABLED` y 401 `SESSION_REVOKED` si
  la sesión se cerró en el medio. Sólo TOTP: un código de recuperación no reconfirma (si se perdió el
  teléfono, se vuelve a ingresar con uno). Throttle de 10 por minuto.
- La antigüedad la mide la base (`now() - mfa_verified_at` en `SessionService.validate`) y llega al
  contexto como `mfaVerifiedAt` en el reloj de la API: un desfase entre los relojes no corre la
  ventana.
- Lo que **no** cuenta como haber escrito el código: cambiar de agencia y el token nuevo de un
  cambio de contraseña heredan el instante de la sesión que reemplazan; entrar con un equipo de
  confianza cuenta desde que se confió en él (`TrustedDeviceService.use` devuelve ese instante);
  completar un ingreso liberando un puesto conserva el del intento original (claim `mfa_at` del
  permiso). `IssueSessionParams.mfaVerifiedAt` lo lleva hasta el `INSERT` de la sesión, que lo
  topea con `now()` de la base (`LEAST`): el claim sale del reloj de la API y, adelantado, dejaría la
  ventana abierta de más. Por lo mismo `SessionService.validate` nunca arma un instante en el futuro.

### Panel

- `withStepUp(fn)` (`apps/web-b2b/src/lib/step-up.ts`): corre la llamada; ante 403
  `MFA_RECENT_REQUIRED` abre el diálogo, manda el código y la repite **una** vez (nunca en bucle).
  Si se cierra el diálogo devuelve `StepUpCancelled` (`isStepUpCancelled`): la acción no se hizo y
  no hay error que mostrar. Dos acciones a la vez comparten un solo código. La llamada envuelta
  tiene que devolver el `reason` del API en el fallo (`StepUpAware<T>`): hoy `runMemberAction`
  (todas las acciones de soporte de Equipo y de la ficha), `removeMembership` (quitar del nodo) y
  `setPlatformUserStatus`.
- `StepUpProvider` (`apps/web-b2b/src/components/step-up-dialog.tsx`), montado una vez en el layout
  del panel: **"Confirma que eres tú"**, "Escribe el código de 6 dígitos de tu app de
  autenticación.", seis casillas (`inputMode="numeric"`, `autocomplete="one-time-code"`); se envía
  solo al completar el sexto dígito o con **Confirmar**. Errores en el diálogo: "Ese código no es
  válido. Inténtalo de nuevo." (las casillas se vacían) y "Demasiados intentos. Espera unos
  minutos.". Mientras verifica no se cierra.
- `POST /api/auth/step-up`: mismo origen, cuerpo reconstruido (`{ code }` de 6 dígitos; lo demás es
  400 sin llegar al API), estado y motivo del API en el error.
- El historial de la persona muestra `auth.mfa.step_up` como "Reconfirmó su 2FA para una acción de
  alto impacto".
- Para sumar una acción de otro frente (cancelar una orden desde la consola, exportar a CSV): en el
  API, `@RequireRecentMfa()` en el handler (y sumarla a la lista del test del guard); en el panel,
  que su llamada devuelva el `reason` y envolverla con `withStepUp`.

### Tests

- `apps/api/src/auth/guards/recent-mfa.guard.test.ts`: los bordes de la ventana (10 minutos exactos
  pasa, un milisegundo después no), la ventana por ruta, sin 2FA activo, sin contexto (401), que una
  ruta sin la marca no la ve, que el guard es el último global y la lista exacta de rutas marcadas.
- `apps/api/src/auth/mfa.service.test.ts`: `stepUp` pone en ahora sólo esa sesión y lo audita; cada
  código malo cuenta y el quinto bloquea (429) sin tocar la sesión; uno de recuperación no sirve ni
  cuenta; sin 2FA, 409; sesión cerrada en el medio, 401.
- `apps/api/src/tenants/member-support.service.test.ts` y `member-support.integration.test.ts`:
  enviar el enlace a un admin pide el código (también si es admin en otro nodo), después de la
  autorización y del 409; a un vendedor, no.
- `apps/api/src/auth/auth-premium.integration.test.ts` (Postgres, como `app_user`): la ventana corre
  desde el código, `stepUp` la renueva y el mismo código no sirve dos veces; cambiar de contraseña o
  de agencia hereda el instante; el equipo de confianza cuenta desde su alta; liberar un puesto al
  entrar conserva el instante del intento (aun con un equipo de confianza de hace una hora); un
  instante heredado en el futuro queda topeado por la base; sesión revocada, 401.
- `seat.service.test.ts`, `jwt-tokens.test.ts`, `auth.service.*.test.ts`, `dto.test.ts` y
  `auth.controller.step-up.test.ts`: el instante heredado de punta a punta y el borde del endpoint.
- Panel: `lib/step-up.test.ts` (reintento único, cancelar, sin bucle, sin diálogo, código
  compartido, el cuerpo del BFF y los mensajes, en tú), `components/step-up-dialog.render.test.ts`,
  `app/api/auth/step-up/route.test.ts`, y el reintento en `tenant-admin-seats-client.test.ts` y
  `platform-users.test.ts`.

### Despliegue y uso real

- Sin migración. Las sesiones vivas al desplegar ya tienen `mfa_verified_at` (el del login): la
  primera acción crítica después de 10 minutos pide el código. Un permiso para liberar un puesto
  firmado antes del despliegue no trae `mfa_at` y cuenta desde su emisión (`iat`), a lo sumo 5
  minutos después del código.
- API y panel van juntos. Si el API sale antes, el panel viejo muestra el 403 como un error ("Confirma
  con tu código…") y la acción no se hace hasta que salga el panel; si el panel sale antes, el
  diálogo nunca se abre (el API viejo no responde ese 403).
- **Quién pierde algo**: un `agency_admin` o un `admin` sin el 2FA activo (esos roles no lo
  exigen) ya no puede restablecer el 2FA de alguien, forzarle el cambio de contraseña ni enviarle el
  enlace a un admin: recibe 403 `MFA_REQUIRED_FOR_ACTION` hasta que active el 2FA en Seguridad. Lo
  demás del soporte (enviar el enlace a un vendedor, desbloquear, cerrar sesiones) sigue igual. El
  superadmin y los roles que exigen el 2FA no cambian, salvo el código cada 10 minutos.
- **Lo que no cubre**: suspender en un solo nodo, cambiar un rol ni invitar no piden el código, por
  D1. El hueco de la revisión adversarial (en una cuenta SIN 2FA, una sesión robada lo activaba con
  su propio teléfono, sin la contraseña, y quedaba reconfirmada en el acto, cerraba las sesiones de
  la persona y no salía ningún aviso) lo cierra USR-13b: ver abajo.

### Pedir la contraseña al activar el 2FA por primera vez (USR-13b)

Activar el 2FA por primera vez, también después de que un admin lo restableció, pide la contraseña
de la cuenta, como Google, GitHub o Stripe antes de cambiar un factor de ingreso. Sin ella, una
sesión robada de una cuenta sin 2FA lo activaba con el teléfono del atacante: la sesión contaba
como recién verificada para las acciones de alto impacto, las demás sesiones de la persona se
cerraban y no le llegaba nada. Con ella, hace falta además la contraseña, y la persona se entera
por correo. Sin cambios en la base.

- **API**: `POST /auth/mfa/confirm` acepta `{ code, currentPassword? }` (`MfaConfirmSchema`).
  `MfaService.confirmEnrollment` decide con `users.mfa_enabled_at`: si la cuenta no tiene el 2FA
  activo, la contraseña es obligatoria. Sin ella, **400 `MFA_PASSWORD_REQUIRED`** ("Escribe tu
  contraseña para activar la verificación en dos pasos."), sin probar ni contar nada. Se prueba
  antes que el código y como en el login: un `bcrypt.compare` aunque la cuenta no tenga contraseña
  guardada (contra un hash de relleno, para que el tiempo no lo delate), dentro de `withLockout`
  (acción `enroll`): el intento se reserva contra el mismo contador de fallos y bloqueo del login
  antes de verificar, un acierto lo limpia, y cada fallo se audita como `auth.mfa.reauth_failed`.
  Mala: **400 `MFA_PASSWORD_INVALID`** ("La contraseña no es correcta."); la quinta, o con la cuenta
  ya bloqueada, **429 `MFA_ACCOUNT_LOCKED`**, que bloquea también el login 15 minutos. Un código con
  otra forma se rechaza antes de probar la contraseña.
- El `UPDATE` que activa el secreto exige además que la cuenta siga como se leyó
  (`(mfa_enabled_at IS NOT NULL) = rotación`): si entre la lectura y la escritura pasó a tener (o
  dejó de tener) el 2FA, 400 `MFA_CODE_INVALID` y no se activa nada.
- El paso 1 (`beginEnrollment`) escribe el secreto pendiente con la misma condición: sin 2FA, sólo
  si la cuenta sigue sin 2FA (si no, 409 `MFA_ALREADY_ENABLED`); al cambiar de teléfono, sólo si lo
  sigue teniendo (si no, 409 `MFA_NOT_ENABLED`). Sin eso, una sesión robada pedía el paso 1 (que sin
  2FA no pide nada) mientras la persona confirmaba el suyo: leía la cuenta sin 2FA, escribía después
  del commit de la persona y dejaba su propio secreto pendiente sobre una cuenta CON 2FA, que el
  paso 2 activaba como un cambio de teléfono, sin la contraseña ni un código de la app de la
  persona. Lo reproduce `mfa.integration.test.ts` con la fila tomada por la confirmación.
- **Aviso**: después del commit, `SecurityNoticeService.notify('mfa_enabled', { userId, tenantId:
null, at })` con el `mfa_enabled_at` que devolvió el `UPDATE`. Sale por el correo de su membership
  activa más antigua (`mail-node.ts`, que ahora trae también el país del nodo), sin nombrar ningún
  nodo: "Activaste la verificación en dos pasos en tu cuenta de PlaneTour el 13 de octubre de 2026 a
  las 10:42 (GMT-5).", que desde ahora le pediremos el código, que cerramos las sesiones de otros
  equipos y "Si no fuiste tú, alguien conoce tu contraseña: elige una nueva desde «¿Olvidaste tu
  contraseña?»… y pídele a tu administrador que restablezca tu verificación en dos pasos.". La hora
  va en la zona del país de ese nodo (`noticeTime`, `security-notices.ts`; Bogotá si no se conoce) y
  siempre con su desfase. Auditoría: el `auth.mfa.enabled` de siempre (`rotation: false`).
- **También avisan** (agregado en la revisión): cambiar de teléfono (`mfa_changed`, "Cambiaste tu
  app de autenticación", con la hora, que la app anterior, los códigos de recuperación anteriores y
  los equipos de confianza ya no sirven, y qué hacer si no fue la persona) y desactivar el propio
  2FA (`mfa_disabled`, "Desactivaste la verificación en dos pasos": que ahora basta la contraseña y
  cómo volver a activarlo). Piden la contraseña y un código, pero quien tiene las dos cosas deja a
  la persona afuera de su cuenta o se la deja con la contraseña sola: que se entere.
- **Lo que no cambia**: cambiar de teléfono (ya tiene 2FA) sigue pidiendo la contraseña y un código
  de la app actual en el paso 1, y no la vuelve a pedir al confirmar (sí avisa: `mfa_changed`). El
  login y quien ya tiene el 2FA activo, igual. El paso 1 (`POST /auth/mfa/enroll`) sigue sin pedir
  nada la primera vez (sólo deja un secreto pendiente que no abre nada), pero ya no escribe si la
  cuenta cambió desde la lectura (ver arriba). El enrolamiento obligatorio de los roles que lo
  exigen no se afloja: también pide la contraseña.
- **Panel**: en el paso 3 de la activación (Seguridad y la pantalla de 2FA obligatoria), "Tu
  contraseña" va antes del código, con `autocomplete="current-password"` y la ayuda "La misma con la
  que ingresas. Así confirmamos que eres tú quien activa la verificación." asociada al campo. El
  sexto dígito sigue enviando solo, pero sólo con la contraseña escrita. Una contraseña mala marca
  ese campo (`aria-invalid`, el error con `role="alert"` y asociado), le lleva el foco con el texto
  seleccionado y no borra el código, que no se llegó a usar. Al cambiar de teléfono el paso 3 no la
  pide (`MfaSetupStep` con `requirePassword` sólo en la primera activación).
- El historial de la persona muestra `auth.mfa.reauth_failed` como "Verificación fallida dentro de
  su sesión", con qué intentaba ("Contraseña incorrecta al activar el 2FA", "Al reconfirmar el
  2FA"…) y si bloqueó la cuenta.
- **Despliegue**: API y panel juntos (`docker compose up -d` los cambia a la vez). En los segundos
  con el API nuevo y el panel viejo, la primera activación responde 400 `MFA_PASSWORD_REQUIRED` y el
  panel viejo lo muestra como código inválido (todo 400 sin un motivo que conozca lo es en ese
  formulario); quien ya tiene el 2FA no nota nada. El panel nuevo pide la contraseña antes de llamar
  al API, así que `MFA_PASSWORD_REQUIRED` sólo le llega de un formulario sin el campo (una pestaña
  de antes del despliegue, o una cuenta que perdió el 2FA a mitad de un cambio de teléfono): lo
  muestra en el código y pide recargar la página ("Para activar la verificación en dos pasos ahora
  también te pedimos tu contraseña. Recarga la página e inténtalo de nuevo."). Antes marcaba el
  campo de la contraseña aunque no estuviera, y el error no se veía.
- **Tests**: `mfa.service.test.ts` (sin contraseña, 400 sin contar; mala, cuenta y la quinta
  bloquea sin probar el código; sin contraseña guardada igual corre un bcrypt; código con otra forma
  antes que la contraseña; buena, limpia el contador, audita y avisa con la hora; la cuenta cambió
  en el medio, sin aviso; cambiar de teléfono no la pide y avisa `mfa_changed`),
  `mfa.integration.test.ts` (Postgres, como `app_user`: la sesión robada sin la contraseña no activa
  nada ni queda reconfirmada y la de la persona sigue abierta; la mala suma al mismo bloqueo del
  login; la buena activa y el aviso sale por el correo de su nodo con la hora; después de
  `admin_reset_user_mfa` también la pide; cambiar de teléfono confirma sin ella y avisa; desactivar
  avisa; el paso 1 que pierde la carrera con la confirmación de la persona no deja su secreto),
  `security-notices.test.ts`, `security-notice.service.test.ts`, `dto.test.ts`; en el panel
  `actions.test.ts` (también: sin el campo, pide recargar en el código), `security-errors.test.ts`,
  `security.render.test.ts` (campo, orden, ayuda, error asociado, en tú) y `audit-format.test.ts`.
  Los helpers que enrolan en los tests de integración reintentan si el paso TOTP cambia mientras se
  prueba la contraseña: el bcrypt va antes que el código y, con el paso anterior, ~1 de cada 100
  enrolamientos caía fuera de la ventana.

## Quitar a una persona de un nodo (USR-11)

Founder D2 = A. Para que alguien dejara de trabajar en un nodo sólo había _Suspender_, y los
suspendidos se apilaban en Equipo para siempre. Ahora _Quitar de este nodo_ termina la membership
como baja blanda: la persona sale de Equipo y pierde el acceso a ese nodo en el acto, pero la fila
queda, así que sus reservas, sus movimientos de cartera y su rastro en la auditoría siguen apuntando
a ella. Para volver, sólo una invitación nueva.

### Base

- `db/migrations/0067_membership_removed.sql`: el CHECK de `memberships.status` suma `'removed'` (el de
  0001 no tenía nombre: se busca en `pg_constraint` y se reemplaza por `memberships_status_check`);
  columnas `removed_at` y `removed_by` (FK a `users`, `ON DELETE SET NULL`), atadas al estado por
  `memberships_removed_consistent` (`status = 'removed'` si y sólo si hay `removed_at`).
- Por qué alcanza con un estado más: todo lo que da acceso o potestad mira `status = 'active'` (las
  RLS y sus funciones, `revoke_user_sessions_for_tenant`, `invitation_backing`, las funciones de
  0063-0065, `SessionService.validate`, `NetworkService`). Se revisaron todos los predicados de la
  base y de la API: ninguno usaba `<> 'suspended'`, que habría dejado pasar a un quitado.
- Lo que miraba memberships sin filtrar el estado ahora descarta las quitadas:
  `user_admin_overview` (el equipo del subárbol) y `admin_user_security` (sólo le responde a quien
  administra un nodo donde la persona sigue estando).

### API

- **`POST /admin/memberships/remove` `{ userId, tenantId }`** (Zod estricto, ids en minúsculas):
  responde `{ id, status: 'removed', revokedSessions, revokedInvitations }`. Las reglas de suspender:
  nunca uno mismo (403); administrar el nodo (403 "No administras este nodo.") y superar su rol en él
  (`ROLE_NOT_GRANTABLE`), o ser superadmin; nunca el último admin activo del nodo (403 "…asigna otro
  antes de quitarlo."; un admin suspendido no cuenta entre los activos, así que quitarlo no pasa por
  esta guarda). Ya quitada: **409 `MEMBERSHIP_REMOVED`** ("Esta persona ya no forma parte de este
  nodo: para que vuelva, invítala de nuevo.").
- **Un rol de plataforma no se quita**: **403 `PLATFORM_ROLE_NOT_REMOVABLE`** ("Un rol de plataforma
  no se quita de un nodo: ninguna invitación lo devuelve. Si hace falta, suspende su acceso."). La
  vuelta de una baja es una invitación, y ninguna concede `superadmin` (D7 B, 0025): quitarle la
  membership de la plataforma a otro superadmin lo dejaba afuera para siempre, salvo una operación
  manual en la base. Suspenderla sí se deshace. El panel no ofrece el ítem a esos roles.
- **Las reglas valen con el nodo en fila**: las lecturas de arriba son sin tomar nada, así que dos
  admins de arriba que quitaban a la vez a los dos últimos admins de un nodo pasaban los dos la
  guarda y el nodo quedaba sin ninguno; y una membership ascendida a admin entre la lectura y el
  cambio se quitaba sin el rango, la guarda ni el 2FA de su rol nuevo. Ahora la transacción toma
  primero `pg_advisory_xact_lock(hashtextextended('node-admins:' || nodo, 0))` (la misma clave para
  quitar, suspender y cambiar el rol en ese nodo), después la fila, y con la fila tomada vuelve a
  mirar el rango, el rol de plataforma, el último admin activo (contado dentro de la transacción) y
  el 2FA. La lectura de afuera sigue: responde antes, sin pedir el código a quien igual no podía.
  Suspender y degradar a un admin pasan por el mismo candado y el mismo conteo (degradar dice
  "…asigna otro antes de cambiarle el rol.").
- **2FA reciente (D1)**: quitar a alguien es el trabajo de todos los días y no lo pide, **salvo que su
  rol en ese nodo sea de admin** (`ADMIN_ROLES`): sacarle el gobierno del nodo a un admin pesa como
  enviarle el enlace a uno, y con una sesión robada alcanzaría para ir sacando a los demás admins.
  `assertRecentMfa()` va después de autorizar y de la guarda del último admin.
- En una transacción, con la fila tomada (`FOR NO KEY UPDATE`): `status = 'removed'`, `removed_at`,
  `removed_by`; `revokeForTenant(…, 'membership_removed')` (sus sesiones del subárbol del nodo que no
  respalda otra membership activa suya, como al suspender: si también trabaja en otra agencia, ahí
  sigue); `revokeOrphaned` con la causa `membership_removed` (lo que emitió y ya no podría emitir);
  y el evento **`MembershipRemoved`** (`targetUserId`, `role`, `previousStatus`, `revokedSessions`,
  `revokedInvitations`). Si algo falla, no queda nada. Después del commit, el aviso
  `membership_removed` a su correo (USR-12).
- `GET /admin/memberships/impact?status=removed`: cuántas invitaciones revocaría, simulado en una
  transacción que se deshace, como para suspender.
- Una membership quitada no se reactiva ni cambia de rol: `PATCH /admin/memberships/status` y
  `PATCH /admin/memberships/role` responden 409 `MEMBERSHIP_REMOVED` (también si otro admin la quitó
  entre la lectura y el cambio: se mira la fila tomada).
- **Volver**: invitar ya no cuenta como miembro a quien fue quitado (sí a un activo o suspendido: 409
  "Ese correo ya es miembro de este nodo."). Al aceptar, el alta de la membership es un
  `ON CONFLICT (tenant_id, user_id) DO UPDATE` sólo sobre una fila `removed`: reactiva la MISMA fila
  con el rol de la invitación y limpia `removed_at` y `removed_by`; `UserInvitationAccepted` suma
  `rejoined: true`. Una invitación de alguien que ya tiene una membership vigente en el nodo (una de
  antes de la regla de invitar) es 409 `ALREADY_MEMBER` y queda pendiente (antes era un 500 por la
  UNIQUE).
- Dónde ya no aparece una membership quitada: Equipo (`listTenantUsers`), el selector de agencia
  (`GET /me/memberships`, ni deshabilitada), la ficha desde ese nodo (404 `MEMBER_NOT_FOUND` si no
  le queda otra membership en su subárbol), el soporte sobre ese nodo (404), los nodos de cada
  persona y los filtros por rol o nodo del directorio de la plataforma, y el conteo de usuarios de
  Gestión de Agencias. Sí sigue en la historia: la Actividad de la red y el historial de la persona
  la nombran, y sus reservas y movimientos siguen a su nombre.

### Panel

- Equipo → acciones → **Membresía**: después de _Suspender_ / _Reactivar_, en rojo y último,
  **Quitar de este nodo** (ícono `UserX`), para miembros activos o suspendidos que no tengan un rol
  de plataforma; también en el menú de su ficha. Primero pregunta el impacto; después la confirmación destructiva **"Quitar a {nombre}
  de {nodo}"**: "Deja de pertenecer a este nodo y se cierran sus sesiones en él.{ Se revocarán N
  invitaciones que envió.} Su historial y sus reservas quedan como están. Si después quieres que
  vuelva, tienes que invitarlo de nuevo." con **Quitar del nodo**. Al salir bien: "Quitamos a
  {nombre} de {nodo}." (con las invitaciones revocadas, si las hubo), la lista y los puestos se
  recargan, la ficha (si estaba abierta) se cierra y el foco va al título _Miembros_: la fila desde
  la que se actuó ya no está. Un error va en su fila (o en la ficha).
- Si es admin y pasaron más de 10 minutos del 2FA, `removeMembership` (`withStepUp`) abre "Confirma
  que eres tú" y repite una vez; cerrar el diálogo no hace nada.
- BFF `POST /api/admin/memberships/remove`: mismo origen, cuerpo reconstruido
  (`membershipRemovePlan`: sólo el miembro y el nodo), estado y motivo del API en el error.
  `membershipImpactTarget` admite `status=removed`. La Actividad de la red ya traía la frase "Quitado
  del nodo"; la revocación de una invitación dice "al quitar del nodo a quien la envió".

### Tests

- `apps/api/src/tenants/admin.controller.test.ts`: el orden (candado del nodo, fila, cambio, sesiones,
  evento, commit, aviso), quién y cuándo, la causa de las invitaciones y el evento; uno mismo, fuera
  de la red, sin rango, el último admin, ya quitada (también en una carrera), el 2FA sólo para un
  admin y después de autorizar, sin aviso si la transacción falla; un rol de plataforma no se quita;
  con la fila tomada, el último admin contado adentro y el rango y el 2FA de un rol ascendido en el
  medio (también al suspender y degradar); reactivar, suspender, cambiar el rol o preguntar el
  impacto de una quitada: 409; el borde Zod.
- `apps/api/src/tenants/membership-removal.integration.test.ts` (Postgres, todo como `app_user`,
  también el canje): sale de Equipo, de `user_admin_overview` y de su selector; sus sesiones del nodo
  se cierran y las de otra agencia siguen; el evento en la transacción (si no entra, no queda nada);
  las invitaciones que ya no respalda; 409 al reactivarla; la invitación nueva reactiva la misma fila
  con el rol nuevo; `ALREADY_MEMBER` deja la invitación pendiente; el CHECK; las reglas; la ficha,
  el soporte y su seguridad dejan de abrirse desde el nodo, y la ficha desde arriba y el conteo de
  Gestión de Agencias ya no la cuentan en ese nodo; dos admins de arriba que quitan a la vez a los dos
  últimos admins del nodo (gana uno); un ascenso entre la lectura y la fila; y un superadmin que
  intenta quitar a otro.
- `member-detail.service.test.ts` y `platform-users.service.test.ts`: las consultas descartan las
  quitadas.
- Panel: `tenant-admin-team.test.ts` (textos, en tú), `tenant-admin-proxy.test.ts`,
  `tenant-admin-proxy-route.test.ts`, `tenant-admin-seats-client.test.ts` (el reintento con el 2FA),
  `audit-format.test.ts` y `team.render.test.ts` (dónde va el ítem y a quién se le ofrece).

### Despliegue

- La migración va antes que la API (deploy.yml migra primero): la API vieja no conoce `'removed'`,
  pero tampoco lo escribe, y `user_admin_overview` conserva sus columnas.
- API y panel juntos: el panel viejo no ofrece quitar; si el panel sale antes, la ruta del BFF
  responde el 404 del API viejo y la fila muestra el error.

## La página de la invitación (USR-17)

`/invitacion` era un formulario ciego: no decía a qué nodo ni con qué rol invitaban, y a quien ya
tenía cuenta le pedía una "contraseña nueva" que el canje ignoraba en silencio, sumándole la
membership sin que esa cuenta se autenticara (alcanzaba con el enlace). Ahora la página lee la
invitación primero y dice **"Te invitaron a {nodo} como {rol}"**, quién la mandó y cuándo vence. Si el
correo no tiene cuenta, la persona elige su nombre y su contraseña como siempre; si ya la tiene,
**ingresa con la suya** (contraseña y 2FA si lo tiene) y acepta con un botón, sin elegir otra.

### Base

- `db/migrations/0068_invitation_preview.sql`: `preview_pending_invitation(p_token_hash)`, SECURITY
  DEFINER y STABLE (sólo lee: mirarla no la gasta), como `find_pending_invitation` y
  `claim_pending_invitation`. Resuelve como máximo una invitación vigente (ni aceptada, ni revocada,
  ni vencida) por hash de token: el nombre del nodo, el rol, el nombre de quien invitó (sin espacios;
  `null` si no tiene), el vencimiento, el id de la invitación y el de la cuenta dueña del correo
  invitado (CITEXT: sin distinguir mayúsculas). Los ids son para la API; no salen de ella.
  `REVOKE ALL FROM PUBLIC`, `EXECUTE` a `app_user`.

### API

- **`POST /invitations/preview` `{ token }`** (público, throttle de 20 por minuto por IP, Zod
  estricto; el token va en el cuerpo para que no quede en los logs de acceso) →
  `200 { valid: true, tenantName, role, inviterName, expiresAt, existingAccount, viewer }` o
  `200 { valid: false }`. Neutral: un token que no existe, ya se usó, se revocó o venció, uno con un
  rol que no se asigna y una invitación que su invitador ya no respalda o cuyo nodo no opera (la
  misma revalidación del canje, `invitation_backing`) dan exactamente `{ valid: false }`. Nunca salen
  ids, el correo invitado, el de quien invitó ni nadie más del nodo. `existingAccount` lo sabe igual
  quien controla ese buzón, que es lo que prueba el token. `viewer` sale de la sesión con que llega el
  pedido, si llega con una: `anonymous`, `invitee` (la cuenta dueña del correo) u `other`.
- **`POST /invitations/accept`** queda para crear la cuenta (nombre y contraseña, como antes). Si el
  correo ya tiene cuenta: **409 `INVITATION_SIGN_IN_REQUIRED`** ("Ya tienes una cuenta con este
  correo: ingresa con ella para aceptar la invitación."), sin hashear la contraseña y con la
  invitación pendiente. Sale sólo con un token vigente, así que no es un oráculo de cuentas más allá
  de lo que la vista previa ya le dice al dueño del buzón. Si otra aceptación crea la misma cuenta en
  el medio, la UNIQUE del correo sale como el mismo 409 (antes, un 500).
- **`POST /invitations/join` `{ token }`** (con sesión, sin rol; throttle de 10 por minuto): acepta
  con la cuenta de la sesión, nunca con una que venga en el cuerpo. En una transacción: canjea con
  `claim_pending_invitation`, y **antes que nada** comprueba que la cuenta dueña del correo invitado
  (CITEXT) sea la de la sesión; si no, **403 `INVITATION_ACCOUNT_MISMATCH`** ("Esta invitación es
  para otra cuenta: ingresa con el correo al que te llegó."), la invitación queda pendiente para su
  dueño y queda **`UserInvitationAccountMismatch`** (actor = la sesión, payload vacío: ni correos ni
  ids). Después, la misma revalidación del invitador que el otro canje (400
  `INVITATION_NO_LONGER_VALID`, con `UserInvitationRejected` y ahora con el actor) y la misma
  membership: nueva, o la quitada (USR-11) reactivada en la misma fila; vigente, 409
  `ALREADY_MEMBER`. Token vencido, revocado o usado: 400. `UserInvitationAccepted` suma
  `existingAccount: true`. El 2FA obligatorio del rol de la cuenta vale como en el resto de la API
  (`MfaEnforcementGuard`): sin 2FA activo, 403 `MFA_ENROLLMENT_REQUIRED`. Un rol invitado que exige
  2FA (p. ej. `tenant_admin`) no se le niega a quien todavía no lo tiene: como con una cuenta nueva,
  se suma y desde el pedido siguiente el API le exige enrolarse (la sesión mira el rol de todas sus
  memberships activas), y el panel le muestra el enrolamiento antes que cualquier pantalla.
- El correo de la invitación dice "Acepta la invitación: si ya tienes cuenta, ingresas con tu
  contraseña de siempre; si no, eliges una."
- `InvitationsService.accept` y `acceptSignedIn` comparten `redeem` (canje, revalidación, rastro de
  los rechazos fuera de la transacción deshecha); el servicio de la vista previa es
  `invitation-preview.service.ts`, con su controller aparte.

### Panel

- `/invitacion` es un Server Component: valida la forma del token (`invitationTokenFrom`), pide la
  vista previa con la sesión si la hay y elige la pantalla (`invitation-view.ts`, sin I/O):
  - **inválida** (o enlace sin token): "Esta invitación ya no es válida. Pídele a quien te invitó que
    te la reenvíe.", sin formulario. Sin servidor, con 429 o con cualquier error que no sea un 400
    (un 404 del API de antes, mientras se despliega), un aviso con **Reintentar** (no dice que la
    invitación no vale);
  - **sin cuenta**: título "Te invitaron a {nodo} como {rol}", "Te invitó {nombre}. La invitación
    vence en N días." y el formulario de siempre (nombre, contraseña, repetirla) con **Crear cuenta y
    aceptar**. Si el navegador tiene abierta la sesión de otra cuenta, lo avisa, y al terminar ofrece
    **Salir e ingresar con tu cuenta nueva** en vez de un login que devolvería a ese panel. Si el API
    responde `INVITATION_SIGN_IN_REQUIRED` (la cuenta se creó mientras tanto), el botón pasa a ser
    **Ingresar con mi cuenta**;
  - **con cuenta y sin sesión**: "Ya tienes una cuenta con este correo. Ingresa con tu contraseña de
    siempre para aceptar la invitación." y **Ingresar para aceptar**, que va a
    `/login?next=/invitacion?token=…`. `next` pasa por `safeNextPath` como siempre (sólo rutas del
    panel): no hay redirect abierto. El login muestra "Ingresa con la cuenta del correo al que te
    llegó la invitación…" y, al entrar (con el 2FA si lo tiene), vuelve a la invitación. Si el
    navegador trae una cookie de sesión que el API ya no acepta, el enlace pasa por
    `/api/session/end?motivo=expirada&next=…`, que la borra: si no, el middleware devolvía del login a
    la invitación;
  - **con la sesión de la cuenta invitada**: "Acepta para sumar {nodo} a tus agencias." y un solo
    botón, **Aceptar invitación** (`POST /invitations/join`). Al aceptar: "Ya formas parte de {nodo}"
    con **Ir al panel** (se elige en el selector de agencia). Los rechazos se leen por estado y motivo:
    otra cuenta → **Salir e ingresar con la cuenta invitada**; sesión que ya no sirve (401) →
    **Ingresar de nuevo** por `/api/session/end` con su motivo y la vuelta; ya es miembro, sin 2FA,
    vencida o revocada, cada una con su mensaje;
  - **con la sesión de otra cuenta**: "Esta invitación es para otra cuenta. Sal de esta sesión e
    ingresa con el correo al que te llegó." y **Salir e ingresar con la cuenta invitada**
    (`switchAccountAction`: revoca la sesión en el API, borra las cookies y va al login que vuelve a
    la invitación).
- Nadie con cuenta ve un campo de contraseña en `/invitacion`.
- La Actividad de la red y el historial nombran el intento de otra cuenta: "Invitación rechazada
  (otra cuenta intentó aceptarla)".

### Tests

- `apps/api/src/tenants/invitation-preview.service.test.ts`: la forma de la respuesta sin ids, que se
  busca por el hash del token y sólo lee, `viewer` en los tres casos, la respuesta neutral para cada
  motivo (sin fila, rol no asignable, sin respaldo, invitador inexistente, suspendido o sin rango,
  nodo que no opera); el controller público con su throttle, el borde Zod; `join` con sesión, 401 sin
  ella y la cuenta siempre de la sesión.
- `apps/api/src/tenants/invitations.service.test.ts`: `accept` con cuenta existente (409 sin hashear
  ni escribir), la carrera de la UNIQUE del correo; `acceptSignedIn` con la cuenta dueña, con otra
  (403 antes de revalidar al invitador, sin escribir, auditado sin correos) y sin cuenta.
- `apps/api/src/tenants/invitation-preview.integration.test.ts` (Postgres, todo como `app_user`): la
  vista previa (nodo, rol, nombre de quien invitó, vencimiento, sin ids ni correos, no gasta la
  invitación), con cuenta y la sesión invitada u otra, sin nombre de invitador, neutral para
  inexistente, vencida, revocada, usada y sin respaldo; el formulario de cuenta nueva con una cuenta
  existente (409, pendiente, contraseña intacta); aceptar con la sesión (membership, evento, token
  gastado); correo con otras mayúsculas; otra cuenta (403, pendiente, auditado, y la dueña acepta
  después); vencida, revocada o usada (400, sin membership); invitador sin respaldo (400 con rastro
  y actor); una membership quitada que vuelve en la misma fila; y las carreras de verdad: dos
  invitaciones al mismo correo aceptadas a la vez (una cuenta con la contraseña de quien ganó, la otra
  409 y pendiente, que después se acepta con la sesión) y el mismo enlace aceptado dos veces a la vez
  con la sesión (los dos esperan en la fila de la invitación: uno acepta, el otro 400).
- `onboarding-invitation.integration.test.ts` y `membership-removal.integration.test.ts`: quien ya
  tenía cuenta acepta con `acceptSignedIn`; por el formulario de cuenta nueva, 409.
- Web: `invitation-view.test.ts` (token, vista previa, qué pantalla, vuelta por el login que pasa
  `safeNextPath`, la cookie muerta, los rechazos de `join`, textos en tú),
  `invitation-screen.render.test.ts` (cada pantalla, qué viaja en cada formulario y que nadie con
  cuenta ve una contraseña), `actions.test.ts`, `errors.test.ts` y `audit-format.test.ts`.

### Despliegue

- La migración va antes que la API (deploy.yml migra primero). La API vieja no usa la función.
- API y panel juntos: con el panel viejo y la API nueva, quien ya tiene cuenta y llena el formulario
  ve el mensaje del 409 ("Ya tienes una cuenta…"); con el panel nuevo y la API vieja, la vista previa
  responde 404 y la página muestra "No pudimos conectar con el servidor" con **Reintentar**: sólo un
  400 dice que la invitación no vale, para no hacer pedir un reenvío (que deja sin efecto el enlace)
  por un despliegue a medias.
- Si alguien con cuenta olvidó su contraseña, el login ofrece restablecerla; después tiene que volver
  a abrir el enlace de la invitación (el restablecimiento no conserva la vuelta).

## Editar tu nombre (USR-18)

Hasta ahora nadie podía corregir su nombre: sólo existía `GET /me`, y el nombre quedaba como se
escribió al aceptar la invitación. Ahora cada persona lo cambia desde **Mi cuenta → Perfil**, sólo el
suyo. El correo se muestra y no se cambia: eso espera un flujo que verifique el buzón nuevo.

### Base

- `db/migrations/0069_users_name_self_only.sql`: `users` no tiene RLS (identidad global: el login la
  lee por correo sin contexto) y `app_user` puede actualizar cualquier fila, así que la regla va en un
  trigger, como 0025 y 0055: **`users_name_self_only`**, `BEFORE UPDATE OF name`, sólo cuando el valor
  cambia. Si quien ejecuta no se salta la RLS (`app_user`), la fila tiene que ser la de
  `app.current_user_id`; sin contexto, con uno que no es un UUID o con el de otra cuenta, **42501
  `users_name_self_only`**. Un UPDATE de varias filas que incluye la propia falla entero. El resto de
  las columnas de `users` (bloqueo, 2FA, contraseña, suspensión) las siguen tocando el login y el
  soporte de un admin sobre otra cuenta, como antes. Migraciones y la consola del operador (roles que
  se saltan la RLS) no se frenan. `app_user` no puede apagar el trigger (no es dueño de la tabla ni
  puede cambiar `session_replication_role`).
- La base no valida la forma del nombre: las cuentas ya creadas pueden tener nombres que hoy no
  pasarían, y un CHECK las dejaría sin poder tocarse. Esa regla es del borde del API.

### API

- **`PATCH /me` `{ name }`** (con sesión, cualquier rol, con el 2FA obligatorio de siempre; tope de 10
  por minuto por IP) → `200 { name }`, el nombre como quedó guardado. La cuenta es siempre la de la
  sesión (`CurrentUser`): la ruta no lleva id y el cuerpo es estricto, así que un `email` o un
  `userId` es **400** "Desde tu perfil sólo puedes cambiar tu nombre.", no algo que se ignora.
- El nombre pasa por **`PersonNameSchema`** (`packages/validation/src/person-name.ts`; desde la revisión
  de USR-18 también lo usa el canje de la invitación, `AcceptInvitationSchema`): NFC; cualquier espacio de Unicode, tabulador o
  salto de línea seguidos pasan a un solo espacio; sin espacios en los bordes; de 1 a 120 (el tope del
  canje de la invitación, en unidades UTF-16, contado después de normalizar); **sin caracteres de
  control ni de formato** (los de dirección como U+202E, los de ancho cero, el guion blando), ni
  sustitutos sueltos, uso privado o sin asignar (todo `\p{C}`), ni los rellenos que se pintan vacíos
  (Hangul U+115F, U+1160, U+3164, U+FFA0 y el braille en blanco U+2800); y con al menos una letra. Lo
  que no pasa se rechaza, no se limpia en silencio. Los mensajes van en tú ("Escribe tu nombre.", "Tu
  nombre tiene caracteres invisibles o de control. Escríbelo de nuevo a mano.").
- `ProfileService.updateName` corre con la cuenta en el contexto (`withRequestContext`, lo exige el
  trigger), toma la fila `FOR NO KEY UPDATE` (como el resto de las escrituras sobre `users`: `FOR
UPDATE` frenaba las inserciones que apuntan a la cuenta) y, si el nombre cambia, lo escribe y deja **`UserProfileUpdated`**
  en la misma transacción (si el evento no entra, el cambio tampoco): actor y agregado = la cuenta,
  payload `{ changed: ['name'], before: { name }, after: { name } }`, la forma de `tenant.updated`. Es
  el nombre de la propia persona, el mismo que su equipo ya ve, y deja ver en el historial que alguien
  se puso el nombre de otro. Con el mismo nombre no escribe ni audita.

### Panel

- **Mi cuenta → Perfil** (`/configuracion/perfil`), antes de Seguridad en el menú y en ⌘K, para
  cualquier rol. Una tarjeta "Datos de tu cuenta" con **Tu nombre** (campo con etiqueta, ayuda "Es el
  que ven tu equipo y las personas a las que invitas.", obligatorio) y **Tu correo** sólo para leer,
  con "Para cambiar tu correo, pídeselo al equipo de soporte." (sin la marca de la plataforma: el
  panel es white-label). Botón **Guardar**; al terminar, el toast "Guardamos tu nombre.".
- El panel valida con las mismas reglas antes de llamar (`lib/person-name.ts`, espejo del esquema:
  su test lee las declaraciones de `packages/validation` como texto y falla si se apartan); el error sale bajo el campo (`role="alert"`,
  `aria-invalid`, `aria-describedby`) y el foco vuelve al campo. Se envía desde `onSubmit` y no con
  `<form action>`, para que un error no borre lo escrito (como Seguridad). Un 400 del API muestra el
  mensaje del campo si es uno conocido; 429, "Hiciste muchos cambios seguidos…"; sin sesión, al login
  con el motivo y la vuelta al perfil.
- Dónde se ve el nombre y por qué queda al día: la barra de arriba ahora muestra **el nombre** (con el
  correo debajo en el menú, que suma **Tu perfil**; sin nombre, el correo como antes) y lo lee de
  `GET /me` en cada render del layout; la acción revalida desde el layout, así que cambia al guardar.
  Equipo, la ficha, el directorio de la plataforma y la vista previa de la invitación ("Te invitó…")
  piden el nombre al API cada vez, y el saludo de los avisos por correo lo lee al enviarse (sin
  controles en el texto y escapado en el HTML, USR-12). El correo de la invitación no lleva el nombre
  de quien invita, y el remitente de los correos es el de la plataforma o el nodo. El historial y la
  Actividad de la red nombran a las personas por correo, no por nombre; el cambio sale como **"Cambió
  su nombre · de «Ana Ruiz» a «Ana María Ruiz»"** (filtro Usuarios). El nombre se pinta siempre como
  texto.

### Tests

- `apps/api/src/me/me.dto.test.ts`: el esquema (recorte, espacios, NFC, alfabetos, tope de 120
  después de normalizar, controles, los de dirección, invisibles y rellenos, sustituto suelto, al
  menos una letra) y el cuerpo estricto.
- `me.controller.test.ts`: `PATCH /me` sin id, con sesión, sin exención del 2FA ni roles, con su
  tope; la cuenta de la sesión; 401 sin ella; el borde Zod (normaliza, 400 con `email` o `userId`,
  400 en `name` con un control de dirección).
- `profile.service.test.ts`: contexto de la sesión, `FOR NO KEY UPDATE`, el UPDATE por id, el evento con el
  antes y el después (también desde `null`), nada con el mismo nombre, 401 sin cuenta, y que un evento
  que no entra hace fallar el cambio.
- `profile.integration.test.ts` (Postgres, todo como `app_user`): cambia sólo la propia cuenta y deja
  el evento; el mismo nombre no escribe; el trigger rechaza el nombre de otra cuenta, sin contexto,
  con uno que no es un UUID y en un UPDATE de varias filas; el propio sí; las demás columnas de otra
  cuenta sí; `app_user` no puede apagar el trigger; el superusuario cambia cualquiera.
- `apps/api/src/tenants/dto.test.ts`: el canje de la invitación normaliza y rechaza el nombre como el
  perfil, y el 400 de `ZodValidationPipe` nombra `name: <mensaje>` (lo que lee el panel).
- Web: `lib/person-name.test.ts` (los mismos casos que el API y la paridad, declaración por
  declaración, con `packages/validation`), `invitacion/actions.test.ts` y `invitacion/errors.test.ts`
  (el nombre del canje con las mismas reglas y su 400 con el mensaje del campo), `perfil/actions.test.ts` (qué viaja,
  la revalidación del layout, que un nombre inválido no llega al API, cada error, el 401 al login),
  `perfil/profile.render.test.ts` (etiqueta, ayuda y campo enlazados, el correo para leer, un botón,
  el nombre como texto, sin `GET /me`, en tú), `components/layout/account-display.test.ts`,
  `lib/command-menu.test.ts` (Perfil antes que Seguridad) y `lib/audit-format.test.ts`.

### Despliegue

- La migración va antes que la API (deploy.yml migra primero). La API vieja no cambia nombres, así
  que el trigger no la afecta.
- Con el panel nuevo y la API vieja, `PATCH /me` responde 404 y el formulario dice "No pudimos guardar
  tu nombre. Inténtalo de nuevo.".
- El canje de la invitación (`POST /invitations/accept`) valida el nombre con `PersonNameSchema` y lo
  guarda normalizado. El panel nuevo lo valida antes y, si el API lo rechaza, muestra el mensaje del
  nombre (lo lee del resumen del 400, `app/invitacion/errors.ts`). Con el panel viejo y la API nueva,
  un nombre que la API rechaza (controles, invisibles, sin letras) sale como "enlace usado o vencido":
  raro y sólo mientras dura el despliegue. Las cuentas creadas antes pueden tener nombres que hoy no
  pasarían; se ven como antes y su dueño los corrige desde Perfil.
