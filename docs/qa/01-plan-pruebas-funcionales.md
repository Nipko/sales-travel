# QA 01 · Inventario y plan de pruebas funcionales (2026-11-26)

> Qué hay que probar en toda la plataforma, a qué nivel, con qué datos y en qué orden se automatiza.
> Parte de la lista F1–F28 de `docs/platform/21-analisis-integral-2026-11.md` §8.2 y la baja a casos
> concretos, pantalla por pantalla, campo por campo y endpoint por endpoint.
>
> Fuente: lectura del código al 2026-11-26 (rama `test/e2e-venta-proveedores-reales`) y de los docs de
> proveedores. Los **hallazgos** (§6) salieron de esa lectura y **no están confirmados**: cada uno tiene su
> caso de prueba, y es ese caso el que lo confirma o lo descarta.

---

## 0. Resumen

| Qué                    | Tamaño                                                                              | Cobertura hoy                                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| API (`apps/api`)       | 50 controllers, **262 endpoints**, 3 colas BullMQ + 3 crons, ~140 funciones SQL     | ~65 endpoints sin ningún test; ~125 sin test a nivel controller; **0 tests HTTP** (la cadena de guardas real nunca se prueba de punta a punta) |
| Panel (`apps/web-b2b`) | ~45 pantallas: acceso (5), venta (14), gestión (6), Mi agencia (6), superadmin (17) | E2E: login/MFA, alta de nodo, roles, 375 px, accesibilidad, y venta real (Sabre, LATAM, TBO, paquete)                                          |
| Proveedores            | Sabre, LATAM NDC, TBO, Despegar, AgentCars                                          | Sabre y TBO con tests de contrato y fixtures; LATAM con pocos; Despegar y AgentCars sin tests en el paquete                                    |

**Este plan define 310 casos** en 22 áreas (§5), 120 de ellos P0. **27 ya están automatizados**, 138
están cubiertos en parte (casi siempre por tests de servicio o de integración, sin pasar por HTTP ni por
el panel) y 145 faltan. La mayoría no necesita navegador: el mayor salto de cobertura viene de un
**arnés HTTP contra la API** (§2, INF-1) que pruebe permisos, validaciones y errores de los 262
endpoints sin depender de la UI. 154 casos tienen nivel H.

**Orden propuesto (§7):** Ola 2 arnés HTTP + matriz de permisos → Ola 3 E2E de administración, Mi
agencia y superadmin con Mailpit → Ola 4 proveedores falsos para que la venta corra en CI → Ola 5
escenarios de certificación con sandbox real.

---

## 1. Cómo leer este plan

**ID:** `ÁREA-NN`. Cada fila es un caso; si un caso tiene variantes (por rol, por proveedor, por
campo) se prueban todas dentro del mismo caso.

**Nivel**

| Código | Qué es                                                                                             | Dónde corre                |
| ------ | -------------------------------------------------------------------------------------------------- | -------------------------- |
| **U**  | Unit (Vitest), sin I/O                                                                             | CI                         |
| **I**  | Integración (Vitest + Postgres/Redis reales, migraciones reales, `app_user` sin BYPASSRLS)         | CI                         |
| **H**  | **HTTP contra la API Nest completa** (guardas, filtros, Zod, throttler reales): arnés nuevo, INF-1 | CI                         |
| **E**  | E2E Playwright del panel con proveedores falsos o sin proveedores                                  | CI (stack E2E) y Mac       |
| **R**  | E2E o arnés con **sandbox real** (`@real`, `E2E_REAL=1`, o arneses de certificación)               | Sólo Mac / workflow manual |

**Prioridad:** **P0** si falla, se pierde dinero, se filtra un tenant o alguien entra donde no debe ·
**P1** flujo de negocio principal · **P2** borde, mensaje o comodidad.

**Estado:** ✅ automatizado · 🟡 parcial (algo lo cubre, no todo) · ⬜ falta.

**Ola:** en qué tanda se automatiza (§7). La Ola 1 es lo ya hecho.

---

## 2. Infraestructura de prueba que hace falta

| ID    | Qué                                                                                                                                                                                                                                                                                                                                                           | Desbloquea                                          | Ola |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | --- |
| INF-1 | **Arnés HTTP:** levantar `AppModule` completo con Postgres/Redis de test y pegarle por HTTP (supertest o `fetch` contra un puerto). Helpers: `como(rol, tenant)` que emite sesión real (login + TOTP), `conMfaReciente()`, `sinMfa()`. Reutiliza el seed de la red E2E.                                                                                       | Todo lo de nivel **H** (154 casos)                  | 2   |
| INF-2 | **Seed por rol completo:** un usuario por rol en cada nodo (superadmin pleno, superadmin supervisado, platform_admin, consolidator_admin, tenant_admin, agency_admin, admin, vendedor, cliente_final) + casos especiales: bloqueado, sin MFA con rol que lo exige, con `password_reset_required`, contraseña legada, cuenta suspendida, membresía suspendida. | H y E de permisos                                   | 2   |
| INF-3 | **Mailpit en el stack E2E** (ya existe en la Mac, puerto 8025) y helper `ultimoCorreo(para)` que extrae el enlace. Invitaciones, restablecer, verificar correo, confirmaciones, cotizaciones.                                                                                                                                                                 | ACC, EQU, COT, POS                                  | 3   |
| INF-4 | **Proveedores falsos** `fake-flights` / `fake-hotels` / `fake-cars` registrados en los registries sólo con env de test, alimentados con las fixtures de Sabre y TBO, con perillas: precio cambia en revalidación, timeout, declinado, parcial, incierto (5xx), sin disponibilidad.                                                                            | Venta completa en CI (VUE, CHK, POS, HOT, AUT, PAQ) | 4   |
| INF-5 | **Reloj manipulable** para vencimientos: mover fechas en BD (`expires_at`, `ticketing_deadline`, invitaciones de 7 días, tokens de 1 h) en vez de esperar.                                                                                                                                                                                                    | ACC, POS, SUP                                       | 2   |
| INF-6 | **Gate de CI:** el job E2E (sin `@real`) corre en cada PR y el deploy espera a CI (hoy `deploy.yml` no espera).                                                                                                                                                                                                                                               | Que todo esto proteja producción                    | 3   |
| INF-7 | **Arnés de sandbox LATAM** (no existe; Sabre y TBO sí tienen): AirShopping OW/RT con 1ADT y 2ADT+1CHD+1INF, OfferPrice, ServiceList, BNPL create → retrieve → cancel, enlace de pago.                                                                                                                                                                         | LAT en R                                            | 5   |

---

## 3. Reglas transversales (se prueban una vez y valen para todo)

### 3.1 Cadena de guardas de la API (orden real en `app.module.ts`)

1. `IpThrottlerGuard` 300/min por IP → 2. `AuthGuard` → 3. `MfaEnforcementGuard` (roles admin sin MFA
   → 403 `MFA_ENROLLMENT_REQUIRED` / `MFA_STEP_UP_REQUIRED`) → 4. `RolesGuard` (sin membresía activa →
   403; rol de plataforma en ruta `@SalesOperation` → 403 `PLATFORM_ROLE_CANNOT_SELL`) → 5. `RecentMfaGuard`
   (`@RequireRecentMfa`: MFA de hace más de 10 min → 403 `MFA_RECENT_REQUIRED`).

### 3.2 Matriz de permisos (caso TRV-01, nivel H, generado)

Un test **por endpoint × rol** que compara el código HTTP con la tabla esperada. La tabla sale de los
decoradores (`@Roles`, `@SalesOperation`, `SuperadminGuard`, `@RequireRecentMfa`, `@Public`,
`@AllowWithoutMfa`) y de los chequeos en el handler (`canManageTenant`, financiador, superadmin). Grupos:

| Grupo   | Quién                                                                                         |
| ------- | --------------------------------------------------------------------------------------------- |
| **Pub** | sin sesión                                                                                    |
| **SR**  | roles que venden: consolidator_admin, tenant_admin, agency_admin, admin, vendedor             |
| **AAR** | admins de agencia: los de SR menos vendedor                                                   |
| **SA**  | superadmin (pleno o supervisado) en el nodo plataforma                                        |
| **SO**  | `@SalesOperation`: SR, pero nunca un rol de plataforma aunque también sea vendedor en el nodo |
| **Net** | además, el nodo pedido tiene que estar bajo el nodo del actor                                 |

### 3.3 Casos transversales

| ID     | Caso                                                                                                                                                                                                                                                                              | Nivel | Pri | Ola | Estado |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --- | --- | ------ |
| TRV-01 | Matriz endpoint × rol (§3.2): 262 endpoints × 9 perfiles, código esperado 2xx/401/403                                                                                                                                                                                             | H     | P0  | 2   | ⬜     |
| TRV-02 | Sin sesión: toda ruta no `@Public` → 401; token vencido, sesión revocada, reemplazada o inactiva → 401 con su `reason`                                                                                                                                                            | H     | P0  | 2   | 🟡     |
| TRV-03 | Rol admin sin MFA: toda ruta salvo `@AllowWithoutMfa` → 403 `MFA_ENROLLMENT_REQUIRED`; con MFA pero sesión sin verificar → `MFA_STEP_UP_REQUIRED`                                                                                                                                 | H     | P0  | 2   | 🟡     |
| TRV-04 | Las 11 rutas `@RequireRecentMfa` (+ las 2 condicionales: `send-password-reset` y `memberships/remove` cuando el objetivo es admin): con MFA de hace 11 min → 403 `MFA_RECENT_REQUIRED`; tras `POST /auth/step-up` → 2xx; actor sin 2FA → `MFA_REQUIRED_FOR_ACTION`                | H     | P0  | 2   | 🟡     |
| TRV-05 | Superadmin/platform_admin en las ~35 rutas `@SalesOperation` → 403 `PLATFORM_ROLE_CANNOT_SELL`, también cuando tiene membresía de vendedor en el nodo activo                                                                                                                      | H     | P0  | 2   | 🟡     |
| TRV-06 | **Aislamiento entre tenants:** vendedor de agencia A pide por id órdenes, cotizaciones, clientes, paquetes, oportunidades, carteras, cuentas de proveedor, payloads y miembros de agencia B → 403/404 y nunca datos. Repetir con admin de A sobre nodos hermanos y sobre el padre | H + I | P0  | 2   | 🟡     |
| TRV-07 | Aislamiento en tablas sin RLS (`tenants`, `users`, `password_reset_tokens`, `consumed_tokens`): ninguna consulta de app las lee sin filtro de actor                                                                                                                               | I     | P0  | 2   | ⬜     |
| TRV-08 | `:id` no UUID en orders, quotations, customers, crm, packages, `pricing/rules/:id`, `hotels/reservations/:id`, `tenants/:id/config` y `/branding`, provider-payloads → hoy 500 (Postgres 22P02); esperado 400/404 (hallazgo QA-H-01)                                              | H     | P1  | 2   | ⬜     |
| TRV-09 | Error de Zod → 400 con `{statusCode, error, message, fields}`; error no HTTP → 500 sin stack ni SQL en el cuerpo                                                                                                                                                                  | H     | P1  | 2   | 🟡     |
| TRV-10 | Throttling: cada `@Throttle` (5/min, 10/min, 20/min) y cada balde `SellerRateLimit` (30/60 por min) devuelve 429 con `Retry-After` en el intento N+1; la cuota `search_quota_per_hour` devuelve 403                                                                               | H     | P1  | 2   | 🟡     |
| TRV-11 | `Idempotency-Key`: falta o no UUID → 400; misma clave y mismo cuerpo → mismo resultado sin duplicar; misma clave y otro cuerpo → 409 (carteras `PORTFOLIO_IDEMPOTENCY_KEY_REUSED`) o resultado guardado (órdenes, hoteles)                                                        | H     | P0  | 2   | 🟡     |
| TRV-12 | Superadmin supervisado: los 17 cambios con puerta (`platform_admins.*`, `governance.*`, `providers.*` salvo kill-switch SET, `users.status`, `tenants.update`, `tenants.move`) → 409 `CHANGE_REQUEST_PENDING` y nada cambia; los no restringidos aplican directo                  | H     | P0  | 2   | 🟡     |
| TRV-13 | Auditoría: cada acción sensible de este plan emite su `domain_event` (nombre y campos), sin secretos ni PII completa en `payload`                                                                                                                                                 | H + I | P0  | 2   | 🟡     |
| TRV-14 | Headers de seguridad en API y panel: CSP, HSTS, `X-Frame-Options: DENY`, `Referrer-Policy`, `Cache-Control: no-store` en los GET sensibles (F28). Hoy `helmet()` va con valores por defecto (QA-H-02)                                                                             | H + E | P1  | 2   | ⬜     |
| TRV-15 | CSRF/origen en el BFF: todo POST/PATCH/DELETE de `src/app/api/**` rechaza `Origin` ajeno. Incluye las dos rutas que se saltan `forwardPlan` (`POST /api/admin/tenants`, `POST /api/admin/tenants/[id]/move`, QA-H-03)                                                             | H     | P0  | 2   | ⬜     |
| TRV-16 | Ningún log (API, BFF, proveedores) contiene contraseñas, tokens, TOTP, PAN, documentos ni payloads de proveedor en claro                                                                                                                                                          | I     | P0  | 2   | 🟡     |
| TRV-17 | 375 px sin scroll horizontal en todas las rutas del panel (hoy sólo las de venta)                                                                                                                                                                                                 | E     | P1  | 3   | 🟡     |
| TRV-18 | axe (WCAG AA) en todas las rutas, tema claro y oscuro (hoy las principales)                                                                                                                                                                                                       | E     | P1  | 3   | 🟡     |
| TRV-19 | Navegación por teclado en diálogos de confirmación, combobox de ruta, calendario y menús de acciones                                                                                                                                                                              | E     | P2  | 3   | ⬜     |
| TRV-20 | Monedas: ningún total suma montos de monedas distintas (inicio, reportes, resumen de plataforma, carteras)                                                                                                                                                                        | E + I | P1  | 3   | ⬜     |

---

## 4. Datos de prueba

Base: la red de `apps/web-b2b/e2e/env/seed.sql` (plataforma → consolidador → agencia A → sub-agencia;
agencia B en BR/BRL). Se amplía con INF-2. Reglas que ya rigen:

- Sólo credenciales sandbox/CERT/test. Pasajeros con apellido `PRUEBA` o `TEST`.
- Tarjetas: sólo las de prueba publicadas por el proveedor, y nunca contra el servidor nuestro (PCI SAQ-A).
- Toda reserva real se cancela en el mismo test y en un `afterAll` de seguridad.
- Secretos del stack E2E: `pnpm e2e:up` los genera en `e2e/.env.e2e` (ignorado).

---

## 5. Casos por área

### 5.1 ACC · Acceso: login, MFA, puestos, contraseña, verificación, invitación

| ID     | Caso                                                                                                                                                                                                    | Nivel | Pri | Ola | Estado |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --- | --- | ------ |
| ACC-01 | Login correcto de vendedor (sin MFA) entra a Inicio                                                                                                                                                     | E     | P0  | 1   | ✅     |
| ACC-02 | Contraseña errada → «El correo o la contraseña no son correctos.» + aviso de bloqueo                                                                                                                    | E     | P1  | 1   | ✅     |
| ACC-03 | Campos vacíos → «Ingresa tu correo y tu contraseña.» sin llamar a la API                                                                                                                                | E     | P2  | 3   | ⬜     |
| ACC-04 | 5 fallos seguidos (contraseña o TOTP, cuentan juntos) bloquean 15 min; el 6.º con la correcta tampoco entra; `auth.login.blocked`                                                                       | H + E | P0  | 2   | 🟡     |
| ACC-05 | Restablecer la contraseña desbloquea la cuenta                                                                                                                                                          | H     | P1  | 2   | 🟡     |
| ACC-06 | Admin sin MFA queda en el gate; activa y recibe 10 códigos de recuperación                                                                                                                              | E     | P0  | 1   | ✅     |
| ACC-07 | Con MFA: código errado «Te quedan N intentos», correcto entra                                                                                                                                           | E     | P0  | 1   | ✅     |
| ACC-08 | Código de recuperación entra una sola vez; formato `A1B2C-3D4E5` con o sin guion/espacios; `auth.mfa.recovery_code_used`                                                                                | E     | P1  | 1   | ✅     |
| ACC-09 | Reto MFA vencido (>5 min) → «la verificación venció» y vuelve al paso 1                                                                                                                                 | H + E | P2  | 2   | ⬜     |
| ACC-10 | «Recordar este equipo» (por defecto marcado): el siguiente login desde el mismo navegador no pide TOTP durante 30 días; desmarcado sí lo pide                                                           | E     | P1  | 3   | ⬜     |
| ACC-11 | Equipo de confianza revocado (por el usuario, por cambio de contraseña o por desactivar MFA) vuelve a pedir TOTP                                                                                        | E     | P1  | 3   | ⬜     |
| ACC-12 | `?next=` seguro: `//evil.com`, `\\`, `/api/x`, `/login`, >2048 caracteres y caracteres de control → redirige a `/`; `/reservas` → va a `/reservas`                                                      | E     | P0  | 3   | ⬜     |
| ACC-13 | Con sesión válida, `/login` redirige a `next`                                                                                                                                                           | E     | P2  | 3   | ⬜     |
| ACC-14 | `?motivo=` muestra el aviso correcto (inactividad con `minutos` 5–480, otro-dispositivo, liberada, expirada, cerrada); valor fuera de la lista no muestra nada                                          | E     | P2  | 3   | ⬜     |
| ACC-15 | `PASSWORD_RESET_REQUIRED` en login: aviso + correo con enlace (Mailpit); al cambiarla entra                                                                                                             | E     | P1  | 3   | ⬜     |
| ACC-16 | Puestos llenos (409 `SEATS_FULL`), usuario no admin del pool: texto + «Volver a intentar», no ve sesiones ajenas                                                                                        | E     | P1  | 3   | ⬜     |
| ACC-17 | Puestos llenos, admin del pool: lista sesiones, «Desconectar y entrar» libera una y entra; la sesión desconectada ve `motivo=liberada`                                                                  | E     | P1  | 3   | ⬜     |
| ACC-18 | Liberación con token vencido (400/401/410), sesión ya cerrada (404), puesto tomado de nuevo (409), sin permiso (403): cada uno con su mensaje                                                           | H     | P2  | 2   | ⬜     |
| ACC-19 | Inactividad: tras el tiempo del nodo (`effective_idle_timeout_minutes`) la sesión cae con `SESSION_IDLE`; el ping pasivo (`x-session-ping: passive`) no cuenta como actividad                           | H     | P1  | 2   | 🟡     |
| ACC-20 | Sesión abierta en otro dispositivo con el mismo usuario (si el nodo es de sesión única) → `SESSION_REPLACED`                                                                                            | H + E | P1  | 2   | 🟡     |
| ACC-21 | Nodo suspendido → login 403 `TENANT_SUSPENDED`; usuario suspendido → no entra; membresía suspendida → no ve ese nodo                                                                                    | H     | P0  | 2   | 🟡     |
| ACC-22 | `/olvide-password`: correo existente y no existente dan la misma respuesta; el existente recibe enlace (Mailpit); 6.º pedido en un minuto → 429                                                         | H + E | P0  | 3   | 🟡     |
| ACC-23 | `/restablecer`: sin token, contraseña <12, no coinciden, token usado, token vencido (>1 h), `PASSWORD_REUSED` cuando un admin forzó el cambio; éxito cierra todas las sesiones y manda aviso por correo | E     | P1  | 3   | 🟡     |
| ACC-24 | `/restablecer` con contraseña de 129+ caracteres: hoy dice «enlace usado o venció» (QA-H-04)                                                                                                            | E     | P2  | 3   | ⬜     |
| ACC-25 | `/verificar`: token válido «¡Correo verificado!», repetirlo es idempotente; sin token; token vencido (2 días) — hoy muestra el mensaje en inglés de la API (QA-H-05)                                    | E     | P2  | 3   | ⬜     |
| ACC-26 | Banner de correo sin verificar: «Reenviar correo» manda uno nuevo; el 6.º en un minuto → 429                                                                                                            | E     | P2  | 3   | ⬜     |
| ACC-27 | `/invitacion` correo nuevo: nombre (reglas de `checkPersonName`: vacío, >120, invisibles, sin letras), contraseña ≥12 y repetida; crea cuenta y membresía con el rol invitado                           | E     | P0  | 3   | ⬜     |
| ACC-28 | `/invitacion` correo con cuenta y sin sesión → «Ingresar para aceptar» → login → acepta                                                                                                                 | E     | P1  | 3   | ⬜     |
| ACC-29 | `/invitacion` con sesión de la cuenta invitada → «Aceptar invitación»; con sesión de otra cuenta → «Salir e ingresar con la cuenta invitada»                                                            | E     | P1  | 3   | ⬜     |
| ACC-30 | Invitación revocada, vencida (7 días), ya usada, con quien invitó suspendido o degradado (`INVITATION_NO_LONGER_VALID`), ya miembro (`ALREADY_MEMBER`)                                                  | H + E | P1  | 2   | 🟡     |
| ACC-31 | Invitación a rol admin: al aceptar cae en el gate de MFA                                                                                                                                                | E     | P1  | 3   | ⬜     |
| ACC-32 | `POST /auth/register` → 403 salvo `ALLOW_PUBLIC_SIGNUP=true`                                                                                                                                            | H     | P0  | 2   | 🟡     |
| ACC-33 | Cambio de nodo activo (`switch-tenant`) a uno sin membresía → 403; a uno válido emite token con el `tid` nuevo y la cookie `st_tenant` se re-sincroniza                                                 | H + E | P0  | 2   | 🟡     |
| ACC-34 | Logout cierra la sesión en BD (el token viejo da 401)                                                                                                                                                   | H     | P1  | 2   | ⬜     |

### 5.2 CTA · Mi cuenta: perfil y seguridad

| ID     | Caso                                                                                                                                                    | Nivel | Pri | Ola | Estado |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --- | --- | ------ |
| CTA-01 | Cambiar nombre: normaliza espacios y NFC, valida las 4 reglas de nombre; el correo no es editable (PATCH con `email` → 400)                             | E + H | P1  | 3   | 🟡     |
| CTA-02 | 11.º cambio de nombre en un minuto → 429 «Hiciste muchos cambios seguidos»                                                                              | H     | P2  | 2   | ⬜     |
| CTA-03 | Activar MFA voluntario (vendedor): QR + clave, contraseña + código, códigos de recuperación; «Listo» sólo tras marcar «Los guardé»                      | E     | P1  | 3   | ⬜     |
| CTA-04 | Primera activación con contraseña errada → `MFA_PASSWORD_INVALID` y cuenta para el bloqueo                                                              | H     | P1  | 2   | 🟡     |
| CTA-05 | Cambiar de teléfono (rotar): contraseña + código actual, nuevo QR; abandonar a la mitad muestra el aviso de cambio pendiente                            | E     | P1  | 3   | ⬜     |
| CTA-06 | Regenerar códigos de recuperación: los viejos dejan de servir; aviso cuando queda 1 o 0                                                                 | E + H | P1  | 3   | 🟡     |
| CTA-07 | Desactivar MFA: sólo si el rol no lo exige (`MFA_REQUIRED_BY_ROLE`); cierra todas las sesiones y olvida equipos                                         | E + H | P0  | 3   | 🟡     |
| CTA-08 | Cambiar contraseña: actual errada (401), nueva <12 o >128, igual a la actual, no coinciden; éxito mantiene esta sesión y cierra las otras               | E + H | P0  | 3   | 🟡     |
| CTA-09 | Sesiones abiertas: cerrar otra (la de otro navegador cae), intentar cerrar la actual (`CANNOT_REVOKE_CURRENT_SESSION`), «Cerrar en todos» manda a login | E     | P1  | 3   | ⬜     |
| CTA-10 | Equipos de confianza: quitar uno y quitar todos                                                                                                         | E     | P2  | 3   | ⬜     |

### 5.3 AGE · Mi agencia (`/configuracion`)

| ID     | Caso                                                                                                                                                                                 | Nivel | Pri | Ola | Estado |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | --- | --- | ------ |
| AGE-01 | General: nombre 2–120, país, moneda, idioma se guardan y se releen; slug no editable; `tenant.config.updated`                                                                        | E + H | P1  | 3   | 🟡     |
| AGE-02 | Cambiar la moneda base cambia la puerta de moneda de la búsqueda (las ofertas en la moneda vieja se descartan con su motivo)                                                         | E     | P0  | 4   | 🟡     |
| AGE-03 | Vendedor abre `/configuracion` (no hay guarda de página) y al guardar recibe 403; hoy el error es genérico (QA-H-06)                                                                 | E     | P1  | 3   | ⬜     |
| AGE-04 | Marca: colores hex de 6 dígitos (inválido → 400), logo sólo `https://`, quitar logo; la vista previa y el panel recargado usan los colores                                           | E + H | P2  | 3   | ⬜     |
| AGE-05 | Contacto de soporte: vacío = hereda del consolidador; teléfono no E.164 muestra la pista pero guarda (QA-H-07); sin contacto efectivo, reservar hotel → 422 `AGENCY_CONTACT_MISSING` | E + H | P0  | 3   | 🟡     |
| AGE-06 | Subir logo/favicon (`POST /tenants/:id/brand-assets`): >512 KB → 413/400, vacío → 400, extensión png con bytes de otro tipo → rechazo por firma, svg con `<script>` → rechazo        | H     | P0  | 2   | ⬜     |
| AGE-07 | Pestaña Dominio: el campo CNAME no guarda nada (QA-H-08) — decidir si se oculta                                                                                                      | E     | P2  | 3   | ⬜     |
| AGE-08 | Branding heredado: la sub-agencia sin marca propia ve la del padre (`resolve_tenant_branding`)                                                                                       | I     | P1  | 2   | ⬜     |

### 5.4 EQU · Equipo (`/admin/usuarios`)

| ID     | Caso                                                                                                                                                                               | Nivel | Pri | Ola | Estado |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --- | --- | ------ |
| EQU-01 | Admin de agencia ve su equipo y no la plataforma                                                                                                                                   | E     | P0  | 1   | ✅     |
| EQU-02 | Invitar: correo inválido, rol vacío; sólo se ofrecen roles por debajo del propio; `consolidator_admin` sólo en nodos consolidador; correo llega (Mailpit) con enlace válido 7 días | E + H | P0  | 3   | 🟡     |
| EQU-03 | Invitar con rol igual o superior al propio → 403; a un nodo fuera de la red → 403                                                                                                  | H     | P0  | 2   | 🟡     |
| EQU-04 | Invitación duplicada pendiente → aviso con «Reenviar»; ya miembro → 409                                                                                                            | E     | P1  | 3   | ⬜     |
| EQU-05 | Reenviar invalida el enlace anterior; revocar deja el enlace sin efecto                                                                                                            | E + H | P1  | 3   | 🟡     |
| EQU-06 | Cambiar rol: no a sí mismo; debe superar el rol actual y el nuevo; último admin del nodo protegido; revoca invitaciones que el degradado envió; vista previa de impacto            | H + E | P0  | 2   | 🟡     |
| EQU-07 | Suspender/reactivar miembro: cierra sus sesiones en ese nodo, revoca sus invitaciones, último admin protegido, aviso por correo                                                    | H + E | P0  | 2   | 🟡     |
| EQU-08 | Quitar del nodo: soft delete; rol de plataforma no removible; objetivo admin exige step-up                                                                                         | H     | P0  | 2   | 🟡     |
| EQU-09 | Enviar enlace de restablecer: máx. 3 cada 15 min (`PASSWORD_RESET_RATE_LIMITED`); deshabilitado si el acceso está suspendido                                                       | H + E | P1  | 2   | 🟡     |
| EQU-10 | Forzar cambio de contraseña (step-up): cierra sesiones y el usuario recibe `PASSWORD_RESET_REQUIRED` al entrar                                                                     | H + E | P0  | 2   | 🟡     |
| EQU-11 | Desbloquear cuenta bloqueada; cerrar sus sesiones; cerrar una sesión puntual                                                                                                       | H     | P1  | 2   | 🟡     |
| EQU-12 | Restablecer 2FA (step-up): el usuario vuelve al gate si su rol lo exige; deshabilitado si no lo tiene                                                                              | H + E | P0  | 2   | 🟡     |
| EQU-13 | Puestos: medidor de uso, desconectar a alguien libera su puesto; no puedes liberarte a ti mismo                                                                                    | E + H | P1  | 3   | 🟡     |
| EQU-14 | Filtros (2FA pendiente, bloqueados, nunca ingresaron, cambio pendiente, rol, ocultar suspendidos, orden) y búsqueda; estado en la URL                                              | E     | P2  | 3   | ⬜     |
| EQU-15 | Exportar equipo (CSV, step-up, 5/min): columnas correctas, sin datos de otros nodos                                                                                                | H     | P1  | 2   | 🟡     |
| EQU-16 | Ficha del miembro: actividad paginada, sesiones, invitaciones que envió                                                                                                            | E     | P2  | 3   | ⬜     |
| EQU-17 | Contraseñas legadas: lista hasta 500, forzar en tandas de 50 (step-up), resultado por fila (enlace enviado, correo falló, omitida)                                                 | H + E | P1  | 3   | 🟡     |

### 5.5 BYO · Proveedores y credenciales (`/admin/proveedores`, credenciales en `/red`)

| ID     | Caso                                                                                                                                                                                                 | Nivel | Pri | Ola | Estado |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --- | --- | ------ |
| BYO-01 | Conectar cada proveedor (Sabre, LATAM, TBO, Despegar, AgentCars) con sus campos obligatorios; cada obligatorio vacío muestra su error y el resumen «Revisa N campos»                                 | E     | P1  | 3   | ⬜     |
| BYO-02 | Las credenciales se guardan cifradas y nunca vuelven al cliente (GET no trae secretos; el formulario de edición va vacío)                                                                            | H + I | P0  | 2   | 🟡     |
| BYO-03 | Editar sin tocar credenciales (`keepCredentials`) conserva las guardadas; mandar credenciales con `keepCredentials` → 400                                                                            | H     | P1  | 2   | 🟡     |
| BYO-04 | Herencia: sub-agencia sin cuenta propia resuelve la heredable activa del ancestro más cercano; cuenta no heredable no baja; cuenta en Sandbox/Deshabilitada no habilita la venta                     | I + H | P0  | 2   | 🟡     |
| BYO-05 | Quitar herencia o deshabilitar una cuenta con reservas abiertas → 409 `PROVIDER_ACCOUNT_IN_USE` con el número                                                                                        | H     | P0  | 2   | 🟡     |
| BYO-06 | TBO y Despegar sólo los carga plataforma o consolidador («La carga el consolidador»)                                                                                                                 | H + E | P1  | 2   | ⬜     |
| BYO-07 | Superadmin supervisado no puede cargar credenciales → 403 `SUPERVISED_CANNOT_MANAGE_CREDENTIALS`                                                                                                     | H     | P0  | 2   | ⬜     |
| BYO-08 | Config de Sabre por campo: `ticketingFormOfPayment` CASH/ON_ACCOUNT/INVOICE, `ticketPrinterCountry` `^[A-Z1]{2}$`, LNIATA 6 alfanuméricos, `pccTimeZone`; valor inválido cae a su default sin romper | U + H | P1  | 2   | 🟡     |
| BYO-09 | «Origen de las tarifas»: Heredar/Mostrar/Ocultar cambia si los resultados muestran el proveedor; bloqueado por un ancestro                                                                           | E + H | P2  | 3   | 🟡     |
| BYO-10 | Configuración de correo del nodo (SMTP): requeridos; puerto 465 → `secure`; «Enviar correo de prueba» llega a Mailpit; heredable                                                                     | E     | P1  | 3   | ⬜     |
| BYO-11 | Sin cuenta usable, el proveedor no aparece en la búsqueda y la búsqueda dice por qué                                                                                                                 | H + E | P1  | 4   | 🟡     |

### 5.6 RED · Mi Red: nodos, jerarquía, pricing, auditoría

| ID     | Caso                                                                                                                                      | Nivel | Pri | Ola | Estado |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ----- | --- | --- | ------ |
| RED-01 | Crear agencia bajo la plataforma y sub-agencia bajo ella                                                                                  | E     | P0  | 1   | ✅     |
| RED-02 | Sólo se ofrecen los tipos válidos bajo cada nodo; profundidad máx. 4                                                                      | E + H | P0  | 1   | 🟡     |
| RED-03 | Slug repetido → 409; slug con mayúsculas o espacios → 400; nombre 2–120                                                                   | H + E | P1  | 2   | 🟡     |
| RED-04 | Puestos al crear bajo la plataforma son obligatorios y sólo para superadmin; el error se ve y recibe el foco (BUG-E2E-01)                 | E     | P1  | 1   | ✅     |
| RED-05 | Correo del admin inicial manda invitación (Mailpit); fallo de correo → aviso, el nodo igual se crea; `adminPassword` → rechazado          | E + H | P1  | 3   | ⬜     |
| RED-06 | Admin de consolidador sólo ve y gestiona su subárbol (`/tenants/network`, ventas, usuarios, auditoría de red)                             | H     | P0  | 2   | 🟡     |
| RED-07 | Vendedor en `/red`: hoy no hay guarda de página y ve el estado vacío (QA-H-09)                                                            | E     | P2  | 3   | ⬜     |
| RED-08 | Reglas de pricing: % y fijo, por vertical; regla en consolidador + agencia + sub-agencia → precio en la búsqueda = cascada correcta       | I + E | P0  | 4   | 🟡     |
| RED-09 | `POST /pricing/rules` sin Zod: `ruleType` inválido → hoy 403 (esperado 400), valor negativo se trunca a 0, vertical no validada (QA-H-10) | H     | P1  | 2   | ⬜     |
| RED-10 | Borrar regla: hoy sin confirmación y sin manejo de error (QA-H-11); borrar regla de otro nodo → 403                                       | E + H | P1  | 2   | ⬜     |
| RED-11 | Simulador de cascada: resultado = `compute_price_waterfall`; error visible (hoy se traga, QA-H-11)                                        | E     | P2  | 3   | ⬜     |
| RED-12 | Auditoría de red: filtros Usuarios/Credenciales/Precios/Red, paginación, sin eventos de otros subárboles                                  | H + E | P1  | 3   | 🟡     |
| RED-13 | Ventas de la red por nodo (`/tenants/network/sales`): sin `tenantId` → 403, UUID malo → hoy 500                                           | H     | P2  | 2   | ⬜     |

### 5.7 CAR · Carteras (agencia, financiador, cola de plataforma)

| ID     | Caso                                                                                                                                                           | Nivel | Pri | Ola | Estado |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --- | --- | ------ |
| CAR-01 | Financiador habilita moneda (ISO con 2 decimales), con cupo inicial y motivo 3–500; repetida → `PORTFOLIO_ALREADY_ENABLED`                                     | H + E | P0  | 2   | 🟡     |
| CAR-02 | Depósito (Idempotency-Key): monto >0, sin separadores de miles, decimales según la moneda, máximo; reintento con la misma clave no duplica                     | H + E | P0  | 2   | 🟡     |
| CAR-03 | Ajuste acreditar/debitar: cero → 400; deja el saldo fuera de rango → `PORTFOLIO_BALANCE_OUT_OF_RANGE`                                                          | H     | P0  | 2   | 🟡     |
| CAR-04 | Cupo de crédito y suspender/reactivar cartera, con confirmación y evento                                                                                       | H + E | P1  | 2   | 🟡     |
| CAR-05 | Quien no financia el nodo → 403 `PORTFOLIO_FINANCIER_REQUIRED` en todo `/tenants/:id/portfolios/*` y en `deposit`/`withdraw`/`credit-limit` de la agencia      | H     | P0  | 2   | 🟡     |
| CAR-06 | Agencia informa un depósito: cartera, monto, referencia 1–100, fecha (no futura, existe), nota ≤500; queda pendiente                                           | E + H | P1  | 3   | 🟡     |
| CAR-07 | Financiador aprueba (comentario opcional ≤500) o rechaza (motivo 3–500); ya resuelto → aviso; la cola de plataforma sólo aprueba lo que financia la plataforma | H + E | P0  | 3   | 🟡     |
| CAR-08 | Reservar con saldo insuficiente → `PORTFOLIO_FUNDS_INSUFFICIENT` y «No se hizo ninguna reserva…»; los 8 motivos `PORTFOLIO_*` muestran su texto                | H + E | P0  | 4   | 🟡     |
| CAR-09 | Retención en cascada: reservar en sub-agencia retiene en cada nivel que financia; cancelar libera en todos; confirmar captura                                  | I     | P0  | 2   | ✅     |
| CAR-10 | Concurrencia: dos reservas a la vez contra el mismo saldo no lo dejan negativo (`PORTFOLIO_HOLD_BUSY` en una)                                                  | I     | P0  | 2   | ✅     |
| CAR-11 | «Cancelar y liberar» una reserva retenida desde la cartera: confirmación del proveedor + saldo liberado; fallo ambiguo → aviso de revisar antes de reintentar  | E     | P1  | 4   | ⬜     |
| CAR-12 | Tarifas no reembolsables bloqueadas por el financiador → la agencia no puede reservarlas (hotel) y ve el motivo                                                | H + E | P0  | 3   | 🟡     |
| CAR-13 | Movimientos por moneda; pestaña «Reservas de tu red» sólo para admins que financian                                                                            | E     | P2  | 3   | ⬜     |

### 5.8 VUE · Búsqueda de vuelos (`/cotizaciones`)

| ID     | Caso                                                                                                                                                                  | Nivel | Pri | Ola | Estado |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --- | --- | ------ |
| VUE-01 | Solo ida BOG→MDE con Sabre CERT: resultados con marca de tarifa de prueba                                                                                             | R     | P0  | 1   | ✅     |
| VUE-02 | Ida y vuelta en dos pasos: elegir ida → «Elegir vuelta y continuar» (Anchored Search)                                                                                 | E + R | P0  | 4   | ⬜     |
| VUE-03 | Multidestino 2–6 tramos: cada tramo nuevo empieza donde llegó el anterior; mismo origen y destino, fecha pasada, tramo antes del anterior → error por tramo           | E     | P1  | 4   | ⬜     |
| VUE-04 | Validaciones del formulario: origen/destino vacíos o iguales, fecha de ida vacía o pasada, vuelta antes de ida, falta vuelta en ida y vuelta; «Intercambiar» invierte | E     | P1  | 3   | ⬜     |
| VUE-05 | Pasajeros: total ≤9 (el + se deshabilita), infantes ≤ adultos (bajar adultos baja infantes), una edad 2–11 por niño, infantes con asiento ≤ infantes                  | E     | P1  | 3   | ⬜     |
| VUE-06 | La API no limita el total a 9 (sólo cada tipo a 9): 9 ADT + 9 CHD pasa la API (QA-H-12)                                                                               | H     | P1  | 2   | ⬜     |
| VUE-07 | Cabinas (4) llegan al proveedor; moneda siempre la del nodo aunque el cliente mande otra                                                                              | H     | P1  | 2   | 🟡     |
| VUE-08 | Puerta de moneda: ofertas en otra moneda se descartan con el motivo; con `foreignFares` habilitado por superadmin se muestran                                         | H + R | P0  | 1   | 🟡     |
| VUE-09 | Orden (Mejor, Precio, Duración, Salida) y filtros (escalas, aerolíneas, franjas por tramo, duración, equipaje, aeropuertos excluidos, precio máx.)                    | E     | P2  | 4   | ⬜     |
| VUE-10 | Calendario de precios ±3 días; si falla, se oculta sin romper la búsqueda                                                                                             | E + H | P2  | 4   | 🟡     |
| VUE-11 | Más tarifas por vuelo bajo demanda (`known` ≤20, `leg` 0/1, aerolínea 2–3) y matriz de familias tarifarias                                                            | E + H | P1  | 4   | 🟡     |
| VUE-12 | Caché por tenant: la segunda búsqueda igual no llama al proveedor; un resultado degradado no se cachea; otro tenant no ve la caché                                    | I     | P0  | 2   | 🟡     |
| VUE-13 | Proveedor caído o lento: los demás responden, el caído aparece con su motivo; circuito abierto lo saca                                                                | H + E | P1  | 4   | 🟡     |
| VUE-14 | Kill-switch «sólo ventas» o «todo» saca al proveedor de la búsqueda en ≤10 s en todas las réplicas                                                                    | H     | P0  | 2   | 🟡     |
| VUE-15 | Cuota por hora del nodo agotada → 403 con mensaje                                                                                                                     | H     | P2  | 2   | 🟡     |
| VUE-16 | Plataforma no vende: superadmin ve el aviso en `/cotizaciones`                                                                                                        | E     | P1  | 3   | ⬜     |

### 5.9 CHK · Checkout de vuelo (`/cotizaciones/[id]`)

| ID     | Caso                                                                                                                                                                                               | Nivel | Pri | Ola | Estado |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --- | --- | ------ |
| CHK-01 | Elegir tarifa → pasajero → «Reservar» → «Confirmada» en <2 min (Sabre CERT)                                                                                                                        | R     | P0  | 1   | ✅     |
| CHK-02 | Lo mismo con proveedor falso en CI, cronometrado (F27)                                                                                                                                             | E     | P0  | 4   | ⬜     |
| CHK-03 | Revalidación al abrir: «Precio confirmado»; vale 5 min, después «Reservar» revalida antes                                                                                                          | E     | P1  | 4   | ⬜     |
| CHK-04 | Precio cambia al revalidar: aviso ámbar, botón «Aceptar y reservar»; aceptar reserva al precio nuevo                                                                                               | E     | P0  | 4   | ⬜     |
| CHK-05 | Precio cambia entre revalidar y reservar → 409 del servidor; la UI revalida y vuelve a preguntar, nunca reserva al precio viejo                                                                    | H + E | P0  | 4   | 🟡     |
| CHK-06 | El servidor ignora el `pricing` que manda el cliente y recalcula desde BD (cliente manda total rebajado → se cobra el real)                                                                        | H     | P0  | 2   | 🟡     |
| CHK-07 | Pasajeros: cantidad y tipos ≠ búsqueda → 400; edad del niño según nacimiento ≠ la buscada → 400; moneda distinta → 400; ruta/fechas distintas → 400; oferta de otra agencia → 400                  | H     | P0  | 2   | 🟡     |
| CHK-08 | Formulario: nombre, apellido, nacimiento (formato, año <1900, fecha inexistente, futura), documento, vencimiento de pasaporte obligatorio con tipo P; resumen «Faltan N datos» con «Ir al primero» | E     | P1  | 3   | ⬜     |
| CHK-09 | Huecos del formulario (QA-H-13): sin regla de caracteres ni largo en nombres, sin chequeo de edad vs ADT/CHD/INF, vencimiento de pasaporte pasado aceptado, nacionalidad no validada contra ISO    | E + H | P1  | 3   | ⬜     |
| CHK-10 | Pasajeros duplicados (mismo documento o mismo nombre) → error                                                                                                                                      | E     | P1  | 3   | ⬜     |
| CHK-11 | «Buscar cliente registrado» llena la tarjeta; «Guardar pasajeros en Clientes» hace upsert y si el CRM tarda >8 s no bloquea la reserva                                                             | E     | P2  | 4   | ⬜     |
| CHK-12 | Facturación: nombre ≥2, documento ≥3, correo válido, teléfono ≥5, prefijo 1–3 dígitos, país ISO; «Guardar facturación» y aviso de lo que falta para la factura                                     | E + H | P1  | 3   | ⬜     |
| CHK-13 | Compartir: correo (deshabilitado sin email; llega a Mailpit), WhatsApp (requiere teléfono), copiar enlace, PDF (200, `application/pdf`)                                                            | E     | P1  | 3   | 🟡     |
| CHK-14 | Idempotencia: doble clic en «Reservar» o reintento tras perder la respuesta → una sola reserva; segundo intento → 409 «ya fue recibida»                                                            | H + E | P0  | 2   | 🟡     |
| CHK-15 | Resultados de la saga: CONFIRMED, PARTIAL, PENDING, UNCERTAIN (5xx o sin JSON), FAILED; el formulario vuelve sólo en FAILED                                                                        | E     | P0  | 4   | ⬜     |
| CHK-16 | Un 501 `SabreOperationNotSupportedError` al crear se muestra como «Creación incierta» aunque no salió nada (QA-H-14)                                                                               | E     | P1  | 4   | ⬜     |
| CHK-17 | Cartera sin saldo, cartera suspendida, red sin moneda: no reserva, no retiene, muestra el motivo y «Ir a Cartera B2B»                                                                              | E     | P0  | 4   | 🟡     |
| CHK-18 | Proveedor ocupado → 429 «no se envió a la aerolínea» y se puede reintentar                                                                                                                         | H     | P1  | 2   | 🟡     |
| CHK-19 | Asientos (Sabre con `seats`): sólo gratis, sin infantes en regazo, quitar/cambiar; si el precio cambia se descartan; la aerolínea no confirma el asiento → aviso tras reservar                     | E + R | P1  | 4   | 🟡     |
| CHK-20 | El cuerpo con `payment` → 400 (strict)                                                                                                                                                             | H     | P0  | 2   | 🟡     |
| CHK-21 | Cotización vencida (`expiresAtSource=provider`) muestra «Precio expirado» y obliga a buscar de nuevo                                                                                               | E     | P2  | 4   | ⬜     |
| CHK-22 | Correo de confirmación sólo si la saga quedó confirmada y no es tarifa de prueba                                                                                                                   | H     | P1  | 2   | 🟡     |

### 5.10 POS · Reservas y posventa (`/reservas`, `/reservas/[id]`)

| ID     | Caso                                                                                                                                                                                                   | Nivel | Pri | Ola | Estado |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | --- | --- | ------ |
| POS-01 | Lista: búsqueda por #, código, pasajero o ruta; chips de vertical y estado; «Por vencer · N»; `?orden=` abre el panel                                                                                  | E     | P1  | 3   | ⬜     |
| POS-02 | La lista y las cotizaciones guardadas traen sólo las 100 más nuevas sin paginar (QA-H-15): con 101 la más vieja no aparece                                                                             | H + E | P1  | 2   | ⬜     |
| POS-03 | Los pasajeros salen enmascarados en la lista y en el detalle                                                                                                                                           | H     | P0  | 2   | 🟡     |
| POS-04 | Matriz de capacidades: cada botón aparece sólo si el proveedor lo soporta (tabla Sabre/LATAM/hoteles/AgentCars del inventario); llamar la API igual → 400 «no está disponible»                         | H + E | P0  | 2   | 🟡     |
| POS-05 | Consultar estado: actualiza el seguimiento sin cambiar `orders.status`; cancelada afuera → «figura cancelada en el proveedor»                                                                          | E + R | P1  | 1   | 🟡     |
| POS-06 | Cancelar: confirmación con PNR, «Reserva cancelada», libera la retención; ya cancelada → 409; dos a la vez → una gana                                                                                  | R + H | P0  | 1   | 🟡     |
| POS-07 | Cancelación que falló antes de llegar al proveedor → «Reintentar» desde el historial; incierta → bloquea nuevos intentos con su texto                                                                  | H + E | P0  | 2   | 🟡     |
| POS-08 | Emitir (Sabre con `issue`): 202 y operación; total cambiado → 409; no confirmada → 409; polling 5 s hasta 120 s; dos emisiones → la segunda se bloquea; forma de pago no habilitada por gobierno → 403 | H + E | P0  | 2   | 🟡     |
| POS-09 | Emisión dudosa: `verify-issue` relee a los 2, 10 y 30 min y resuelve a emitida o fallida sin re-emitir                                                                                                 | I     | P0  | 2   | 🟡     |
| POS-10 | Condiciones y anulación (Sabre con `void`): «Se puede anular sin costo» → anula, cancela y libera; fuera de ventana → bloqueado; no verificada → aviso                                                 | H + E | P0  | 2   | 🟡     |
| POS-11 | Servicios adicionales (Sabre con `services`): catálogo, agregar (≤20, índices únicos), quitar; total distinto → 409; ajusta la retención                                                               | H + E | P1  | 2   | 🟡     |
| POS-12 | Editar pasajeros (Sabre con `modify`): documento PASSPORT/NATIONAL_ID 4–20, país ISO, vencimiento futuro ≤20 años, viajero frecuente, SSR de la lista cerrada; infante sin FF ni SSR                   | H + E | P1  | 2   | 🟡     |
| POS-13 | Pagar LATAM: opciones según gobierno; enlace de pago al correo del pagador (409 si ya está pagada); efectivo/BSP/GOV; sin opciones → aviso                                                             | H + E | P1  | 2   | 🟡     |
| POS-14 | `POST /orders/:id/payment-link` no tiene ningún test                                                                                                                                                   | H     | P1  | 2   | ⬜     |
| POS-15 | Reenviar confirmación: necesita PNR, no fallida y correo; llega a Mailpit                                                                                                                              | H + E | P2  | 3   | 🟡     |
| POS-16 | Hotel: voucher PDF, estimado de penalidad antes de cancelar, cancelar                                                                                                                                  | E + R | P1  | 4   | ⬜     |
| POS-17 | Repricing (reshop LATAM) sólo existe en la lista, no en el detalle (QA-H-16)                                                                                                                           | E     | P2  | 4   | ⬜     |
| POS-18 | Plazo de emisión: «Quedan…» y «Plazo vencido»; aviso `OrderTicketingDeadlineApproaching` del barrido                                                                                                   | E + I | P1  | 2   | 🟡     |

### 5.11 SAB · Sabre (contrato y certificación)

> Gating: `SABRE_OPERATIONS` (issue, void, refund, seats, services, modify), vacío por defecto. Rodeo
> H-07 (`bookOnTicketingPcc`) activo. Escenarios CERT en `apps/api/src/providers-sabre/cert-run/` y
> `.github/workflows/sabre-cert-run.yml`.

| ID     | Caso                                                                                                                                                                                                      | Nivel | Pri | Ola | Estado |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --- | --- | ------ |
| SAB-01 | `SABRE_OPERATIONS` con valor desconocido aborta el arranque; vacío apaga todo; cada valor prende sólo su capacidad (segunda defensa en el adapter)                                                        | U     | P0  | 1   | ✅     |
| SAB-02 | El flag `refund` se acepta pero nadie lo lee (QA-H-17)                                                                                                                                                    | U     | P2  | 2   | ⬜     |
| SAB-03 | BFM: OW, RT, multidestino 3 tramos; índices RPH; cabina; PTC por edad (CNN o C02–C11), INF/INS; respuesta parcial MIP/PROCESS                                                                             | U     | P0  | 1   | ✅     |
| SAB-04 | Familias tarifarias, escalera de marcas, degradación upsell → single → off, más tarifas, vueltas ancladas                                                                                                 | U     | P1  | 1   | ✅     |
| SAB-05 | Flight Check (revalidación ATPCO): precio distinto (H-04), alternativa misma cabina; LCC → rechazo                                                                                                        | U + R | P0  | 1   | 🟡     |
| SAB-06 | Crear reserva: mapeo de pasajeros (CHD→CNN, P→PASSPORT, CC/DNI→NATIONAL*ID_CARD, CE→ALIEN_RESIDENT, INF→INFANT*\*), limpieza de nombres/documento/teléfono, 4 resultados CONFIRMED/PARTIAL/PENDING/FAILED | U     | P0  | 1   | ✅     |
| SAB-07 | Documento sin vencimiento (cédula) → se omite el bloque de documentos completo: el pasajero viaja sin APIS (decisión aceptada; caso que la documenta)                                                     | U     | P1  | 2   | 🟡     |
| SAB-08 | Rodeo H-07: la reserva sale con `targetPcc` = PCC de emisión y deja el log `h07_workaround`; con el flag apagado vuelve a la oficina propia                                                               | U + R | P0  | 1   | 🟡     |
| SAB-09 | **Cierre de H-07:** cuando Sabre active el TJR, correr `sab-12` con el flag apagado, luego quitar `bookingLane` y el campo del panel                                                                      | R     | P0  | 5   | ⬜     |
| SAB-10 | Reserva con niño e infante en CERT (pendiente de H-07)                                                                                                                                                    | R     | P0  | 5   | ⬜     |
| SAB-11 | Marca/fare basis por tramo al reservar (doc 15 D5), verificar en CERT tras H-07                                                                                                                           | R     | P1  | 5   | ⬜     |
| SAB-12 | Requisitos de aerolínea (BA ciudadanía y título, AF teléfono/correo de agencia, VISA, FISCAL_ID sin NIT/CPF/RUC)                                                                                          | U     | P1  | 1   | ✅     |
| SAB-13 | Errores de creación: `INVALID_COMBINATION` todavía fuera de la lista de rechazos ciertos (H-02 parcial)                                                                                                   | U     | P1  | 2   | ⬜     |
| SAB-14 | Equipaje y cargos de mano no decodificados (H-03, 100 % de ofertas)                                                                                                                                       | U     | P1  | 2   | ⬜     |
| SAB-15 | Escenario CERT `book-cancel` (sab-12) desde el panel: buscar → reservar → leer → cancelar → leer                                                                                                          | R     | P0  | 1   | ✅     |
| SAB-16 | Escenario CERT `book-issue-void` (sab-13): emitir CASH, chequear tiquetes, VOID dentro de la ventana, leer; incluye el tiquete fantasma de SXGFHO                                                         | R     | P0  | 5   | 🟡     |
| SAB-17 | Escenarios CERT `seatmap` y `book-with-seat` (sab-21): v3 vs v1, sólo gratis, cambio de equipo                                                                                                            | R     | P1  | 5   | ⬜     |
| SAB-18 | Escenario CERT `ancillaries` (sab-21): shop → agregar maleta → leer → EMD → VOID                                                                                                                          | R     | P1  | 5   | ⬜     |
| SAB-19 | Escenario CERT `book-modify` (sab-25): pasaporte + WCHR, luego viajero frecuente, luego cancelar; modificación encadenada exige leer de nuevo                                                             | R     | P1  | 5   | ⬜     |
| SAB-20 | Escenario CERT `book-issue-refund` (sab-24): sólo en el arnés (reembolso no está en la plataforma)                                                                                                        | R     | P2  | 5   | ⬜     |
| SAB-21 | Negativos del doc 20 §8: oferta vencida, saltar price, PCC cruzado, `offerItemId` falso, token inválido, híbrido, >12 documentos                                                                          | U + R | P1  | 5   | 🟡     |
| SAB-22 | Fixtures capturadas que faltan (doc 11 §4.3): create, get emitida, cancel, flightCheck, void, errores; tests de `sabre-offer-price.adapter` y `ancillaries/remove.response.mapper`                        | U     | P1  | 2   | ⬜     |
| SAB-23 | Reserva huérfana: limpiar PNRs sobrantes (STECKS, SXGFHO) y que el arnés salga con código 2 si deja PNRs vivos                                                                                            | R     | P1  | 5   | 🟡     |

### 5.12 LAT · LATAM NDC

| ID     | Caso                                                                                                              | Nivel | Pri | Ola | Estado |
| ------ | ----------------------------------------------------------------------------------------------------------------- | ----- | --- | --- | ------ |
| LAT-01 | GRU→GIG en agencia BRL: LATAM, marca de prueba, sin aviso de descarte                                             | R     | P0  | 1   | ✅     |
| LAT-02 | Reserva sin cobro (BNPL) → «Pendiente de pago» + localizador                                                      | R     | P0  | 1   | ✅     |
| LAT-03 | Diálogo de pago en BRL, «Confirmar pago» deshabilitado sin datos                                                  | R     | P1  | 1   | ✅     |
| LAT-04 | Cancelar BNPL; la lectura posterior (CLOSED sin tiquetes) se ve cancelada (H-09)                                  | R + U | P0  | 1   | ✅     |
| LAT-05 | Pagar y emitir (LATAM-PRUEBA-01): necesita la tarjeta de prueba del sandbox y una decisión sobre PCI              | R     | P0  | 5   | ⬜     |
| LAT-06 | 409 intermitente al cancelar (H-10): reintento seguro y mensaje                                                   | R     | P1  | 5   | ⬜     |
| LAT-07 | Multipasajero 2ADT+1CHD+1INF: búsqueda, desglose y reserva                                                        | U + R | P1  | 5   | ⬜     |
| LAT-08 | Mapeo con fixtures reales grabadas (hoy 1 XML sintético): AirShopping, OfferPrice, OrderCreate, Retrieve, errores | U     | P1  | 2   | ⬜     |
| LAT-09 | Enlace de pago y lectura del plazo de pago (puede tardar ~20 min en aparecer)                                     | R     | P2  | 5   | ⬜     |

### 5.13 HOT · Hoteles (TBO, Despegar)

| ID     | Caso                                                                                                                                                                                                        | Nivel | Pri | Ola | Estado |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --- | --- | ------ |
| HOT-01 | Búsqueda COP: Despegar aparece y su tarifa se muestra como no reservable desde el panel                                                                                                                     | R     | P1  | 1   | ✅     |
| HOT-02 | Búsqueda USD con TBO: «Reservar» → «Tarifa revalidada»; tarifa sólo de paquete detectada y bloqueada                                                                                                        | R     | P0  | 1   | ✅     |
| HOT-03 | Reservar y cancelar con TBO (TBO-PRUEBA-01): bloqueado porque toda tarifa de la cuenta de test es de paquete (Q-31)                                                                                         | R     | P0  | 5   | ⬜     |
| HOT-04 | Formulario de búsqueda: destino o IDs (≤100), fechas (≥1 noche, entrada no pasada), habitaciones ≤8, adultos 1–8, niños ≤6 con edad 0–17, nacionalidad ISO (sin ella se excluyen los que la exigen), moneda | E + H | P1  | 3   | ⬜     |
| HOT-05 | Límites del proveedor (TBO hasta 4 niños) sacan a ese proveedor con su motivo                                                                                                                               | H     | P2  | 2   | 🟡     |
| HOT-06 | Resultados: 20 por tanda, «más», sesión vencida, orden, filtros, mapa                                                                                                                                       | E     | P2  | 4   | ⬜     |
| HOT-07 | Detalle: ventana de oferta 27 min con aviso a los 20; selección guardada 60 min                                                                                                                             | E     | P2  | 4   | ⬜     |
| HOT-08 | Huéspedes: título, nombre/apellido transliterados a ASCII, 2–40, sin números, duplicados; errores del servidor vuelven al campo (`GUESTS_INVALID`)                                                          | E + H | P1  | 3   | ⬜     |
| HOT-09 | Contacto: correo, prefijo, teléfono 4–20 con ≥4 dígitos                                                                                                                                                     | E + H | P1  | 3   | ⬜     |
| HOT-10 | Rechazos previos en orden: prebook por vencer (<30 s), sólo paquete, no reembolsable bloqueado, cargos en el hotel sin aceptar, no reembolsable sin aceptar, total aceptado distinto                        | H     | P0  | 2   | 🟡     |
| HOT-11 | Precio sube → 409 y casilla «Acepto el precio nuevo»; baja → reserva igual y avisa; cambian condiciones → gana condiciones                                                                                  | H + E | P0  | 4   | 🟡     |
| HOT-12 | Idempotencia de `hotels/book`: clave nueva por intento, la misma si se perdió la respuesta; 202 pendiente → polling «Verificando con el proveedor…»                                                         | H + E | P0  | 2   | 🟡     |
| HOT-13 | Verificación (`verify-hotel-booking`) a los 120 s sin re-reservar; HCN cada hora; cancelación en curso releída                                                                                              | I     | P0  | 2   | ✅     |
| HOT-14 | TBO: los 8 casos de certificación (1A CO; 1A1C PE; 2A2C BR; 2 hab. MX; mixtas CL y AR; suplementos EC; detalle por ConfirmationNumber y por BookingReferenceId)                                             | R     | P0  | 5   | 🟡     |
| HOT-15 | TBO: sondas PR-01..PR-11 (edades de niños, MealType, path, ref desconocida, credenciales malas, BookingCode falso, 101 códigos, acentos y ñ, TotalFare +0,01, ref duplicada)                                | R     | P1  | 5   | 🟡     |
| HOT-16 | Despegar: reserva con cuenta de bóveda, cancelación en 3 pasos con cotización, solicitudes especiales, comisión entre mín. y máx., salto de precio y recuperación                                           | R     | P1  | 5   | ⬜     |
| HOT-17 | Despegar: tests de mapeo en el paquete (hoy 0) y errores PRODUCT_GONE, INVALID_PREBOOK_ID, NOT_ENOUGH_BALANCE, 429                                                                                          | U     | P1  | 2   | ⬜     |
| HOT-18 | Conciliación diaria de hoteles: corrida manual (202, `RECONCILIATION_RUNNING` si ya corre), discrepancias listadas                                                                                          | I + H | P1  | 2   | 🟡     |

### 5.14 AUT · Autos (AgentCars)

| ID     | Caso                                                                                                                                  | Nivel | Pri | Ola | Estado |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------- | ----- | --- | --- | ------ |
| AUT-01 | Búsqueda: lugar de la lista, devolver en otro lugar, fecha/hora no pasada, devolución después de recogida, prepago/pago en destino    | E     | P1  | 4   | ⬜     |
| AUT-02 | Conductor: nombre, apellido, correo, edad 18–99 (<25 aviso de conductor joven), vuelo opcional; sesión de 15 min con cuenta regresiva | E     | P1  | 4   | ⬜     |
| AUT-03 | Confirmar ahora vs en espera (no disponible a <48 h de la recogida)                                                                   | E + H | P1  | 4   | ⬜     |
| AUT-04 | Cambio de precio: Antes/Ahora/Diferencia                                                                                              | E     | P1  | 4   | ⬜     |
| AUT-05 | El neto llega del cliente (doc 21 §5.2): el servidor tiene que recalcularlo                                                           | H     | P0  | 2   | ⬜     |
| AUT-06 | Gestionar reserva por apellido + código: consultar, cancelar, liberar; otra agencia no puede (ownership)                              | H + E | P0  | 2   | 🟡     |
| AUT-07 | Barrido de pendientes (`cars-pending`, :07 y :37) resuelve las inciertas                                                              | I     | P1  | 2   | 🟡     |
| AUT-08 | Oficinas y reporte diario: validaciones de distancia, ciudad/coordenadas, país, fecha                                                 | E + H | P2  | 3   | ⬜     |
| AUT-09 | Certificación AgentCars (7 casos MIA/FLL/MCO/CDG/MAD…): bloqueada hasta que registren la IP                                           | R     | P1  | 5   | ⬜     |

### 5.15 PAQ · Paquetes

| ID     | Caso                                                                                                                                        | Nivel | Pri | Ola | Estado |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --- | --- | ------ |
| PAQ-01 | Búsqueda vuelo+hotel BOG→MDE, «Crear cotización», PDF                                                                                       | R     | P1  | 1   | ✅     |
| PAQ-02 | Lo mismo con proveedores falsos e incluyendo auto                                                                                           | E     | P1  | 4   | ⬜     |
| PAQ-03 | Validaciones del constructor (al menos un servicio, destino, origen, fechas, viajeros, ciudad del hotel, ≤9 pasajeros de vuelo)             | E     | P2  | 3   | ⬜     |
| PAQ-04 | API sin ningún test: crear (≤12 ítems, habitaciones 1–6, adultos 1–9, niños 0–17 ≤6), editar, agregar y quitar ítem, aislamiento por tenant | H     | P1  | 2   | ⬜     |
| PAQ-05 | Marcar aceptada, WhatsApp, imprimir, copiar texto; lista de guardados con estados                                                           | E     | P2  | 3   | ⬜     |

### 5.16 COT · Cotizaciones guardadas

| ID     | Caso                                                                                                           | Nivel | Pri | Ola | Estado |
| ------ | -------------------------------------------------------------------------------------------------------------- | ----- | --- | --- | ------ |
| COT-01 | `quote_number` correlativo por agencia sin duplicados bajo concurrencia                                        | I     | P0  | 2   | 🟡     |
| COT-02 | Pestañas por estado y conteos; no hay pestaña «Canceladas» aunque el estado existe (QA-H-18)                   | E     | P2  | 3   | ⬜     |
| COT-03 | Cambios de estado: hoy cualquier transición vale (draft ↔ accepted ↔ cancelled…); definir cuáles se permiten | H     | P1  | 2   | ⬜     |
| COT-04 | Enviar por correo sin email del cliente → 400; sin SMTP configurado → aviso; correo llega con el PDF           | H + E | P1  | 3   | 🟡     |
| COT-05 | GET/PATCH de cotizaciones sin tests a nivel API; aislamiento por tenant                                        | H     | P0  | 2   | ⬜     |

### 5.17 CLI · Clientes y CRM

| ID     | Caso                                                                                                                                   | Nivel | Pri | Ola | Estado |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------- | ----- | --- | --- | ------ |
| CLI-01 | Crear viajero: requeridos, documento; PII cifrada en BD (no legible con SQL directo)                                                   | H + I | P0  | 2   | 🟡     |
| CLI-02 | El modal fija nacimiento 1990-05-15, género M y nacionalidad COL ocultos (QA-H-19)                                                     | E     | P1  | 3   | ⬜     |
| CLI-03 | Editar y borrar no tienen UI alcanzable (QA-H-19); borrar sólo admin (`DELETE` AAR)                                                    | E + H | P1  | 3   | ⬜     |
| CLI-04 | Upsert por documento (el checkout lo usa): no duplica                                                                                  | H     | P1  | 2   | ⬜     |
| CLI-05 | Búsqueda q 2–120, límite 1–25; directorio filtra por nombre, documento y correo                                                        | H + E | P2  | 2   | ⬜     |
| CLI-06 | Oportunidades: crear (título 1–200, pax 1–99, canal), mover de etapa con rollback si falla; valor estimado se manda sin ×100 (QA-H-20) | H + E | P1  | 2   | ⬜     |
| CLI-07 | `GET /crm/opportunities?stage` y `GET /crm/tasks?limit` sin validación                                                                 | H     | P2  | 2   | ⬜     |
| CLI-08 | Tareas, interacciones y reasignar cartera (`reassign_portfolio`): sólo API, sin tests                                                  | H + I | P2  | 2   | ⬜     |
| CLI-09 | Aislamiento: clientes, oportunidades y tareas de otra agencia nunca se ven                                                             | H     | P0  | 2   | ⬜     |

### 5.18 INI · Inicio y reportes

| ID     | Caso                                                                                                                                                 | Nivel | Pri | Ola | Estado |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --- | --- | ------ |
| INI-01 | Panel «Hoy»: plazos vencidos, <24 h, creación trabada >30 min, cotizaciones por vencer, fallidas, cartera bloqueada o baja, proveedor pausado; vacío | E     | P1  | 4   | ⬜     |
| INI-02 | Superadmin en `/` va a `/admin/plataforma/estado`                                                                                                    | E     | P2  | 3   | 🟡     |
| INI-03 | KPIs por moneda; si fallan, «—» y «Sin datos»                                                                                                        | E     | P2  | 3   | ⬜     |
| INI-04 | «Mis Agencias Asignadas» muestra consolidator_admin y agency_admin como «Vendedor / Agente» (QA-H-21)                                                | E     | P2  | 3   | ⬜     |
| INI-05 | Reportes: ventas confirmadas por mes, vertical y vendedor; una moneda a la vez; exportar CSV; vacío; 403 para rol sin permiso                        | E + H | P1  | 3   | 🟡     |
| INI-06 | `/reports/commissions` es un stub (`available:false`)                                                                                                | H     | P2  | 2   | ⬜     |

### 5.19 SUP · Superadmin

| ID     | Caso                                                                                                                                                                                                                                                    | Nivel | Pri | Ola | Estado |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --- | --- | ------ |
| SUP-01 | Vendedor y admin de agencia no entran a `/admin/plataforma/*` ni `/admin/tenants`                                                                                                                                                                       | E     | P0  | 1   | ✅     |
| SUP-02 | Superadmin con nodo activo = agencia: entra a `/admin/plataforma/*` pero `/admin/tenants` lo devuelve a `/` (QA-H-22)                                                                                                                                   | E     | P2  | 3   | ⬜     |
| SUP-03 | Estado, Salud, Resumen (período hoy/7d/30d/mes, `?nodo=`), Sistema: cargan, refrescan, errores legibles                                                                                                                                                 | E     | P2  | 3   | 🟡     |
| SUP-04 | Actividad: filtros (categoría, nodo, correo, fechas, tipo, entidad), período máx. 92 días, «Cargar más», exportar CSV (step-up, máx. 5000)                                                                                                              | E + H | P1  | 3   | 🟡     |
| SUP-05 | Anuncios: crear (gravedad, título 3–120 limpio, mensaje ≤600, audiencia toda la red o un nodo, sólo admins, ventana ≤31 días y fin futuro), editar, archivar; el crítico no se puede ocultar; la audiencia correcta lo ve                               | E + H | P1  | 3   | 🟡     |
| SUP-06 | Anuncio vencido se puede editar en la UI y la API lo rechaza (QA-H-23)                                                                                                                                                                                  | E     | P2  | 3   | ⬜     |
| SUP-07 | Reservas de plataforma: filtros, búsqueda ≥2, «Requieren atención», abrir detalle registra `platform.order.viewed`, exportar CSV (step-up, >5000 → 422)                                                                                                 | E + H | P1  | 3   | 🟡     |
| SUP-08 | Acciones sobre reservas con motivo 5–500: consultar, reenviar, reintentar, cancelar con número de orden («1042» o «#1042», distinto → 400); cada intento audita                                                                                         | H + E | P0  | 2   | 🟡     |
| SUP-09 | Cola de depósitos: estado, alcance (Planetour / otros / toda la red), moneda, búsqueda; aprobar/rechazar sólo lo que financia la plataforma                                                                                                             | E + H | P0  | 3   | 🟡     |
| SUP-10 | Kill-switch: «sólo ventas» o «todo», vencimiento 1/4/24 h o sin vencimiento, motivo 5–500, escribir el código para confirmar; vence solo; reanudar (con puerta); el de variable de entorno no se puede reanudar desde el panel                          | E + H | P0  | 2   | 🟡     |
| SUP-11 | Cerrar circuito con motivo; salud se refresca cada 30 s                                                                                                                                                                                                 | E + H | P1  | 3   | 🟡     |
| SUP-12 | Habilitación global y excepciones por nodo (Heredar/Habilitado/Deshabilitado, con motivo); la búsqueda del nodo respeta la cadena                                                                                                                       | H + E | P0  | 2   | 🟡     |
| SUP-13 | Gobierno sin ningún test: perfiles (crear, editar, duplicar, archivar, predeterminado), nombre 2–80, ítems ≤200 del catálogo, duplicado → 400, nombre repetido → 409, archivar asignado → 409                                                           | H     | P0  | 2   | ⬜     |
| SUP-14 | Reglas globales y por nodo de formas de pago; asignar perfil a un nodo; la matriz efectiva y el checkout/emisión obedecen (forma no habilitada → 403)                                                                                                   | H + E | P0  | 2   | ⬜     |
| SUP-15 | Usuarios de plataforma: filtros (rol, nodo, activos, suspendidos, sin 2FA, bloqueados, nunca ingresaron), exportar (step-up, 5/min)                                                                                                                     | E + H | P1  | 3   | 🟡     |
| SUP-16 | Suspender en toda la plataforma (step-up, con puerta): impacto previo, revoca sesiones e invitaciones; no a sí mismo; último superadmin → 409                                                                                                           | H + E | P0  | 2   | 🟡     |
| SUP-17 | Superadmins: dar acceso (supervisado o pleno, correo existente o «Crear cuenta y dar acceso»), hacer pleno/supervisado, quitar acceso; no a sí mismo; último pleno → 409; todo con step-up                                                              | H + E | P0  | 2   | 🟡     |
| SUP-18 | Solicitudes de cambio: el supervisado pide → 409 pendiente; un pleno aprueba (step-up) y se aplica **como el solicitante** con `approval` en la auditoría; no aprueba la propia; rechazar; cancelar sólo el solicitante; si falla al aplicar → `failed` | H + E | P0  | 2   | 🟡     |
| SUP-19 | El 409 «quedó como solicitud» se muestra como error en Proveedores, Gobierno, Agencias y Usuarios (sólo Superadmins lo trata como aviso) (QA-H-24)                                                                                                      | E     | P1  | 3   | ⬜     |
| SUP-20 | El supervisado se salta la puerta al crear un nodo con `governanceProfileId` y puestos (QA-H-25)                                                                                                                                                        | H     | P0  | 2   | ⬜     |
| SUP-21 | Nota de decisión: el BFF exige 3–500 y la API 1–500 (QA-H-26); rechazar y cancelar no piden step-up, aprobar sí                                                                                                                                         | H     | P2  | 2   | ⬜     |
| SUP-22 | Dar acceso supervisado a un correo inexistente queda como solicitud y falla recién al aprobar (QA-H-27)                                                                                                                                                 | H     | P2  | 2   | ⬜     |
| SUP-23 | Agencias: árbol, búsqueda, crear (los 4 tipos, defaults CO/COP/es), suspender (impacto, motivo 5–500, con puerta), sucursal, mover (ciclo, reservas abiertas → 409, revoca sesiones), cambio de tipo con reservas abiertas → 409                        | H + E | P0  | 2   | 🟡     |
| SUP-24 | Nodo: proveedores, gobierno, «Tarifas en otra moneda» (sin confirmación, QA-H-28), resumen, carteras, puestos (1–10000 o heredar; inactividad 5–480)                                                                                                    | E + H | P1  | 3   | 🟡     |
| SUP-25 | Listados de solicitudes de cambio sin paginar (máx. 100)                                                                                                                                                                                                | H     | P2  | 2   | ⬜     |

### 5.20 JOB · Colas y procesos programados

| ID     | Caso                                                                                                                                                                                                                          | Nivel | Pri | Ola | Estado |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --- | --- | ------ |
| JOB-01 | `post-sale-retry`: cada job (cancel, verify-creation, compensate, verify-hotel-booking, verify-cancellation, hcn-check, issue sin reintentos, verify-issue, reconcile-\*) con ids deterministas: encolar dos veces no duplica | I     | P0  | 2   | 🟡     |
| JOB-02 | Barrido de 15 min: re-encola lo que la cola perdió (matar el worker a mitad y comprobar que se retoma), emite `system.post_sale_sweep.completed`                                                                              | I     | P0  | 2   | 🟡     |
| JOB-03 | Sin Redis: los procesos corren con temporizadores del proceso (primer barrido a 60 s)                                                                                                                                         | I     | P1  | 2   | ⬜     |
| JOB-04 | Purga diaria de payloads de proveedor (`SKIP LOCKED`), 404 al pedir uno vencido                                                                                                                                               | I + H | P1  | 2   | 🟡     |
| JOB-05 | Kill-switch releído cada 10 s por réplica; caché de búsqueda y `last_seen` cada 60 s                                                                                                                                          | I     | P2  | 2   | ⬜     |
| JOB-06 | Sistema → Procesos marca «Atrasada» cuando un job no corrió a tiempo                                                                                                                                                          | E     | P2  | 3   | ⬜     |

### 5.21 SQL · Funciones de base con lógica de negocio sin tests directos

| ID     | Caso                                                                                                                                    | Nivel | Pri | Ola | Estado |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------- | ----- | --- | --- | ------ |
| SQL-01 | `enforce_platform_role_scope`: un admin de agencia no puede escalar a rol de plataforma por ninguna vía                                 | I     | P0  | 2   | ⬜     |
| SQL-02 | `accept_invitation`: invitación válida, vencida, revocada, usada, de quien ya no puede invitar                                          | I     | P0  | 2   | ⬜     |
| SQL-03 | Guardas de carteras: `portfolio_transactions_financier_guard`, `portfolio_deposit_reports_guard`, `agency_portfolios_balance_guard`     | I     | P0  | 2   | ⬜     |
| SQL-04 | `revoke_user_sessions_for_tenant` (suspender miembro cierra sus sesiones en el subárbol)                                                | I     | P0  | 2   | ⬜     |
| SQL-05 | `applicable_markup_rules`, `tenants_enforce_hierarchy`, `tenants_maintain_path`                                                         | I     | P1  | 2   | ⬜     |
| SQL-06 | `governance_chain`, `governance_bootstrap`, `resolve_tenant_branding`, `resolve_tenant_by_host`, `audit_direct_change`, `is_admin_user` | I     | P1  | 2   | ⬜     |
| SQL-07 | `orders_provider_booking_ref_immutable`: el localizador del proveedor no se puede reescribir                                            | I     | P0  | 2   | ⬜     |
| SQL-08 | Funciones `wallet_hold_*` con 1–2 tests (adjust, preview, decide, chain, level_cost, net, mark_conflict, uncapture_on_retract)          | I     | P1  | 2   | 🟡     |

### 5.22 NFR · No funcionales mínimos

| ID     | Caso                                                                                                         | Nivel | Pri | Ola | Estado |
| ------ | ------------------------------------------------------------------------------------------------------------ | ----- | --- | --- | ------ |
| NFR-01 | Tiempo a venta <2 min (vuelo con proveedor falso en CI; con Sabre CERT en la Mac)                            | E + R | P0  | 4   | 🟡     |
| NFR-02 | Búsqueda de hoteles responde en la ola de 8 s aunque un proveedor tarde más                                  | H     | P1  | 4   | 🟡     |
| NFR-03 | Apagado ordenado: la API drena las reservas en vuelo antes de cerrar                                         | I     | P1  | 2   | ⬜     |
| NFR-04 | Health: 503 si cae la BD; el deploy no sigue si `/api/health` falla                                          | H     | P1  | 2   | 🟡     |
| NFR-05 | Sin límite de tamaño de cuerpo configurado en la API (Express por defecto): un POST de 5 MB no debe tumbarla | H     | P2  | 2   | ⬜     |

---

## 6. Hallazgos del inventario (por confirmar con su caso)

Salieron de leer el código. Ninguno se corrigió todavía: el caso de la última columna lo confirma; si
falla, se abre el arreglo.

| ID      | Grav. | Qué                                                                                                                                                                                                                                                                                                | Dónde (aprox.)                                                         | Caso           |
| ------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------- |
| QA-H-01 | Media | `:id` sin validar como UUID → Postgres 22P02 → 500 en ~10 rutas                                                                                                                                                                                                                                    | orders, quotations, customers, crm, packages, pricing, hotels, tenants | TRV-08         |
| QA-H-02 | Media | `helmet()` con valores por defecto: sin CSP ni HSTS propios, contra lo que pide CLAUDE.md                                                                                                                                                                                                          | `apps/api/src/main.ts`                                                 | TRV-14         |
| QA-H-03 | Alta  | `POST /api/admin/tenants` y `/move` se saltan el chequeo de origen y la reconstrucción del cuerpo del BFF                                                                                                                                                                                          | `apps/web-b2b/src/app/api/admin/tenants/**`                            | TRV-15         |
| QA-H-04 | Baja  | Contraseña >128 en `/restablecer` dice «enlace usado o venció»                                                                                                                                                                                                                                     | `restablecer/actions.ts`                                               | ACC-24         |
| QA-H-05 | Baja  | `/verificar` muestra el error de la API en inglés                                                                                                                                                                                                                                                  | `verificar/verify-client.tsx`                                          | ACC-25         |
| QA-H-06 | Baja  | `/configuracion` sin guarda de rol; al guardar, error genérico que pierde el motivo                                                                                                                                                                                                                | `configuracion/page.tsx`                                               | AGE-03         |
| QA-H-07 | Media | Teléfono de soporte no E.164 se guarda (el servidor sólo pide 4–40) y después bloquea reservar hoteles                                                                                                                                                                                             | `support-contact-card.tsx`, `branding.schemas.ts`                      | AGE-05         |
| QA-H-08 | Baja  | Campo «Dominio personalizado (CNAME)» no guarda nada                                                                                                                                                                                                                                               | `configuracion/page.tsx`                                               | AGE-07         |
| QA-H-09 | Baja  | `/red` sin guarda de página                                                                                                                                                                                                                                                                        | `red/page.tsx`                                                         | RED-07         |
| QA-H-10 | Media | `POST /pricing/rules` y `/pricing/waterfall` sin Zod: `ruleType` malo → 403, negativo se trunca, vertical libre                                                                                                                                                                                    | `pricing/pricing.controller.ts`                                        | RED-09         |
| QA-H-11 | Media | Borrar regla de pricing sin confirmación ni manejo de error; el simulador se traga los errores                                                                                                                                                                                                     | `red/page.tsx` (PricingModal)                                          | RED-10, RED-11 |
| QA-H-12 | Media | La API no limita el total de pasajeros a 9 (sólo cada tipo)                                                                                                                                                                                                                                        | `packages/canonical/src/pax.ts`                                        | VUE-06         |
| QA-H-13 | Alta  | Pasajero de vuelo: sin reglas de caracteres/largo, sin edad vs tipo, pasaporte vencido aceptado, país sin ISO; en el servidor los pasajeros son JSON libre hasta el ACL                                                                                                                            | `passenger-form.tsx`, `orders/dto.ts`                                  | CHK-09         |
| QA-H-14 | Media | Un 501 al crear se muestra como «Creación incierta» aunque no se envió nada                                                                                                                                                                                                                        | `create-order-reconciliation.ts:125`                                   | CHK-16         |
| QA-H-15 | Media | `/reservas` y cotizaciones guardadas sin paginación: tope de 100                                                                                                                                                                                                                                   | `orders.service.ts`, `quotations.service.ts`                           | POS-02         |
| QA-H-16 | Baja  | Repricing (LATAM) sólo en la lista de reservas, no en el detalle                                                                                                                                                                                                                                   | `reservas/page.tsx`                                                    | POS-17         |
| QA-H-17 | Baja  | `SABRE_OPERATIONS=refund` se acepta pero no hace nada                                                                                                                                                                                                                                              | `sabre.factory.ts:214`                                                 | SAB-02         |
| QA-H-18 | Baja  | Sin pestaña «Canceladas» en cotizaciones guardadas                                                                                                                                                                                                                                                 | `cotizaciones/guardadas/page.tsx`                                      | COT-02         |
| QA-H-19 | Media | Clientes: nacimiento, género y nacionalidad fijos y ocultos; editar y borrar sin UI                                                                                                                                                                                                                | `clientes/ClientesClient.tsx`                                          | CLI-02, CLI-03 |
| QA-H-20 | Media | Valor estimado de la oportunidad sin pasar a unidades menores                                                                                                                                                                                                                                      | `clientes/ClientesClient.tsx`                                          | CLI-06         |
| QA-H-21 | Baja  | Inicio etiqueta consolidator_admin y agency_admin como «Vendedor / Agente»                                                                                                                                                                                                                         | `(app)/page.tsx:309`                                                   | INI-04         |
| QA-H-22 | Baja  | `/admin/plataforma` mira a la persona y `/admin/tenants` al nodo activo                                                                                                                                                                                                                            | layouts de `admin/plataforma` y `admin/tenants`                        | SUP-02         |
| QA-H-23 | Baja  | Anuncio vencido editable en la UI, rechazado por la API                                                                                                                                                                                                                                            | `announcements-panel.tsx`                                              | SUP-06         |
| QA-H-24 | Media | «Tu cambio quedó como solicitud» (409) se muestra como error salvo en Superadmins                                                                                                                                                                                                                  | Proveedores, Gobierno, Agencias, Usuarios                              | SUP-19         |
| QA-H-25 | Alta  | El superadmin supervisado asigna perfil de gobierno y puestos al crear un nodo sin pasar por la puerta                                                                                                                                                                                             | `POST /admin/tenants`                                                  | SUP-20         |
| QA-H-26 | Baja  | Nota de decisión: BFF 3–500, API 1–500                                                                                                                                                                                                                                                             | `platform-admins.ts` (BFF)                                             | SUP-21         |
| QA-H-27 | Baja  | Dar acceso supervisado a correo inexistente falla recién al aprobar                                                                                                                                                                                                                                | `supervision.service.ts`                                               | SUP-22         |
| QA-H-28 | Baja  | «Tarifas en otra moneda» cambia sin confirmación                                                                                                                                                                                                                                                   | `foreign-currency-fares-card.tsx`                                      | SUP-24         |
| QA-H-29 | Alta  | Neto de autos llega del cliente (ya en doc 21 §5.2)                                                                                                                                                                                                                                                | `cars/*`                                                               | AUT-05         |
| QA-H-30 | Alta  | Reservas de hotel Despegar: `:id` es el id del proveedor y va directo al ACL sin chequear que la reserva sea de la agencia; un id inexistente sale como 502 en vez de 404                                                                                                                          | `hotels/despegar-hotel-reservations.service.ts`                        | TRV-08, TRV-06 |
| QA-H-31 | Alta  | CRM: una oportunidad, interacción o tarea acepta el cliente, la oportunidad o el vendedor de OTRA agencia (las FK no miran el tenant)                                                                                                                                                              | `crm/*.service.ts`                                                     | CLI-09         |
| QA-H-32 | Alta  | Paquetes: aceptan el cliente de otra agencia, fechas que no existen (2027-02-31) y regreso antes de la ida                                                                                                                                                                                         | `packages/packages.schemas.ts`, `packages.service.ts`                  | PAQ-04         |
| QA-H-33 | Media | Fechas que no son fecha («mañana», «nunca») en tareas, oportunidades y paquetes terminan en 500                                                                                                                                                                                                    | `crm/crm.schemas.ts`, `packages/packages.schemas.ts`                   | CLI-07, PAQ-04 |
| QA-H-34 | Alta  | Logo SVG: sólo se revisaban los primeros 512 bytes y 3 patrones; un script tardío, un `onclick`, un `foreignObject` o un `href` a `javascript:` pasaban                                                                                                                                            | `storage/brand-assets.controller.ts`                                   | AGE-06         |
| QA-H-35 | Media | Límite de cuerpo de Express (100 KB): un logo de más de ~75 KB no se puede subir, y el 413 del parser (o un JSON roto) sale como 500                                                                                                                                                               | `main.ts`, `all-exceptions.filter.ts`                                  | AGE-06, NFR-05 |
| QA-H-36 | Baja  | Un UUID mal formado en la query (`?tenantId=abc`) sale como 500                                                                                                                                                                                                                                    | `all-exceptions.filter.ts`                                             | RED-13         |
| QA-H-37 | Baja  | Borrar una regla de pricing de otro nodo responde 200 `{deleted:false}`: no borra, pero el panel lo lee como hecho                                                                                                                                                                                 | `pricing/pricing.controller.ts`                                        | RED-10         |
| QA-H-38 | Media | Los logos no funcionan en ningún ambiente: el api escribe en `/var/lib/sales-travel/blobs` sin volumen ni permiso (EACCES) y ni Caddy ni el panel sirven `/blobs/*`                                                                                                                                | `docker-compose.*.yml`, `Caddyfile`, `local-disk-storage.adapter.ts`   | AGE-06         |
| QA-H-39 | Alta  | CRM: oportunidades e interacciones abrían la transacción sin el usuario (`withTenant`), así que la RLS de 0031 no sabía quién pedía: una oportunidad asignada no la veía nadie (ni el admin), no se podía crear (500) y desaparecía al asignarla                                                   | `crm/crm-opportunities.service.ts`, `crm-interactions.service.ts`      | CLI-06, CLI-08 |
| QA-H-40 | Alta  | Traspaso de cartera: `reassign_portfolio` (SECURITY DEFINER) no mira el destino; un admin podía pasar oportunidades y tareas a un vendedor de otra agencia                                                                                                                                         | `crm/crm-tasks.service.ts`                                             | CLI-08         |
| QA-H-41 | Baja  | Un vendedor que asigna una oportunidad a otro choca contra la RLS y recibe 500; el traspaso a sí mismo respondía 403 en vez de 400                                                                                                                                                                 | `crm/crm-opportunities.service.ts`, `crm-tasks.controller.ts`          | CLI-06, CLI-08 |
| QA-H-42 | Media | `accept_invitation` (0028), sin uso desde 0056, seguía SECURITY DEFINER y ejecutable: marcaba aceptada cualquier invitación por id, de cualquier nodo y sin mirar vencimiento; 17 funciones SECURITY DEFINER más las podía ejecutar PUBLIC                                                         | `db/migrations/0028`, `0056`                                           | SQL-02         |
| QA-H-43 | Media | Marca blanca: una agencia sin nombre comercial propio salía con el del consolidador en el PDF y el correo de sus cotizaciones (`resolve_tenant_branding` heredaba el nombre aunque 0030 decía que no)                                                                                              | `db/migrations/0030`                                                   | AGE-08         |
| QA-H-44 | Baja  | `is_admin_user()` (0013), sin uso desde 0020, seguía SECURITY DEFINER: «admin en cualquier nodo», peligrosa si se reusa en una política; la guarda de 0099 la dejaba pasar porque un comentario la nombraba                                                                                        | `db/migrations/0013`, `security-definer.integration.test.ts`           | SQL-06         |
| QA-H-45 | Baja  | `airports` sin RLS y con escritura para `app_user`: el `GRANT SELECT` de 0003 no quitó el INSERT/UPDATE/DELETE por defecto de 0001 (como 0041 con hoteles); sólo la escribe el sync como `postgres`                                                                                                | `db/migrations/0003`, `tablas-sin-rls.integration.test.ts`             | TRV-07         |
| QA-H-46 | Alta  | La tarjeta digitada de LATAM (`card`, PAN y CVV por nuestro servidor, fuera de PCI SAQ-A) quedó ENCENDIDA en «Configuración vigente», aunque la doc 17 dice «apagada salvo que el superadmin la encienda» y CLAUDE.md exige sólo checkout alojado en fase 1. Por confirmar en producción y decidir | `governance_bootstrap` (siembra), doc 17 §6                            | SUP-14         |
| QA-H-47 | Baja  | Los botones y textos de acción en rojo fijo (`text-red-600/700`, «Cancelar reserva» y otros) no llegan al contraste AA en modo oscuro; F26 lo vio en /reservas móvil oscuro en cuanto hubo reservas en la lista                                                                                    | `reservas/page.tsx` y 6 pantallas más                                  | TRV-18         |

### 6.1 Mejoras que salen de probar

Probar también es evaluar la funcionalidad. Lo que no es un bug pero conviene mejorar va acá, con
cuándo conviene hacerlo. Las chicas y sin riesgo se hacen en el momento, junto al arreglo; las que
cambian el producto o piden una decisión quedan propuestas.

| ID      | Grav.  | Qué                                                                                                                                                                                                                                                                                                                   | Dónde (aprox.)                                                  | Caso           |
| ------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------- |
| QA-M-01 | Mejora | Llevar a la base la regla «lo que referencio es de mi agencia» (FK compuestas `(tenant_id, id)` o un trigger) en vez de chequearla en cada servicio. Cuándo: migración de la Ola 3                                                                                                                                    | `db/migrations`, `crm/crm-references.ts`                        | CLI-09, PAQ-04 |
| QA-M-02 | Mejora | Logos de verdad: volumen persistente, `/blobs/*` servido por Caddy con `Content-Security-Policy: default-src 'none'` y `nosniff`, y después MinIO/S3 detrás del mismo puerto. Cuándo: el próximo deploy al VPS                                                                                                        | `infrastructure/*`, `storage/*`                                 | AGE-06         |
| QA-M-03 | Mejora | Una sola definición de «fecha» y «día de calendario» en `packages/validation`, usada por CRM, paquetes, cotizaciones, clientes y órdenes (hoy cada módulo tiene la suya)                                                                                                                                              | `packages/validation`                                           | CLI-07, PAQ-04 |
| QA-M-04 | Mejora | Cotizaciones con estados permitidos (borrador → enviada → aceptada/vencida/cancelada) en vez de cualquier transición. Necesita decisión del founder                                                                                                                                                                   | `quotations/*`                                                  | COT-03         |
| QA-M-05 | Mejora | ¿Despegar sólo con la cuenta del consolidador, como TBO (D-TBO-03 A)? Hoy cualquier agencia puede cargar la suya. Necesita decisión del founder (va con QA-H-30)                                                                                                                                                      | `provider-forms.ts`, `despegar-hotels.factory.ts`               | BYO-06         |
| QA-M-06 | Mejora | Reporte de comisiones: `/reports/commissions` responde `available:false`. Necesita el modelo de comisión del vendedor (pricing waterfall) y decisión de cuándo                                                                                                                                                        | `reports.service.ts`                                            | INI-06         |
| QA-M-07 | Mejora | Buscar en el servidor en Reservas y Cotizaciones guardadas: hoy el filtro es del lado del panel sobre las que cargó (hasta 1000). Cuándo: cuando una agencia pase las 1000                                                                                                                                            | `orders.service.ts`, `quotations.service.ts`                    | POS-02         |
| QA-M-08 | Mejora | Un supervisado puede ENCENDER el kill-switch de un proveedor (`PUT /admin/providers/:code/kill-switch`) y duplicar un perfil de gobierno sin pasar por la puerta; apagarlo (`clear`) sí la tiene. ¿Es a propósito (emergencia) o debe quedar como solicitud? Necesita decisión del founder                            | `provider-enablement.controller.ts`, `governance.controller.ts` | TRV-12         |
| QA-M-09 | Mejora | Un ajuste (débito) del financiador no tiene tope: deja la cartera muy por debajo de cero y de su cupo (probado: −3·10¹² sin error). `PORTFOLIO_BALANCE_OUT_OF_RANGE` sólo sale al liberar una retención. ¿Se topa el débito al saldo disponible o se deja libre por ser una corrección? Necesita decisión del founder | `wallet-financing.service.ts`                                   | CAR-03         |

---

## 7. Olas

| Ola | Qué entra                                                                                                                                                                                                         | Casos | Necesita            | Corre en       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------- | -------------- |
| 1   | **Hecha (en parte).** Login/MFA, alta de nodo, roles, 375 px, axe; venta real Sabre/LATAM/TBO/paquete (`@real`); contrato de Sabre                                                                                | 30    | —                   | CI + Mac       |
| 2   | **Arnés HTTP + seed por rol.** Toda la matriz de permisos (TRV-01..16), validaciones y errores de la API, idempotencia, step-up, supervisión, aislamiento, SQL sin tests, colas, hallazgos QA-H-01/03/10/12/25/29 | 138   | INF-1, INF-2, INF-5 | CI             |
| 3   | **E2E de administración con Mailpit.** Acceso completo (invitación, restablecer, puestos, `next`), Mi cuenta, Mi agencia, Equipo, Red, Carteras, Superadmin, formularios campo por campo, 375 px y axe en todo    | 89    | INF-3, INF-6        | CI             |
| 4   | **Venta en CI con proveedores falsos.** Vuelos (OW/RT/multi), checkout con cambio de precio y los 5 resultados, posventa, hoteles, autos, paquetes, Inicio; tiempo a venta                                        | 34    | INF-4               | CI             |
| 5   | **Sandbox y certificación.** Cierre de H-07 y escenarios CERT de Sabre, 8 casos + sondas TBO, Despegar, AgentCars (IP), arnés y pago LATAM                                                                        | 19    | INF-7 + terceros    | Mac / workflow |

**Ritmo sugerido:** la Ola 2 primero porque cubre más con menos mantenimiento (sin selectores) y
protege lo más grave (permisos, dinero, aislamiento). La Ola 3 puede empezar en paralelo apenas exista
Mailpit en el stack E2E. La Ola 4 depende de INF-4, que también desbloquea demos sin sandbox.

---

## 8. Qué queda manual o fuera

- **Pagos con tarjeta** (LATAM card, Despegar con token): fuera de PCI SAQ-A en fase 1. Sólo enlace de
  pago o efectivo/BSP hasta que el founder decida.
- **Reembolsos y cambios (exchange):** no existen en la plataforma; sólo el arnés CERT de Sabre prueba
  el reembolso.
- **Emisión real en Sabre CERT:** manual por `sabre-cert-run.yml` hasta cerrar H-07.
- **Facturación electrónica, Stripe/Mercado Pago, WhatsApp, IA:** no existen en código todavía.
