# CLAUDE.md — Instrucciones permanentes para Claude Code

> Este archivo se carga automáticamente al inicio de cada sesión de Claude Code en este repo. Define **principios, stack, convenciones y referencias** que aplican siempre. Mantenerlo conciso (< 200 líneas).

---

## 🎯 Qué es este proyecto

**Sales-Travel** — plataforma consolidadora de turismo B2B/B2C para LATAM. Multi-tenant white-label con IA omnicanal (WhatsApp/web/voz) y constructor visual drag-and-drop de paquetes turísticos. Mercado inicial: Colombia, Brasil, Perú.

Posicionamiento: **"El primer consolidador conversacional de LATAM."** Diferenciadores: WhatsApp como canal de venta de primera clase, Package Studio visual, cobertura simultánea CO+PE+BR.

---

## 📚 Antes de cualquier cambio: leer la fuente de verdad

| Pregunta | Documento |
|---|---|
| ¿Qué módulos existen? ¿Qué endpoints? ¿Modelo de datos? | `docs/platform/10-mapa-completo-plataforma.md` |
| ¿Por qué decidimos X arquitectura/proveedor? | `docs/research/05-arquitectura-referencia.md` |
| ¿Qué proveedor de hoteles/GDS/pagos usamos? | `docs/research/03-integraciones-ecosistema.md` |
| ¿Qué exige DIAN/SUNAT/NF-e? | `docs/research/04-regulacion-fiscal-latam.md` |
| ¿Quién es la competencia? ¿Cuáles son los gaps? | `docs/research/06-competencia-latam.md` |
| ¿Cuándo se construye qué? | `docs/discovery/07-roadmap-olas.md` |

**Regla:** si vas a tomar una decisión técnica significativa, primero verifica que no esté ya decidida en estos docs.

---

## 🛠️ Stack técnico (no negociar sin razón)

- **Backend:** NestJS + TypeScript 5 (Node 20 LTS). Modular Monolith hexagonal con Anti-Corruption Layer por proveedor.
- **IA sidecar:** FastAPI + Pydantic v2 + LangGraph.
- **Web:** Next.js 15 (App Router, RSC) + Tailwind CSS v4 + shadcn/ui v4.
- **Mobile:** React Native + Expo SDK 52.
- **DB:** PostgreSQL 16 + TimescaleDB + pgvector. Multi-tenant con RLS forzada.
- **Cache/Queue:** Redis 7 (cache + streams + BullMQ).
- **Search:** Typesense (fase 1) → OpenSearch (fase 2 AWS).
- **Workflows:** Temporal.io self-hosted (sagas largas, p.ej. reservas multi-proveedor con compensación).
- **Object storage:** MinIO (fase 1) → S3 (fase 2). Mismo SDK.
- **Auth:** BetterAuth/Lucia (PG-backed, code-owned).
- **ORM:** Prisma (CRUD) + Kysely (queries complejas).
- **Validación:** Zod en cada endpoint y border. Schemas compartidos entre web/mobile/back en `packages/validation`.
- **Pagos:** Stripe + Mercado Pago. **Solo hosted checkout en fase 1 (PCI SAQ-A)**, nunca tocamos PAN/CVV.
- **IA:** multi-LLM router vía LiteLLM (Claude / GPT-4o-mini / Haiku según tarea).
- **Observabilidad:** OpenTelemetry SDK → Grafana stack (fase 1) → Datadog/ADOT (fase 2).
- **CI/CD:** GitHub Actions. Entornos `dev` / `staging` / `prod`.
- **Feature flags:** Unleash self-hosted.

**Infra fase 1:** Hostinger VPS + Cloudflare. **Fase 2:** AWS multi-región `sa-east-1` (São Paulo) + `us-east-1`.

---

## 🧱 Principios NO negociables

1. **Tiempo a venta < 2 minutos.** Cualquier flujo más lento es bug, no feature.
2. **Mobile-first siempre.** Vendedor en ruta y cliente final usan móvil.
3. **UX limpia tipo Linear/Stripe/Notion.** Whitespace, jerarquía clara, sin decoración. Nada de estética "ERP 2012".
4. **Drag-and-drop como verbo central.** El Package Studio (M2) es el corazón del producto.
5. **Conversacional first.** WhatsApp es ciudadano de primera, no add-on.
6. **Multi-tenant white-label nativo.** Cada decisión técnica respeta aislamiento de tenant. RLS forzada en Postgres.
7. **Cloud-ready día 1.** 15 abstracciones de infra (`packages/core/ports/`) detrás de interfaces. Nunca importar AWS-SDK ni Redis directamente desde dominio.
8. **Eventos antes que estado.** Todo cambio de negocio relevante emite domain event a `domain_events` (TimescaleDB hypertable, append-only).
9. **Fail loud, recover gracefully.** Circuit breakers, sagas Temporal con compensación, kill-switches por proveedor (feature flags).
10. **Accesibilidad WCAG AA mínimo.** Contraste, keyboard nav, screen readers.

---

## 📁 Estructura del repo (target Sprint 0+)

```
sales-travel/
├── docs/                        # documentación viva (markdown)
├── .claude/                     # config Claude Code (commit settings.json team-wide)
├── packages/                    # código compartido (Turborepo + pnpm workspaces)
│   ├── core/ports/              # 15 abstracciones de infra (interfaces)
│   ├── domain/                  # entidades + lógica de negocio (sin I/O)
│   ├── canonical/               # modelo canónico (Offer, Itinerary, Segment, …)
│   ├── ui/                      # design system shadcn-based
│   ├── validation/              # schemas Zod
│   ├── i18n/                    # ES/PT/EN
│   └── sdk/                     # SDK cliente para nuestra API
├── providers/                   # Anti-Corruption Layer por proveedor
│   ├── amadeus/, travelport/, sabre/, ndc-latam/
│   ├── hoteldo/, hotelbeds/, ratehawk/
│   ├── civitatis/, getyourguide/
│   ├── assist-card/, universal-assistance/
│   ├── cartrawler/
│   ├── stripe/, mercadopago/
│   ├── alegra/, focus-nfe/, nubefact/
│   └── whatsapp-cloud/, twilio-voice/, deepgram/, elevenlabs/, litellm/
├── apps/
│   ├── api/                     # NestJS modular monolith
│   ├── ai-sidecar/              # FastAPI + LangGraph
│   ├── temporal-worker/         # workers de sagas
│   ├── web-b2b/                 # Next.js panel agencia
│   ├── web-b2c/                 # Next.js sitio público
│   ├── web-admin/               # Next.js superadmin
│   └── mobile/                  # React Native + Expo
├── infrastructure/              # Terraform (Hostinger DNS + Cloudflare → AWS Ola 3)
└── tools/                       # scripts (db migrations, seeds, codegen, …)
```

Detalle en `docs/platform/10-mapa-completo-plataforma.md` §10.

---

## ✅ Convenciones de código

- **TypeScript estricto:** `strict: true`, `noUncheckedIndexedAccess: true`, `noImplicitOverride: true`.
- **Naming:** kebab-case archivos, PascalCase clases/types/components, camelCase funciones/vars, SCREAMING_SNAKE constantes.
- **Imports absolutos** vía path mappings en cada package (`@core/*`, `@domain/*`, `@ui/*`).
- **No barrel files masivos** (anti-pattern: `index.ts` que re-exporta todo). Usar imports directos.
- **Errores con clases tipadas** en `packages/core/errors/` (no throw genérico).
- **Validación en bordes:** todo input externo (HTTP body, env vars, payload de proveedor) pasa por Zod.
- **Logging estructurado** (JSON) con OpenTelemetry. Nunca `console.log` en código de producción.
- **NUNCA loguear secrets, PAN, tokens, ni PII sensible.**
- **Tests:** unit con Vitest, integration con Vitest+containers, E2E con Playwright. Coverage >70% en domain/, >50% global.
- **Commits:** Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `perf:`).
- **PRs:** descripción + screenshots si UI + checklist de tests + linked issue.

---

## 🔐 Seguridad (siempre presente)

- **Hosted checkout** únicamente en fase 1 (PCI SAQ-A). Nunca PAN/CVV en servidor.
- **Webhooks** con signature verification + idempotency keys + outbox pattern.
- **Secretos** vía sops + age en repo (NUNCA secretos planos en commits).
- **MFA obligatorio** para roles `tenant_admin` y superiores.
- **Audit log** inmutable de toda acción sensible (event sourcing parcial en `domain_events`).
- **Headers de seguridad:** Helmet (CSP estricto, HSTS preload, X-Frame-Options DENY, Referrer-Policy strict-origin).
- **Rate limiting** en endpoints públicos (Cloudflare + middleware app).
- **Tests de aislamiento cross-tenant** obligatorios en CI.

Detalle en `docs/platform/10-mapa-completo-plataforma.md` §3.

---

## 🤖 Skills de Claude Code activos en este proyecto

(Configurados en `.claude/settings.json`)

- **`tailwind-v4-shadcn`** — invocar para setup/debug Tailwind v4 + shadcn/ui.
- **`ui-ux-pro-max`** — invocar para diseñar/revisar UI (50+ estilos, paletas, font pairings).
- **`interface-design`** — invocar para construir/auditar interfaces de aplicación (dashboards, paneles, herramientas). Subskills: `init`, `audit`, `critique`, `extract`, `status`.
- **`design-review`** — invocar para review de craft visual.
- **`shadcn` MCP** — acceso directo a 1.300+ blocks/components shadcn v4.

**Cuando construyas UI nueva:** usar `interface-design:init` para arrancar y `design-review` antes de PR.

---

## 🚫 Anti-patrones explícitamente prohibidos

- ❌ Importar `aws-sdk`, `redis`, `stripe`, `axios` directamente desde `apps/` o `packages/domain/`. Siempre vía port en `packages/core/ports/`.
- ❌ Tipos de proveedor (Amadeus DTO, Stripe types) filtrándose al dominio. Convertir a modelo canónico en el ACL.
- ❌ Queries SQL crudas sin `tenant_id` filter. Usar siempre el query builder con tenant context inyectado.
- ❌ `any` en TypeScript salvo justificación documentada.
- ❌ Skipping de hooks pre-commit / PR checks.
- ❌ Branches de larga vida. Trunk-based development con feature flags.
- ❌ Comentarios que explican "qué" hace el código. Solo explicar "por qué" cuando sea no obvio.

---

## 📞 Para preguntas no cubiertas aquí

Antes de inventar respuesta, leer en este orden:
1. `docs/platform/10-mapa-completo-plataforma.md` (mapa técnico)
2. `docs/research/05-arquitectura-referencia.md` (decisiones arquitectónicas)
3. `docs/discovery/06-documento-maestro.md` (visión y scope)

Si después de leer sigue sin estar claro, **preguntar al founder** antes de implementar.
