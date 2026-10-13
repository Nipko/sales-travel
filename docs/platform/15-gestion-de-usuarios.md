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

| Acción                                                               | Dónde                                     | Quién puede                                                                     | Estado                                                      |
| -------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Invitar a alguien a un nodo (una pendiente por correo y nodo)        | Equipo → Invitar                          | Admin del nodo, con un rol menor al suyo; superadmin                            | **Hecho (doc 14, USR-8)**                                   |
| Reenviar una invitación (token nuevo, 7 días)                        | Equipo → Invitaciones / Invitar (409)     | Admin del nodo que supere el rol invitado; superadmin                           | **Hecho (doc 14, USR-8)**: avisa si el correo falla         |
| Revocar una invitación                                               | Equipo → Invitaciones                     | Admin del nodo que supere el rol invitado; superadmin                           | **Hecho (USR-8)**                                           |
| Cambiar el rol en un nodo                                            | Equipo → fila                             | Admin del nodo que supere el rol actual y el nuevo; superadmin. Nunca el propio | Hecho                                                       |
| Suspender / reactivar el acceso a un nodo                            | Equipo → acciones                         | Admin del nodo que supere su rol; superadmin. Nunca el propio                   | Hecho (PR #14)                                              |
| Cerrar todas sus sesiones                                            | Equipo → acciones → Seguridad             | Soporte a un miembro                                                            | Hecho                                                       |
| Restablecer su 2FA                                                   | Equipo → acciones → Seguridad             | Soporte a un miembro                                                            | Hecho                                                       |
| **Enviarle un enlace para restablecer la contraseña**                | Equipo → acciones → Acceso                | Soporte a un miembro. 409 si su cuenta o su acceso al nodo están suspendidos    | **Hecho (USR-2)**                                           |
| **Desbloquear la cuenta** (bloqueo por intentos fallidos)            | Equipo → acciones → Acceso (si bloqueada) | Soporte a un miembro                                                            | **Hecho (USR-2)**                                           |
| Liberar un puesto (cerrar una sesión que ocupa cupo)                 | Equipo → Puestos                          | Admin del nodo de esa sesión; superadmin. Nunca la propia                       | Hecho (PR #12)                                              |
| Fijar puestos e inactividad de un nodo                               | Gestión de Agencias                       | Superadmin                                                                      | Hecho (PR #12)                                              |
| **Forzar cambio de contraseña en el próximo ingreso**                | Equipo → acciones → Acceso                | Soporte a un miembro. Los mismos 409 que enviar el enlace                       | **Hecho (USR-3)**: el login responde 403 hasta que la elija |
| Suspender / reactivar la cuenta en toda la plataforma                | Plataforma → Usuarios → acciones          | Superadmin. Nunca la propia ni la del último superadmin activo                  | **Hecho (USR-4)**: la confirmación dice lo que corta        |
| Buscar a cualquier persona de la red (nombre, correo, filtros)       | Plataforma → Usuarios                     | Superadmin                                                                      | **Hecho (USR-4)**                                           |
| Ver la ficha de una persona y cerrar una sesión puntual              | Ficha del usuario                         | Admin de su subárbol (lo suyo); superadmin (todo)                               | Pendiente (USR-5, USR-7)                                    |
| Ver el historial de una persona y la actividad de la red             | Ficha / Mi Red → Actividad                | Admin de su subárbol; superadmin (también eventos sin nodo)                     | Pendiente (USR-6)                                           |
| Invitar o promover a un admin de consolidador                        | Equipo                                    | Superadmin                                                                      | Pendiente (USR-9)                                           |
| Filtrar el equipo (2FA pendiente, bloqueados, nunca ingresaron, rol) | Equipo                                    | Admin del nodo; superadmin                                                      | Pendiente (USR-10)                                          |
| Quitar a una persona de un nodo (baja blanda)                        | Equipo → acciones                         | —                                                                               | Pendiente (USR-11; founder D2 = A)                          |
| Avisarle por correo cada cambio de seguridad hecho por un admin      | Automático                                | —                                                                               | Pendiente (USR-12)                                          |
| Reconfirmar el 2FA antes de las acciones de alto impacto             | Automático                                | —                                                                               | Pendiente (USR-13; founder D1 = C)                          |
| Forzar cambio de contraseña en bloque a cuentas heredadas            | Plataforma                                | Superadmin                                                                      | Pendiente (USR-14; founder D3 = B)                          |
| Ver invitaciones pendientes y vencidas de toda la red                | Plataforma → Invitaciones                 | Superadmin                                                                      | Pendiente (USR-15)                                          |
| Exportar usuarios a CSV                                              | Plataforma → Usuarios / Equipo            | Superadmin (toda la red); admin del nodo (su equipo). Auditado                  | Pendiente (USR-16)                                          |
| Editar el propio nombre                                              | Mi cuenta → Perfil                        | Cada usuario, sobre sí mismo                                                    | Pendiente (USR-18)                                          |

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
  medio.
- Mientras la marca está, `SessionService.validate` no acepta ninguna sesión de la persona: un login
  que pasó la contraseña justo antes de forzarlo no deja una sesión viva.
- La marca la levantan el canje del enlace (el del admin o el de "Olvidé mi contraseña") y el cambio
  de contraseña, en el mismo `UPDATE` que fija la contraseña nueva.
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
  da el 401; forzado en medio del paso del código.
- `apps/api/src/auth/password-reset.service.test.ts`: `requireReset` (orden y transacción), el
  reenvío a lo sumo cada 10 minutos, `reset` y `change` levantan la marca, la plantilla nueva en tú y
  escapada.
- `apps/api/src/tenants/member-support.service.test.ts`: autorización reusada, 409, 429 sólo al
  volver a forzarlo, correo después del commit y su fallo auditado.
- `apps/api/src/auth/password-reset-required.integration.test.ts` (se salta sin `PGHOST`): forzar →
  login 403 → canjear el enlace → login con la nueva; reenvío a los 10 minutos; 2FA sin desafío;
  sesión emitida tarde que no vale; "Olvidé mi contraseña" levanta la marca; `user_admin_overview`
  como `app_user`.
- Web: `login-state.test.ts`, `login-steps.render.test.ts`, `tenant-admin-team.test.ts`,
  `tenant-admin-proxy.test.ts`, `tenant-admin-proxy-route.test.ts` y `team.render.test.ts`.

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
