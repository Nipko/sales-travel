# 12 — Modelo Consolidador (B2B2B / BYOC), Diagnóstico de Gaps y Plan de Implementación

**Versión:** 1.0 (borrador de trabajo)
**Fecha:** 2026-06-03
**Propósito:** Tres cosas en un solo documento: (1) incorporar formalmente el **modelo consolidador con credenciales propias (BYOC)** al target de la plataforma; (2) un **diagnóstico honesto** de dónde estamos vs. la visión y vs. el mercado; (3) un **plan secuenciado** para construirlo y pulirlo con UX limpia y mejores prácticas.

> Este doc es la fuente de verdad para el modelo consolidador. El target ya quedó reflejado en `CLAUDE.md`, `docs/discovery/06-documento-maestro.md` §1.1 y `docs/platform/10-mapa-completo-plataforma.md` (entidad TENANT + jerarquía M8.1).

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
| Carteras / crédito B2B                       | ✅ Funcional  | `agency_portfolios` + `portfolio_transactions`, límites de crédito, hold→aprobación.                                         |
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

- `path` se mantiene con trigger en insert/move (re-parent es raro y se hace en transacción).
- **Niveles:** `platform` (nosotros) → `consolidator` → `agency` → `subagency`. Un vendedor es un **usuario** con membership en un nodo, no un tenant.
- Profundidad: soportar N niveles técnicamente, limitar a 4 por política de negocio (evita árboles patológicos).

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

| Gap                                                                    | Prioridad | Por qué                                                                         |
| ---------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------- |
| **Gateway real** (Stripe + MP) hosted checkout (SAQ-A)                 | **P0**    | Hoy no se cobra. Bloquea operación.                                             |
| **Wallet / depósitos de agencia** con extracto y conciliación de saldo | **P0**    | Carteras existen pero faltan recarga real, estados de cuenta, y reconciliación. |
| Split payments / payout por nodo (consolidador↔agencia)               | P1        | Reparto de márgenes en la red.                                                  |
| Métodos locales (PIX, PSE, Yape/Plin, Boleto)                          | P1        | Conversión en LATAM.                                                            |
| Antifraude / 3DS                                                       | P2        | Riesgo a escala.                                                                |

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

| #   | Riesgo / decisión                                                     | Nota                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **Migración de tenancy plana → jerárquica** sobre datos existentes    | Hacer con `path` calculado y `tenant_type='agency'` por defecto; los tenants actuales pasan a ser agencias raíz hasta asignar consolidador.                                           |
| R2  | BYOC: responsabilidad legal de **quién emite** (BSP/IATA)             | La cuenta de credenciales usada define el emisor; registrar en `domain_events`. Validar con el founder el modelo contractual.                                                         |
| R3  | Pricing waterfall mal configurado → márgenes negativos o fuga de neto | Simulador what-if + validaciones + visibilidad por rol.                                                                                                                               |
| R4  | Complejidad de RLS jerárquica → fugas                                 | Tests exhaustivos en CI + fuzz con rotación de nodos.                                                                                                                                 |
| D1  | ¿Profundidad máxima de jerarquía?                                     | ✅ **Decidido: 4 niveles** (platform/consolidador/agencia/sub-agencia). Implementado en el trigger `tenants_maintain_path` (migración 0011).                                          |
| D2  | ¿El consolidador puede ver el neto del proveedor de sus agencias?     | ✅ **Decidido: sólo agregados**, no el neto de cada sub que trae credenciales propias. A reflejar en la proyección de pricing por rol (Fase 0 paso 7).                                |
| D3  | ¿Pagos se liquidan por agencia o centralizado en el consolidador?     | ✅ **Decidido: híbrido** — liquidación **por agencia** cuando trae credenciales de pago propias; **centralizada en el consolidador** para las sub-agencias que heredan. Configurable. |
| D4  | Orden vs. roadmap de olas existente                                   | ✅ **Decidido: fundación consolidador va ANTES** de los verticales de la Ola 2.                                                                                                       |
| D5  | ¿Amplitud multi-contenido vs. profundidad NDC primero?                | ✅ **Decidido: amplitud multi-contenido primero** (alineado con la evidencia §4.0: >80% quiere contenido unificado).                                                                  |

---

## 8. Próximos pasos inmediatos

1. **Validar** §3 (arquitectura), §6 (orden de fases). Decisiones D1–D5 ✅ cerradas (§7).
2. ✅ **Fase 0, paso 1-2 implementado** en la rama `feat/consolidator-foundation` (ver §9).
3. ✅ Investigación de mercado incorporada (§4.0 con citas). Pendiente local: profundizar conciliación BSP/ARC y requisitos fiscales LATAM con fuentes locales cuando lleguemos a Fase 1/4.

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
- Verificación de email + (opcional) refresh tokens / revocación de sesión y MFA para roles admin+.
