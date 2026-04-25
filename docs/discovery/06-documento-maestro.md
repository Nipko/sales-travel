# Documento Maestro del Proyecto — Sales-Travel

**Versión:** 1.0 (Discovery consolidado)
**Fecha:** 2026-04-24
**Estado:** Borrador para validación del founder antes de pasar a roadmap detallado

---

## 1. Visión y Posicionamiento

### 1.1 Visión
Ser el **consolidador único de turismo de referencia en América**, que permita a agencias de viajes B2B y a consumidores finales B2C **buscar, cotizar, armar y comprar paquetes turísticos completos** (vuelos NDC/GDS, hoteles, actividades, asistencias, autos) desde una sola interfaz **drag-and-drop, intuitiva y conversacional con IA**, con presencia inicial fuerte en Colombia y Brasil y expansión a toda Latinoamérica y luego al resto del mundo.

### 1.2 Misión
Eliminar la fricción operativa que hoy obliga a las agencias a saltar entre múltiples sistemas (un GDS para vuelos, otro portal para hoteles, otro para asistencias, etc.) y devolverles tiempo para vender, mientras se entrega al consumidor final una experiencia tipo "marketplace de viajes inteligente".

### 1.3 Propuesta de valor diferenciada

| Para B2B (agencias) | Para B2C (cliente final) |
|---|---|
| Una sola pantalla para armar paquetes con inventario de N proveedores | Búsqueda conversacional por WhatsApp / web / voz |
| Markup parametrizable por agencia, destino, temporada | Cotización en segundos, paquete listo |
| White-label propio (dominio, branding, app PWA) | Pago local (PIX, PSE, Yape, MP) |
| Comisiones, vendedores, contabilidad y reporting integrados | Asistencia y autos como cross-sell sugerido por IA |
| App móvil para vendedores en ruta + cierre con link de pago | Soporte 24/7 en español/portugués/inglés |

### 1.4 Posicionamiento de marca
**"El consolidador con la experiencia de un marketplace moderno y la profundidad de un GDS."** Tono profesional pero accesible. Mensaje principal: **"Arma cualquier viaje en una sola pantalla."**

### 1.5 Métricas de éxito (North Star)
- **B2B:** Tiempo medio de cotización de paquete completo < 2 minutos.
- **B2C:** Tasa de conversión search → booking ≥ 1,8% (benchmark OTA LATAM 1,2-2%).
- **Operación:** Uptime ≥ 99,5% (Ola 1) → 99,9% (Ola 2 post-AWS).
- **Crecimiento:** GMV mensual y reservas/día por país y segmento.

---

## 2. Alcance Funcional por Módulos

### 2.1 Mapa de módulos (capas)

```
┌──────────────────────────────────────────────────────────────────┐
│  Canales: Web B2B · Web B2C · App Móvil · WhatsApp · IG · TG · Voz │
├──────────────────────────────────────────────────────────────────┤
│  Experiencia: Búsqueda unificada · Constructor drag-and-drop ·    │
│               Cotizador IA · Checkout · Mi cuenta · Soporte       │
├──────────────────────────────────────────────────────────────────┤
│  Negocio:    Pricing/Markup · Reservas · Post-venta · Pagos ·     │
│              Contabilidad · Facturación electrónica · Reporting   │
├──────────────────────────────────────────────────────────────────┤
│  Plataforma: Multi-tenant · White-label · Roles & Permisos ·      │
│              Auditoría · Notificaciones · Feature flags · IA      │
├──────────────────────────────────────────────────────────────────┤
│  Integración: GDS · NDC · Hoteles · Actividades · Asistencias ·   │
│               Autos · PSP · Mensajería · LLM · Fiscalizadores     │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 Detalle por módulo

#### M1 — Búsqueda y Catálogo
- Buscador unificado (origen/destino/fechas/pax) que dispara *scatter-gather* a todos los proveedores activos por categoría.
- Filtros (precio, escalas, aerolíneas, estrellas, régimen, valoraciones, políticas de cancelación).
- Mapping Giata para deduplicar hoteles cuando hay múltiples bedbanks.
- Cache distribuido con TTL granular (ver `research/05-arquitectura-referencia.md` §1.3).
- Catálogo de destinos con contenido enriquecido (descripciones, fotos, geolocalización).

#### M2 — Constructor de Paquetes (drag-and-drop)
- Lienzo visual: el usuario arrastra "tarjetas" (vuelo, hotel, actividad, asistencia, auto) a un itinerario.
- Cálculo en tiempo real del precio total con markup, impuestos y FX por moneda.
- Validación de coherencia (fechas, ciudad, pax) y sugerencias IA ("agregar asistencia: 87% de las agencias en este destino la incluyen").
- Guardar como cotización, compartir por link/WhatsApp, convertir en reserva.

#### M3 — Cotizador con IA
- Plantillas profesionales de cotización (PDF y enlace web).
- Generación asistida por IA: el agente describe en lenguaje natural lo que quiere ("paquete 7 noches Cancún todo incluido, salida desde Medellín en julio") y el sistema arma 3 opciones con márgenes configurables.
- Seguimiento del estado de la cotización (enviada, vista, aceptada, expirada).
- Conversión a reserva con un click.

#### M4 — Reservas y Emisión
- Saga de reserva multi-proveedor con compensación (Temporal): si el pago falla tras hold, se revierten holds en proveedores.
- Confirmación de PNR (vuelos), voucher (hoteles, actividades), póliza (asistencia).
- Cola de tickets pendientes de emisión y reintentos.
- Modificaciones (cambio de pax, fecha, ruta) y cancelaciones con recálculo de penalidades por proveedor.

#### M5 — Pagos y Cobranza
- Stripe + Mercado Pago, hosted checkout (PCI SAQ-A) — ver `research/05` §6.
- Métodos locales por país (PIX, PSE, Boleto, Yape, tarjetas en cuotas).
- Split payments: comisión a la agencia + fee de plataforma.
- Pagos por **créditos prepagos** o **cash en plataforma** para agencias B2B (saldo recargable).
- Conciliación nocturna automática y reportes de excepciones.

#### M6 — Pricing y Comisiones (motor parametrizable)
- Reglas por tenant: markup % o monto fijo, por categoría / destino / temporada / proveedor / tipo de cliente final.
- Override manual por reserva con permiso.
- Comisiones internas: vendedor → agencia → plataforma, configurables.
- Versionado de reglas y simulación ("¿qué pasa si cambio el markup de hoteles a 8%?").

#### M7 — Multi-tenant y White-label
- Cada agencia es un tenant aislado (RLS + namespaces).
- Dominio propio (CNAME) con SSL automático on-demand.
- Branding (logo, colores, tipografía, favicon, footer) editable desde panel.
- Emails transaccionales con remitente del tenant (DKIM por dominio).
- PWA instalable con identidad del tenant para clientes finales.

#### M8 — Roles y Permisos
- Jerarquía: **superadmin → admin (de plataforma) → admin (de agencia/tenant) → vendedor → cliente final**.
- Permisos granulares (RBAC + ABAC para reglas como "vendedor solo ve sus clientes").
- Auditoría de toda acción sensible (event sourcing parcial).

#### M9 — IA Omnicanal
- WhatsApp Business API (ya disponible en cliente) como canal principal.
- Webchat embebido, IG/Telegram/Twilio Voice fase 2.
- Multi-LLM (Claude / GPT-4o-mini / Haiku) con router por costo y latencia.
- Tool-calling para buscar, cotizar, agendar, enviar links de pago, escalar a humano.
- Ola 1: búsqueda + cotización. Ola 2-3: reserva + cobro completos.

#### M10 — Contabilidad propia
- Plan de cuentas configurable.
- Asientos automáticos por evento (reserva, pago, comisión, reembolso, contracargo).
- Cuentas por cobrar / pagar por proveedor y por agencia.
- Cierre mensual y reportes (estado de resultados, flujo de caja, balance).
- Multi-moneda con FX por fecha de transacción.

#### M11 — Facturación electrónica
- Adapter por país: DIAN (Colombia), NFS-e (Brasil), SUNAT (Perú).
- Proveedores recomendados Ola 1: Alegra (CO), dLocal/Ebanx como MoR (BR), Nubefact (PE) — ver `research/04`.
- Notas crédito/débito y documentos soporte.
- Cumplimiento Reforma Tributária BR (IBS/CBS) en hoja de ruta 2027-2033.

#### M12 — Reporting y BI propio
- Dashboards por rol: founder, admin agencia, vendedor.
- KPIs: GMV, número de reservas, ticket promedio, conversión, tasa de cancelación, LTV, márgenes por proveedor.
- Filtros por país, tenant, vendedor, producto, periodo.
- Export CSV/Excel y suscripción a reportes por email.
- Embebido en plataforma (no SaaS externo).

#### M13 — App Móvil
- **App vendedor (iOS+Android, React Native + Expo):** cotizar, compartir por WhatsApp, cerrar venta con link de pago, ver comisiones y metas, modo offline para zonas con baja conectividad.
- **App cliente final (marca única + PWA white-label por agencia):** ver itinerario, check-in, reembolsos, asistencia y soporte.

#### M14 — Soporte 24/7
- Sistema de tickets integrado.
- Niveles: BPO LATAM nivel 1 (24/7) → equipo interno nivel 2 (8x5 con on-call) → ingeniería nivel 3 (on-call).
- PagerDuty/Opsgenie con runbooks por tipo de incidente.
- SLA contractual ofrecido a tenants enterprise.

---

## 3. Modelo de Datos Macro

> Vista de alto nivel. El modelo lógico detallado se diseña en Ola 1 fase 0.

```
TENANT
  ├── 1:N USER (superadmin, admin, vendedor, cliente)
  ├── 1:1 BRANDING_CONFIG (white-label)
  ├── 1:N PRICING_RULE (markup, fees, commissions)
  ├── 1:N PAYMENT_ACCOUNT (Stripe Connect, MP collector)
  └── 1:N FISCAL_CONFIG (país, RUC/NIT/CNPJ, fiscalizador)

CUSTOMER (cliente final, persona o empresa)
  ├── 1:N CONTACT, DOCUMENT, PREFERENCES
  └── 1:N CONVERSATION (canal, historial)

QUOTE (cotización)
  ├── 1:N QUOTE_ITEM (vuelo/hotel/actividad/asistencia/auto)
  ├── 0:1 BOOKING (cuando se confirma)
  └── pricing_breakdown (neto, markup, impuestos, FX)

BOOKING (reserva confirmada)
  ├── 1:N BOOKING_ITEM (con provider_ref, estado, voucher_url)
  ├── 1:N PAYMENT_INTENT (Stripe/MP)
  ├── 1:N INVOICE (factura electrónica país-dependiente)
  ├── 1:N COMMISSION (vendedor, agencia, plataforma)
  └── 1:N AUDIT_EVENT (event sourcing)

PROVIDER (Amadeus, HotelDo, Assist Card, …)
  ├── credentials (cifradas)
  ├── 1:N PROVIDER_RATE_PLAN
  └── 1:N PROVIDER_BOOKING (relación con BOOKING_ITEM)

ACCOUNTING
  ├── CHART_OF_ACCOUNTS (por tenant)
  ├── JOURNAL_ENTRY (asientos automáticos y manuales)
  └── RECONCILIATION (PSP payouts vs reservas)

DOMAIN_EVENT (TimescaleDB hypertable, append-only)
  └── todos los eventos del sistema para auditoría y proyecciones
```

---

## 4. Arquitectura (resumen)

Ver detalle completo en `research/05-arquitectura-referencia.md`. Resumen:

- **Stack:** NestJS + FastAPI sidecar IA · Next.js 15 web · React Native + Expo móvil · PostgreSQL 16 + TimescaleDB + pgvector · Redis 7 · Typesense · Temporal · Caddy · MinIO.
- **Patrón:** Modular Monolith hexagonal con Anti-Corruption Layer por proveedor.
- **Multi-tenant:** shared DB + RLS forzada + dominio custom con SSL on-demand.
- **Cloud-ready día 1:** 15 abstracciones (`IObjectStorage`, `IQueue`, `ICache`, `IAuth`, `IPaymentProcessor`, `IMessagingChannel`, `ILLMProvider`, etc.).
- **Fase 1:** Hostinger VPS (3 nodos KVM) + Cloudflare. ~USD 260/mes infra.
- **Fase 2:** AWS multi-región (`sa-east-1` + `us-east-1`). ~USD 1.880-12.650/mes según escala.
- **CI/CD:** GitHub Actions, dev/staging/prod, blue-green Caddy → canary ECS, feature flags Unleash.

---

## 5. Roadmap por Olas (alto nivel)

> Detalle granular en próximo documento `07-roadmap-olas.md` (entregable C).

### 🌊 Ola 1 — Mes 0 a 6 — "B2B CO+BR vendiendo aéreo + hotel + asistencia"
- **Mes 0-1:** Setup legal CO, contratos GDS/HotelDo/Assist Card/Stripe/MP, repo, CTO en sitio.
- **Mes 1-3:** Núcleo plataforma (Modular Monolith con ports), primer adapter Amadeus end-to-end, motor pricing parametrizable, multi-tenant + white-label básico.
- **Mes 3-5:** Hoteles HotelDo + Hotelbeds, asistencia Assist Card, checkout Stripe+MP, contabilidad básica + facturación CO (Alegra) y BR (vía MoR).
- **Mes 5-6:** WhatsApp cotización con IA, reporting v1, hardening seguridad, soft launch B2B con 5-10 agencias piloto.

### 🌊 Ola 2 — Mes 6 a 10 — "Expansión vertical + Perú + móvil vendedor + IA omnicanal"
- Actividades (Civitatis + GetYourGuide), autos (CarTrawler), Perú (entidad SAC + SUNAT/Nubefact + DIRCETUR).
- App móvil vendedor (iOS+Android) con offline.
- IA expandida a IG, Telegram, webchat, voz (Twilio + Deepgram + ElevenLabs).
- Reporting v2 (BI embebido).
- Inicio dry-run AWS (Aurora + ECS), preparación migración.

### 🌊 Ola 3 — Mes 10 a 14 — "B2C completo + IA con reservas/cobro + AWS"
- Web y app B2C (marca única + PWA white-label por tenant).
- IA con capacidad de reservar y cobrar autónomamente (con guardrails y human-in-the-loop opcional).
- Migración a AWS (re-platform incremental, 6-8 semanas).
- Módulo contable completo (cierre mensual, conciliación avanzada).
- CNPJ propio en BR + Pix directo + Focus NFe (transición desde MoR).
- Compliance ISO 27001 ligera o equivalente para clientes enterprise.

### Olas posteriores (referencia)
- **Ola 4 — Año 2:** México, Argentina, Chile. NDC directo con LATAM/Avianca/Aeroméxico. Marketplace de actividades con operadores locales. Programa de afiliados.
- **Ola 5 — Año 2-3:** Estados Unidos (turistas hispanos), Europa (turistas a LATAM). Marca consolidada global.

---

## 6. Estructura Organizacional Inicial

> Detalle de perfiles, salarios y proceso de contratación en próximo documento `08-organizacion-equipo.md` (entregable D).

### 6.1 Headcount Ola 1 (12 personas)

| Rol | # | Cuándo |
|---|---|---|
| CTO / VP Engineering | 1 | Mes 0 (primera contratación) |
| Backend senior (Node/NestJS) | 2 | Mes 1 |
| Frontend senior (Next.js + RN) | 2 | Mes 1 |
| DevOps / SRE | 1 | Mes 1 |
| QA / Test engineer | 1 | Mes 2 |
| Product Manager | 1 | Mes 0-1 |
| UX / UI Designer | 1 | Mes 0-1 |
| Integraciones (GDS/NDC) | 1 | Mes 1 |
| Data engineer | 1 | Mes 3 |
| IA engineer (LLM ops) | 1 | Mes 2-3 |

### 6.2 Headcount adicional Ola 2 (+8 personas, total 20)
+1 backend, +1 frontend, +1 mobile dev, +1 IA, +1 PM B2C, +1 designer, +1 DevOps, +1 customer success.

### 6.3 Headcount adicional Ola 3 (+5-10 personas, total 25-30)
Equipo de soporte 24/7 (con BPO partner para nivel 1), finanzas/contabilidad, legal/compliance, marketing/growth.

### 6.4 Geografía y modelo
- **Núcleo en LATAM:** Colombia, Argentina, Uruguay (zona horaria, costo, talento).
- **Nearshore puntual:** PCI consultoría, IA específica.
- **Modalidad:** 100% remoto con cumbre presencial trimestral.

---

## 7. Presupuesto Anual Estimado

> Estimaciones orden de magnitud para validación del founder. Detalle por mes en roadmap.

| Categoría | Año 1 (USD) |
|---|---|
| Nómina (12-20 personas, mix sr/mid LATAM) | 480.000 – 720.000 |
| Infraestructura + SaaS (Hostinger fase 1, migración AWS H2) | 25.000 – 60.000 |
| Integraciones (setup GDS, mapping Giata, agregadores, contratos) | 80.000 – 200.000 |
| Legal, fiscal, compliance, auditorías | 60.000 – 100.000 |
| Marketing, ventas, branding | 50.000 – 150.000 |
| Imprevistos (15%) | 100.000 – 180.000 |
| **Total Año 1 estimado** | **~795.000 – 1.410.000 USD** |

Año 2 (post-AWS, B2C, expansión PE/MX/AR): **1.500.000 – 2.500.000 USD** acumulado adicional.

---

## 8. Riesgos del Proyecto

| # | Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|---|
| R1 | Hostinger no soporta volumen/PCI antes de AWS | Alta | Alto | Triggers de migración objetivos + diseño cloud-ready día 1 (`02-decisiones-segunda-ronda.md`) |
| R2 | Timeline de 6 meses optimista para Ola 1 | Alta | Alto | Esquema por olas + alcance Ola 1 acotado a B2B CO/BR |
| R3 | Homologación GDS/NDC más lenta que estimado | Alta | Alto | Empezar con consolidador existente + Duffel como acelerador NDC |
| R4 | Compliance fiscal BR sin CNPJ → fricción B2C | Alta | Alto | dLocal/Ebanx como MoR fase inicial; CNPJ en Ola 3 |
| R5 | Equipo no se contrata a tiempo | Alta | Crítico | CTO mes 0, headhunter con red LATAM, salarios competitivos LATAM |
| R6 | Competencia reacciona agresivamente (Wooba, Sakura, Ideas Fractal) | Media | Medio | Diferenciación clara: drag-and-drop + IA omnicanal nativa |
| R7 | LLM cost runaway con omnicanal | Media | Medio | Hard limits, budget por tenant, cache de respuestas, modelo router por costo |
| R8 | Filtración cross-tenant | Baja | Crítico | RLS forzada, tests de aislamiento en CI, fuzz testing |
| R9 | Vendor lock o cambio de términos GDS/PSP | Media | Alto | Anti-Corruption Layer, multi-provider con failover |
| R10 | Founder/equipo abrumado por alcance | Media | Alto | Disciplina de olas, cero scope creep, retros mensuales |

---

## 9. Decisiones cerradas (snapshot)

- **Infra fase 1:** Hostinger + Cloudflare. Triggers de migración a AWS definidos.
- **Pagos fase 1:** Stripe + Mercado Pago, hosted checkout (SAQ-A).
- **Monetización:** motor parametrizable por tenant (markup/fee/comisión por categoría).
- **Esquema:** 3 olas (mes 6 / 10 / 14), todas en producción.
- **Merchant model:** híbrido (B2C MoR default, B2B facilitador default).
- **Equipo:** núcleo LATAM remoto, CTO primero, 12 → 20 → 25-30 personas.
- **Vendedor en ruta:** empleado de agencia (no freelance inicialmente).
- **App cliente final:** marca única + PWA white-label por tenant (no apps separadas).
- **Stack:** NestJS + Next.js + React Native + PostgreSQL + Redis + Temporal + Cloud-ready ports.

---

## 10. Pendientes de decisión

| # | Pendiente | Quién decide | Cuándo |
|---|---|---|---|
| P1 | Holding (Uruguay vs Delaware C-Corp vs único en CO) | Founder + asesor legal | Mes 1-2 |
| P2 | Marca comercial (¿"Sales-Travel" o nombre nuevo?) | Founder + branding | Mes 1 |
| P3 | Headhunter para CTO (in-house o agencia) | Founder | Mes 0 |
| P4 | Investigación competencia LATAM detallada (research #06) | Pendiente WebSearch | A criterio del founder |
| P5 | Programa de pilotaje con primeras 5-10 agencias | Founder + Sales | Mes 4-5 |
| P6 | Política de soporte 24/7 (BPO partner) | Founder + COO futuro | Mes 4-5 |
| P7 | Levantamiento de capital (bootstrap vs seed VC) | Founder | Mes 1-3 |

---

## 11. Próximos entregables

1. **`07-roadmap-olas.md`** — roadmap detallado por sprint dentro de cada ola, con dependencias, criterios de aceptación y entregables verificables.
2. **`08-organizacion-equipo.md`** — perfiles detallados, rangos salariales LATAM, descripción de cargos, plan de contratación mes a mes.
3. **(Pendiente)** Investigación competencia LATAM (#06) cuando se desbloquee WebSearch o se reciba material crudo.
