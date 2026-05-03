# Stack UI/UX para Plataforma Travel-Tech B2B/B2C — Skills Claude Code + Stack Frontend

**Fecha:** 2026-04-24

---

## 1. Marketplace registrado pero NO instalado: `nextlevelbuilder/ui-ux-pro-max-skill`

**Estado:** maduro y muy popular.

- 70.1k estrellas, 7.2k forks, MIT
- Última release v2.5.0 (10-mar-2026), mantenimiento activo
- Multi-plataforma: Claude Code, Cursor, Windsurf, Copilot, Gemini CLI

**Catálogo:**

- 67 estilos UI (glassmorphism, brutalism, minimalism, neumorphism)
- 161 paletas de color mapeadas a industrias
- 57 font pairings (Google Fonts)
- 161 reglas de razonamiento por industria
- 25 tipos de chart para dashboards
- 15 stacks tech recomendados

**Instalación:**

```bash
/plugin install ui-ux-pro-max@ui-ux-pro-max-skill
```

**Veredicto:** vale la pena. Es el "diccionario visual" más amplio para Claude. Útil para fase de exploración estética. Riesgo bajo: comunidad enorme.

---

## 2. Top 7 skills/plugins UI mantenidos en 2026

| #   | Plugin                                  | Stars       | Comando                                                                                  | Uso                                                       |
| --- | --------------------------------------- | ----------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 1   | **Frontend Design (Anthropic oficial)** | 277k+ inst. | Incluido en Claude Code                                                                  | Evita defaults genéricos                                  |
| 2   | **interface-design** (Dammyjay93)       | 4.6k        | `/plugin marketplace add Dammyjay93/interface-design`                                    | **Persiste design system entre sesiones** ⭐              |
| 3   | **awesome-claude-design** (VoltAgent)   | 1.5k        | Descarga DESIGN.md                                                                       | 68 plantillas (Linear, Stripe, Notion, Airbnb, Vercel)    |
| 4   | **Shadcnblocks-Skill** (masonjames)     | 15          | `/plugin marketplace add masonjames/Shadcnblocks-Skill`                                  | 1.338 blocks + 1.189 components shadcn indexados          |
| 5   | **shadcn-ui-mcp-server** (Jpisnice)     | 2.8k        | `claude mcp add shadcn -- bunx -y @jpisnice/shadcn-ui-mcp-server --github-api-key TOKEN` | MCP shadcn v4 (React/Vue/Svelte/RN)                       |
| 6   | **secondsky/claude-skills**             | 120         | `/plugin marketplace add secondsky/claude-skills`                                        | tailwind-v4-shadcn, design-system-creation, design-review |
| 7   | **Frontend-Design-Toolkit** (wilwaldon) | 88          | Repo de referencia                                                                       | Mejor curaduría 2026                                      |

**Riesgos:**

- Shadcnblocks-Skill: solo 15 stars y 7 commits — mantenedor único.
- Algunas "skills" son guías filosóficas, no generadores reales.

---

## 3. Stack frontend recomendado (no-Claude pero integrable)

### Component libraries (combinar)

- **shadcn/ui v4** — base obligatoria
- **Tremor** (Vercel) — dashboards densos B2B; 35+ componentes con Recharts
- **Aceternity UI** — landings B2C con motion (Framer Motion)
- **Magic UI** — animaciones complementarias
- **Origin UI** — variantes shadcn con timelines (útil para itinerarios travel)
- **Hero UI** — alternativa minimal

### Visualización

- **Tremor** para 80% de casos
- **Recharts** custom
- **Visx** (Airbnb) para gráficos custom (mapas de rutas, gantt itinerarios)

### Generadores AI complementarios

- **v0.dev** — componentes React/Tailwind aislados
- **Lovable.dev** — prototipos full-stack, **SOC 2 + ISO 27001 + GDPR** (relevante B2B travel)
- **Bolt.new** — solo para PoC desechables
- **Builder.io Fusion** — único figma-to-code maduro que aprende tu repo
- **Locofy** — débil en charts, no usar para dashboards densos

### Constructor drag-and-drop visual

- **Builder.io SDK** o **Plasmic** — únicos two-way visual editors maduros con React
- **dnd-kit** + **react-grid-layout** si custom

### Multi-tenant white-label foundation

- **ixartz/SaaS-Boilerplate** (Next.js 16 + shadcn + multi-tenancy + i18n)
- **MakerKit** (de pago, B2B-first)
- Theming runtime: **CSS variables OKLCH** (Tailwind v4) — un único `--brand-hue` por tenant

---

## 4. Recomendación priorizada (orden de instalación)

### Fase 1 — Setup inmediato

```bash
# 1. Tu marketplace ya registrado
/plugin install ui-ux-pro-max@ui-ux-pro-max-skill

# 2. Persistencia design system
/plugin marketplace add Dammyjay93/interface-design
/plugin install interface-design

# 3. shadcn vía MCP
claude mcp add shadcn -- bunx -y @jpisnice/shadcn-ui-mcp-server --github-api-key TU_TOKEN

# 4. Skills tailwind v4 + shadcn + design-review
/plugin marketplace add https://github.com/secondsky/claude-skills
/plugin install tailwind-v4-shadcn@claude-skills
/plugin install design-review@claude-skills
```

### Fase 2 — Componentes complejos

```bash
/plugin marketplace add masonjames/Shadcnblocks-Skill
/plugin install shadcnblocks
```

Descargar de **VoltAgent/awesome-claude-design** los `DESIGN.md` de **Linear**, **Stripe**, **Notion**, **Airbnb** como inspiración.

### Fase 3 — Integración Figma

- **Figma MCP** (oficial)
- **Builder.io Fusion** sync continuo Figma↔repo

---

## 5. Stack final recomendado para Sales-Travel

```
┌─ Foundation
│  Next.js 15+ (App Router) + React 19 + TypeScript 5
│  Tailwind CSS v4 (CSS-first, OKLCH tokens)
│  shadcn/ui v4 (base de componentes)
│
├─ B2B Dashboard (denso, white-label)
│  Tremor (KPIs + charts) + Recharts (custom)
│  Origin UI (timelines, itinerarios)
│  TanStack Table v8 (grids reservas)
│  CSS variables runtime → multi-tenant theming
│
├─ B2C Marketplace (mobile-first, conversión)
│  Aceternity UI + Magic UI (hero, animaciones)
│  shadcn forms (search, filtros)
│  Framer Motion (transiciones)
│
├─ Constructor visual drag-and-drop (Package Studio)
│  dnd-kit + react-grid-layout (custom, control total)
│  Plasmic/Builder.io SDK como fallback si custom es muy lento
│
├─ Pipeline AI
│  Claude Code + skills Fase 1
│  v0.dev (componentes aislados)
│  Lovable.dev (prototipos B2C validables)
│  Builder.io Fusion (Figma → repo, fase 3)
│
└─ Multi-tenant base
   ixartz/SaaS-Boilerplate (fork) como punto de partida
```

---

## 6. Riesgos a vigilar

1. **Token burn en bolt.new/v0** con proyectos >20 componentes — solo para spikes
2. **Shadcnblocks-Skill** mantenedor único + pocas stars → forkear si lo adoptas core
3. **Aceternity/Magic UI** dependen de Framer Motion — bundle size mobile B2C; lazy-load obligatorio
4. **Tremor post-Vercel** — algunas roadmap items se movieron a closed-source; confirmar OSS sigue activo
5. **uipro-cli** instala globalmente — vigilar updates breaking
6. **Locofy** débil en charts y responsive complejo — no para dashboards travel densos
7. **Multi-tenant theming**: si vas con `awesome-claude-design` DESIGN.md de marcas reales (Stripe, Linear) cuidado con copiar identidad — usar como inspiración, no clonar

---

## 7. Fuentes

- [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill)
- [masonjames/Shadcnblocks-Skill](https://github.com/masonjames/Shadcnblocks-Skill)
- [Dammyjay93/interface-design](https://github.com/Dammyjay93/interface-design)
- [VoltAgent/awesome-claude-design](https://github.com/VoltAgent/awesome-claude-design)
- [wilwaldon/Claude-Code-Frontend-Design-Toolkit](https://github.com/wilwaldon/Claude-Code-Frontend-Design-Toolkit)
- [secondsky/claude-skills](https://github.com/secondsky/claude-skills)
- [Jpisnice/shadcn-ui-mcp-server](https://github.com/Jpisnice/shadcn-ui-mcp-server)
- [Tremor – Dashboards y charts React](https://www.tremor.so/)
- [ixartz/SaaS-Boilerplate](https://github.com/ixartz/SaaS-Boilerplate)
