# 12 — Modelo Consolidador (B2B2B / BYOC), Diagnóstico de Gaps y Plan de Implementación

**Versión:** 1.2
**Fecha:** 2026-06-03 · **Actualizado:** 2026-09-29 (carteras por moneda, [§10](#10--carteras-por-moneda-y-quién-las-establece-2026-09-29)); 2026-09-28 (modelo de red validado, §3.0)
**Propósito:** Tres cosas en un solo documento: (1) incorporar formalmente el **modelo consolidador con credenciales propias (BYOC)** al target de la plataforma; (2) un **diagnóstico honesto** de dónde estamos vs. la visión y vs. el mercado; (3) un **plan secuenciado** para construirlo y pulirlo con UX limpia y mejores prácticas.

> Este doc es la fuente de verdad para el modelo consolidador. El target ya quedó reflejado en `CLAUDE.md`, `docs/discovery/06-documento-maestro.md` §1.1 y `docs/platform/10-mapa-completo-plataforma.md` (entidad TENANT + jerarquía M8.1).

> **Actualización 2026-09-28: el modelo de red está validado y firmado por el founder.** Planetour es la raíz única de tipo `platform`. Vende a nombre propio por sus **sucursales**. Las agencias externas y los consolidadores cuelgan de Planetour. El **superadmin** cuadra la red, pero **no vende**. Lo firmado está en [§3.0](#30-modelo-de-red-validado-2026-09-28) y manda sobre lo que diga en contrario el resto del documento, que se escribió en junio. La auditoría, lo que ya se arregló, lo pendiente y el runbook de producción están en [13 — Validación del modelo de red](./13-validacion-modelo-red.md).

> **Actualización 2026-09-29: carteras por moneda.** La cartera de cada agencia la establece **quien la financia** (opción A del founder): Planetour, por su superadmin, para lo que cuelga de la plataforma; el consolidador para sus agencias; la agencia para sus sub-agencias. Hay una cartera por moneda, con su cupo. La agencia sólo ve sus carteras e informa depósitos, que quedan pendientes hasta que quien la financia los aprueba. Una reserva se retiene en la cartera de la moneda de la tarifa, y sin ella se rechaza (en hoteles, antes de llamar al proveedor). Cierra la brecha crítica de carteras de la auditoría. Detalle en [§10](#10--carteras-por-moneda-y-quién-las-establece-2026-09-29) y [13 §4.1](./13-validacion-modelo-red.md#41-confidencialidad); runbook en [13 §5](./13-validacion-modelo-red.md#5-runbook-del-vps), pasos 7 a 9.

---

## 1. Resumen ejecutivo (TL;DR)

1. **Lo que pidió el founder** — la plataforma no es sólo para que una agencia venda; debe ser para **consolidadores** que habilitan a **otras agencias y sub-agencias**, donde **cada agencia conecta sus propias credenciales de proveedor (BYOC)** o hereda las del consolidador. Esto está ahora en el target.

2. **El hallazgo crítico** — el código **hoy no soporta esto**. La tenancy es **plana** (cada tenant = una agencia), las credenciales del único proveedor (`latam-ndc`) son **globales (env vars)**, y el JWT no lleva tenant. Habilitar el modelo consolidador es un **épico fundacional** que cambia el contrato de datos de casi todo (tenancy, auth, RLS, pricing, resolución de proveedor). **Debe ir antes de seguir sumando verticales.**

3. **Dónde estamos vs. la visión** — los docs describen 16 módulos; el código es un MVP de Sprint 1 sólido pero parcial (~15-20% de la visión): search→cotización→orden de **vuelos LATAM NDC**, carteras/crédito B2B, CRM básico, markup rules (en DB, sin aplicar al pricing), reportes parcialmente mock. **Sin pagos, sin IA/WhatsApp, sin Package Studio, sin hoteles/autos/asistencias, sin tests.**

4. **Dónde estamos cortos vs. el mercado** — falta toda la capa de **mid/back-office** que define a un consolidador serio: emisión/ticketing real con colas y reintentos, **post-venta** (reemisiones, reembolsos, voids, cambios), **conciliación BSP/financiera**, gestión de fondos/depósitos de agencias con extractos, **multi-GDS/multi-source de inventario**, fare rules y EMD/ancillaries, y reporting accionable. Ver §4.

5. **El plan** — 6 fases. **Fase 0 (fundacional consolidador)** primero; luego cerrar gaps del core (pagos, Package Studio, post-venta), endurecer UX, y recién entonces ampliar verticales. Ver §6.

---

## 2. Estado real hoy: código vs. visión (diagnóstico honesto)

> Inventario verificado leyendo el código (no los docs). La visión documentada es ambiciosa y correcta; el objetivo de esta sección es que no confundamos "documentado" con "construido".

### 2.1 Lo que SÍ existe y funciona

| Área                                         | Estado        | Nota                                                                                                                         |
| -------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Multi-tenant + RLS forzada                   | ✅ Funcional  | `app.current_tenant_id` GUC + `FORCE ROW LEVEL SECURITY`. Bien hecho.                                                        |
| Auth email+password, JWT, bcrypt             | ✅ Funcional  | JWT lleva sólo `sub`; tenant se infiere del primer membership.                                                               |
| Memberships N:M (user↔tenant+rol)           | ✅ Funcional  | Roles: `superadmin, tenant_admin, admin, vendedor, cliente_final`.                                                           |
| Búsqueda de vuelos LATAM NDC                 | ✅ Funcional  | `providers/latam-ndc`, real + modo mock. AirShopping/OfferPrice/OrderCreate/OrderManage/OrderChange/ServiceList/OrderReshop. |
| Cotizaciones (CRUD + expiración)             | ✅ Funcional  | `quotations`.                                                                                                                |
| Órdenes (crear/listar/cancelar/pagar/reshop) | ✅ Funcional  | `orders`, contra el provider.                                                                                                |
| Carteras / crédito B2B                       | ✅ Funcional  | Una cartera por tenant y moneda (0052). Cupo, depósitos y ajustes los fija quien financia al nodo (§10).                     |
| CRM clientes (pasajeros)                     | ✅ Funcional  | `customers` con documentos/pasaporte.                                                                                        |
| Admin superadmin (tenants/usuarios)          | ✅ Funcional  | Panel en `web-b2b/admin`.                                                                                                    |
| Arquitectura hexagonal + ACL + canonical     | ✅ Buena base | `packages/canonical`, `packages/domain` (4 ports), `packages/core` (15 ports, sólo interfaces).                              |

### 2.2 Lo que NO existe (documentado, sin código)

| Área                                                   | Estado | Impacto                                                                          |
| ------------------------------------------------------ | ------ | -------------------------------------------------------------------------------- |
| **Jerarquía consolidador→agencia→sub-agencia**         | ❌     | Bloquea el target. Tenancy es plana.                                             |
| **Credenciales de proveedor por tenant (BYOC)**        | ❌     | Bloquea el target. Creds globales por env var.                                   |
| **Pricing waterfall multinivel**                       | ❌     | `markup_rules` existe en DB pero **no se aplica** al pricing ni cascada.         |
| Pagos (Stripe/MP, wallet real, split, métodos locales) | ❌     | Port definido, sin gateway. No se puede cobrar de verdad.                        |
| Package Studio drag-and-drop                           | ❌     | Es el "corazón" del producto en la visión. `package_*` existe en DB pero sin UI. |
| Saga de reservas (Temporal) + compensación             | ❌     | Reservas sin durabilidad ni compensación.                                        |
| Post-venta real (reemisión, reembolso, void, cambios)  | ❌     | Sólo cancel básico.                                                              |
| IA / WhatsApp / omnicanal (M9)                         | ❌     | Diferenciador #1 del posicionamiento; nada construido.                           |
| Hoteles / autos / actividades / asistencias            | ❌     | Sólo vuelos.                                                                     |
| Facturación electrónica (DIAN/SUNAT/NF-e)              | ❌     | Nada.                                                                            |
| Contabilidad / conciliación                            | ❌     | Nada.                                                                            |
| Branding white-label / dominio custom / SSL            | ❌     | Campos de color en `tenants`, sin editor ni theming runtime.                     |
| MFA, magic link, SSO, anomalía login                   | ❌     | Sólo password.                                                                   |
| Notificaciones (email/SMS/push)                        | ❌     | Ports sin impl.                                                                  |
| Feature flags, event bus, jobs, search index, tracing  | ❌     | Ports sin impl.                                                                  |
| Tests (unit/integration/e2e)                           | ❌     | Cero. `vitest` instalado, sin specs.                                             |
| Audit log inmutable (`domain_events`)                  | ❌     | GUC de contexto seteado, sin tabla de eventos.                                   |

### 2.3 Veredicto

La base técnica es **correcta y disciplinada** (hexagonal, ACL, RLS, minor units, contexto de tenant en cada transacción). El problema no es calidad sino **alcance y orden**: para volverse un consolidador real hay que (a) habilitar la jerarquía + BYOC en el núcleo, y (b) construir el mid/back-office que hoy no existe. Sumar más verticales antes de eso sería construir sobre cimientos que habrá que rehacer.

---

## 3. El modelo consolidador — arquitectura objetivo

### 3.0 Modelo de red validado (2026-09-28)

Modelo de negocio del founder, validado contra el código y los datos de producción en la auditoría del 2026-09-28 ([13](./13-validacion-modelo-red.md)).

```
Planetour S.A.S  (platform, raíz única; superadmin: cuadra la red, no vende)
├── Sucursal Planetour …      (agency + is_branch; vendedores de Planetour)
├── Amazon Minimalist         (agency externa; vende a nombre de Planetour)
│   └── sub-agencia …         (subagency)
└── Consolidador …            (consolidator; credenciales propias)
    └── agencia …             (agency)
        └── sub-agencia …     (subagency)
```

| Actor                     | Qué es                                                                                                                                                                                                     | Cómo está modelado                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Planetour**             | Mayorista. Provee proveedores, credenciales y contenidos a toda su red.                                                                                                                                    | Tenant slug `platform` ("Planetour S.A.S"), `tenant_type = 'platform'`, raíz única.                    |
| **Superadmin**            | Superusuario de Planetour. Ve y ajusta ("cuadra") toda la red: nodos, usuarios, credenciales, reglas y habilitación de proveedores. **No vende**, ni siquiera desde una sucursal donde además sea miembro. | Membership `superadmin` en Planetour. Las rutas de venta le responden 403 `PLATFORM_ROLE_CANNOT_SELL`. |
| **Sucursal**              | Así vende Planetour a nombre propio, con sus propios vendedores.                                                                                                                                           | `agency` hija directa de Planetour con `is_branch = true`. La UI la muestra como "Sucursal".           |
| **Agencia externa**       | Cuelga de Planetour, vende a nombre de Planetour y hereda sus credenciales. Ejemplo: Amazon Minimalist, que hoy es raíz suelta y se mueve bajo Planetour desde el panel.                                   | `agency` hija de Planetour.                                                                            |
| **Consolidador**          | Hijo de Planetour con credenciales propias. Provee a su propia jerarquía.                                                                                                                                  | `consolidator` hijo de Planetour. Sólo lo crea el superadmin.                                          |
| **Agencia / sub-agencia** | Venden dentro de la red de su padre y heredan sus credenciales, salvo que traigan las propias (BYOC).                                                                                                      | `agency` bajo un consolidador; `subagency` bajo una agencia.                                           |
| **Vendedor**              | Persona que vende en un nodo. No es un tenant.                                                                                                                                                             | Membership `vendedor` en ese nodo.                                                                     |

En esta etapa ser sucursal no cambia ni el pricing ni las carteras: una sucursal se comporta como cualquier agencia hija de Planetour. Con las sucursales queda resuelta la pregunta "¿cómo vende Planetour a nombre propio?" (D1 de la auditoría).

**Decisiones de la red (auditoría del 2026-09-28).** Las cita el código (por ejemplo, "D4 A" en `db/migrations/0050_tenant_hierarchy_rules.sql`). No son las D1–D5 de junio de [§7](#7-riesgos-y-decisiones-abiertas).

| #   | Decisión                                                                    | Elegida                                                                                                                                                                                                                                                                                                                                                                | Dónde se aplica                                                                                  |
| --- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| D1  | ¿Cómo vende Planetour a nombre propio?                                      | ✅ **Sucursales**: agencias hijas de Planetour con `is_branch`, cada una con sus vendedores. La raíz provee y administra.                                                                                                                                                                                                                                              | Migración 0050; _Gestión de Agencias_.                                                           |
| D4  | ¿Qué tipo de nodo puede colgar de cuál?                                     | ✅ **A, jerarquía estricta.** Un solo `platform` y es la raíz. Bajo `platform`: `consolidator` y `agency` (las sucursales incluidas). Bajo `consolidator`: `agency`. Bajo `agency`: `subagency`. Máximo 4 niveles. La sucursal sólo cuelga de `platform`.                                                                                                              | Índice único y trigger de 0050, en toda escritura de `tenants`. La API deriva el tipo del padre. |
| D6  | ¿Qué pasa al mover un nodo de padre?                                        | ✅ **A.** Lo histórico (órdenes, movimientos de cartera) queda como está; desde el cambio rigen las credenciales, reglas y marca del nuevo padre. Se rechazan ciclos, más de 4 niveles y lo que viole D4. Se bloquea si el nodo o su subárbol tiene reservas abiertas pagadas con cartera, o reservas abiertas hechas con una cuenta de un ancestro que deja de serlo. | `move_tenant_subtree` (0051), sólo superadmin; `POST /admin/tenants/:id/move`.                   |
| D7  | Rol `platform_admin`                                                        | ✅ **B, retirado como rol asignable.** Sigue en el enum por compatibilidad, pero ni la API ni la web lo asignan.                                                                                                                                                                                                                                                       | `ASSIGNABLE_ROLES` y los Zod de la API; aceptar una invitación.                                  |
| D2  | ¿Planetour cobra margen a un consolidador que vende con su propio contrato? | Abierta. Recomendada: B, fee de plataforma aparte, arranca en 0.                                                                                                                                                                                                                                                                                                       | [13 §4.3](./13-validacion-modelo-red.md#43-decisiones-que-faltan)                                |
| D3  | ¿Dónde viven las credenciales de Planetour?                                 | Abierta. Recomendada: A, todas en la bóveda y sin respaldo de variables del servidor.                                                                                                                                                                                                                                                                                  | [13 §4.3](./13-validacion-modelo-red.md#43-decisiones-que-faltan)                                |
| D5  | ¿Quién puede "entrar como" otro nodo?                                       | Abierta. Recomendada: A ahora (sólo el superadmin, auditado) y B cuando exista el primer consolidador real.                                                                                                                                                                                                                                                            | [13 §4.3](./13-validacion-modelo-red.md#43-decisiones-que-faltan)                                |

**Carteras: ¿quién establece la cartera de cada agencia?** ✅ **A, quien la financia** (founder, 2026-09-29). Quien financia es el ancestro más cercano de tipo plataforma, consolidador o agencia: Planetour, por su superadmin, para lo que cuelga de la plataforma; el consolidador para sus agencias; la agencia para sus sub-agencias. El superadmin puede con cualquier nodo. Quien financia fija las monedas (una cartera por moneda), el cupo, el estado y los depósitos y ajustes, con motivo y auditados. La agencia sólo ve sus carteras e informa depósitos, que quedan pendientes. Se retiene en la cartera de la moneda de la tarifa y, sin ella, la reserva se rechaza (en hoteles, antes de llamar al proveedor). Se aplica en 0052 y 0053, en `/tenants/:tenantId/portfolios` y en _Gestión de Agencias_ y _Mi Red_ → _Carteras_ ([§10](#10--carteras-por-moneda-y-quién-las-establece-2026-09-29)).

### 3.1 Jerarquía de tenants

Hoy `tenants` es plano. Se añade jerarquía con **materialized path** (extensión `ltree`), que da queries jerárquicas O(1) por índice GiST sin recursión:

```sql
ALTER TABLE tenants
  ADD COLUMN parent_tenant_id UUID NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  ADD COLUMN tenant_type TEXT NOT NULL DEFAULT 'agency'
    CHECK (tenant_type IN ('platform','consolidator','agency','subagency')),
  ADD COLUMN path LTREE NOT NULL;   -- p.ej. 'consolidadorA.agenciaB.subC'

CREATE INDEX idx_tenants_path_gist ON tenants USING GIST (path);
CREATE INDEX idx_tenants_parent ON tenants(parent_tenant_id);
```

- `path` se mantiene con trigger en insert. Cambiar de padre por `UPDATE` está bloqueado; se hace sólo con `move_tenant_subtree` (0051), que recalcula el `path` de todo el subárbol en una transacción (D6 A, [§3.0](#30-modelo-de-red-validado-2026-09-28)).
- **Niveles:** `platform` (Planetour, raíz única) → `consolidator` → `agency` → `subagency`. Bajo `platform` también cuelgan agencias directas, sucursales incluidas (`is_branch`). La matriz exacta es D4 A ([§3.0](#30-modelo-de-red-validado-2026-09-28)) y la impone la base (0050). Un vendedor es un **usuario** con membership en un nodo, no un tenant.
- Profundidad: máximo 4 niveles por política de negocio (evita árboles patológicos).
- `tenants.is_branch` (0050): marca la sucursal de Planetour. Sólo puede ser `true` en una `agency` hija directa de `platform`.

### 3.2 BYOC — credenciales de proveedor por nodo + resolución (núcleo del pedido)

Hoy no hay tabla de credenciales. Se crea `provider_accounts`:

```sql
CREATE TABLE provider_accounts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_code   TEXT NOT NULL,           -- 'latam-ndc','amadeus','hotelbeds','stripe'...
  label           TEXT NOT NULL,
  credentials_enc BYTEA NOT NULL,          -- cifrado (pgcrypto / ref a vault). NUNCA en logs.
  config          JSONB NOT NULL DEFAULT '{}',  -- PCC/pseudo-city, IATA, agencyId, endpoints...
  is_inheritable  BOOLEAN NOT NULL DEFAULT true, -- hijos pueden usar estas creds
  status          TEXT NOT NULL DEFAULT 'sandbox' CHECK (status IN ('active','sandbox','disabled')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider_code, label)
);
```

**Resolución de credenciales (`ProviderCredentialResolver`)** — al buscar/reservar para un tenant `T`:

1. ¿`T` tiene `provider_account` activa para ese `provider_code`? → úsala (la agencia trae sus propias credenciales).
2. Si no, sube por `T.path` al ancestro más cercano con una cuenta `active` **e** `is_inheritable=true` → la usa (opera bajo el consolidador).
3. Si ninguno, error de configuración explícito (no fallback silencioso a env var en prod).

Esto materializa exactamente "cada agencia coloca sus propias credenciales para servir a sus agencias": la agencia que tiene contrato NDC propio pone su PCC; la sub-agencia sin contrato hereda el del consolidador. La marca de **quién emite** (responsabilidad BSP/contractual) queda registrada por la cuenta usada.

> **Validado por investigación de mercado (fuentes primarias).** Este diseño coincide con cómo lo resuelven las plataformas líderes:
>
> - **TravelgateX** modela la conectividad como un objeto **"Access"** = _"el conjunto de credenciales y la configuración de autenticación que permite a un Buyer conectarse a un Seller… se usa para filtrar distintas credenciales y configuraciones del mismo Seller (p. ej. feeds B2B y B2C)"_ ([docs.travelgatex.com](https://docs.travelgatex.com/getting-started/concepts/)). Nuestro `provider_accounts` (credenciales + `config` + scope por tenant) es exactamente esa abstracción "Access".
> - **Travelport Universal API** usa _"una estructura jerárquica para su sistema de perfiles… las credenciales de proveedor se almacenan a nivel de área de trabajo, gestionando credenciales para Agencia, Sucursal y Agente"_ ([support.travelport.com](https://support.travelport.com/webhelp/uapi/Content/Getting_Started/Easy_Overview/Getting_Credentials.htm)) — la misma jerarquía agencia→sucursal→agente que nuestro `path`.
> - El **PCC (Pseudo City Code / office ID)** del GDS no sólo asocia las reservas a la agencia sino que **determina las tarifas privadas (private fares) disponibles para ella** ([Travelport/Wikipedia](https://en.wikipedia.org/wiki/Pseudo_city_code)). Implicación de diseño: la cuenta de credenciales usada **también define qué inventario/tarifas privadas ve** ese nodo — no es sólo autenticación, es _scoping de contenido_. Nuestro `config` por `provider_account` debe poder portar el PCC/pseudo-city y las tarifas privadas asociadas.

**Seguridad (no negociable):**

- Cifrado en reposo (pgcrypto con clave en vault, no en DB; o ref a Secrets Manager). En fase 1, sops+age para la clave maestra.
- Redacción obligatoria en logs/telemetría; test de CI que falla si una credencial aparece en logs.
- Rotación y `status=disabled` como kill-switch por cuenta.

### 3.3 Pricing waterfall multinivel

`markup_rules` hoy es por tenant y **no se aplica**. El modelo consolidador necesita **cascada por el `path`**:

```
neto del proveedor
  + override del consolidador   (su margen por dar acceso a la red)
  + markup de la agencia        (su utilidad)
  + comisión del vendedor       (interna a la agencia)
  = precio final al cliente
```

- Las reglas se evalúan **de ancestro a descendiente** (orden por `nlevel(path)`), cada nivel añade su capa.
- **Visibilidad controlada:** la sub-agencia ve su costo (lo que le cobra su padre) y su precio final; **no** ve el neto del proveedor ni el override del consolidador. Esto se aplica en el dominio (proyección por rol), no sólo en UI.
- Reusar el motor de reglas (`scope`/`conditions` por categoría/destino/temporada/proveedor) que ya está modelado, añadiendo el eje jerárquico.
- Versionado + simulador "what-if" (ya en la visión M6) para que un consolidador pruebe "si subo override de hoteles 2%, ¿qué pasa con la red?".

> **Validado (AltexSoft, commission/markup engine).** El motor debe distinguir **dos modelos de contratación** que cambian cómo se construye el precio: **net-rate** (el proveedor da neto y el intermediario añade markup para formar el precio final) vs **commissionable/gross** (el proveedor fija el precio final y el intermediario gana una comisión sobre él). Las reglas de markup son **flat** (monto fijo o % fijo del neto) o **variable** (ajustadas por múltiples factores), y se condicionan por **canal y tipo de cliente** (B2C/B2B/B2G) ([altexsoft.com](https://www.altexsoft.com/blog/ota-rates-commission-engine/)). Para nuestro waterfall: cada capa (override consolidador, markup agencia, comisión vendedor) debe soportar net-rate vs commissionable y flat vs variable, porque el inventario llega en ambas modalidades y se calcula distinto.

### 3.4 Roles, auth y JWT

El JWT actual sólo lleva `sub`; el tenant se infiere del "primer membership". Para usuarios que operan en múltiples nodos de una red consolidadora esto es insuficiente e inseguro.

- **JWT lleva tenant activo** (`{ sub, tid, role }`) + endpoint de **switch-tenant** para usuarios multi-nodo. Refresh tokens rotatorios.
- **Roles ampliados:** añadir `consolidator_admin` (gestiona su red, agencias, credenciales, override) y `agency_admin` distinto de `subagency`. Mapear los actuales (`tenant_admin`/`admin`) a la nueva jerarquía con migración.
- **Visibilidad jerárquica:** un `consolidator_admin` puede ver/administrar sus descendientes; una agencia **no** ve hacia arriba ni lateral. Se implementa en RLS (§3.5) + guards ABAC.
- **Superadmin (2026-09-28):** administra toda la red pero **no vende**. Las rutas de venta (`@SalesOperation()`: búsquedas, PreBook, Book, órdenes nuevas, pago/emisión, cotizaciones, paquetes y reservas con cartera) responden 403 `PLATFORM_ROLE_CANNOT_SELL` a los roles de plataforma, en cualquier nodo. Planetour vende con usuarios de sus sucursales ([§3.0](#30-modelo-de-red-validado-2026-09-28)).
- **`platform_admin` retirado (D7 B):** sigue en el enum de roles por compatibilidad, pero ni la API ni la web lo asignan.
- **Anti-escalada (G-06):** el rango se mide sobre el nodo destino y nadie asigna un rol igual o superior al propio.

### 3.5 RLS jerárquica

La RLS por igualdad de `tenant_id` sigue para datos operativos (una agencia ve sus reservas). Pero la gestión de red requiere **visibilidad descendente**. Patrón:

- Operativo (orders, quotations, customers, portfolios): política actual `tenant_id = current_setting('app.current_tenant_id')` **se mantiene**.
- Gestión de red (sub-tenants, provider_accounts heredables, reporting agregado): política adicional que permite ver filas cuyo `tenant.path <@ current_setting('app.current_tenant_path')` (descendientes), habilitada sólo cuando el rol es `*_admin`.
- Setear `app.current_tenant_path` junto al `tenant_id` en `withRequestContext`.
- **Tests de aislamiento cross-red obligatorios en CI:** agencia A de consolidador X **no** ve datos de agencia B de consolidador Y, ni de su propio consolidador hacia arriba.

### 3.6 Onboarding self-service de agencias (modelo Stripe)

Diferenciador identificado en `research/06` §4.6: nadie en LATAM permite que una agencia se dé de alta y venda en horas. Para el consolidador:

- Un `consolidator_admin` **invita** a una agencia (email) → la agencia completa onboarding (datos fiscales, branding, **conecta sus credenciales o acepta heredar**) → queda operativa.
- Wizard guiado, estados claros (`invited → onboarding → active`), y "modo sandbox" hasta que conecte pagos.

---

## 4. Diagnóstico de gaps vs. mercado (priorizado)

> Marco: lo que define a una **plataforma consolidadora B2B seria** (referencias Juniper, Wooba/Travellink, Mystifly, Hotelbeds, TravelgateX) más allá de "buscar y reservar un vuelo". Prioridad: **P0** = imprescindible para operar como consolidador real; **P1** = paridad competitiva; **P2** = diferenciación/avanzado.

### 4.0 Evidencia de mercado (investigación validada con fuentes primarias)

Hallazgos de la investigación profunda (103 agentes, 21 fuentes, verificación adversarial 3-votos). Los que sostienen el checklist:

1. **NDC ya es baseline, no diferenciador.** Sabre reporta que _"NDC ya no es un diferenciador competitivo; es una expectativa de base"_ (~2/3 de aerolíneas implementando; 42 aerolíneas NDC live) y que **>80% de las agencias quieren acceso a contenido unificado en una sola plataforma** que consolide NDC + LCC + contenido tradicional + alojamiento + tierra ([sabre.com](https://www.sabre.com/insights/releases/from-content-complexity-to-connected-retailing-7-transformations-redefining-travel-in-2026-led-by-the-rise-of-agentic-ai/)). **Implicación directa:** tener sólo búsqueda de vuelos NDC (lo que tenemos hoy) está **por debajo del estándar**; la agregación multi-contenido es lo esperado. _(Cifras de encuesta comisionada por Sabre, n=499 — citar con atribución; tendencia corroborada por Phocuswright: 91%+ agencias usan 4+ sistemas de booking.)_

2. **Mid/Back-office (MBO) NDC-ready es estándar de mercado.** El **mid-office** maneja post-booking: control de calidad, ticketing, enforcement de políticas, enriquecimiento de PNR, generación de itinerario/factura, y servicios post-booking (cambios, repricing, reembolsos, cancelaciones). El **back-office** maneja facturación, reporting financiero, **tracking de comisiones, conciliación/liquidación con proveedores**, integración contable y **libros de IVA/impuestos**. Un MBO moderno debe procesar reservas **sin importar canal ni formato de transmisión** (AIR, XML, JSON, Edifact, NDC) ([AltexSoft](https://www.altexsoft.com/blog/mid-office-back-office-systems-in-travel/), [Amadeus](https://amadeus.com/en/blog/articles/why-travel-agency-mbo-systems-key-to-ndc)). Esto valida directamente §4.1 y §4.4.

3. **Self-service del ciclo de ticketing es table-stakes.** Emisión, reemisión, revalidación, cancelación y reembolso vía **point-and-click**, no comandos manuales de GDS — ya no es diferenciador, es lo mínimo esperado (corroborado en Sabre Mosaic Agency Workspace, Travelport NDC servicing). Valida los P0 de §4.1.

4. **WhatsApp es canal transaccional de primera clase** en viajes (confirmaciones, updates, soporte, marketing, upsell y **flujos transaccionales**), no sólo mensajería ([PhocusWire](https://www.phocuswire.com/whatsapp-travel-brands-meta-communication)). Valida el posicionamiento del producto.

5. **Tendencias 2025-2026 a anticipar (no construir aún, sí no cerrarse la puerta):** **agentic AI booking** — Google anunció (nov-2025) completar reservas de vuelos/hoteles dentro de AI Mode vía partners OTA, sin ser merchant of record ([Google](https://blog.google/products-and-platforms/products/search/agentic-plans-booking-travel-canvas-ai-mode/), [Skift](https://skift.com/2025/11/17/google-is-building-agentic-travel-booking-plus-other-travel-ai-updates/)); y **MCP** como ruta más rápida para que agentes IA accedan a contenido aéreo sin conformar a cada implementación NDC (framing de un ejecutivo de Travelport — opinión naciente, 2-1, citar como tal).

**Gap LATAM no cubierto por la investigación genérica** (queda como pregunta abierta para diseño): requisitos fiscales específicos (DIAN/SUNAT/NF-e), liquidación BSP por región LATAM, y el data-model detallado de conciliación BSP/ARC. Son ítems a resolver con fuentes locales en la fase correspondiente.

### 4.1+ Checklist priorizado

> **P0** = imprescindible para operar como consolidador real; **P1** = paridad competitiva; **P2** = diferenciación/avanzado.

### 4.1 Aéreo / Ticketing / Post-venta

| Gap                                                                                              | Prioridad | Por qué                                                              |
| ------------------------------------------------------------------------------------------------ | --------- | -------------------------------------------------------------------- |
| Emisión/ticketing real con **cola de pendientes + reintentos** (robotic ticketing)               | **P0**    | Un consolidador vive de emitir; hoy no hay cola ni durabilidad.      |
| **Post-venta:** reemisión, reembolso, void (ventana same-day), cambios voluntarios/involuntarios | **P0**    | Es el grueso del trabajo de un consolidador; hoy sólo cancel básico. |
| **Fare rules / condiciones tarifarias** visibles y aplicadas (penalidades, equipaje, no-show)    | **P0**    | Sin esto se vende a ciegas y se pierde plata en cambios.             |
| **EMD / ancillaries** (equipaje, asientos, servicios)                                            | P1        | `ServiceList` ya existe en el provider; falta exponerlo.             |
| **Multi-GDS / multi-source** (Amadeus/Sabre/Travelport + LCC) con dedupe y mejor-precio          | P1        | Hoy sólo LATAM NDC. Un consolidador agrega fuentes.                  |
| Colas tipo GDS (queues) para gestión operativa                                                   | P1        | Flujo de trabajo estándar de back-office aéreo.                      |

### 4.2 Non-air (verticales)

| Gap                                                               | Prioridad | Por qué                                                                    |
| ----------------------------------------------------------------- | --------- | -------------------------------------------------------------------------- |
| Hoteles (bedbank: Hotelbeds/HotelDo) + **mapping/dedupe** (Giata) | P1        | Cross-sell y margen; clave para paquetes.                                  |
| Asistencias, autos, actividades/tours, traslados                  | P1/P2     | Completan el paquete; el constructor los necesita.                         |
| **Package Studio drag-and-drop**                                  | P1        | "Corazón" del producto en la visión; diferenciador vs carrito tradicional. |

### 4.3 Pagos y fondos

| Gap                                                                    | Prioridad | Por qué                                                                   |
| ---------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------- |
| **Gateway real** (Stripe + MP) hosted checkout (SAQ-A)                 | **P0**    | Hoy no se cobra. Bloquea operación.                                       |
| **Wallet / depósitos de agencia** con extracto y conciliación de saldo | **P0**    | Carteras por moneda (§10). Faltan recarga real, extractos y conciliación. |
| Split payments / payout por nodo (consolidador↔agencia)               | P1        | Reparto de márgenes en la red.                                            |
| Métodos locales (PIX, PSE, Yape/Plin, Boleto)                          | P1        | Conversión en LATAM.                                                      |
| Antifraude / 3DS                                                       | P2        | Riesgo a escala.                                                          |

### 4.4 Mid/Back-office y finanzas

| Gap                                                                                                 | Prioridad | Por qué                                                     |
| --------------------------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------- |
| **Conciliación BSP/financiera** (lo emitido vs lo liquidado)                                        | **P0**    | Define a un consolidador; sin esto no se controla la plata. |
| Contabilidad (asientos por evento, CxC/CxP por proveedor y agencia)                                 | P1        | Cierre y control.                                           |
| Facturación electrónica (DIAN/SUNAT/NF-e vía adapters)                                              | P1        | Obligación legal para operar en CO/PE/BR.                   |
| **Reporting accionable por nodo** (GMV, márgenes, top destinos, conversión) con drill-down y export | P1        | Hoy parcial/mock; un consolidador necesita ver su red.      |
| **Audit log inmutable** (`domain_events`)                                                           | **P0**    | Trazabilidad legal y antifraude; hoy no existe.             |

### 4.5 IA / Conversacional

| Gap                                                    | Prioridad | Por qué                                                               |
| ------------------------------------------------------ | --------- | --------------------------------------------------------------------- |
| WhatsApp Business como canal de venta nativo (cotizar) | P1        | Diferenciador #1 del posicionamiento; nadie en LATAM lo tiene nativo. |
| Copiloto IA en el panel (armar/sugerir/cross-sell)     | P2        | Multiplicador de productividad del vendedor.                          |

### 4.6 Plataforma / Seguridad / Calidad

| Gap                                                            | Prioridad | Por qué                                    |
| -------------------------------------------------------------- | --------- | ------------------------------------------ |
| **Tests de aislamiento cross-tenant/cross-red en CI**          | **P0**    | Con jerarquía + BYOC, una fuga es crítica. |
| Cifrado de credenciales + redacción en logs                    | **P0**    | BYOC sin esto es inaceptable.              |
| MFA para roles admin+                                          | P1        | Estándar de seguridad.                     |
| White-label real (branding editor + dominio + theming runtime) | P1        | Promesa white-label del producto.          |
| Notificaciones (email transaccional)                           | P1        | Confirmaciones, vouchers.                  |
| Feature flags + kill-switch por proveedor                      | P1        | Operar una red sin caídas en cascada.      |

---

## 5. UX limpia y mejores prácticas

Principio rector ya definido (Linear/Stripe/Notion). Aplicado al consolidador:

- **Densidad con jerarquía:** tablas B2B densas (TanStack Table, virtualizadas) pero con whitespace, grid 8px, y jerarquía tipográfica. Nada de "ERP 2012".
- **Command palette (Cmd/Ctrl+K)** para saltar entre red/agencias/reservas/cotizaciones.
- **Estados explícitos:** skeletons (no spinners), empty states con guía, error states con retry, optimistic UI < 200ms.
- **Vista de red para el consolidador:** árbol/tabla de agencias con KPIs por nodo, drill-down a una agencia "como si fueras ella" (impersonación auditada).
- **Onboarding guiado** por wizard (alta de agencia, conectar credenciales, conectar pagos) con progreso claro.
- **Mobile-first** y **WCAG AA** (contraste, keyboard nav, screen readers) desde el día 1 en cada pantalla nueva.
- **Design system** en `packages/ui` (shadcn/ui v4 + tokens por tenant como CSS variables), un único catálogo. Usar el skill `interface-design:init` al arrancar cada módulo nuevo y `design-review` antes de PR (ya en CLAUDE.md).
- **Tokens multi-tenant** servidos por SSR (sin rebuilds por tenant); el branding del nodo (y su consolidador) define el tema.

---

## 6. Plan de implementación por fases

> Trunk-based, feature flags, cada fase es entregable y verificable. Las fases 0-2 son secuenciales; 3-5 pueden solaparse. Estimaciones en "tallas" (S/M/L) no en fechas (dependen del equipo).

### Fase 0 — Fundación consolidador (BLOQUEANTE, va primero) — **L**

Objetivo: el núcleo soporta jerarquía + BYOC + waterfall + auth correcto, con aislamiento probado.

1. Migración `tenants`: `parent_tenant_id`, `tenant_type`, `path` (ltree) + triggers e índices. **S**
2. Tabla `provider_accounts` + cifrado + `ProviderCredentialResolver` (resolución por `path` con herencia). Migrar `latam-ndc` de env var a `provider_accounts`. **M**
3. Roles ampliados (`consolidator_admin`, `agency_admin`, `subagency`) + migración de roles actuales. **S**
4. JWT con `tid` + switch-tenant + guards de visibilidad jerárquica. **M**
5. RLS jerárquica (`app.current_tenant_path`, política descendente para `*_admin`) + **tests de aislamiento cross-red en CI**. **M**
6. `domain_events` (audit log append-only) + emisión en acciones sensibles (login, cambio de credenciales, override, refund). **S**
7. Motor de **pricing waterfall** sobre `markup_rules` + visibilidad por rol. **M**

**DoD Fase 0:** un consolidador puede crear una agencia, la agencia conecta su credencial NDC propia (o hereda), busca y el precio refleja la cascada; tests prueban que nadie ve datos fuera de su rama.

### Fase 1 — Operar de verdad: pagos + post-venta + audit — **L**

1. Gateway de pagos real (Stripe + MP, hosted checkout SAQ-A) detrás del port. **M**
2. Wallet/depósitos de agencia con recarga real, extracto y conciliación de saldo. **M**
3. Post-venta aéreo: reembolso, void (same-day), reemisión, cambios; cola de pendientes + reintentos (Temporal). **L**
4. Saga de reserva multi-proveedor con compensación (Temporal). **M**
5. Fare rules expuestas y aplicadas en cotización/orden. **S**

**DoD Fase 1:** una agencia cobra una venta real, emite, y puede reembolsar/cambiar con trazabilidad.

### Fase 2 — UX limpia + panel consolidador + white-label — **M**

1. Design system consolidado en `packages/ui` (tokens, componentes, command palette, estados). **M**
2. **Vista de red** del consolidador (árbol de agencias, KPIs por nodo, impersonación auditada). **M**
3. Branding editor + theming runtime por tenant (+ su consolidador). **S**
4. Onboarding wizard self-service de agencias. **S**
5. Reporting accionable por nodo (GMV/márgenes/conversión, drill-down, export). **M**

### Fase 3 — Verticales + Package Studio — **L**

1. Hoteles (Hotelbeds/HotelDo) + mapping/dedupe. **M**
2. Asistencias + autos + actividades. **M**
3. **Package Studio drag-and-drop** (vuelo+hotel+asistencia) con cálculo en vivo y waterfall aplicado. **L**
4. EMD/ancillaries en aéreo. **S**

### Fase 4 — Multi-source aéreo + colas + fiscal — **M/L**

1. Segundo source aéreo (Amadeus/Sabre/Travelport o LCC) con dedupe y mejor-precio. **L**
2. Colas operativas tipo GDS. **M**
3. Facturación electrónica CO/PE/BR (adapters). **M**
4. Contabilidad + conciliación BSP. **L**

### Fase 5 — IA conversacional + seguridad avanzada — **M/L**

1. WhatsApp Business nativo: cotizar por chat (Channel Gateway + LLM router + tools search/quote/share). **L**
2. Copiloto IA en panel (sugerencias/cross-sell). **M**
3. MFA admins, notificaciones transaccionales, feature flags + kill-switch por proveedor. **M**

---

## 7. Riesgos y decisiones abiertas

> Las D1–D5 de esta tabla son las de junio. Las decisiones de la red del 2026-09-28 (D1–D7 de la auditoría: sucursales, D4 A, D6 A, D7 B y las abiertas D2, D3 y D5) están en [§3.0](#30-modelo-de-red-validado-2026-09-28).

| #   | Riesgo / decisión                                                     | Nota                                                                                                                                                                                                                                                                          |
| --- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **Migración de tenancy plana → jerárquica** sobre datos existentes    | Hecha en 0011 con `tenant_type='agency'` por defecto. Desde 2026-09-28 (D4 A) sólo la plataforma puede ser raíz: 0049 promueve a Planetour y las agencias raíz que queden se mueven bajo Planetour desde el panel ([13 §5](./13-validacion-modelo-red.md#5-runbook-del-vps)). |
| R2  | BYOC: responsabilidad legal de **quién emite** (BSP/IATA)             | La cuenta de credenciales usada define el emisor; registrar en `domain_events`. Validar con el founder el modelo contractual.                                                                                                                                                 |
| R3  | Pricing waterfall mal configurado → márgenes negativos o fuga de neto | Simulador what-if + validaciones + visibilidad por rol.                                                                                                                                                                                                                       |
| R4  | Complejidad de RLS jerárquica → fugas                                 | Tests exhaustivos en CI + fuzz con rotación de nodos.                                                                                                                                                                                                                         |
| D1  | ¿Profundidad máxima de jerarquía?                                     | ✅ **Decidido: 4 niveles** (platform/consolidador/agencia/sub-agencia). Implementado en el trigger `tenants_maintain_path` (migración 0011).                                                                                                                                  |
| D2  | ¿El consolidador puede ver el neto del proveedor de sus agencias?     | ✅ **Decidido: sólo agregados**, no el neto de cada sub que trae credenciales propias. A reflejar en la proyección de pricing por rol (Fase 0 paso 7).                                                                                                                        |
| D3  | ¿Pagos se liquidan por agencia o centralizado en el consolidador?     | ✅ **Decidido: híbrido** — liquidación **por agencia** cuando trae credenciales de pago propias; **centralizada en el consolidador** para las sub-agencias que heredan. Configurable.                                                                                         |
| D4  | Orden vs. roadmap de olas existente                                   | ✅ **Decidido: fundación consolidador va ANTES** de los verticales de la Ola 2.                                                                                                                                                                                               |
| D5  | ¿Amplitud multi-contenido vs. profundidad NDC primero?                | ✅ **Decidido: amplitud multi-contenido primero** (alineado con la evidencia §4.0: >80% quiere contenido unificado).                                                                                                                                                          |

---

## 8. Próximos pasos inmediatos

1. **Validar** §3 (arquitectura), §6 (orden de fases). Decisiones D1–D5 ✅ cerradas (§7).
2. ✅ **Fase 0, paso 1-2 implementado** en la rama `feat/consolidator-foundation` (ver §9).
3. ✅ Investigación de mercado incorporada (§4.0 con citas). Pendiente local: profundizar conciliación BSP/ARC y requisitos fiscales LATAM con fuentes locales cuando lleguemos a Fase 1/4.
4. **Modelo de red (2026-09-28):** la tanda 1 está en producción desde el merge de #6. De la tanda 2 ya están las carteras por moneda ([§10](#10--carteras-por-moneda-y-quién-las-establece-2026-09-29)), que se despliegan con los pasos 7 a 9 del runbook de [13 §5](./13-validacion-modelo-red.md#5-runbook-del-vps). Falta el resto: G-02 (el neto del proveedor, la otra crítica), G-01, G-17, G-16, el CRM y las decisiones D2, D3 y D5 ([13 §4](./13-validacion-modelo-red.md#4-qué-queda-para-la-tanda-2)).

## 9. Estado de implementación (rama `feat/consolidator-foundation`)

**Fase 0, paso 1-2 — entregado y verificado (typecheck + lint + tests unitarios verdes):**

| Componente                                                                                       | Archivo                                                                | Estado                                             |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | -------------------------------------------------- |
| Migración jerarquía (`parent_tenant_id`, `tenant_type`, `path` ltree, trigger, límite 4 niveles) | `db/migrations/0011_tenant_hierarchy.sql`                              | ✅                                                 |
| Migración `provider_accounts` (BYOC) + función `resolve_provider_account` (herencia por path)    | `db/migrations/0012_provider_accounts.sql`                             | ✅                                                 |
| Cifrado de credenciales AES-256-GCM (clave fuera de la DB)                                       | `apps/api/src/provider-credentials/credentials-cipher.ts`              | ✅ + test unitario (5/5)                           |
| Servicio BYOC (resolve con herencia, upsert cifrado, listado sin secreto)                        | `apps/api/src/provider-credentials/provider-credentials.service.ts`    | ✅                                                 |
| API admin de credenciales (upsert/list/resolve — nunca devuelve el secreto)                      | `apps/api/src/provider-credentials/provider-credentials.controller.ts` | ✅                                                 |
| Tipos Kysely + alta de tenant con padre/tipo                                                     | `database.types.ts`, `tenants/admin.controller.ts`                     | ✅                                                 |
| Test de integración jerarquía + herencia + límite de profundidad                                 | `provider-credentials.integration.test.ts`                             | ⏸ se salta sin `PGHOST` (requiere DB para correr) |

**Paso adicional entregado — Wiring BYOC + Autorización jerárquica:**

- ✅ `latam-ndc` resuelve credenciales por tenant (BYOC, propia o heredada) con fallback a env (`apps/api/src/providers-latam/*`). En prod desde `012069a`.
- ✅ `NetworkService` — autorización jerárquica por `path`: un admin gestiona su nodo + descendientes (no ancestros ni otra red). Endpoint `GET /tenants/network` (el consolidador ve su red).
- ✅ Cierre de hueco de authz: gestionar credenciales BYOC y dar de alta usuarios/sub-agencias sólo dentro del subárbol propio (antes cualquier admin podía escribir credenciales de cualquier tenant).
- ✅ Tests: factory BYOC (5/5 unit) + autorización jerárquica (integración, se salta sin DB).

**Entregado — Roles ampliados + JWT con `tid` (Fase 0 pasos 3-4):**

- ✅ Roles `consolidator_admin` y `agency_admin` en el CHECK de `memberships.role` (migración 0013) y en el tipo `Role`; reconocidos como admins en `NetworkService`, `is_admin_user()` y los `assertAdmin`.
- ✅ JWT lleva `tid` (tenant activo) + `role`; `login`/`register` lo pueblan; `POST /auth/switch-tenant` valida membership activa y emite token firmado con el `tid` elegido.
- ✅ Middleware: usa `x-tenant-id` (header, compat web-b2b) con fallback al `tid` del JWT. Backward-compatible (tokens viejos sin `tid` siguen igual).

**✅ Hallazgo de seguridad de `x-tenant-id` — CERRADO:** el API ya no confía ciegamente en el header. El middleware valida el `x-tenant-id` con `NetworkService.canAccessTenant` (miembro directo, superadmin, o admin de un ancestro para act-as); si el usuario no está autorizado, **ignora el header y usa el `tid` firmado** (drop-on-invalid, nunca throw). Así un cliente directo no puede operar bajo un tenant ajeno. Cubierto por tests de integración (vendedor accede sólo a su tenant; header forjado rechazado). _Nota perf: agrega 1 query de validación por request autenticado con header; aceptable a esta escala._

**✅ Entregado — UI de gestión de red** (`web-b2b`): página `/red` ("Mi Red") con árbol de agencias/sub-agencias, alta de sub-agencia bajo un nodo, gestión de credenciales BYOC por nodo, y **resumen de ventas por nodo** (reservas/cotizaciones). Nav "Mi Red" visible para roles admin.

**✅ Entregado — Harness de tests con Postgres en CI:** job `test` en `ci.yml` levanta `postgres:16`, aplica todas las migraciones y corre la suite del API. Los tests de integración (jerarquía, BYOC, autorización, waterfall, agregación) **corren y validan en cada push/PR**.

**✅ Entregado — Agregación de red** (0014): función `network_sales_summary` (SECURITY DEFINER, gateada por `canManageTenant`). El consolidador ve orders/quotations de toda su red. _Se eligió este enfoque sobre políticas RLS descendentes a propósito: cero riesgo para el aislamiento de las queries normales._

**✅ Entregado — Audit log** (0015): `domain_events` append-only + `AuditService.emit` (best-effort, sin secretos). Emite en cambios de credenciales, creación de tenants y cambios de rol.

**✅ Entregado — Roles** (#3): `createTenant` asigna `consolidator_admin`; `PATCH /admin/memberships/role` cambia roles (gateado + auditado).

**✅ Entregado — Pricing waterfall** (0016): `compute_price_waterfall` aplica markups en cascada por nivel del path (percentage compone, fixed suma); `POST /pricing/waterfall`. Con test de cascada en CI.

**Pendiente (siguiente iteración):**

- **Aplicar el waterfall al flujo real de cotización** (hoy es un simulador via endpoint); visibilidad de breakdown por rol (la sub-agencia ve su costo+final, no el neto del consolidador).
- **UI de roles y simulador de pricing** en el panel (los endpoints ya existen).
- Verticales nuevos (hoteles/asistencias) y conciliación BSP — Fases 3-4.

### Decisión de secuenciado pendiente (de la investigación)

La investigación deja una pregunta de producto importante: **¿profundidad NDC/offer-order vs amplitud multi-contenido?** NDC ya es baseline pero la cuota de ventas NDC de agencias sigue baja (~10% histórico) y la profundidad offer/order varía. Para un consolidador LATAM, la recomendación tentativa es **amplitud primero** (sumar un segundo source aéreo + hoteles para cumplir el ">80% quiere contenido unificado") sobre profundizar NDC avanzado — pero esto se valida con el founder en función de los contratos de inventario disponibles. Va como **D5** a confirmar.

---

## §6 — Hardening de seguridad (auditoría Tier 1-3)

Auditoría transversal de seguridad sobre la app desplegada (sesiones, auditoría/asientos, roles, estadísticas). Validado con typecheck + lint + tests de integración en Postgres (CI) y desplegado a prod.

**✅ Tier 1 (crítico):**

- PII de pasajeros/PNR fuera de los logs del GDS (logging gateado tras `LATAM_DEBUG_HTTP`).
- `error.message` crudo ya no se filtra en respuestas 500 (`AllExceptionsFilter` → "Internal server error").
- Endpoints `/admin/*` con scoping real (`assertSuperadmin`), sin enumeración cross-red.

**✅ Tier 2 (alto):**

- Rate limiting anti brute-force: `@nestjs/throttler` (300/min global, 10/min en login/register) con tracker por `CF-Connecting-IP` (`IpThrottlerGuard`).
- Validación de montos de cartera (entero positivo, tope de cordura) en depósitos/retiros/holds.

**✅ Tier 3 (medio):**

- **Cifrado de PII de clientes** (migración 0018 + `pii-cipher.ts`): `document_number` en reposo con AES-256-GCM + **blind index** HMAC para búsqueda/dedup por igualdad. Sub-claves vía HKDF de la clave maestra existente (sin secret nuevo). Filas legacy quedan en claro hasta sobreescribirse → **pendiente backfill** (script con la clave). Test unitario 5/5.
- **Hardening de sesiones/login** (migración 0019 + `auth.service.ts`): **account lockout** por usuario (5 fallos consecutivos → bloqueo 15 min, complementa el rate-limit por IP), **timing-guard** con `bcrypt.compare` dummy para no filtrar existencia de cuenta (anti-enumeración), `last_login_at`, y **auditoría de eventos de auth** a `domain_events` (`auth.register`, `auth.login.success/failed/blocked`, `auth.switch_tenant`). Test de integración del lockout (se salta sin DB, corre en CI).
- **Validación Zod en endpoints restantes** (`*/dto.ts` + `ZodValidationPipe` por endpoint): customers (create/update), orders (create/reshop/pay), quotations (create/status/customer) y provider-accounts (upsert). Valida integridad en el borde (longitudes, email, fechas parseables, `providerCode`, `tenantId` uuid, credenciales no vacías) y **sanea** claves desconocidas; los blobs provider-shaped (offer/searchCriteria/credentials) se validan como objeto con **passthrough** para no perder datos anidados. Sin imponer ISO estricto en campos libres (`'COL'`/`'PASAPORTE'`) para no romper el cliente. 13 tests unitarios.
- **RLS jerárquica de `memberships`** (migración 0020): la policy `memberships_admin_read` pasaba de `is_admin_user()` (cualquier admin leía TODAS las memberships de TODA la DB — fuga cross-red) a `can_read_membership(tenant_id)`, función SECURITY DEFINER que acota la lectura al **subárbol del admin por `path`** (espejo de `canManageTenant`); el superadmin ve todo. Las escrituras siguen gobernadas por `memberships_tenant_isolation` (FOR ALL, WITH CHECK) → login/register/changeRole intactos. Test de integración que invoca la función real (corre en CI).

**Pendiente (Tier 3, opcional):**

- Backfill de PII legacy de clientes (cifrar filas existentes).
- (Opcional) refresh tokens / revocación de sesión y MFA para roles admin+.

## §7 — Notificaciones por email (BYO-email) + verificación

- **BYO-email por agencia**: cada nodo puede configurar su propio remitente (servidor SMTP, correo y **clave de aplicación**) para las notificaciones a su red. Reutiliza la infraestructura BYOC (`provider_accounts` con `provider_code = 'email'`): la clave va cifrada (AES-256-GCM), host/puerto/remitente en `config`, y la **resolución hereda** (propia → ancestro heredable → **default del sistema** vía env `MAIL_*`). Sin tabla nueva. UI: sección "Email" por nodo en _Mi Red_ (`EmailModal`).
- **MailerService** (`apps/api/src/mail`, nodemailer): `sendToTenant(tenantId, msg)` resuelve el remitente y envía; **best-effort** (nunca rompe la operación de negocio). 5 tests de resolución de spec.
- **Verificación de email**: token con **audiencia dedicada** (un link de verificación no sirve como bearer de API y viceversa); envío best-effort en `register`; `POST /auth/verify-email` (público) + `POST /auth/resend-verification`; sella `users.email_verified_at` (idempotente) y audita `auth.email_verified`. UI: página pública `/verificar`. No bloquea el login (no rompe usuarios existentes). 3 tests de separación de audiencia.
- **Gestión de usuarios/roles por nodo**: `GET /tenants/network/users` (gateado por `canManageTenant`) + UI `UsersModal` (listar, cambiar rol, invitar) en _Mi Red_.
- **Notificaciones reales (cotización + reserva)** (`mail/templates.ts`): `POST /quotations/:id/send-email` envía la cotización al cliente; `POST /orders/:id/send-confirmation` + auto-envío best-effort al crear la reserva mandan la confirmación con PNR. Todo vía `MailerService` (BYO-email). UI: "Enviar por email" en la cotización ahora envía de verdad (antes abría `mailto`); botón "Enviar confirmación por email" en el detalle de reserva. WhatsApp sigue por `wa.me` (canal real).
- _Requiere para envío real_: definir el SMTP por defecto del sistema (`MAIL_HOST`/`MAIL_PORT`/`MAIL_USER`/`MAIL_PASS`/`MAIL_FROM`) y `APP_WEB_URL` para el enlace de verificación.

## §8 — Post-venta durable (operaciones) — Fase 1 (primer incremento)

- **`order_operations`** (migración 0021): tabla append por orden que registra cada operación de post-venta (cancelar/void, pagar/emitir, reemisión/reshop) con `status` (pending/success/failed), `last_error`, `attempts` y actor. RLS forzada por tenant. `result` nunca guarda datos sensibles (PAN/CVV).
- **OrdersService** registra cada operación (éxito o fallo, incl. excepciones del proveedor); `listOperations` y `retryOperation` (hoy reintenta **cancelación** re-ejecutando el void con el PNR de la orden; `pay` no se reintenta porque no guardamos datos de tarjeta — PCI).
- **Endpoints**: `GET /orders/:id/operations`, `POST /orders/:id/operations/:opId/retry`. **UI**: "Historial de operaciones" en el detalle de la reserva con badges de estado, el error humanizado y botón **Reintentar** en cancelaciones fallidas. Test de integración (CI).
- **Pendiente (evolución):** **worker durable** (Temporal/BullMQ) para reintentos automáticos y la **saga de reserva** con compensación; reembolso y reemisión/cambios como flujos NDC propios.

## §9 — Modelo de red: Planetour, sucursales y superadmin (rama `feat/network-model`, 2026-09-28)

Primera tanda del modelo de [§3.0](#30-modelo-de-red-validado-2026-09-28). Se desplegó con el merge de #6 (`fb25713`); el runbook está en [13 §5](./13-validacion-modelo-red.md#5-runbook-del-vps), pasos 1 a 6.

- **Base** (0049–0051): Planetour pasa a `platform`; una sola plataforma y sin padre; `tenants.is_branch`; trigger con la matriz D4 A en toda escritura de `tenants`; `move_tenant_subtree` (D6 A) con evento `tenant.moved`. Errores propios (STH01 regla de la jerarquía, STH02 movimiento bloqueado) que la API devuelve como 409 con motivo.
- **API de nodos**: el tipo del hijo sale del padre y el padre por defecto es Planetour; `platform` nunca se crea por API; consolidador y sucursal, sólo el superadmin bajo Planetour. `PATCH /admin/tenants/:id` (estado, sucursal, tipo) y `POST /admin/tenants/:id/move`, sólo superadmin y auditados. Sin escalada de roles (G-06) y sin `platform_admin` asignable (D7 B).
- **El superadmin no vende**: 403 `PLATFORM_ROLE_CANNOT_SELL` en las rutas `@SalesOperation()`, con un test que falla si una ruta de venta queda sin marcar. La web le quita la venta del menú.
- **`seed-superadmin`** arreglado (G-04): promueve sin renombrar, no toca contraseñas existentes, idempotente y auditado.
- **Panel**: _Gestión de Agencias_ es el árbol de la red, con alta, mover, suspender/activar y marcar sucursal; _Mi Red_ toma como raíz la plataforma.
- **Pendiente** (tanda 2): el neto del proveedor (G-02), el simulador de reglas (G-01), "entrar como" (G-17), el reporte de comisiones (G-16), el CRM y las decisiones D2, D3 y D5. Detalle en [13 §4](./13-validacion-modelo-red.md#4-qué-queda-para-la-tanda-2). Las carteras, que también eran de la tanda 2, están resueltas en [§10](#10--carteras-por-moneda-y-quién-las-establece-2026-09-29).

## §10 — Carteras por moneda y quién las establece (2026-09-29)

Rama `feat/wallets-per-currency`, desde `main` 5de126d. Sin desplegar al escribir esto; el runbook está en [13 §5](./13-validacion-modelo-red.md#5-runbook-del-vps), pasos 7 a 9. Cierra la brecha crítica de carteras de la auditoría del 2026-09-28: cualquier admin se registraba depósitos, retiros y su propio cupo.

**La decisión (founder, 2026-09-29, opción A).** La cartera de cada agencia la establece quien la financia: su ancestro más cercano de tipo plataforma, consolidador o agencia. A lo que cuelga de Planetour (agencias, sucursales y consolidadores) lo financia Planetour, y eso lo opera su superadmin. A las agencias de un consolidador las financia el consolidador, con sus admins o el superadmin, y a las sub-agencias, su agencia. La raíz Planetour sólo la gestiona el superadmin. Quien financia define en qué monedas opera la agencia (una cartera por moneda), el cupo de cada cartera y los depósitos y ajustes, con motivo, quién y cuándo, auditados en `domain_events`. La agencia sólo ve sus carteras e informa depósitos.

- **Base** ([0052](../../db/migrations/0052_wallets_per_currency.sql), [0053](../../db/migrations/0053_tenant_credit_limit_to_wallets.sql)):
  - `agency_portfolios` pasa a ser única por `(tenant_id, currency)`, conservando las filas que había. La moneda y el nodo de una cartera no cambian.
  - `tenant_financier_id` y `can_finance_tenant` dicen quién financia a cada nodo y si el usuario del request puede hacerlo.
  - Unos triggers dejan el cupo, el estado, los depósitos y los ajustes sólo a quien financia, con el asiento firmado por el usuario que actúa y con la hora de la base.
  - El libro es de sólo agregar para `app_user`, y la aplicación no borra carteras.
  - `portfolio_deposit_reports` tiene RLS y una sola transición (`pending` → `approved` o `rejected`), y la base deja el `domain_event` de cada paso.
  - Errores propios: STW01 (regla de las carteras) da 409, y 42501 con `portfolio_financier_required` (o las reglas de autoría del asiento y de la resolución) da 403.
  - 0053 pasa `tenants.credit_limit` (0007) al cupo de la cartera en la moneda por defecto del nodo, y la columna queda fuera de uso.
- **API** (`apps/api/src/portfolios/`):
  - Quien financia trabaja en `/tenants/:tenantId/portfolios`: habilitar moneda, cupo, suspender o reactivar, depósitos y ajustes con `Idempotency-Key`, y aprobar o rechazar depósitos informados. Todo corre con `withRequestContext({ userId, tenantId: nodo dueño })`, con Zod y motivo obligatorio (al aprobar un depósito informado es opcional), y en la misma transacción que su `domain_event`.
  - La agencia, en `/portfolios`, lee sus carteras, movimientos e informes, e informa depósitos. `deposit`, `withdraw` y `credit-limit` responden 403 `PORTFOLIO_FINANCIER_REQUIRED`.
- **Retención:**
  - Toda retención (el hotel antes del Book, y vuelos o autos confirmados por `hold-booking`) va a la cartera de la agencia en la moneda de la tarifa, con el tope del saldo más el cupo y sin convertir.
  - Sin cartera en esa moneda, 409 `PORTFOLIO_CURRENCY_NOT_ENABLED`, sin abrir una implícita. Con la cartera suspendida, `PORTFOLIO_INACTIVE`, y sin fondos, `PORTFOLIO_FUNDS_INSUFFICIENT`. En hoteles, antes de llamar al proveedor.
  - El PreBook de hoteles devuelve `funding` para avisar antes de cargar huéspedes. `tenants.credit_limit` ya no se lee.
- **Web:**
  - _Gestión de Agencias_ → nodo → _Carteras_ para el superadmin y _Mi Red_ → agencia → _Carteras_ para quien financia: carteras por moneda, habilitar moneda, cupo, suspender o reactivar, depósitos y ajustes con confirmación, aprobar o rechazar depósitos informados, y el historial.
  - _Cartera B2B_ ya no deposita, retira ni fija el cupo: la agencia ve sus carteras y movimientos, e informa depósitos con **Informar depósito**.
  - La búsqueda de hoteles avisa si la agencia no tiene cartera activa en la moneda elegida.
- **Tests:** base, API y retención corren como `app_user` contra Postgres en el CI (`wallets-rls`, `wallet-financing`, `holds-per-currency`). Incluyen el que pedía la auditoría: el admin de una agencia no puede tocar su cupo.
- **Pendiente:** la conciliación del saldo contra el libro, la recarga real y los extractos ([§4.3](#43-pagos-y-fondos)), un test de dos aprobaciones a la vez, prohibir en la base que una agencia abra carteras vacías, borrar `tenants.credit_limit` y las monedas sin dos decimales. Detalle en [13 §4.4](./13-validacion-modelo-red.md#44-después-de-la-tanda-2). El registro de la decisión para TBO es D-TBO-21 en [tbo/08](../tbo/08-requisitos-maestro.md#d-tbo-21--cómo-se-cobra-y-cómo-se-controla-el-crédito-limit).

## §11 — Tarifas no reembolsables: aviso, confirmación obligatoria y control por agencia (2026-09-29)

Rama `feat/hotels-redesign`. Sin desplegar al escribir esto. Pedido explícito del founder: máxima claridad para agencias y clientes sobre las tarifas de hotel que no se reembolsan.

**Qué es "no reembolsable".** Lo decide el servidor (`apps/api/src/hotels/hotel-non-refundable.ts`) con la política FINAL del PreBook y la hora de ahora, de forma conservadora: la declarada así (también si TBO manda `IsRefundable=false` con tramos a 0), y la reembolsable cuyo cargo del 100 % ya rige o puede regir (los tramos están en hora local del hotel sin zona, así que se compara contra UTC+14). La web usa la misma lectura (`rate-refundability.ts`). El 100 % es el precio de VENTA: lo que se descuenta de la cartera o del crédito de la agencia.

- **Base** ([0055](../../db/migrations/0055_non_refundable_rates_permission.sql)): `tenant_booking_permissions` (un permiso por nodo, sin fila = `allowed`) con RLS forzada: lo lee el nodo, quien administra un ancestro y quien lo financia; lo escribe sólo quien lo financia (`can_finance_tenant`, el mismo modelo que las carteras), firmado por el usuario que actúa; nadie lo borra desde la aplicación. `non_refundable_rates_block(tenant)` dice si rige un bloqueo (`own` o `inherited`: el bloqueo de un consolidador alcanza a sus agencias y sub-agencias) y lanza 42501 para un nodo que quien pregunta no puede ver, en vez de responder "permitido".
- **API:**
  - `GET/PUT /tenants/:tenantId/booking-permissions` para quien financia (motivo obligatorio, `domain_event` `booking.permissions.non_refundable_rates.changed` en la misma transacción); `GET /hotels/booking-permissions` y `nonRefundableRates` en el sobre de `POST /hotels/availability` para que la web marque las tarifas.
  - PreBook: bloqueada para la agencia → 403 `NON_REFUNDABLE_BLOCKED` (antes de llamar al proveedor si la búsqueda ya la mostró no reembolsable; después, sin guardar snapshot, si lo es con la política final). Si no, la respuesta lleva `nonRefundable` con el 100 %.
  - Book: bloqueada → 403 `NON_REFUNDABLE_BLOCKED`; sin `nonRefundableAcknowledged: true` → 400 `NON_REFUNDABLE_NOT_ACKNOWLEDGED` con el monto en `details`. Se vuelve a comprobar después de la revalidación de C2. Nada sale al proveedor en esos casos.
  - La orden guarda en `selected_offer.nonRefundable` por qué lo es, el 100 %, la política aceptada (tramos en hora local del hotel) y quién la aceptó, cuándo y sobre qué monto; el evento `HotelNonRefundableAcknowledged` lo audita antes del Book, sin PII ni texto del proveedor.
  - La confirmación por correo de una reserva de hotel usa su propia plantilla, con el recuadro "Tarifa no reembolsable" y el monto exacto (con centavos).
  - El PreBook y el Book directos de Despegar (`choiceId` / `prebookId`, sólo por API) no informan la política de cancelación antes de reservar: con las no reembolsables bloqueadas para la agencia se rechazan enteros con 403 `NON_REFUNDABLE_BLOCKED`, para que la API directa no sea la puerta de lo que quien financia bloqueó.
- **Web:** etiqueta y filtro en resultados (ya estaban), aviso con el monto en el detalle y un aviso grande en el paso 1 del checkout; casilla OBLIGATORIA en el paso 2 con el monto exacto y el recordatorio de revisar nombres y fechas; "No reembolsable" en Mis Reservas (lista y detalle, con cuándo lo aceptó el vendedor), en el voucher (sin importes) y en el correo; cancelación con el 100 % y doble confirmación; control "Puede reservar tarifas no reembolsables" en _Gestión de Agencias_ y _Mi Red_ → nodo → _Carteras_. Bloqueadas, las tarifas se muestran como "No disponible para tu agencia" y no se ofrece reservarlas.
- **Tests:** unidad de la clasificación, del PreBook y del Book (incluidos los rechazos y el registro en la orden), y la integración de 0055 como `app_user` (`booking-permissions.integration.test.ts`).
- **Pendiente:** no hay cotización de hotel para el cliente en la web (sólo la de vuelos): cuando exista, tiene que decir "No reembolsable" igual que el voucher. El flujo directo de Despegar tampoco puede exigir la confirmación de una no reembolsable a una agencia que las tiene permitidas (no sabe cuál lo es): se cierra cuando Despegar pase al contrato neutral con órdenes.

## §12 — Suspender corta el nodo, no a la persona; invitaciones con respaldo (2026-09-29)

Cierra dos brechas de la auditoría del 2026-09-29. Va sobre auth premium (#12, 0055).

- **Sesiones al suspender una membership.** Antes, suspender la membership de un nodo cerraba todas las sesiones del usuario (`revoke_user_sessions`, 0026). Un vendedor que opera en dos agencias quedaba afuera de las dos, y el admin de una sucursal donde el superadmin es miembro podía cerrarle todo. El corte del nodo ya lo hace `SessionService.validate`, que lee rol y estado de la membership en cada request. Ahora sólo se revocan las sesiones del subárbol del nodo cuyo nodo ya no tiene membership activa del usuario (`revoke_user_sessions_for_tenant`, [0056](../../db/migrations/0056_membership_scoped_revocation.sql)). Eso libera el puesto y le dice al usuario por qué quedó afuera. La revocación de todas las sesiones queda para la suspensión del usuario (superadmin), el cambio de contraseña y el reset de 2FA.
- **Invitaciones que sobrevivían a quien las emitió.** Una invitación vale mientras su invitador la pueda volver a emitir: usuario activo, con un rol que supere al de la invitación sobre el nodo (la misma regla que para invitar, G-06), y el nodo con sus ancestros activos. La regla está en `invitation-validity.ts` (con `ROLE_RANK`) y los datos los junta `invitation_backing` (0056).
  - Al suspender o degradar una membership, o al suspender al usuario, se revocan en la misma transacción las invitaciones que emitió en ese subárbol (en toda la red si es la suspensión del usuario) y que ya no podría emitir, cada una con su `UserInvitationRevoked` (`cause`, `defect`). Las que otro rol suyo sigue respaldando quedan.
  - El canje marca la invitación con `claim_pending_invitation` dentro de la transacción que crea la membership y revalida invitador y nodo. Si no pasa, responde 400 `INVITATION_NO_LONGER_VALID` ("Esta invitación ya no es válida, pide una nueva."), deja la invitación pendiente (el rollback la devuelve) y escribe `UserInvitationRejected`.
- **API:** `PATCH /admin/memberships/status`, `PATCH /admin/memberships/role` y `PATCH /admin/users/status` hacen el cambio, las revocaciones y su evento en una transacción, y devuelven `revokedSessions` y `revokedInvitations`. `GET /admin/memberships/impact` responde cuántas invitaciones revocaría un cambio, con las mismas validaciones: lo aplica en una transacción que se deshace.
- **Web (Equipo):** la confirmación de suspender o degradar dice "Se revocarán N invitaciones que envió", y el aviso de éxito dice cuántas se revocaron. Suspender aclara que en otros nodos sigue operando. Cada invitación pendiente muestra "Invitado por X · hace N días". El canje distingue la invitación que ya no vale de la usada, vencida o revocada.
- **Tests:** `membership-revocation.integration.test.ts` corre como `app_user` contra Postgres. Cubre al usuario suspendido en A que sigue operando en B, al superadmin miembro de una sucursal, las invitaciones del suspendido y del degradado, el canje revalidado y el aislamiento entre redes.

## §13 — Cambiar de agencia desde el panel (2026-09-29)

Sobre auth premium (#12: puestos simultáneos, una sesión por usuario, `SEATS_FULL`). Cierra el hallazgo de la auditoría del 2026-09-29: aceptar una invitación le suma a una cuenta existente una membership en otra agencia, y `POST /auth/switch-tenant` existía, pero el panel no lo llamaba nunca y el menú _Agencia Activa_ sólo mostraba la actual. Además la agencia por defecto tenía dos criterios: la API abría la sesión en la membership más antigua y el panel tomaba la primera de `/me/memberships` por orden alfabético, sin mirar su estado.

- **Un solo criterio de agencia por defecto** ([`default-tenant.ts`](../../apps/api/src/auth/default-tenant.ts)): la última agencia con la que operó (`users.last_tenant_id`, [0061](../../db/migrations/0061_users_last_tenant.sql)) si sigue con membership activa y su nodo opera; si no, la más antigua que opera; si ninguna opera, la más antigua igual, para que el panel explique por qué. Lo usan el login (también al liberar un puesto) y `GET /me/memberships` (`isDefault`). La columna se escribe cada vez que se emite una sesión con tenant.
- **API:**
  - `POST /auth/switch-tenant` responde 403 `TENANT_SUSPENDED` si el destino o un ancestro no está activo (antes emitía una sesión sin rol), sin tocar la sesión actual. Con el cupo del destino lleno sigue el 409 `SEATS_FULL` de auth-premium.
  - `GET /me/memberships` suma `logoUrl` (heredado, 0030), `tenantType`, `operable`, `unavailableReason` (`tenant_suspended`, `tenant_archived`, `ancestor_suspended`), `blockedByName` e `isDefault`. Sigue en orden alfabético y con todas las memberships.
- **Web:**
  - Selector de agencia en el topbar, en el drawer móvil (_Cambiar de agencia_) y en la paleta ⌘K / Ctrl+K (_Cambiar de agencia…_, más las pantallas del menú). Hoja desde abajo en el teléfono, paleta en escritorio; buscador desde 5 agencias; las que no operan aparecen al final, deshabilitadas y con su motivo.
  - Elegir llama a `switch-tenant`, reescribe `st_session` y `st_tenant` juntas, hace `router.refresh()`, avisa a las otras pestañas y muestra "Ahora operas como <Agencia>" (en "tú" neutro, como el resto de los textos nuevos). Con `SEATS_FULL` se muestra el mismo panel del login: quien administra el nodo del cupo desconecta a alguien (`/auth/seats/release`) y entra.
  - El middleware alinea `st_tenant` con el `tid` de la sesión: la cabecera `x-tenant-id` ya no se despega del nodo cuyo puesto ocupa la sesión. El layout y las guardas de administración resuelven la agencia activa con `resolveActiveMembership` (la de la sesión, si no la `isDefault` de la API), y el layout ya no intenta escribir cookies.
  - El drawer móvil se dibuja en un portal a `<body>`: el `backdrop-filter` del header lo encerraba en sus 56 px.
- **Tests:** criterio y vista de memberships (unit), `AuthService` con dobles, y [`tenant-switch.integration.test.ts`](../../apps/api/src/auth/tenant-switch.integration.test.ts) contra Postgres como `app_user` (en CI). En la web, la lógica pura (`agencies`, `tenant-switch`, `command-menu`, middleware) y el render del selector.
- **Pendiente:** elegir con qué agencia entrar cuando el cupo de la por defecto está lleno en el login (hoy se muestra `SEATS_FULL` de esa agencia), y llevar a la pantalla de inicio si la página abierta no existe en la agencia nueva (hoy se refresca la misma ruta).
