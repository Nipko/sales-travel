# Sales-Travel

> Plataforma consolidadora de turismo B2B/B2C para LATAM (Colombia, Brasil, Perú).
> Multi-tenant white-label con IA omnicanal (WhatsApp, web, voz) y constructor visual de paquetes (drag-and-drop).

**Estado:** Sprint 0 cerrado. Ola 1 en progreso — búsqueda de vuelos LATAM NDC funcionando en producción.
**Repositorio:** privado.
**Stack confirmado:** ver `docs/platform/10-mapa-completo-plataforma.md`.

---

## 📚 Documentación

Toda la documentación de discovery, research y diseño de plataforma está en `/docs/`.

### Discovery (decisiones del founder y planificación)

| Documento                                                                 | Propósito                                                 |
| ------------------------------------------------------------------------- | --------------------------------------------------------- |
| [`01-preguntas.md`](./docs/discovery/01-preguntas.md)                     | 28 preguntas de discovery con respuestas del founder      |
| [`02-decisiones.md`](./docs/discovery/02-decisiones.md)                   | Decisiones cerradas en segunda ronda + defaults aceptados |
| [`06-documento-maestro.md`](./docs/discovery/06-documento-maestro.md)     | Visión, misión, módulos, modelo de datos macro, riesgos   |
| [`07-roadmap-olas.md`](./docs/discovery/07-roadmap-olas.md)               | Roadmap mes a mes en 3 olas (Mes 6 / 10 / 14) con DoD     |
| [`08-organizacion-equipo.md`](./docs/discovery/08-organizacion-equipo.md) | Perfiles, salarios LATAM, plan de contratación, cultura   |

### Research (investigaciones técnicas y de mercado)

| Documento                                                                          | Propósito                                                                       |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [`03-integraciones-ecosistema.md`](./docs/research/03-integraciones-ecosistema.md) | Mapa de proveedores: GDS, NDC, hoteles, actividades, asistencias, autos, pagos  |
| [`04-regulacion-fiscal-latam.md`](./docs/research/04-regulacion-fiscal-latam.md)   | Regulación, fiscal y protección de datos en CO/BR/PE                            |
| [`05-arquitectura-referencia.md`](./docs/research/05-arquitectura-referencia.md)   | Arquitectura de referencia (fase Hostinger → AWS), 15 abstracciones cloud-ready |
| [`06-competencia-latam.md`](./docs/research/06-competencia-latam.md)               | Análisis competitivo: Ideas Fractal, Wooba, Sakura + tier-1 internacionales     |
| [`07-skills-uiux-claude-code.md`](./docs/research/07-skills-uiux-claude-code.md)   | Stack frontend + skills Claude Code recomendados                                |

### Plataforma (mapa técnico exhaustivo)

| Documento                                                                          | Propósito                                                                                                                                  |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [`10-mapa-completo-plataforma.md`](./docs/platform/10-mapa-completo-plataforma.md) | **Fuente de verdad técnica.** 17 módulos, modelo de datos, sitemap UI, endpoints API, flujos críticos, design system, estructura del repo. |

---

## 🎯 Posicionamiento

**"El primer consolidador conversacional de LATAM."**

Tres ángulos diferenciadores:

- **Conversacional first**: WhatsApp Business como canal de venta de primera clase, no add-on.
- **Package Studio**: constructor visual drag-and-drop de paquetes dinámicos.
- **Multi-país andino-brasileño**: única plataforma diseñada para CO + PE + BR desde día 1.

Detalle en [`docs/research/06-competencia-latam.md`](./docs/research/06-competencia-latam.md).

---

## 🛠️ Stack técnico (resumen)

- **Backend:** NestJS + TypeScript (Modular Monolith hexagonal con Anti-Corruption Layer por proveedor)
- **IA sidecar:** FastAPI + LangGraph
- **Frontend web:** Next.js 15 (App Router) + Tailwind CSS v4 + shadcn/ui v4
- **Mobile:** React Native + Expo (vendedor + cliente final)
- **Datos:** PostgreSQL 16 + TimescaleDB + pgvector + Redis 7
- **Search:** Typesense → OpenSearch (fase 2)
- **Workflows:** Temporal.io self-hosted → Temporal Cloud
- **Object storage:** MinIO → S3 (mismo SDK)
- **Pagos:** Stripe + Mercado Pago (hosted checkout, SAQ-A)
- **IA:** multi-LLM router (Claude / GPT / Haiku) vía LiteLLM
- **Infra fase 1:** Hostinger VPS + Cloudflare. **Fase 2:** AWS multi-región (sa-east-1 + us-east-1).

Detalle completo en [`docs/research/05-arquitectura-referencia.md`](./docs/research/05-arquitectura-referencia.md) y [`docs/platform/10-mapa-completo-plataforma.md`](./docs/platform/10-mapa-completo-plataforma.md).

---

## 🗺️ Roadmap por olas (resumen)

| Ola       | Mes   | Foco                                                                                                                                                  |
| --------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ola 1** | 0–6   | B2B Colombia + Brasil. Aéreo (Travelport+Amadeus+LATAM NDC), hoteles (HotelDo+Hotelbeds), asistencia. WhatsApp cotización con IA. White-label básico. |
| **Ola 2** | 6–10  | Actividades, autos, Perú. App vendedor móvil. IA omnicanal (IG+TG+webchat+voz). Dry-run AWS.                                                          |
| **Ola 3** | 10–14 | B2C completo. App cliente final. IA con reserva+cobro autónomo. Migración productiva AWS. CNPJ propio BR.                                             |

Detalle en [`docs/discovery/07-roadmap-olas.md`](./docs/discovery/07-roadmap-olas.md).

---

## 👥 Equipo

Headcount objetivo:

- **Mes 0:** founder + CTO + PM + UX (4)
- **Mes 6:** 12 personas (cierre Ola 1)
- **Mes 10:** 20 personas (cierre Ola 2)
- **Mes 14:** 30 personas (cierre Ola 3)

Modalidad: 100% remoto LATAM (CO/AR/UY) + cumbre presencial trimestral.

Detalle en [`docs/discovery/08-organizacion-equipo.md`](./docs/discovery/08-organizacion-equipo.md).

---

## 🚀 Estado actual (mayo 2026)

### Completado

- **Sprint 0** — Monorepo, auth, DB multi-tenant, CI/CD, deploy a VPS con Docker
- **LATAM NDC** — Integración AirShopping v192 conectada y respondiendo con ofertas reales
- **Modelo canónico** — `packages/canonical` con schemas Offer, Itinerary, Segment, Money + campos fareFamily, baggage, policies
- **Búsqueda de vuelos** (`app.planetour.cloud/cotizaciones`) — UI premium con:
  - Formulario de búsqueda (ida/vuelta, pasajeros, cabina, moneda)
  - Airport autocomplete (8.803 aeropuertos, lazy-loaded)
  - Resultados agrupados por vuelo con fare families expandibles (BASIC/LIGHT/FULL/PREMIUM)
  - Comparación visual de equipaje, cambios y reembolso por tarifa
  - Soporte round-trip (ida + vuelta en la misma card)
  - Logos de aerolíneas (CDN con fallback)
  - Ordenamiento por precio/duración/salida/mejor
  - Skeleton loading animado
  - Responsive (mobile + desktop)

### En progreso

- Flujo "Cotizar" — guardar selección como cotización, generar PDF, compartir
- Más endpoints LATAM NDC — OfferPrice, SeatAvailability, ServiceList, OrderCreate
- Multi-proveedor — Amadeus, Travelport, Sabre

### Pendiente

- Tenant CRUD desde superadmin
- Package Studio (drag-and-drop)
- WhatsApp IA — cotización conversacional
- Manual operativo (legal, fiscal, comercial)

---

## 📁 Estructura del repo

```
sales-travel/
├── README.md
├── CLAUDE.md                  # instrucciones permanentes para Claude Code
├── docs/                      # documentación viva
├── .claude/                   # config Claude Code (skills/plugins)
├── packages/
│   ├── core/                  # ports + errores tipados (CJS)
│   ├── canonical/             # modelo canónico Zod (Offer, Itinerary, Segment, Money)
│   └── validation/            # schemas Zod compartidos
├── providers/
│   └── latam-ndc/             # ACL LATAM NDC v192 (AirShopping, auth OAuth2)
├── apps/
│   ├── api/                   # NestJS modular monolith (auth, search, tenants)
│   └── web-b2b/               # Next.js 15 panel agencia (cotizaciones, dashboard)
├── infrastructure/
│   └── hostinger/             # provision.sh, Caddyfile, docker-compose
└── tools/                     # seed-superadmin, migrations
```

Detalle en [`docs/platform/10-mapa-completo-plataforma.md`](./docs/platform/10-mapa-completo-plataforma.md) §10. Providers y apps adicionales se irán agregando conforme avance Ola 1.

---

## 🤝 Para equipo nuevo (onboarding rápido)

1. Lee este README.
2. Lee [`CLAUDE.md`](./CLAUDE.md) — los principios y convenciones que aplican a TODO.
3. Lee [`docs/discovery/06-documento-maestro.md`](./docs/discovery/06-documento-maestro.md) para visión y módulos.
4. Lee [`docs/platform/10-mapa-completo-plataforma.md`](./docs/platform/10-mapa-completo-plataforma.md) para el detalle técnico.
5. Lee la sección que toque tu rol en [`docs/discovery/08-organizacion-equipo.md`](./docs/discovery/08-organizacion-equipo.md).
