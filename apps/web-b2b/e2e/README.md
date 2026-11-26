# E2E del panel (Playwright)

Pruebas de punta a punta del panel B2B contra un stack local **sin proveedores**: Postgres
(TimescaleDB, como producción) + Redis + migraciones + API en Docker, y el panel en `next dev`. Es la
Semana 1 del plan de `docs/platform/21-analisis-integral-2026-11.md` §8.5.

## Correrlas

```bash
# 1. Stack (desde apps/web-b2b). La primera vez construye las imágenes del api y del migrador.
pnpm e2e:up

# 2. Navegador: el Chromium de Playwright…
pnpm exec playwright install chromium
# …o el Chrome/Edge instalado, sin descargar nada:
export PW_CHANNEL=chrome   # o msedge

# 3. Pruebas (levanta `next dev` en :3101 si no está corriendo)
pnpm e2e
pnpm e2e --project=desktop -g "F1"     # un subconjunto

# 4. Bajar el stack y descartar la base
pnpm e2e:down
```

`pnpm e2e:up` crea `e2e/.env.e2e` (fuera de git) con contraseñas y llaves al azar la primera vez
(`e2e/env/generar-secretos.mjs`); el compose y Playwright las leen de ahí. Para rotarlas: `pnpm e2e:down`
y borrar el archivo.

Puertos: Postgres `55442`, Redis `56381`, API `4102`, panel `3101` (`support/env.ts`; se pueden cambiar
con `E2E_PG_URL`, `E2E_API_URL`, `E2E_WEB_URL`).

## Cómo está armado

| Pieza                    | Qué hace                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docker-compose.e2e.yml` | `postgres` → `migrate` (todas las migraciones) → `seed` → `api`. La base no tiene volumen.                                                                                                       |
| `env/seed.sql`           | Red de prueba: plataforma → consolidador → agencia A → subagencia, y agencia B. Usuarios `@e2e.test` (superadmin, admin A, admin sin MFA, vendedor A, vendedor B), todos con `E2e-Prueba-2026!`. |
| `global-setup.ts`        | En cada corrida vuelve a aplicar el seed (deja a los usuarios sin MFA ni sesiones) y borra `e2e/.auth`.                                                                                          |
| `auth.setup.ts`          | Proyecto `setup`: inicia sesión con cada usuario, **activa MFA** donde el rol lo exige y guarda la sesión en `e2e/.auth/*.state.json`.                                                           |
| `support/totp.ts`        | Códigos TOTP (RFC 6238) desde la clave que muestra el alta; respeta que el api no acepta dos veces el mismo paso de 30 s.                                                                        |
| `support/auth.ts`        | Login, alta de MFA, desafío y códigos de recuperación. Si el api responde «muchos intentos» (10 logins/min por IP), espera el minuto y reintenta.                                                |
| `a11y-baseline.json`     | Violaciones de axe ya conocidas por proyecto, tema y ruta. F26 falla sólo con violaciones **nuevas**. La lista sólo debe achicarse.                                                              |

Proyectos: `setup`, `desktop` (1280×800) y `mobile` (375×812). Etiquetas: `@auth` y `@desktop` sólo en
desktop; `@mobile` sólo en mobile.

## Qué cubre (docs/platform/21 §8.2)

| ID  | Archivo                          | Qué comprueba                                                                                                             |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| F1  | `tests/f1-login-mfa.e2e.ts`      | Contraseña errada; gate de MFA que no se saltea; alta con 10 códigos; código errado/correcto; recuperación de un solo uso |
| F3  | `tests/f3-network-nodes.e2e.ts`  | Alta de agencia y sub-agencia; tipos válidos según la jerarquía; BUG-E2E-01                                               |
| F5  | `tests/f5-roles.e2e.ts`          | Vendedor sin MFA ni acceso a plataforma; admin de agencia ve su equipo y no el de otra agencia; superadmin ve la consola  |
| F25 | `tests/f25-mobile-layout.e2e.ts` | 10 rutas de venta a 375 px: sin scroll horizontal y con margen lateral                                                    |
| F26 | `tests/f26-accessibility.e2e.ts` | axe WCAG 2.1 A/AA en 7 rutas, temas oscuro y claro, desktop y móvil                                                       |

## Ventas con proveedores reales (`@real`)

Sólo corren con `E2E_REAL=1`, que pone `./pruebas.sh e2e` en el ambiente de pruebas de la Mac
(`infrastructure/pruebas`): ahí la red de prueba tiene Sabre CERT y TBO test por BYOC en el consolidador, y
Despegar (api-dev) y LATAM (sandbox) por credencial global. El stack local de `docker-compose.e2e.yml` no
tiene proveedores y las salta. Nunca contra producción.

| ID        | Archivo                           | Qué comprueba                                                                                                                        |
| --------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| F10       | `tests/f10-f12-vuelo-real.e2e.ts` | Búsqueda solo ida BOG → MDE a 50 días con tarifas de Sabre CERT marcadas como de prueba                                              |
| F12 · F27 | `tests/f10-f12-vuelo-real.e2e.ts` | Elegir tarifa, cargar un pasajero y reservar sin cobro: PNR confirmado en menos de 2 min (anota el tiempo); luego cancela el PNR     |
| F14       | `tests/f14-hotel-real.e2e.ts`     | Medellín en COP (Despegar, sin checkout en el panel) y en USD con nacionalidad CO (TBO): la tarifa de TBO se revalida en el checkout |
| F17       | `tests/f17-paquete-real.e2e.ts`   | Paquete vuelo + hotel BOG → MDE, cotización PQ creada y su PDF                                                                       |

- **Limpieza:** la reserva de vuelo se cancela al final, aunque falle un paso intermedio (`afterAll`).
- **Preparación de la red:** F14 deja carteras COP y USD con saldo en el consolidador y la agencia A y el
  contacto de soporte del consolidador (`support/venta.ts`, `prepararRedParaVender`), como lo haría el
  consolidador. Sin eso el checkout de hotel no deja seguir.
- **TBO lento:** la búsqueda de TBO test a veces pasa de los 8 s del fan-out; F14 repite la búsqueda hasta 4
  veces y lo anota.
- **TBO-PRUEBA-01** (`test.fixme`): la cuenta de test de TBO sólo trae tarifas «solo con paquete aéreo» en
  Colombia, así que no hay Book/Cancel de hotel suelto que probar. Pregunta abierta en
  `docs/tbo/10-preguntas-para-tbo.md` Q-31.
- **Sin cubrir todavía:** autos (AgentCars rechaza la IP de la Mac hasta que la registren) y vuelos de LATAM
  (el sandbox cotiza en BRL y la agencia vende en COP).

## Bugs conocidos

Los tests de un bug conocido están marcados con `test.fail()`: pasan mientras el bug exista y fallan
cuando se arregla (entonces hay que quitar la marca). `E2E_SHOW_BUGS=1` los corre como tests normales
para ver el error.

| ID         | Dónde                              | Qué pasa                                                                                                                                                         |
| ---------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BUG-E2E-01 | Mi Red → Nuevo nodo                | Sin «Puestos simultáneos», el campo queda `aria-invalid` pero fuera de la vista y sin foco: el botón parece no hacer nada                                        |
| BUG-E2E-02 | `/paquetes`, `/paquetes/guardados` | A 375 px el título queda a 0 px del borde                                                                                                                        |
| BUG-E2E-03 | Línea base de axe                  | Contraste: menú lateral a 9–10 px (desktop), botón primario en tema claro, chips de paquetes; `scrollable-region-focusable` en Inicio móvil                      |
| BUG-E2E-04 | Alta de MFA → «Listo»              | Intermitente: «Listo» no sale de la pantalla de códigos; el render de `/` loguea `SyntaxError: Unexpected end of JSON input`. El setup recarga y lo anota; F1 no |

## Qué falta (Semana 2)

- Proveedores falsos activables por env en los registries del api (`apps/api/src/providers/*-provider.registry.ts`),
  alimentados con las fixtures de Sabre y TBO, para que la venta F10–F27 también corra en CI sin sandboxes.
- F11 (cambio de precio) y F16 (autos), que necesitan el proveedor falso o la IP registrada en AgentCars.
