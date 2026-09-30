# 12 — Modelo Consolidador (B2B2B / BYOC), Diagnóstico de Gaps y Plan de Implementación

**Versión:** 1.3
**Fecha:** 2026-06-03 · **Actualizado:** 2026-09-29 (carteras por moneda, [§10](#10--carteras-por-moneda-y-quién-las-establece-2026-09-29); tarifas no reembolsables, [§11](#11--tarifas-no-reembolsables-aviso-confirmación-obligatoria-y-control-por-agencia-2026-09-29); retención en cascada, [§12](#12--retención-en-cascada-opción-1)); 2026-09-28 (modelo de red validado, §3.0)
**Propósito:** Tres cosas en un solo documento: (1) incorporar formalmente el **modelo consolidador con credenciales propias (BYOC)** al target de la plataforma; (2) un **diagnóstico honesto** de dónde estamos vs. la visión y vs. el mercado; (3) un **plan secuenciado** para construirlo y pulirlo con UX limpia y mejores prácticas.

> Este doc es la fuente de verdad para el modelo consolidador. El target ya quedó reflejado en `CLAUDE.md`, `docs/discovery/06-documento-maestro.md` §1.1 y `docs/platform/10-mapa-completo-plataforma.md` (entidad TENANT + jerarquía M8.1).

> **Actualización 2026-09-28: el modelo de red está validado y firmado por el founder.** Planetour es la raíz única de tipo `platform`. Vende a nombre propio por sus **sucursales**. Las agencias externas y los consolidadores cuelgan de Planetour. El **superadmin** cuadra la red, pero **no vende**. Lo firmado está en [§3.0](#30-modelo-de-red-validado-2026-09-28) y manda sobre lo que diga en contrario el resto del documento, que se escribió en junio. La auditoría, lo que ya se arregló, lo pendiente y el runbook de producción están en [13 — Validación del modelo de red](./13-validacion-modelo-red.md).

> **Actualización 2026-09-29: carteras por moneda.** La cartera de cada agencia la establece **quien la financia** (opción A del founder): Planetour, por su superadmin, para lo que cuelga de la plataforma; el consolidador para sus agencias; la agencia para sus sub-agencias. Hay una cartera por moneda, con su cupo. La agencia sólo ve sus carteras e informa depósitos, que quedan pendientes hasta que quien la financia los aprueba. Una reserva se retiene en la cartera de la moneda de la tarifa, y sin ella se rechaza (en hoteles, antes de llamar al proveedor). Cierra la brecha crítica de carteras de la auditoría. Detalle en [§10](#10--carteras-por-moneda-y-quién-las-establece-2026-09-29) y [13 §4.1](./13-validacion-modelo-red.md#41-confidencialidad); runbook en [13 §5](./13-validacion-modelo-red.md#5-runbook-del-vps), pasos 7 a 9.

> **Actualización 2026-09-29: retención en cascada ("opción 1" del founder).** El cupo ya no puede crecer sin tope a lo largo de la red. Una reserva retiene en la cartera del nodo que vende y, además, en la de cada nivel que lo financia, en la moneda de la tarifa, hasta el dueño de la credencial con que se reserva. El que vende retiene el precio de venta y cada ancestro su costo. Si un nivel no alcanza, no se retiene en ninguno y no se llama al proveedor. Lo decide la base desde la orden (0060). Detalle en [§12](#12--retención-en-cascada-opción-1); runbook en [13 §5](./13-validacion-modelo-red.md#5-runbook-del-vps), paso 14.

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

**Carteras: ¿hasta dónde retiene una reserva?** ✅ **Opción 1, en cascada** (founder, 2026-09-29). Retiene el nodo que vende y cada nivel que lo financia, hasta el dueño de la credencial con que se reserva, sin incluirlo, en la moneda de la tarifa. La alternativa "nadie da más cupo del que tiene" no se eligió. Se aplica en 0060 ([§12](#12--retención-en-cascada-opción-1)).

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

| Gap                                                                    | Prioridad | Por qué                                                                                                  |
| ---------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------- |
| **Gateway real** (Stripe + MP) hosted checkout (SAQ-A)                 | **P0**    | Hoy no se cobra. Bloquea operación.                                                                      |
| **Wallet / depósitos de agencia** con extracto y conciliación de saldo | **P0**    | Carteras por moneda (§10) con retención en cascada (§12). Faltan recarga real, extractos y conciliación. |
| Split payments / payout por nodo (consolidador↔agencia)               | P1        | Reparto de márgenes en la red.                                                                           |
| Métodos locales (PIX, PSE, Yape/Plin, Boleto)                          | P1        | Conversión en LATAM.                                                                                     |
| Antifraude / 3DS                                                       | P2        | Riesgo a escala.                                                                                         |

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
4. **Modelo de red (2026-09-28):** la tanda 1 está en producción desde el merge de #6. De la tanda 2 ya están las carteras por moneda ([§10](#10--carteras-por-moneda-y-quién-las-establece-2026-09-29), mergeadas con #10), que se despliegan con los pasos 7 a 9 del runbook de [13 §5](./13-validacion-modelo-red.md#5-runbook-del-vps), y la retención en cascada ([§12](#12--retención-en-cascada-opción-1)), con el paso 14. Falta el resto: G-02 (el neto del proveedor, la otra crítica), G-01, G-17, G-16, el CRM y las decisiones D2, D3 y D5 ([13 §4](./13-validacion-modelo-red.md#4-qué-queda-para-la-tanda-2)).

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

## §12 — Retención en cascada (opción 1)

Rama `feat/wallets-credit-cascade`, desde `main` 7f9f011, con las carteras por moneda de [§10](#10--carteras-por-moneda-y-quién-las-establece-2026-09-29) ya mergeadas (#10). La base está en [0060](../../db/migrations/0060_wallet_network_holds.sql), la API en `apps/api/src/portfolios/` y la web en _Cartera B2B_ y en _Carteras_ de cada nodo. Sin desplegar al escribir esto; el runbook es el [paso 14 de 13 §5](./13-validacion-modelo-red.md#paso-14--deploy-de-la-retención-en-cascada-0060). El número sigue a §11 (tarifas no reembolsables) y a los pasos 10 a 13 del runbook, que llegaron a `main` con el rediseño de hoteles (#11).

**El riesgo que cierra.** Desde §10 el cupo de cada cartera lo fija quien la financia, pero nada acotaba cuánto podía dar ese financiador. Una agencia le daba cupo ilimitado a su sub-agencia, y la sub-agencia reservaba con la cuenta de proveedor que hereda de Planetour, que es la que le paga al proveedor. La retención caía sólo en la cartera de la sub-agencia, así que el cupo no tenía tope a lo largo de la cadena de financiación.

**La decisión (founder, 2026-09-29, "opción 1").** Cada reserva retiene también en la cartera de cada nivel que financia, en la moneda de la tarifa, hasta el dueño de la credencial con que se reserva. La otra opción, "nadie da más cupo del que tiene", no se eligió.

### 12.1 Quién retiene

T es el nodo que vende (`app.current_tenant_id`) y O el dueño de la credencial.

- **T retiene siempre**, en su cartera de la moneda de la tarifa, el precio de venta, como hasta ahora (D-TBO-21 A). Es el nivel 0 (`depth` 0, asiento `BOOKING_HOLD`) y vale también cuando O es T.
- **Retiene además cada ancestro de T que financia** y está por debajo de O: los de tipo `platform`, `consolidator` o `agency` con `nlevel` mayor que el de O. Van del más cercano al más lejano (`depth` 1, 2, …; asiento `NETWORK_HOLD`). Con la matriz D4 equivale a aplicar `tenant_financier_id` desde T hacia arriba hasta O, sin incluirlo.
- **O y la raíz nunca retienen.** "Hasta el dueño" excluye al dueño: O le paga al proveedor con su propio contrato, así que quien lo financia no queda expuesto por esa venta. La raíz siempre es O o está por encima de O.
- De los ancestros no se mira `tenants.status`, sólo el estado de su cartera. La suspensión de un nodo ya la frenan otras capas.

**De dónde sale O.** Siempre de la base, a partir de la orden. La API no lo pasa.

| La orden                                                                     | O                                                                                                                                                                                                                                                                 | `credential_source` |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Guarda la cuenta de la bóveda (`orders.provider_account_id`: hoteles de TBO) | El dueño de esa cuenta, si cumple el criterio de 0045: el mismo proveedor que la orden, estado `active` y cuenta propia de T o de un ancestro que la deja heredar. Si no lo cumple, se rechaza: `hold_owner_unresolvable` → 409 `PORTFOLIO_HOLD_ACCOUNT_CHANGED`. | `account`           |
| No guarda cuenta (vuelos, autos) y la bóveda le resuelve una al nodo         | El dueño de la cuenta que `resolve_provider_account` le resuelve a T para ese proveedor, sea la propia o la del ancestro heredable más cercano. Es la misma resolución con que se reservó. Se toma la de ahora, no la del momento de reservar.                    | `resolved`          |
| No guarda cuenta y la bóveda no resuelve ninguna (credenciales de entorno)   | La raíz del árbol de T, o sea Planetour. Un nodo legado suelto es su propia raíz y su cadena queda vacía.                                                                                                                                                         | `root`              |

**Casos.** P es Planetour (nivel 1), C un consolidador (2), A una agencia de C (3) y S una sub-agencia de A (4). B es una sucursal de P, A2 una agencia directa de P y S2 una sub-agencia de A2. Los tests de integración corren estos casos con la tabla de `apps/api/src/portfolios/__fixtures__/network-hold-cases.ts`, donde S2 se llama S3.

| Vende                     | Con la credencial de               | Retienen | Nuevo desde 0060    |
| ------------------------- | ---------------------------------- | -------- | ------------------- |
| B (sucursal)              | P                                  | B        | —                   |
| A2                        | P                                  | A2       | —                   |
| C                         | P                                  | C        | —                   |
| A                         | P                                  | A y C    | C                   |
| S                         | P                                  | S, A y C | A y C               |
| S2                        | P                                  | S2 y A2  | A2                  |
| S                         | C                                  | S y A    | A                   |
| A                         | C                                  | A        | —                   |
| S                         | A (la base la admite; TBO hoy no)  | S        | —                   |
| C                         | su propia cuenta (O = T)           | C        | — (pregunta, §12.9) |
| S                         | credenciales de entorno (O = P)    | S, A y C | A y C               |
| S, sin cuenta en la orden | la de A, que la bóveda le resuelve | S        | —                   |

**En producción hoy** (Planetour, Amazon Minimalist bajo Planetour y una sucursal) todos los nodos son de nivel 2 o menos. La cadena de cualquier venta es vacía y no cambia ninguna.

### 12.2 Montos

- **Nivel 0: el precio de venta** (`orders.total_amount`), como hoy.
- **Cada ancestro L: su costo.** Lo calcula la base: el neto de la tarifa más los markups de los niveles de arriba de L (las entradas de `compute_price_waterfall` con `level < nlevel(L)`), con las mismas reglas y el mismo orden que el precio de venta (0016; `applyCascade` en la API). No incluye el piso del proveedor ni los markups de L y de sus descendientes: es lo que L le debe hacia arriba por esa venta.
- **El neto sale de la orden.** En hoteles y autos es `selected_offer.pricing.netMinor`; en hoteles lo escribe el intent y lo reescribe el revise de C2. En vuelos es `selected_offer.total`, porque la oferta canónica lleva ahí el neto del proveedor, revalidado antes de abrir la orden. Tiene que ser un entero entre 1 y 2^53 − 1 en la moneda de la orden.
- **Falla cerrado.** Si la cadena no es vacía y no hay neto válido, o si el costo de un nivel sale fuera de rango, la retención se rechaza con 409 `PORTFOLIO_NETWORK_COST_UNAVAILABLE` y no se escribe nada. Nunca vuelve en silencio al precio de venta.
- **Los montos no llegan por parámetro, pero salen de campos que escribe la API.** `wallet_hold_retain` recibe sólo la orden y quien firma, y lee la venta de `orders.total_amount` y el neto de `selected_offer`. Esos campos los escribe la API: en hoteles, el intent y el revise de C2; en vuelos, la revalidación antes de abrir la orden. La base no impide que `app_user` los cambie antes de retener ni después, así que la cascada confía en ellos: es la frontera de confianza (§12.8). El neto por parámetro lo reciben sólo el aviso previo (`wallet_hold_preview`) y su reporte. Corren antes de que exista la orden, y ese neto es el mismo que la base leerá después.

Ejemplo, el mismo de los tests: neto USD 1.000,00, reglas de hoteles P +5 %, C +8 %, A +10 % y S +12 %, y S vende con la cuenta de P.

| Nivel | Cartera | Base  | Cálculo                              | Retiene  |
| ----- | ------- | ----- | ------------------------------------ | -------- |
| 0     | S       | venta | 1.000,00 × 1,05 × 1,08 × 1,10 × 1,12 | 1.397,09 |
| 1     | A       | costo | 1.000,00 × 1,05 × 1,08               | 1.134,00 |
| 2     | C       | costo | 1.000,00 × 1,05                      | 1.050,00 |

### 12.3 Todo o nada

- Retener es una sola transacción con el tenant que vende. Bloquea la orden (`FOR UPDATE`) y la cartera propia. Después deriva la cadena, así un movimiento de nodo concurrente ya terminó o espera, y bloquea las carteras de la red por nivel, de la más profunda a la más alta.
- Cada nivel se decide antes de escribir: primero la cartera propia, con los motivos de siempre, y después la red. Un nivel alcanza con la regla de hoy: cartera en la moneda, `active`, y saldo más cupo mayor o igual que lo que retiene. El primer rechazo revierte todo, incluido el `BOOKING_HOLD` de T, y el proveedor no se llama. En hoteles el intent se cierra como no enviado.
- El orden de bloqueo es uno solo en retener, liberar y `move_tenant_subtree`: la orden, el grupo y las carteras por (`nlevel` DESC, id). Las tablas nuevas no tienen FK a `tenants`, para que una retención no tome un `KEY SHARE` que se cruce con un movimiento de nodo.
- La API corre cada retención y cada liberación con `lock_timeout` de 2 s. Ante un deadlock, un `lock_timeout` o un error de serialización, reintenta la transacción entera hasta 2 veces, con una espera al azar de 50 a 250 ms. Si la red sigue contenida, responde 409 `PORTFOLIO_HOLD_BUSY` al retener o `PORTFOLIO_RELEASE_BUSY` al liberar. Con `PORTFOLIO_RELEASE_BUSY` el estado de la reserva no cambia, y repetir el pedido termina de liberar. Antes esperaba sin límite.

### 12.4 Ciclo de vida

Cada retención es un grupo por orden (`wallet_hold_groups`) con un nivel por cartera retenida (`wallet_hold_levels`). El grupo y sus niveles comparten estado:

| Estado     | Qué significa                                                           | Cómo llega                                                                                                                                                                                                                                                                                      |
| ---------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `held`     | Retenida.                                                               | La retención de hoteles antes del Book, sobre un intent abierto (`pending`, sin desenlace del proveedor y con clave de creación). También vuelve a `held` cada vez que la orden pasa de `confirmed` o `ticketed` a `pending`: si la confirmación se retracta y mientras se cancela (ver abajo). |
| `captured` | La reserva se confirmó y la retención quedó como cargo. No mueve saldo. | Un trigger al pasar la orden a `confirmed` o `ticketed`. También nace así en la retención manual de una orden confirmada (`POST /portfolios/hold-booking`).                                                                                                                                     |
| `released` | Liberada en todos sus niveles.                                          | La orden quedó `failed` con el grupo `held`, o `cancelled` con el grupo `held` o `captured`.                                                                                                                                                                                                    |
| `conflict` | Requiere conciliación manual. No mueve saldo.                           | La orden pasa a `failed` con el grupo `captured` (figuró confirmada), o el libro tiene una liberación que no casa con lo retenido. Se escala.                                                                                                                                                   |

`wallet_hold_settle` cierra la retención según el estado de la orden:

- `pending`: devuelve `open` y no toca nada. Un desenlace incierto conserva la retención (D-TBO-24 A).
- `confirmed` o `ticketed`: captura si estaba `held`.
- `failed`: libera si estaba `held`. Si estaba `captured`, pasa a `conflict`.
- `cancelled`: libera si estaba `held` o `captured`.
- Una retención ya liberada devuelve `already-released`, una en conflicto `conflict` y una orden sin retención `no-hold`.

**Mientras se cancela.** El trigger que descaptura mira sólo el paso de `confirmed` o `ticketed` a `pending`, y cancelar también da ese paso. Lo dan el claim de cada cancelación en `OrdersService`, la primera y cada reintento, y el estado `cancelling` de un hotel. Por eso, durante la cancelación de una reserva cobrada, todos sus niveles vuelven a `held` y dejan `portfolio.hold.uncaptured`. El saldo no se mueve. Después:

- si la cancelación sale, se libera;
- si el proveedor la rechaza, la orden vuelve a `confirmed` y se captura otra vez, así que cada nivel tiene dos `portfolio.hold.captured`;
- si queda sin verificar (UNVERIFIED), la orden sigue `pending` y la retención `held` hasta que se verifique.

Mientras tanto, en _Reservas de tu red_ la reserva figura como Retenida, y su monto pasa del total cobrado al retenido en cada nivel.

**Liberar recorre lo registrado.** Nunca recalcula la cadena ni el dueño: si la cuenta se desactiva o el nodo se mueve después de retener, la plata vuelve a las mismas carteras. Cada nivel se libera con `BOOKING_RELEASED` (nivel 0) o `NETWORK_RELEASED` (ancestros). La liberación es reentrante: si el asiento de liberación de esa cartera y esa orden ya existe, lo enlaza sin volver a acreditar, y si no casa con lo retenido, el grupo pasa a `conflict`. Tampoco exige que la cartera esté activa, porque devolver lo retenido no es operar.

**Quién libera:**

- Hoteles: el Book que falla y la cancelación que confirma el proveedor, cada uno con el estado que espera de la orden. Si la orden no está en ese estado, 409.
- El rechazo: _Cartera B2B_ → **Reservas retenidas** → **Cancelar y liberar** (`POST /portfolios/orders/:id/reject`), como admin del nodo que vende. El superadmin desde Planetour no puede. Qué hace según la orden:
  - un vuelo se cancela con el proveedor, si su proveedor lo admite, y después se libera;
  - un hotel o un auto que no está `failed` ni `cancelled` da 400, porque se cancelan desde _Mis Reservas_;
  - una orden `failed` o `cancelled` se libera sin llamar al proveedor, en cualquier vertical. Pero la pantalla lista sólo las reservas `pending`, así que ese caso se pide por API.
- **Nuevo:** cancelar un vuelo o un auto desde _Mis Reservas_ (`POST /orders/:id/cancel`, `OrdersService.cancelOrder`). Antes sólo liberaba el rechazo. Si la liberación falla o está en conflicto, la cancelación no se deshace y se escala (`OrderEscalated`). La cancelación desde la pantalla de _Autos_ (`/cars/reservations/cancel`) va directo al proveedor: no actualiza la orden ni libera la retención.
- **Nuevo:** la conciliación diaria, en su paso R-W. Al terminar cada corrida de una cuenta de la bóveda recorre, en cada tenant de su red, las retenciones que no coinciden con su orden y las cierra. Son las abiertas con la orden `failed` o `cancelled`, y las `held` con la orden confirmada. Incluye las hechas con cuentas retiradas del mismo dueño y proveedor. Un conflicto o un error se escala en la orden y la corrida sigue. Sólo ve las retenciones que guardan su cuenta (`provider_account_id`), o sea las de hoteles. Vuelos y autos no la guardan, así que una liberación suya que se escaló sólo se cierra con el rechazo por API.

**Paridad de cancelación.** Cancelar libera el 100 % en todos los niveles, como hoy. No hay columnas de penalidad hasta que exista una cifra confirmada por el proveedor y una política del founder (§12.9).

### 12.5 Modos

El modo se fija por red en `wallet_hold_policy`:

| Modo      | Qué hace                                                                                                                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enforce` | La cascada completa. Es el modo cuando no hay fila, así que el riesgo queda cerrado desde el deploy.                                                                                                                |
| `observe` | Retiene sólo el nodo que vende y deja `portfolio.network_hold.would_block` en cada nivel de la red que habría rechazado, sin tocar su cartera. La cuenta de la orden igual tiene que resolverse.                    |
| `off`     | Retiene sólo el nodo que vende, como antes de 0060, y no exige que la cuenta se resuelva (si no se resolvía, el grupo queda con `credential_source = 'unresolved'`). En la raíz es el kill-switch de todo el árbol. |

**Qué fila manda.** Un `off` en cualquier ancestro-o-igual del nodo que vende gana siempre. Si no hay ninguno, manda la fila del ancestro-o-igual más cercano, y sin ninguna fila rige `enforce`. Una fila vale para toda la red del nodo, en todas las monedas y en todos sus niveles.

- La cambia el operador por `psql` (runbook, 13 §5 paso 14). La aplicación no la lee ni la escribe: `app_user` no tiene permisos sobre la tabla.
- Cada cambio deja `wallet_hold.policy_changed` como evento de plataforma (`tenant_id` NULL), así el nodo no lee la razón ni el autor que anotó el operador. Lo que sí ve es el modo con que se tomó cada retención suya: está en el payload de sus eventos `portfolio.hold.*` y en `wallet_hold_groups.mode`, que puede leer. Un `off` o un `observe` se notan en la red. Si hay que ocultarlo, se saca `mode` de esos eventos y de lo que lee `app_user`. El evento de plataforma lleva el actor que declaró ese cambio (`updated_by`, o `wallet_hold.actor` con `SET LOCAL`), el modo anterior, el nuevo y el efectivo. Se consulta directo en la base.
- Cambiar de modo no toca lo ya retenido: cada grupo guarda el modo con que se retuvo, y liberar recorre lo registrado.
- 0060 no pone `observe` por su cuenta. Deja un `WARNING` "REVISAR" por cada par (nodo intermedio, moneda) en que el nodo no tiene cartera activa con saldo o cupo y su red sí usa esa moneda. El operador decide qué hacer con cada uno.

### 12.6 Guardas

- **Asientos de retención.** `BOOKING_HOLD`, `BOOKING_RELEASED`, `BOOKING_CHARGE`, `NETWORK_HOLD` y `NETWORK_RELEASED` sólo los escriben las funciones de retención, o un rol que se salta la RLS (migraciones, seeds, la consola del operador). Si `app_user` lo intenta, aunque sea en su propia cartera, recibe 42501 `hold_entry_reserved`.
- **Saldo.** `balance_minor` sólo lo mueven esas funciones o quien financia al nodo (`can_finance_tenant`, que cubre depósitos, ajustes y aprobaciones de _Carteras_). Cualquier otro recibe 42501 `portfolio_balance_reserved`.
- **Tablas nuevas.** `wallet_hold_groups` y `wallet_hold_levels` son de sólo lectura para la aplicación, con RLS forzada. El grupo lo ve el nodo que vende, y cada nivel sólo el dueño de esa cartera: el que vende no ve los niveles de sus ancestros.
- **Funciones.** Las de entrada (`wallet_hold_retain`, `wallet_hold_settle`, `wallet_hold_preview`, `wallet_hold_report_block` y `wallet_hold_report_preview_block`) son `SECURITY DEFINER`, con `search_path = pg_catalog, public, pg_temp` y `EXECUTE` sólo para `app_user`. La única otra función de 0060 con `EXECUTE` para `app_user` es `raise_wallet_hold_violation`. Es `SECURITY INVOKER` y sólo lanza el error de una regla, sin leer ni escribir nada. La necesitan las guardas, que son INVOKER y corren con el rol de quien escribe. Por eso `app_user` puede lanzar a voluntad cualquiera de esos errores, incluidos los STW02 que la API devuelve como 409. Los helpers no tienen `GRANT`.
- **Endurecimiento.** Con una tabla temporal, `app_user` podía sombrear `pg_roles` y hacerle creer a la guarda de 0052 que se saltaba la RLS. Desde 0060:
  - `current_role_bypasses_rls` tiene `search_path` fijo y califica `pg_catalog.pg_roles`;
  - `app_user` ya no crea tablas temporales ni objetos en `public`;
  - toda función con `search_path = public`, o `SECURITY DEFINER` sin `search_path` propio, pasa a `pg_catalog, public, pg_temp`, y `migrations-search-path.test.ts` rechaza las dos cosas en cualquier migración posterior a 0053;
  - la migración falla si su rol no es superusuario ni `BYPASSRLS`.
- **Borrados.** Borrar una orden o una cartera con retenciones registradas falla (23503), en vez de dejar plata varada.
- **Mover un nodo.** `move_tenant_subtree` bloquea las carteras en el mismo orden. STH02 `tenant_move_open_wallet_bookings` cuenta los grupos abiertos del subárbol: `held` o `captured` con la orden activa, o `conflict` en cualquier estado. Una cascada liberada a medias ya no cuenta como liberada.

### 12.7 Qué ve cada uno

**El vendedor.** Los rechazos de la red son 409 y hablan sólo de "tu red" y de "quien te financia", sin montos, ids, nombres ni qué nivel falló.

| Motivo (`reason`)                        | Cuándo                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| `PORTFOLIO_NETWORK_CURRENCY_NOT_ENABLED` | Un nivel no tiene cartera en la moneda de la tarifa.                      |
| `PORTFOLIO_NETWORK_FUNDS_UNAVAILABLE`    | Un nivel tiene la cartera suspendida, está sobre el cupo o no le alcanza. |
| `PORTFOLIO_NETWORK_COST_UNAVAILABLE`     | No se puede calcular el costo para la red (§12.2).                        |
| `PORTFOLIO_HOLD_ACCOUNT_CHANGED`         | La cuenta con que se cotizó ya no está activa en la red del nodo.         |
| `PORTFOLIO_HOLD_BUSY`                    | La red siguió ocupada con otras reservas después de los reintentos.       |

Los motivos de la cartera propia no cambian (`PORTFOLIO_CURRENCY_NOT_ENABLED`, `PORTFOLIO_INACTIVE` y `PORTFOLIO_FUNDS_INSUFFICIENT`) y se evalúan primero. El aviso del PreBook (`funding`) y la verificación antes de C2 evalúan toda la red con la misma regla. En la web, un motivo de red no ofrece ir a _Cartera B2B_: pide hablar con quien te financia.

**Quien financia.**

- En _Cartera B2B_ aparecen los asientos "Retención de tu red" y "Retención de tu red liberada". Sus admins ven además de qué agencia y qué reserva vienen ("Agencia · Reserva #n").
- Los admins de un nodo con red debajo tienen la pestaña **Reservas de tu red**, con lo que su red retiene o cobró en sus carteras al costo de su nivel, los totales por moneda y el estado de cada reserva: Retenida, Cobrada, Liberada o En revisión. El total "Cobrado" es el acumulado histórico de lo cobrado, pagado o no, porque ningún asiento marca un cargo como pagado. No es la deuda viva: lo que el nivel tiene expuesto es el saldo de su cartera.
- Quien financia a un nodo ve lo mismo en _Carteras_ de ese nodo ("Reservas de su red").
- En _Cartera B2B_, en _Reservas de tu red_ y en _Carteras_ no aparecen quién vendió, los pasajeros, el precio de venta ni el id de la orden.
- **La actividad de la red es otra cosa** (_Mi Red_, `GET /tenants/network/audit`). Los admins de un ancestro leen ahí los eventos de todo su subárbol, con el payload y el correo del actor, como antes de 0060. Eso incluye la retención del nivel 0 en el tenant del que vende, con quién vendió, el precio de venta (`amountMinor` con `basis: 'sale'`) y el id de la orden. También incluye el `OrderCreateRequested` de cada hotel de la red, con la venta y el neto. Ocultarles a los ancestros el precio de venta y el vendedor queda pendiente, junto con G-01 y G-02 ([13 §4.1](./13-validacion-modelo-red.md#41-confidencialidad)).

**Rastro.** Por cada nivel, la base escribe un `domain_event` en el tenant dueño de la cartera, en la misma transacción: `portfolio.hold.retained`, `captured`, `uncaptured`, `released` y `conflict`. El actor va sólo en el nivel 0, así que los eventos de los niveles de la red no dicen quién vendió. Los avisos de la red son dos:

- `portfolio.network_hold.would_block`, en `observe`, va a cada nivel que habría rechazado.
- `portfolio.network_hold.blocked`, en `enforce`, va sólo al primer nivel que bloquea. En la reserva se escribe uno por orden. En el PreBook, que todavía no tiene orden, uno por nodo que vende, moneda y día.

**API.** `GET /portfolios/network-holds` es para los admins del nodo, y `GET /tenants/:tenantId/portfolios/network-holds` para quien financia al nodo o el superadmin. Las dos aceptan filtros de moneda y estado y devuelven hasta 200 reservas más los totales.

### 12.8 Límites

- **Vuelos y autos** retienen sólo por `POST /portfolios/hold-booking`, que ninguna pantalla llama. Ahora lo hacen en cascada, con O resuelto por la bóveda o la raíz.
- **Hoteles de Despegar:** siguen sin retención.
- **Lo retenido antes de 0060** queda como un grupo `legacy` de un solo nivel. No se debita a nadie hacia atrás.
- **Moneda:** la cascada no convierte. Un nodo intermedio necesita cartera, con saldo o cupo, en cada moneda en que su red vende con una credencial de más arriba.
- **Topes del PreBook y el Book de hoteles:** 60 y 30 pedidos por minuto por vendedor y nodo, además del tope global por IP. Acotan el abuso sobre la cartera caliente del consolidador. Se cuentan en memoria, en un solo contenedor de la API.
- **Saldo contra libro:** la base ya no deja que `app_user` mueva el saldo fuera de los asientos, pero todavía no impone que el saldo sea la suma del libro ([13 §4.4](./13-validacion-modelo-red.md#44-después-de-la-tanda-2)).
- **La venta y el neto son la frontera de confianza.** La base calcula cada nivel desde `orders.total_amount` y el neto de `selected_offer`, que escribe `app_user`, y nada en `orders` los protege.
  - Un camino con un bug, como un neto en otra unidad, o una API comprometida pueden retener de menos en cada nivel. Por ejemplo, 1 centavo con el neto en 1. Eso reabre el riesgo que cierra la opción 1.
  - La orden se puede volver a sus valores reales después de retener, y nada nota la diferencia con lo que quedó en `wallet_hold_levels`.
  - Seguimiento propuesto: un trigger en `orders` que no deje a `app_user` cambiar `total_amount` ni el precio de `selected_offer` (`pricing`, `total`) cuando la orden ya tiene retención; y que `wallet_hold_retain` exija que la venta cubra el precio de la cascada sobre ese neto (`compute_price_waterfall`).
  - El neto en sí seguirá viniendo de la API.
- **Liberaciones escaladas de vuelos y autos.** La conciliación R-W no las ve, porque la orden no guarda cuenta, y _Cartera B2B_ lista sólo las reservas `pending`. Se cierran llamando por API al rechazo (§12.4).
- **Cancelar un auto desde la pantalla de _Autos_** no pasa por la orden y no libera su retención (§12.4).

**Tests.** De la base, como `app_user`: `network-holds.integration`, `network-holds-rls.integration` y `wallet-hold-backfill.integration`. `network-holds.concurrency.integration` necesita sesiones reales, así que sólo corre con el Postgres del CI. De la API: `network-holds.api.integration`, `wallet-hold.store.test`, los de `portfolios`, hoteles, órdenes y conciliación, y `migrations-search-path.test.ts`.

### 12.9 Preguntas abiertas

1. **O = T.** Un consolidador que vende con su propia cuenta retiene sólo en su cartera, y Planetour no retiene nada por esa venta. ¿Debería retener también quien lo financia? Por ahora queda como hoy, cubierto por el caso O = T de `network-hold-cases.ts` y por `hotel-booking.service.test.ts`, hasta que el founder decida. Toca a D2 ([13 §4.3](./13-validacion-modelo-red.md#43-decisiones-que-faltan)).
2. **Penalidad de cancelación.** Cancelar devuelve el 100 % en todos los niveles. Cuando un proveedor cobre una penalidad confirmada, ¿quién la absorbe en cada nivel?
3. **Conflictos.** Un grupo en `conflict` congela la plata en todos sus niveles y no deja mover el nodo. Hoy se resuelve a mano, en la base. ¿Quién concilia, y con qué herramienta?
4. **Nodos intermedios sin cartera.** Si el `WARNING` de 0060 lista alguno, ¿se le abre cartera o se pone `observe` mientras tanto? Hay que tener en cuenta que `observe` apaga la cascada en toda la red del nodo y en todas las monedas.

### 12.10 Diferencias con la especificación del 2026-09-29

Las revisiones de cada tarea movieron lo implementado respecto de la especificación en estos puntos:

- **Vuelos sí tienen neto** (`selected_offer.total`). Por eso un vuelo de un vendedor de nivel 3 o más retiene en cascada, en vez de dar `PORTFOLIO_NETWORK_COST_UNAVAILABLE`.
- **Orden sin cuenta:** O es el dueño de la cuenta que la bóveda le resuelve al nodo, y la raíz sólo si no resuelve ninguna. Así una sub-agencia que vuela con su propia cuenta no le deja un cargo a toda su red.
- **`off`:** en cualquier ancestro gana sobre las filas más cercanas, y no exige resolver la cuenta.
- **Confirmación retractada:** devuelve la retención a `held`, para que la conciliación la libere si la reserva no existía. El trigger mira sólo el paso a `pending`, así que también descaptura mientras se cancela (§12.4).
- **`conflict`:** deja un evento por nivel y bloquea mover el nodo en cualquier estado de la orden.
- **Cambio de política:** es un evento de plataforma, no del nodo. El nodo no lee la razón ni el autor, pero sí el modo con que se tomó cada retención suya (§12.5).
- **Modo `observe`:** la migración no lo pone sola; sólo avisa.
- **Topes del PreBook y el Book:** son por vendedor y nodo, no por IP, porque web-b2b llama a la API desde un solo peer.
- **PreBook bloqueado:** también avisa al nivel que bloquea (`wallet_hold_report_preview_block`).
- **Liberación contenida:** responde `PORTFOLIO_RELEASE_BUSY` y no dice que no se retuvo.
- **Datos de la red:** `network-holds` y los datos de red de los movimientos son sólo para admins.
- **Cancelación:** libera también en autos, no sólo en vuelos, si se cancela desde _Mis Reservas_.
- **Numeración:** la especificación pedía §11 y el paso 10 del runbook, pero en `main` ya los ocupa el rediseño de hoteles (#11). Acá son §12 y el paso 14.
