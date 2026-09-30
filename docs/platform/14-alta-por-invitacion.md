# 14 — Alta de usuarios sólo por invitación

## Decisión del founder (2026-09-29)

**Sólo invitación.** Nadie fija la contraseña de otro, tampoco el superadmin: no hay onboarding
asistido con clave. Toda cuenta nueva y todo admin inicial de un nodo reciben el correo "Te invitaron
a …", eligen su contraseña y aceptar demuestra el control del buzón (vale como verificación de email).
Una cuenta existente sólo entra a otro nodo **aceptando** la invitación. Si el correo no llega, se
reenvía (enlace nuevo, 7 días más).

## Las dos brechas (auditoría 2026-09-29)

1. **`POST /admin/users`** — si el email ya existía en cualquier red, cualquier admin de agencia le
   creaba una membership en su nodo sin aceptación y la respuesta devolvía `id`, `name` y `status` de
   esa identidad ajena (enumeración + PII entre redes). Con `PATCH /admin/memberships/status`, que al
   suspender revocaba **todas** las sesiones del usuario en la plataforma, un admin de sub-agencia
   vinculaba al admin de otro consolidador (o al superadmin) y lo deslogueaba en bucle. Si el email
   no existía, el admin elegía la contraseña: sin cambio obligatorio ni verificación.
2. **`POST /admin/tenants` con `adminPassword`** — el `tenant_admin` inicial nacía con la clave que
   eligió quien creó el nodo, sin verificar el email ni avisarle.

La mitad de la brecha 1 que es la suspensión (revocar sólo las sesiones del nodo suspendido) va en su
propio cambio: `0056_membership_scoped_revocation`, `revoke_user_sessions_for_tenant`.

## Qué cambió

### API

- **`POST /admin/users` → 410 `USER_CREATION_RETIRED`**, sin leer el body ni la base: la respuesta es
  la misma exista o no el email. La ruta sigue para que un panel viejo reciba el motivo y no un 404.
  Se van `CreateUserSchema` y `PasswordService` del controller.
- **`CreateTenantSchema`**: `adminPassword` se rechaza con 400 y el motivo (un panel viejo no da por
  fijada una clave que nadie fijó; vacío sigue siendo "no enviado"). `adminName` se descarta: el nombre
  lo pone el invitado al aceptar.
- **`TenantsService.create` siempre invita** al admin inicial: nunca crea la cuenta ni la membership.
  `admin` en la respuesta es `{ email, role, status: 'invited', invitationId, expiresAt }` o
  `{ email, role, status: 'invite_failed' }`, igual tenga o no cuenta ese email. `TenantCreated`
  registra `admin: 'invited'`.
- **Reenviar**: `POST /invitations/:id/resend?tenantId=` rota el token (el anterior deja de valer) y
  lo deja vencer a los 7 días, también si ya había vencido. Exige administrar el nodo y superar en
  rango al rol invitado. Quien reenvía pasa a ser `invited_by` (el que la respalda al canjear); el
  anterior queda en el evento `UserInvitationResent`. 404 `INVITATION_NOT_PENDING` si se aceptó, se
  revocó o es de otro nodo.

### Panel (web-b2b)

- El botón **Usuarios** de cada fila de _Mi Red_ abre _Equipo_ (`/admin/usuarios?tenant=<id>`) en ese
  nodo. Se borró el modal propio de `/red`, el que tenía "Contraseña temporal"; un id fuera de la red
  se ignora y abre en la raíz.
- Crear agencia (`/red`) y crear nodo (`/admin/tenants`) piden sólo el email del admin. Al terminar,
  el aviso dice a quién se invitó y cuándo vence; si la invitación no salió, que se invite desde
  _Equipo_.
- Invitaciones pendientes en _Equipo_: **Invitado · vence en N días** (o **venció**) con **Reenviar**
  junto a **Revocar**.
- Se borró el `POST` del proxy `/api/admin/users`; `/api/invitations/[id]/resend` es nuevo.

## Tests

- `apps/api/src/tenants/onboarding-invitation.test.ts`: el 410 sin dependencias, el 400 por
  `adminPassword`, `adminName` descartado, `resend` 401/403 sin llegar al servicio y Zod en su borde.
- `apps/api/src/tenants/onboarding-invitation.integration.test.ts` (se salta sin `PGHOST`): el alta no
  crea `users` ni `memberships`, sólo la invitación; la respuesta tiene las mismas claves para un email
  nuevo y uno de otra red; aceptar vincula sin tocar contraseña ni nombre de quien ya tenía cuenta;
  reenviar invalida el enlace viejo, pasa `invited_by` a quien reenvió y audita; 403 por rango y 404
  fuera de estado.
- `tenants-admin.integration.test.ts`: los casos de admin inicial esperan invitación, nunca cuenta.
- Web: `invitation-expiry.test.ts`, `tenant-admin-seats-client.resend.test.ts`,
  `tenant-admin-form.test.ts`.

## Fuera de alcance

Usuarios ya creados con una contraseña elegida por un admin siguen con ella. Si el founder lo pide, se
les fuerza un restablecimiento (revocar sesiones + correo de restablecer).
