# Sales-Travel

> Plataforma consolidadora de turismo B2B2B/B2B/B2C para LATAM (Colombia, Brasil, Perú).
> Multi-tenant white-label: un consolidador da acceso a su red de agencias y sub-agencias, cada una con sus
> credenciales de proveedor propias (BYOC) o heredadas, y un pricing en cascada.

**Estado (2026-11-05):** Ola 1 en curso, en producción en `app.planetour.cloud`. Vuelos (LATAM NDC y Sabre),
hoteles (TBO y Despegar) y autos (AgentCars) con búsqueda, reserva y postventa; red de agencias multinivel,
gobierno de proveedores y formas de pago, y consola de plataforma para superadmins.
**Repositorio:** privado. **Versión:** ver [`CHANGELOG.md`](./CHANGELOG.md) (release-please).

> 🚨 **Pendiente urgente — Sabre H-07:** las reservas Sabre salen por un rodeo temporal (`bookOnTicketingPcc` →
> `targetPcc`). Ver [`docs/sabre/12-hallazgos-sandbox.md`](./docs/sabre/12-hallazgos-sandbox.md).

---

## Qué hay construido

| Área                      | Estado                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Vuelos**                | LATAM NDC y Sabre (BFM, Flight Check, marcas por trayecto, niños/infantes, reserva, emisión, postventa). Multi-proveedor.   |
| **Hoteles**               | TBO y Despegar: catálogo e inventario sincronizados, búsqueda, prebook, reserva, cancelación y verificación.                |
| **Autos**                 | AgentCars: búsqueda, oficinas, reserva y reporte.                                                                           |
| **Cotizaciones/reservas** | Cotizaciones guardadas, pasajeros y facturación con datos fiscales, reservas con seguimiento y alertas de plazos.           |
| **Red consolidadora**     | Jerarquía multinivel, credenciales por nodo con herencia, pricing waterfall, carteras por moneda, puestos y resumen de red. |
| **Gobierno**              | Perfiles de gobierno: proveedores y formas de pago habilitadas por nodo, kill-switch por proveedor.                         |
| **Plataforma**            | Consola de superadmins (plenos y supervisados), usuarios, actividad, auditoría, anuncios del sistema.                       |
| **Seguridad**             | RLS forzada, 2FA obligatorio para todo rol admin, invitaciones, recuperación de contraseña, audit log.                      |
| **CRM**                   | Clientes (personas y empresas) con PII cifrada.                                                                             |

Pendiente de olas siguientes: Package Studio (drag-and-drop), WhatsApp/IA conversacional, B2C, app móvil,
facturación electrónica (DIAN/SUNAT/NF-e). Ver [`docs/discovery/07-roadmap-olas.md`](./docs/discovery/07-roadmap-olas.md).

---

## 📁 Estructura del repo

```
sales-travel/
├── apps/
│   ├── api/                 # NestJS modular monolith (auth, red, búsqueda, reservas, gobierno, consola…)
│   └── web-b2b/             # Next.js 15 panel de agencia y consola de plataforma
├── packages/
│   ├── canonical/           # modelo canónico Zod (Offer, Itinerary, Segment, HotelOffer, Ancillary, SeatMap…)
│   ├── core/                # ports + errores tipados
│   ├── domain/              # lógica de dominio sin I/O (gobierno)
│   └── validation/          # schemas Zod compartidos (ISO-3166, nombres de persona)
├── providers/               # Anti-Corruption Layer por proveedor
│   ├── latam-ndc/  sabre/  tbo-hotels/  despegar-hotels/  agent-cars/
├── db/migrations/           # SQL versionado (RLS, jerarquía, órdenes, gobierno…)
├── infrastructure/hostinger # docker compose prod + CERT, Caddy, provisión del VPS
├── tools/                   # migraciones, seeds, sync de aeropuertos/hoteles, arneses de certificación
└── docs/                    # documentación viva (ver abajo)
```

## 🛠️ Desarrollo

Requisitos: Node 20.18 (`.nvmrc`), pnpm 9.15.

```bash
pnpm install
pnpm build        # turbo, respeta dependencias entre paquetes
pnpm typecheck
pnpm lint
pnpm test         # algunos tests de integración necesitan Postgres (variables PG* en turbo.json)
pnpm format:check
```

CI (`.github/workflows/ci.yml`) corre formato, build, lint, typecheck y tests en cada push a `main`.
El deploy (`deploy.yml`) construye las imágenes, despliega al VPS, migra y hace smoke test.
Trabajamos trunk-based sobre `main`.

---

## 📚 Documentación

| Pregunta                                          | Documento                                                                                                                                                        |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mapa técnico: módulos, endpoints, modelo de datos | [`docs/platform/10-mapa-completo-plataforma.md`](./docs/platform/10-mapa-completo-plataforma.md)                                                                 |
| Modelo consolidador / BYOC y plan                 | [`docs/platform/12-modelo-consolidador-y-plan.md`](./docs/platform/12-modelo-consolidador-y-plan.md)                                                             |
| Usuarios, roles y superadmins                     | [`docs/platform/15-gestion-de-usuarios.md`](./docs/platform/15-gestion-de-usuarios.md), [`16-roles-y-superadmins.md`](./docs/platform/16-roles-y-superadmins.md) |
| Integración Sabre                                 | [`docs/sabre/`](./docs/sabre/) (plan en `11-plan-implementacion.md`, hallazgos en `12-hallazgos-sandbox.md`)                                                     |
| Integración LATAM NDC                             | [`docs/latam-ndc/01-estado-y-plan.md`](./docs/latam-ndc/01-estado-y-plan.md)                                                                                     |
| Integración TBO hoteles                           | [`docs/tbo/`](./docs/tbo/) (plan en `09-plan-implementacion.md`)                                                                                                 |
| Integración AgentCars                             | [`docs/cars/agentcars-api-reference.md`](./docs/cars/agentcars-api-reference.md)                                                                                 |
| Arquitectura y decisiones                         | [`docs/research/05-arquitectura-referencia.md`](./docs/research/05-arquitectura-referencia.md)                                                                   |
| Visión, módulos y roadmap                         | [`docs/discovery/06-documento-maestro.md`](./docs/discovery/06-documento-maestro.md), [`07-roadmap-olas.md`](./docs/discovery/07-roadmap-olas.md)                |
| Proveedores del ecosistema, fiscal, competencia   | [`docs/research/`](./docs/research/)                                                                                                                             |
| Infra y operación del VPS                         | [`infrastructure/hostinger/README.md`](./infrastructure/hostinger/README.md)                                                                                     |

Principios, stack y convenciones para todo cambio: [`CLAUDE.md`](./CLAUDE.md).

---

## 🎯 Posicionamiento

**"El primer consolidador conversacional de LATAM."** Red de agencias self-service con credenciales propias,
WhatsApp como canal de venta de primera clase, Package Studio visual y cobertura CO + PE + BR.
Detalle en [`docs/research/06-competencia-latam.md`](./docs/research/06-competencia-latam.md).
