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
| Quitar a una persona de un nodo (baja blanda)                                  | Equipo → acciones                         | —                                                                                         | Pendiente (USR-11; founder D2 = A)                                        |
| Avisarle por correo cada cambio de seguridad hecho por un admin                | Automático                                | —                                                                                         | Pendiente (USR-12)                                                        |
| Reconfirmar el 2FA antes de las acciones de alto impacto                       | Automático                                | —                                                                                         | Pendiente (USR-13; founder D1 = C)                                        |
| Forzar cambio de contraseña en bloque a cuentas heredadas                      | Plataforma                                | Superadmin                                                                                | Pendiente (USR-14; founder D3 = B)                                        |
| Ver invitaciones pendientes y vencidas de toda la red                          | Plataforma → Invitaciones                 | Superadmin                                                                                | Pendiente (USR-15)                                                        |
| Exportar usuarios a CSV                                                        | Plataforma → Usuarios / Equipo            | Superadmin (toda la red); admin del nodo (su equipo). Auditado                            | Pendiente (USR-16)                                                        |
| Editar el propio nombre                                                        | Mi cuenta → Perfil                        | Cada usuario, sobre sí mismo                                                              | Pendiente (USR-18)                                                        |

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
- Pendiente de USR-13 (D1 = C): reconfirmar el 2FA antes de suspender en toda la plataforma.

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
