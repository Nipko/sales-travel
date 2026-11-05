# 16 — Roles, superadmins plenos y supervisados, y auditoría de la plataforma

> Estado: implementado el 2026-11-05 (migración `0092_platform_supervision.sql`). Diseño acordado
> con el founder ese mismo día: **superadmin pleno + superadmin supervisado con aprobación**, y
> **alta y baja de superadmins desde el panel**.

## 1. Inventario de roles (cómo está hoy)

La fuente única es `apps/api/src/auth/roles.ts`. Los roles se guardan en `memberships.role`, una
membership por (usuario, nodo).

| Rol (rango)                     | Dónde vive                                          | Vende | Administra                                                               | Consola de la plataforma                            | MFA obligatorio |
| ------------------------------- | --------------------------------------------------- | ----- | ------------------------------------------------------------------------ | --------------------------------------------------- | --------------- |
| `superadmin` (100)              | Sólo en el nodo `platform` (trigger 0025)           | No    | Toda la red (`canManageTenant`, `can_finance_tenant`)                    | Sí (`SuperadminGuard` + `is_platform_superadmin()`) | Sí              |
| ↳ **supervisado** (0092)        | Igual, con `memberships.platform_supervised = true` | No    | Igual, pero lo sensible queda como solicitud                             | Sí, ve todo; no aprueba                             | Sí              |
| `platform_admin` (90, retirado) | Sólo en `platform`                                  | No    | Ver huecos (§2)                                                          | No (`SuperadminGuard` lo deja fuera)                | Sí              |
| `consolidator_admin` (70)       | Consolidador (la API no lo impide en otros nodos)   | Sí    | Su subárbol: usuarios por debajo de 70, BYOC, markup, carteras, payloads | No                                                  | Sí              |
| `tenant_admin` (60)             | Agencia / sub-agencia                               | Sí    | Su subárbol, por debajo de 60                                            | No                                                  | Sí              |
| `agency_admin` (50)             | Agencia                                             | Sí    | Su subárbol, por debajo de 50 (incluye BYOC, markup y carteras)          | No                                                  | **No**          |
| `admin` / "Manager" (40)        | Cualquier nodo                                      | Sí    | Su subárbol, por debajo de 40 (incluye BYOC, markup y carteras)          | No                                                  | **No**          |
| `vendedor` (20)                 | Cualquier nodo                                      | Sí    | —                                                                        | No                                                  | No              |
| `cliente_final` (10)            | Cualquier nodo                                      | No    | —                                                                        | No                                                  | No              |

Jerarquía de nodos (0050): una sola raíz `platform` → `consolidator` o `agency` (una agencia que
cuelga de la plataforma puede ser sucursal, `is_branch`) → `agency` → `subagency`; hasta 4 niveles.

Cadena de guardas de la API: `AuthGuard` → `MfaEnforcementGuard` → `RolesGuard` (los roles de
plataforma pasan salvo en `@SalesOperation()`: el superadmin no vende) → `RecentMfaGuard` (acciones
de alto impacto, 2FA de los últimos 10 minutos) → `SuperadminGuard` por controlador en la consola.
La base lo vuelve a exigir con RLS y funciones como `is_platform_superadmin()`.

La web muestra «Plataforma» a quien tiene `role === 'superadmin'` en el nodo activo
(`lib/nav.ts`, `admin/plataforma/layout.tsx`).

## 2. Huecos encontrados

| #   | Hueco                                                                                                                                                                                                                                                 | Estado                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| H1  | Un superadmin podía degradar o suspender a otro con `PATCH /admin/memberships/role` y `/status` (rutas de nodo), sin el chequeo de «último superadmin».                                                                                               | **Cerrado**: los roles de plataforma se gestionan sólo en Plataforma → Superadmins (403).  |
| H2  | Suspender una cuenta (`PATCH /admin/users/status`) sólo cuidaba que quedara «algún» superadmin: con supervisados podía quedar ninguno que apruebe.                                                                                                    | **Cerrado**: ahora exige que quede otro superadmin **pleno** activo.                       |
| H3  | Un cambio por SQL directo en el VPS (p. ej. `provider_accounts.config.bookOnTicketingPcc`, 2026-11-05) no dejaba rastro.                                                                                                                              | **Cerrado** para las tablas sensibles (§4.3).                                              |
| H4  | `ProviderCredentialsUpdated` no decía qué cambió.                                                                                                                                                                                                     | **Cerrado**: lleva antes → después de estado, herencia y `config`, y si cambió el secreto. |
| H5  | `UserStatusChanged` no decía el estado anterior.                                                                                                                                                                                                      | **Cerrado**: lleva `before` / `after`.                                                     |
| H6  | `agency_admin` y `admin` gestionan BYOC, markup y carteras sin MFA obligatorio (CLAUDE.md pide MFA para `tenant_admin` y superiores: por rango cumple, por riesgo no).                                                                                | Pendiente: decisión del founder.                                                           |
| H7  | `platform_admin` está retirado pero conserva privilegios: `canAccessTenant` (network.service.ts), `session.service` lo trata como usuario de plataforma, `can_read_membership` (0020), el CRM (0031), la bóveda de payloads (0043) y anuncios (0079). | Pendiente: migración que lo quite de esas listas (o que convierta esas memberships).       |
| H8  | Listas de roles copiadas fuera de `roles.ts`: `network.service.ts` (3, una incluye `platform_admin` y otra no), `portfolios.controller.ts`, `tenants.controller.ts`, `hotel-readiness.controller.ts`, SQL 0031/0043/0079 y siete archivos de la web.  | Pendiente: refactor a `roles.ts` / `lib/roles`.                                            |
| H9  | `consolidator_admin` sólo en nodos consolidadores lo filtra la web; la API lo permite en cualquier nodo.                                                                                                                                              | Pendiente.                                                                                 |
| H10 | Varias rutas sólo de superadmin comprueban `isSuperadmin` a mano dentro de un controlador de `AGENCY_ADMIN_ROLES` (después de los pipes) en vez de `SuperadminGuard`.                                                                                 | Pendiente (funciona; el orden de chequeos es menos estricto).                              |
| H11 | `isSuperadmin()` (app) no exige usuario activo ni nodo `platform`; `is_platform_superadmin()` (base) sí. En la práctica lo cubren 0025 y la sesión.                                                                                                   | Pendiente (alinear).                                                                       |
| H12 | La web decide «Plataforma» por el rol del nodo activo: un superadmin parado en una sucursal no ve la consola.                                                                                                                                         | Pendiente (usar `viewer.superadmin`).                                                      |

## 3. Diseño acordado: pleno + supervisado

- **Varios superadmins.** Ya cabían en los datos; ahora se dan y se quitan desde **Plataforma →
  Superadmins** (`/admin/plataforma/superadmins`). `tools/seed-superadmin` sigue de respaldo en el VPS.
- **Pleno**: aplica sus cambios al instante. Es el único que aprueba solicitudes.
- **Supervisado** (`memberships.platform_supervised = true`, sólo con rol `superadmin`): ve y opera toda
  la consola, pero **los cambios sensibles no se aplican**: quedan como solicitud en
  `platform_change_requests` y el API responde 409 `CHANGE_REQUEST_PENDING` («tu cambio quedó como
  solicitud»). Un pleno distinto del que la pidió la **aprueba** (se aplica en ese momento, a nombre de
  quien la pidió) o la **rechaza**; quien la pidió puede **cancelarla**.
- **Cambios sensibles** (puerta `SupervisionService.gate`):

  | Área        | Cambio                                                                               | Tipo (`kind`)       |
  | ----------- | ------------------------------------------------------------------------------------ | ------------------- |
  | Gobierno    | Crear, editar, archivar perfil; perfil de nodos nuevos; asignar perfil; regla a mano | `governance.*`      |
  | Proveedores | Levantar un apagado de emergencia; encender/apagar global o por nodo y quitar ajuste | `providers.*`       |
  | Superadmins | Dar acceso, pasar a pleno/supervisado, quitar acceso                                 | `platform_admins.*` |
  | Usuarios    | Suspender o reactivar una cuenta en toda la plataforma                               | `users.status`      |

  **Sin aprobación, a propósito:** _poner_ un apagado de emergencia y cerrar un circuito (sirven en
  un incidente; esperar sería peor) y duplicar un perfil (no cambia ningún nodo).
  **Bloqueado para el supervisado:** cargar credenciales de proveedor (403
  `SUPERVISED_CANNOT_MANAGE_CREDENTIALS`): un secreto no espera en una cola.

- **Reglas que no dependen de quién llama:** nadie se da, cambia ni quita su propio acceso; nunca
  queda la plataforma sin un superadmin **pleno** activo (409 `LAST_FULL_SUPERADMIN`, con bloqueo de
  filas para que dos plenos no se bajen a la vez); dar, cambiar o quitar acceso y aprobar piden el 2FA
  de los últimos 10 minutos. El MFA se le exige a todo superadmin al entrar (`MFA_REQUIRED_ROLES`).
- **Defensa en profundidad:** la RLS de `platform_change_requests` (0092) deja leer a cualquier
  superadmin, pedir sólo a nombre propio y decidir sólo a un pleno (`is_platform_full_superadmin()`); un
  CHECK impide que la decida quien la pidió.

## 4. Auditoría de lo que hace la plataforma

### 4.1 Dónde mirar

**Plataforma → Actividad** (`/admin/plataforma/actividad`):

- **«Sólo superadmins»** (primer chip, combinable con cualquier categoría y con fechas, nodo, correo y
  entidad): lo que hizo cualquier persona que es o fue superadmin, más los cambios directos en la base.
  Enlace directo: `/admin/plataforma/actividad?solo=superadmins`. Plataforma → Superadmins tiene el
  botón «Lo que hicieron».
- **Categoría «Superadmins»**: dar/quitar acceso, solicitudes (creada, aprobada, rechazada, cancelada,
  fallida) y cambios directos en la base.
- En la lista, cada evento de un superadmin lleva su marca (**Superadmin**, **Superadmin supervisado**,
  **Ex superadmin**) y los directos en la base **Fuera del panel**.
- El detalle de cada evento muestra **Qué cambió** (tabla campo · antes · después; una `config` se abre
  para ver justo la clave que cambió), qué secreto cambió (nunca el valor), **Por qué** (el motivo de
  quien actuó o la nota de quien decidió), **Aprobación** (quién pidió, quién aprobó, la solicitud) y,
  si fue directo en la base, **Hecho fuera del panel** (tabla, usuario de la base, programa).
- Se exporta a CSV como antes (2FA reciente; deja `platform.audit.exported`).

### 4.2 Qué queda registrado

Todo en `domain_events` (append-only; la API no puede borrar ni editar). Sin secretos ni PII sensible:
`redactPayload` vuelve a limpiar al leer.

| Evento                                    | Cuándo                                      | Lleva                                                                                                    |
| ----------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `platform.superadmin.granted`             | Dar acceso                                  | antes / después (rol, estado, supervisado), motivo                                                       |
| `platform.superadmin.supervision_changed` | Pleno ↔ supervisado                        | antes / después, motivo                                                                                  |
| `platform.superadmin.revoked`             | Quitar acceso                               | antes / después, sesiones cerradas, motivo                                                               |
| `platform.change_request.*`               | Pedir, aprobar, rechazar, cancelar, fallar  | tipo, resumen, lo pedido, quién pidió, nota o error                                                      |
| (el evento del cambio)                    | Al aplicarse una solicitud aprobada         | `approval: { changeRequestId, requestedBy, approvedBy, note }`                                           |
| `platform.provider_governance.*`          | Gobierno (ya existía)                       | antes / después, nodos afectados                                                                         |
| `ProviderCredentialsUpdated`              | Cargar o editar una cuenta de proveedor     | antes / después de estado, herencia y `config`; si cambió el secreto                                     |
| `UserStatusChanged`                       | Suspender o reactivar una cuenta            | antes / después                                                                                          |
| `db.direct_change`                        | Un cambio en la base fuera de la API (§4.3) | tabla, operación, cada columna antes / después, secretos que cambiaron, usuario de la base, programa, IP |

Cada evento guarda además quién (actor), cuándo, el nodo, la IP, el navegador y el id del pedido.

### 4.3 Cambios fuera del panel (SQL directo)

Un trigger (`audit_direct_change`, 0092) en las tablas sensibles deja `db.direct_change` cuando las
cambia **alguien que no es la API** (`session_user`/`current_user` distinto de `app_user`): una
consola `psql` por SSH, una migración, un seed. La API ya deja su propio evento y no se duplica.

Tablas cubiertas: `provider_accounts` (sin `credentials_enc`, sólo si cambió), `provider_enablement`,
`provider_kill_switches`, `payment_method_rules`, `governance_profiles`, `governance_profile_items`,
`tenant_governance_profiles` y `memberships` **con rol de plataforma**.

Lo que **no** se ve:

- **Quién** fue en persona: la base sólo sabe el usuario de la base (`postgres`) y la IP. Para que quede
  claro, al abrir `psql` en el VPS poner el motivo como nombre de programa — aparece en la Actividad:

  ```bash
  PGAPPNAME='Nir: rodeo H-07 bookOnTicketingPcc' psql ...
  ```

- Tablas fuera de la lista (p. ej. `orders`, `tenants`, `users`), cambios hechos con los triggers
  apagados (`session_replication_role = replica`), con `app.direct_change_audited = 'on'` (lo pone
  `tools/seed-superadmin`, que ya deja su propio evento por cada cambio) o por alguien que borre filas
  de `domain_events` con el superusuario. Quien tiene el superusuario puede saltarse cualquier
  auditoría hecha dentro de la misma base: para eso hace falta, más adelante, `pgaudit` o los logs de
  Postgres enviados fuera del VPS.
- Lo que pasó antes de 0092 (el cambio del 2026-11-05 no tiene evento).

## 5. Dónde está el código

| Pieza                                 | Archivo                                                                                                                                                                                        |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migración                             | `db/migrations/0092_platform_supervision.sql`                                                                                                                                                  |
| Puerta, solicitudes, aprobar/rechazar | `apps/api/src/platform-admins/supervision.service.ts`                                                                                                                                          |
| Dar / cambiar / quitar superadmins    | `apps/api/src/platform-admins/platform-admins.service.ts`, `platform-admins.controller.ts`                                                                                                     |
| Aprobación en cada evento             | `apps/api/src/platform-admins/approval-context.ts` + `audit/audit.service.ts`                                                                                                                  |
| Filtro «Sólo superadmins» y categoría | `apps/api/src/audit/audit-categories.ts`, `admin-audit.*`                                                                                                                                      |
| Rutas con puerta                      | `governance/governance.controller.ts`, `provider-enablement/provider-enablement.controller.ts`, `tenants/admin.controller.ts`, `provider-credentials/provider-credentials.controller.ts`       |
| Pantalla Superadmins                  | `apps/web-b2b/src/app/(app)/admin/plataforma/superadmins/`, `lib/platform-admins*.ts`                                                                                                          |
| Actividad (antes → después, marcas)   | `apps/web-b2b/src/app/(app)/admin/plataforma/actividad/_components/`, `lib/platform-audit.ts`                                                                                                  |
| Tests                                 | `platform-admins/supervision.service.test.ts`, `platform-supervision.integration.test.ts` (RLS, ciclo completo, trigger y aislamiento cross-tenant), `web-b2b/src/lib/platform-admins.test.ts` |

Para sumar una ruta sensible: en su controlador, registrar el tipo en `onModuleInit`
(`supervision.register(kind, { schema, summary, execute })`) y llamar a
`await supervision.gate(actor, kind, input)` antes de aplicar.
