# Estructura Organizacional y Plan de Contratación — Sales-Travel

**Versión:** 1.0
**Fecha:** 2026-04-24
**Geografía base:** Colombia, Argentina, Uruguay (núcleo). Brasil + Perú al escalar Ola 2-3.
**Modalidad:** 100% remoto + cumbre presencial trimestral.

> Los rangos salariales son **valores brutos USD/mes** orientativos para perfiles **senior con 5-8+ años** trabajando remoto desde LATAM en 2026. Los rangos varían por país y por nivel. Validar con headhunter local antes de hacer ofertas.

---

## 1. Organigrama Objetivo (Fin de Ola 3 — Mes 14)

```
                          FOUNDER / CEO
                                │
        ┌──────────────────┬────┴─────┬──────────────────┬────────────┐
        │                  │          │                  │            │
       CTO            HEAD OF       HEAD OF           HEAD OF    HEAD OF FINANCE
      (VP Eng)       PRODUCT        OPERATIONS        GROWTH      & COMPLIANCE
        │                  │          │                  │            │
   ┌────┴────┐        ┌────┴────┐  ┌──┴────┐        ┌────┴───┐    ┌───┴──┐
  Backend  Frontend  Senior PMs  Customer  BPO     Marketing Sales Contad. Legal
  Mobile   DevOps    UX Designers Support  24/7    Growth    B2B   Compli. Audit
  Data     QA        Researchers
  IA       Integraciones
```

---

## 2. Headcount por Ola

| Rol | Ola 1 (Mes 0-6) | Ola 2 (Mes 6-10) | Ola 3 (Mes 10-14) | Total Mes 14 |
|---|---|---|---|---|
| **Liderazgo** | | | | |
| Founder/CEO | 1 | — | — | 1 |
| CTO / VP Engineering | 1 | — | — | 1 |
| Head of Product | (PM hace doble rol) | 1 | — | 1 |
| Head of Operations | — | — | 1 | 1 |
| Head of Growth | — | — | 1 | 1 |
| Head of Finance & Compliance | — | — | 1 | 1 |
| **Producto** | | | | |
| Product Manager | 1 | +1 | — | 2 |
| UX/UI Designer | 1 | +1 | — | 2 |
| **Ingeniería** | | | | |
| Backend Senior (NestJS) | 2 | +1 | +1 | 4 |
| Frontend Senior (Next.js) | 2 | +1 | — | 3 |
| Mobile Engineer (RN+Expo) | — | +1 | +1 | 2 |
| DevOps / SRE | 1 | +1 | — | 2 |
| QA Engineer | 1 | +1 | — | 2 |
| Integraciones (GDS/NDC/PSP) | 1 | — | — | 1 |
| Data Engineer | 1 | — | — | 1 |
| IA Engineer (LLM ops) | 1 | +1 | — | 2 |
| **Operaciones** | | | | |
| Customer Success | — | +1 | +1 | 2 |
| Support BPO partner | — | — | (externalizado) | — |
| Travel Operations Specialist | — | +1 | +1 | 2 |
| **Comercial / Crecimiento** | | | | |
| Sales B2B | — | — | +2 | 2 |
| Marketing / Growth | — | +1 | +1 | 2 |
| **Finanzas / Legal** | | | | |
| Contador | — | — | +1 | 1 |
| Legal / Compliance | — | — | +1 | 1 |
| **TOTAL acumulado** | **12** | **20** | **30** | **30** |

> **Nota:** "+1" indica nueva contratación en esa ola.

---

## 3. Perfiles Detallados (descripciones de cargo)

### 3.1 CTO / VP Engineering ⭐ Mes 0 — primera contratación crítica
**Misión:** Liderar la construcción técnica de la plataforma. Definir arquitectura, contratar y crecer al equipo de ingeniería, garantizar entregas de cada ola en tiempo y calidad.

**Perfil:**
- 10+ años en ingeniería de software, 4+ años liderando equipos de 10+ personas
- Experiencia previa en travel-tech, fintech o marketplace de alta escala (preferible)
- Manejo profundo de arquitecturas event-driven, multi-tenant, integraciones complejas (SOAP/REST/GraphQL)
- Cultura producto + DevOps + seguridad
- Inglés profesional (lectura técnica y comunicación con proveedores como Stripe/Amadeus)

**Compensación:** USD 8.000 – 14.000/mes + equity 1-3% (vesting 4 años, cliff 1 año).

**Headhunter recomendado:** Torre.co (LATAM tech), Talently, Talent.com, o boutique como UpHelp/SocialNature.

---

### 3.2 Backend Senior (NestJS) — 2 en Ola 1, total 4 al Mes 14
**Misión:** Implementar dominio, ports/adapters de proveedores, motor de pricing, sagas Temporal, conciliación de pagos.

**Perfil:**
- 5-8 años con Node.js, TypeScript, NestJS o frameworks similares
- Experiencia con PostgreSQL, Redis, queues, microservicios o monolitos modulares
- Bonus: travel-tech, fintech, multi-tenant, Temporal/saga patterns

**Compensación:** USD 4.500 – 7.500/mes.

---

### 3.3 Frontend Senior (Next.js) — 2 en Ola 1, total 3 al Mes 14
**Misión:** UI B2B (panel agencias, constructor drag-and-drop, búsqueda) y B2C (web pública, cliente final).

**Perfil:**
- 5+ años con React, 3+ con Next.js (App Router)
- Manejo de design systems, accesibilidad, performance (Core Web Vitals)
- TypeScript end-to-end, Storybook, testing (Playwright)
- Experiencia con i18n, multi-tenant, white-label

**Compensación:** USD 4.000 – 6.500/mes.

---

### 3.4 Mobile Engineer (React Native + Expo) — Ola 2 y 3
**Misión:** App vendedor (Ola 2) y app cliente final (Ola 3).

**Perfil:**
- 4+ años React Native, idealmente con Expo SDK reciente
- Publicación en App Store + Play Store
- Offline-first (WatermelonDB / RxDB), push notifications, deep linking
- Bonus: travel apps, mapas, escáner de pasaporte

**Compensación:** USD 4.500 – 7.000/mes.

---

### 3.5 DevOps / SRE — 1 en Ola 1, total 2 al Mes 14
**Misión:** Infraestructura Hostinger fase 1, observabilidad, CI/CD, hardening, migración AWS en Ola 3.

**Perfil:**
- 5+ años en infra (Linux, Docker, Terraform, GitHub Actions)
- Experiencia AWS (ECS, RDS, CloudFront, EventBridge) — mandatorio para migración Ola 3
- OpenTelemetry, Grafana stack, Prometheus
- Hardening, PCI-DSS, gestión de secretos
- Bonus: certificación AWS Solutions Architect

**Compensación:** USD 5.000 – 8.000/mes.

---

### 3.6 QA Engineer — 1 en Ola 1, total 2
**Misión:** Estrategia de testing (unit/integration/E2E), automatización, regression suites, validación de flujos de reserva.

**Perfil:**
- 4+ años con Playwright o Cypress, k6 / Artillery para load testing
- Experiencia en sistemas con flujos de pago y reservas (criticidad alta)
- Bonus: contract testing (Pact), security testing básico

**Compensación:** USD 3.500 – 5.500/mes.

---

### 3.7 Integraciones (GDS/NDC/PSP) — 1, dedicado
**Misión:** Liderar técnicamente las homologaciones con cada proveedor, mantener docs internas, ser punto de contacto técnico con Amadeus/Travelport/Sabre/HotelDo/Stripe/MP.

**Perfil:**
- 5+ años en travel-tech (idealmente)
- Manejo de SOAP/XML legacy, OAuth, certificados, IP whitelisting
- Familiaridad con NDC IATA, PCI-DSS, BSP/ARC
- Comunicación clara para tratar con account managers de proveedores

**Compensación:** USD 5.000 – 8.000/mes (perfil escaso, premium).

---

### 3.8 Data Engineer — 1 en Mes 3
**Misión:** Pipelines de datos, TimescaleDB, embeddings, dashboards de reporting (M12), data marts.

**Perfil:**
- 4+ años con SQL avanzado, Python, ETL/ELT
- Experiencia con time-series DB, pgvector, dbt
- Bonus: BI embebido (Metabase/Cube), MLops

**Compensación:** USD 4.500 – 7.000/mes.

---

### 3.9 IA Engineer (LLM Ops) — 1 en Mes 2-3, +1 Ola 2
**Misión:** Orquestar agentes LLM, multi-LLM router, tool-calling, RAG, evals, optimización de costos de inferencia.

**Perfil:**
- 3+ años con LLMs en producción (Claude, OpenAI, etc.)
- Manejo de LangGraph / LlamaIndex / framework propio
- Conocimiento profundo de prompt engineering, evals, observability LLM
- Bonus: voz (Deepgram/ElevenLabs), embeddings, function calling complejo

**Compensación:** USD 5.000 – 9.000/mes (mercado caliente, premium).

---

### 3.10 Product Manager — 1 en Mes 0-1, +1 Ola 2
**Misión:** Discovery continuo, priorización, roadmap táctico, métricas de éxito por ola, interface entre comercial e ingeniería.

**Perfil:**
- 5+ años PM en producto digital (idealmente B2B o marketplace)
- Discovery (entrevistas con agencias), data-driven, manejo de squad
- Bonus: travel, fintech, multi-tenant

**Compensación:** USD 5.000 – 8.000/mes.

---

### 3.11 UX/UI Designer — 1 en Mes 0-1, +1 Ola 2
**Misión:** Diseñar la experiencia drag-and-drop, paneles B2B, sitio B2C, app móvil. Mantener design system.

**Perfil:**
- 5+ años con productos digitales complejos
- Figma avanzado, design tokens, prototipado, user research
- Bonus: travel UX, accesibilidad WCAG, motion design

**Compensación:** USD 4.000 – 6.500/mes.

---

### 3.12 Customer Success / Account Manager — Ola 2 en adelante
**Misión:** Onboarding de agencias, capacitación, expansión, NPS, reducción de churn.

**Perfil:**
- 3+ años en CS B2B SaaS o travel
- Habilidades comerciales + soporte
- Manejo de Helpdesk + CRM (HubSpot)

**Compensación:** USD 2.500 – 4.500/mes.

---

### 3.13 Travel Operations Specialist — Ola 2-3
**Misión:** Soporte operativo a agencias (cambios, cancelaciones complejas, escalamientos a aerolíneas), gestión de incidentes con proveedores.

**Perfil:**
- 5+ años en agencia de viajes operando GDS (Amadeus/Sabre command line)
- Conocimiento de fare rules, reissues, refunds, NDC
- Disposición a turnos rotativos

**Compensación:** USD 1.800 – 3.000/mes.

---

### 3.14 Sales B2B — Ola 3
**Misión:** Captar agencias B2B (outbound + inbound), gestionar pipeline, cerrar contratos.

**Perfil:**
- 3+ años en venta consultiva B2B (SaaS o travel)
- Inglés/portugués valorado
- Manejo de CRM, demos en vivo

**Compensación:** USD 2.500 – 4.500/mes + variable por ventas (50% adicional posible).

---

### 3.15 Marketing / Growth — Ola 2-3
**Misión:** Branding, contenido, SEO, ads, growth loops, partnerships.

**Perfil:**
- 4+ años growth/performance marketing
- SEO técnico + content + paid (Meta, Google, TikTok LATAM)
- Bonus: travel marketing

**Compensación:** USD 3.500 – 6.000/mes.

---

### 3.16 Heads (Operations / Growth / Finance) — Ola 3
**Misión:** Liderar áreas funcionales (operación 24/7, comercial, finanzas/compliance).

**Perfil:** 8-12 años en su área, con experiencia escalando equipos en startups o travel/fintech.

**Compensación:** USD 6.000 – 10.000/mes + equity 0.3-0.8%.

---

### 3.17 Contador y Legal/Compliance — Ola 3
- **Contador:** experiencia multi-país (CO/BR/PE), facturación electrónica, conciliación PSP. **USD 2.500 – 4.500/mes.**
- **Legal/Compliance:** travel + protección de datos (LGPD, Ley 1581, Ley 29733) + contratos enterprise. **USD 3.500 – 6.000/mes.**

---

## 4. Plan de Contratación Mes a Mes

| Mes | Cargos a abrir | Acumulado | Notas |
|---|---|---|---|
| **0** | CTO ⭐, Product Manager, UX Designer | 4 (con founder) | CTO es el primer hire — usar headhunter |
| **1** | 2 Backend, 2 Frontend, 1 DevOps, 1 Integraciones | 10 | CTO lidera entrevistas técnicas |
| **2** | 1 QA, 1 IA Engineer | 12 | Cierre del headcount Ola 1 |
| **3** | 1 Data Engineer | 13 | Refuerzo dominio data |
| **6-7** | 1 Mobile, 1 Backend, 1 Frontend, 1 IA, 1 PM | 18 | Inicio Ola 2 |
| **8-9** | 1 DevOps (foco AWS), 1 QA, 1 Designer, 1 Customer Success, 1 Travel Ops | 23 | Refuerzo operativo + preparar AWS |
| **10-11** | 1 Mobile B2C, 1 Backend B2C, 1 Customer Success, 1 Marketing | 27 | Apertura B2C |
| **12-14** | Heads (Ops, Growth, Finance), 2 Sales B2B, 1 Travel Ops, 1 Contador, 1 Legal | 30+ | Cierre estructura Mes 14 |

---

## 5. Costo de Nómina Estimado por Ola

> Asumiendo punto medio del rango salarial por perfil. Cifras en USD/mes y USD/año totales.

| Período | Headcount | Nómina mensual (USD) | Nómina ola completa (USD) |
|---|---|---|---|
| Ola 1 (Mes 0-6) | 12 al cierre | ~62.000/mes | ~280.000 (acumulado 6 meses) |
| Ola 2 (Mes 6-10) | 20 al cierre | ~100.000/mes | ~325.000 (acumulado 4 meses) |
| Ola 3 (Mes 10-14) | 30 al cierre | ~155.000/mes | ~510.000 (acumulado 4 meses) |
| **Total Año 1 (Mes 0-12)** | — | — | **~1.000.000 USD** |
| **Total Año 1+2 al Mes 14** | — | — | **~1.115.000 USD** |

> Sumar **20-30%** por cargas sociales, beneficios y costos de empleador según país. Estimación realista año 1: **USD 1.2M – 1.4M en nómina total**.

---

## 6. Modalidad de Contratación

### Opciones por país
- **Colombia:** contratación directa SAS local + prestaciones de ley.
- **Argentina:** contratación directa o vía monotributista.
- **Uruguay:** vía SAS local o servicios profesionales.
- **Brasil/México (Ola 2+):** EOR (Employer of Record) tipo Deel, Remote.com, OysterHR, hasta abrir entidad local.
- **Perú:** EOR inicial, luego contratación local con SAC Perú (Ola 2-3).

### Beneficios estándar a ofrecer
- Equipo de trabajo (laptop + monitor + accesorios) — ~USD 2.000 setup inicial
- Health insurance (USD 100-200/mes según país)
- Días de PTO (15-20/año + feriados locales)
- Stipend mensual oficina remota (USD 50-100)
- Equity para senior+ (vesting 4 años, cliff 1 año, pool 10-15% diluido)
- Cumbre presencial trimestral (un destino LATAM rotativo)

---

## 7. Proceso de Contratación

### Loop estándar (4-5 etapas, 2-3 semanas total)
1. **Screening con People Lead** (30 min) — fit cultural, motivación, expectativas
2. **Entrevista técnica con líder del área** (60 min) — profundidad técnica
3. **Live coding o case study** (60-90 min, take-home opcional)
4. **System design / architecture** (para senior+) (60 min)
5. **Founder/CTO closing call** (45 min) — visión, pregunta abierta
6. **Reference checks** (3 referencias mínimo, contactadas en paralelo a #5)

### Filtros automáticos previos al loop
- CV con experiencia mínima requerida
- GitHub o portfolio público (cuando aplique)
- Test asíncrono breve (< 90 min) para senior backend/frontend
- Inglés intermedio mínimo (entrevista en inglés con CTO si no hay otra forma de validarlo)

### Time-to-hire objetivo
- Senior: **3-4 semanas** desde primera conversación a oferta firmada
- Heads: **6-8 semanas** (búsqueda más exhaustiva)

---

## 8. Cultura y Principios de Trabajo

### Valores propuestos (a refinar con el equipo)
1. **El cliente cierra negocio en 2 minutos.** Cada decisión se evalúa por su impacto en la velocidad de venta.
2. **Construimos como si fuéramos 10× más grandes.** Disciplina arquitectónica desde día 1.
3. **Confianza por defecto.** Equipo remoto adulto, sin micromanagement.
4. **Datos antes de opiniones.** Decisiones en métricas, no en intuiciones.
5. **Ownership total.** Si lo viste y no lo escalaste, era tuyo.

### Rituales mínimos
- **Standup async diario** (Slack/Linear) — sin Zoom obligatorio
- **Demo semanal** (45 min) abierta a toda la empresa
- **Retro cada 2 semanas** por squad
- **All-hands mensual** con métricas y roadmap
- **Cumbre presencial trimestral** (3-4 días, mezcla trabajo + bonding)

---

## 9. Headhunters y Bolsas Recomendadas (LATAM tech 2026)

### Headhunters
- **Torre.co** — fuerte en LATAM tech remoto, AI matching
- **Talently** — bootcamp + recruiting, foco juniors-mids
- **Endava / Globant** (poaching difícil pero red enorme)
- **Toptal LATAM** — para freelancers premium
- **UpHelp / Talent.com** — boutiques

### Bolsas / comunidades
- **LinkedIn Recruiter Lite** (USD 170/mes) — esencial
- **WeWorkRemotely / RemoteOK** — internacional
- **Hire LATAM** (slack)
- **Comunidades Discord/Slack:** PlatziDev, NodeJS LATAM, React Brasil
- **Conferencias LATAM:** JSConf Colombia, Ada Lovelace Day, BrazilJS, RubyConf BR

### Equity y stock options
- Pool inicial recomendado: **10-15%** de la cap table.
- Senior+ aspiran a **0.1-0.5%**. Heads: **0.3-0.8%**. CTO: **1-3%**.
- Cliff 1 año, vesting mensual luego, total 4 años.
- Strike price razonable según fase de financiación.

---

## 10. Decisiones Pendientes (operativas equipo)

| # | Decisión | Quién | Cuándo |
|---|---|---|---|
| E1 | Sistema HR/payroll (Deel vs Remote vs propio) | Founder | Mes 0 |
| E2 | Stack de comunicación interna (Slack vs Discord vs Mattermost) | CTO | Mes 0 |
| E3 | Project management tool (Linear vs Jira vs Asana vs ClickUp) | CTO + PM | Mes 0 |
| E4 | Política de equity y plan de incentivos a largo plazo | Founder + asesor legal | Mes 1-2 |
| E5 | Headhunter elegido para CTO ⭐ | Founder | Día 1 |
| E6 | Política PTO, salud, beneficios estandarizados | Founder + Head of Ops futuro | Mes 1 |
| E7 | Onboarding playbook (primeros 30/60/90 días) | CTO + PM | Mes 1 |

---

## 11. Resumen Ejecutivo

- **Mes 0:** primera contratación es **CTO**, paralelo PM + UX. Cuatro personas con el founder.
- **Mes 6:** **12 personas**, lanzamiento Ola 1.
- **Mes 10:** **20 personas**, expansión vertical + Perú + móvil.
- **Mes 14:** **30 personas**, B2C en producción, AWS productivo, organización completa.
- **Costo nómina año 1:** ~USD 1.0M (más cargas: 1.2-1.4M).
- **Costo nómina año 2 al Mes 14:** ~USD 0.5M adicional.
- **Modalidad:** 100% remoto LATAM + cumbre trimestral.
- **Equity pool:** 10-15% para empleados, CTO 1-3%.

---

## Próximos pasos inmediatos (Founder, esta semana)

1. **Activar headhunter para CTO** — 3 conversaciones agendadas en 7 días.
2. **Decidir holding** (Uruguay vs Delaware) con asesor legal.
3. **Constituir SAS Colombia** — 2 semanas.
4. **Iniciar contratos con Travelport/Amadeus/HotelDo/Stripe/MP** — ciclo largo, no esperar.
5. **Definir nombre comercial + dominios** — semana 1.
6. **Decidir herramientas operativas** (Slack/Linear/Deel) — semana 1.
