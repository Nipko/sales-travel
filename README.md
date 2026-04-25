# Sales-Travel

> Plataforma consolidadora de turismo B2B/B2C para LATAM (Colombia, Brasil, Perú).
> Multi-tenant white-label con IA omnicanal (WhatsApp, web, voz) y constructor visual de paquetes (drag-and-drop).

**Estado:** Discovery + planificación completados. Sprint 0 técnico pendiente.
**Repositorio:** privado.
**Stack confirmado:** ver `docs/platform/10-mapa-completo-plataforma.md`.

---

## 📚 Documentación

Toda la documentación de discovery, research y diseño de plataforma está en `/docs/`.

### Discovery (decisiones del founder y planificación)

| Documento | Propósito |
|---|---|
| [`01-preguntas.md`](./docs/discovery/01-preguntas.md) | 28 preguntas de discovery con respuestas del founder |
| [`02-decisiones.md`](./docs/discovery/02-decisiones.md) | Decisiones cerradas en segunda ronda + defaults aceptados |
| [`06-documento-maestro.md`](./docs/discovery/06-documento-maestro.md) | Visión, misión, módulos, modelo de datos macro, riesgos |
| [`07-roadmap-olas.md`](./docs/discovery/07-roadmap-olas.md) | Roadmap mes a mes en 3 olas (Mes 6 / 10 / 14) con DoD |
| [`08-organizacion-equipo.md`](./docs/discovery/08-organizacion-equipo.md) | Perfiles, salarios LATAM, plan de contratación, cultura |

### Research (investigaciones técnicas y de mercado)

| Documento | Propósito |
|---|---|
| [`03-integraciones-ecosistema.md`](./docs/research/03-integraciones-ecosistema.md) | Mapa de proveedores: GDS, NDC, hoteles, actividades, asistencias, autos, pagos |
| [`04-regulacion-fiscal-latam.md`](./docs/research/04-regulacion-fiscal-latam.md) | Regulación, fiscal y protección de datos en CO/BR/PE |
| [`05-arquitectura-referencia.md`](./docs/research/05-arquitectura-referencia.md) | Arquitectura de referencia (fase Hostinger → AWS), 15 abstracciones cloud-ready |
| [`06-competencia-latam.md`](./docs/research/06-competencia-latam.md) | Análisis competitivo: Ideas Fractal, Wooba, Sakura + tier-1 internacionales |
| [`07-skills-uiux-claude-code.md`](./docs/research/07-skills-uiux-claude-code.md) | Stack frontend + skills Claude Code recomendados |

### Plataforma (mapa técnico exhaustivo)

| Documento | Propósito |
|---|---|
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

| Ola | Mes | Foco |
|---|---|---|
| **Ola 1** | 0–6 | B2B Colombia + Brasil. Aéreo (Travelport+Amadeus+LATAM NDC), hoteles (HotelDo+Hotelbeds), asistencia. WhatsApp cotización con IA. White-label básico. |
| **Ola 2** | 6–10 | Actividades, autos, Perú. App vendedor móvil. IA omnicanal (IG+TG+webchat+voz). Dry-run AWS. |
| **Ola 3** | 10–14 | B2C completo. App cliente final. IA con reserva+cobro autónomo. Migración productiva AWS. CNPJ propio BR. |

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

## 🔧 Próximos pasos

1. **Sprint 0 técnico (pendiente):** scaffolding del repo Turborepo, packages base, los 15 ports cloud-ready, primer adapter Amadeus end-to-end, Docker Compose local, CI/CD.
2. **Manual operativo (pendiente):** consolidación de lo no-técnico (legal, fiscal, comercial, soporte) en un documento separado para no contaminar el foco constructivo.

---

## 📁 Estructura del repo (esperada al cierre de Sprint 0)

```
sales-travel/
├── README.md
├── CLAUDE.md                  # instrucciones permanentes para Claude Code
├── docs/                      # documentación viva (este directorio)
├── .claude/                   # config Claude Code (skills/plugins)
├── packages/                  # código compartido
│   ├── core/ports/            # 15 abstracciones de infra
│   ├── domain/                # entidades + lógica de negocio
│   ├── canonical/             # modelo canónico (Offer, Itinerary, …)
│   ├── ui/                    # design system shadcn-based
│   ├── validation/            # schemas Zod
│   ├── i18n/                  # ES/PT/EN
│   └── sdk/                   # SDK cliente
├── providers/                 # ACL por proveedor (amadeus, hoteldo, stripe, …)
├── apps/
│   ├── api/                   # NestJS modular monolith
│   ├── ai-sidecar/            # FastAPI + LangGraph
│   ├── temporal-worker/       # workers de sagas
│   ├── web-b2b/               # Next.js panel agencia
│   ├── web-b2c/               # Next.js sitio público
│   ├── web-admin/             # Next.js superadmin
│   └── mobile/                # React Native + Expo
└── infrastructure/            # Terraform (Hostinger DNS + Cloudflare → AWS Ola 3)
```

Estructura completa en [`docs/platform/10-mapa-completo-plataforma.md`](./docs/platform/10-mapa-completo-plataforma.md) §10.

---

## 🤝 Para equipo nuevo (onboarding rápido)

1. Lee este README.
2. Lee [`CLAUDE.md`](./CLAUDE.md) — los principios y convenciones que aplican a TODO.
3. Lee [`docs/discovery/06-documento-maestro.md`](./docs/discovery/06-documento-maestro.md) para visión y módulos.
4. Lee [`docs/platform/10-mapa-completo-plataforma.md`](./docs/platform/10-mapa-completo-plataforma.md) para el detalle técnico.
5. Lee la sección que toque tu rol en [`docs/discovery/08-organizacion-equipo.md`](./docs/discovery/08-organizacion-equipo.md).
