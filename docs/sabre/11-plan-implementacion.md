---
titulo: 'Sabre — Plan de implementación por fases'
fecha: 2026-08-26
estado: reconciliado-contra-spec; Fases 2.b y 3 con código completo, sin verificar contra CERT
Fuentes: ver 00-fuentes.md
---

# Sabre — Plan de implementación por fases

Los requisitos están en [10-requisitos-maestro.md](./10-requisitos-maestro.md). Este documento dice **en qué
orden se construyen, con qué entregables, con cuánto esfuerzo, en cuánto calendario y cuándo se puede decir que
una fase terminó**.

> ### Qué cambió respecto de la primera pasada
>
> La primera versión de este plan salió con **13 hallazgos de crítica, 8 de severidad alta**. Los cambios de fondo:
>
> 1. **Existe la fase de certificación.** La palabra no aparecía ni una vez en el documento anterior. El plan
>    terminaba en CERT, que es un entorno que **no factura**. Ahora hay una **Fase C** con dueño, calendario y
>    criterio de salida, y el hito "primera venta facturable" **no** está al final de la Fase 4.
> 2. **La Fase 2 se parte en dos.** La afirmación de que era "trabajo puro de repo que hay que hacer igual" sólo era
>    cierta para una parte: `providers-sabre/*` y el formulario de Sabre en la UI se tiran a la basura si el contrato
>    no se firma. **Fase 2.a** es incondicional y no menciona Sabre **ni una vez**; **Fase 2.b** está condicionada al
>    contrato y depende de la Fase 1.
> 3. **Hay compuerta comercial Go/No-Go** entre la Fase 0 y la Fase 1, con entradas, umbral y quién decide.
> 4. **Encaje con el roadmap declarado.** Ninguno de los doce documentos de `docs/sabre/` había leído
>    `docs/discovery/07-roadmap-olas.md`, que `CLAUDE.md` señala como fuente de verdad de secuenciación. El roadmap
>    pone a Sabre **sólo como adapter de búsqueda**. Lo que este plan proponía era una **expansión de alcance
>    silenciosa** y ahora está declarada como tal, para que el founder la apruebe o la rechace (§1).
> 5. **Esfuerzo y calendario van separados** en toda la tabla, con el supuesto de dotación publicado (§2).
> 6. **Tres errores de procedencia erradicados** (los mismos que el maestro): el front-matter ya no cita
>    `EXTERNAL_AGENCY.postman_collection.json` (que es la colección de LATAM NDC, no la de Sabre); las 4 respuestas
>    guardadas **no están vacías** (16.479 bytes cada una, `evidence/responses/*.json`); y el carril SOAP/LLS
>    (243 de 1.077 requests) tiene **decisión de alcance explícita en §1.5** —queda fuera del plan, con evidencia y
>    con condición de reapertura— en vez de estar ignorado.
> 7. **Renumeración de preguntas.** El maestro renumeró §8 y avisó de que este documento citaba "P-01" con el
>    sentido antiguo. **Corregido en todo el texto:** las credenciales son **P-05**; **P-01** es ahora el fee por
>    transacción. Todas las `P-xx` y `D-x` de este documento usan la numeración de
>    [10 §8 y §9](./10-requisitos-maestro.md).
> 8. **Cierre del 25 de agosto.** Las credenciales de CERT ya están disponibles fuera de Git; queda cargarlas en el
>    almacén cifrado y ejecutar el smoke test. Amadeus Self-Service fue descontinuado el 17 de julio de 2026, por
>    lo que dejó de ser una alternativa ejecutable. Véase [12-cierre-auditoria.md](./12-cierre-auditoria.md).
> 9. **Trazabilidad requisito → fase (§11).** La auditoría encontró **cinco RF del maestro sin fase asignada**
>    —RF-17, RF-18, RF-20, RF-22 y RF-23— y esta pasada añadió un sexto por contenido, **RF-06**. Ahora **los 23 RF
>    tienen fase, o un motivo escrito para no tenerla** (§11). El caso grave eran RF-18 y RF-20: el modelo
>    consolidador sin dueño.

---

## 1. Encaje con el roadmap de olas — **cambio de alcance que el founder tiene que aprobar**

### 1.1 Lo que dice el roadmap

`docs/discovery/07-roadmap-olas.md` (v1.0, 2026-04-24) asigna Sabre a **un solo lugar**, Ola 1 / Mes 2:

> `| Tech / Adapters | Adapter Travelport y Sabre (search) ⚠️ | Credenciales productivas, certificación inicial |
Search desde 3 GDS en paralelo con scatter-gather |`

Tres cosas de esa línea importan y ninguna estaba recogida en la primera versión de este plan:

- **`(search)`.** Sabre entra al roadmap como **fuente de búsqueda**, no como ciclo de vida del billete. El DoD de
  Ola 1 no menciona emisión, void ni refund por Sabre — la única línea de post-venta de Ola 1 es
  _"Cancelación + reembolso vía proveedor"_ en Mes 4, y está escrita para el proveedor con el que ya se vende.
- **`Credenciales productivas, certificación inicial`** aparece como **dependencia declarada** desde abril. El plan
  anterior no tenía fase de certificación en absoluto.
- **`⚠️`** y **RR1**: _"Homologación GDS más lenta de lo esperado → +4-8 semanas Ola 1 → Empezar Mes 0, usar
  Self-Service Amadeus en paralelo a contrato Enterprise"_. Esa mitigación del roadmap quedó obsoleta: Amadeus
  Self-Service fue descontinuado el 17 de julio de 2026. La comparación vigente es Sabre CERT frente a propuestas
  Enterprise de Amadeus/Travelport, con evaluación equivalente de contrato, contenido y certificación.

### 1.2 La expansión de alcance, dicha con todas las letras

El plan anterior asignaba **27-33 d-p (≈55 % del total)** a las Fases 3 y 4, que son exactamente `createBooking`,
`fulfillFlightTickets`, `voidFlightTickets` y `refundFlightTickets`. **Eso no está en Ola 1 en ninguna parte.**

| Fase        | Qué es                           | Roadmap                                   | Este plan (v1)    | Este plan (v2)                       |
| ----------- | -------------------------------- | ----------------------------------------- | ----------------- | ------------------------------------ |
| 2.a         | Fan-out genérico multi-proveedor | Implícito en "scatter-gather" (Mes 2)     | Ola 1             | **Ola 1 — incondicional**            |
| 0 + 1 + 2.b | Sabre como fuente de búsqueda    | **Ola 1, Mes 2**                          | Ola 1             | **Ola 1 — tras compuerta comercial** |
| 3           | Reserva y cancelación por Sabre  | **No está**                               | Ola 1 (implícito) | **Propuesta para Ola 2**             |
| 4           | Emisión, void, refund, asientos  | **No está**                               | Ola 1 (implícito) | **Propuesta para Ola 2**             |
| 5           | Hoteles Sabre                    | **No está** (Ola 1 usa HotelDo/Hotelbeds) | Condicional       | **Condicional, Ola 2+**              |

> **Decisión que se le pide al founder:** aprobar o rechazar que las Fases 3 y 4 se propongan para **Ola 2**, y
> confirmar que **el alcance de Sabre en Ola 1 es únicamente búsqueda**. Si la respuesta es "también quiero vender
> por Sabre en Ola 1", eso son **27-33 d-p adicionales más 4-8 semanas de certificación** compitiendo con pagos,
> fiscal, IA WhatsApp y Package Studio, que son los compromisos abiertos de la propia Ola 1. **No cabe.**

### 1.3 El alcance defendible para Ola 1, dicho sin adornos

**El alcance que este expediente venía asumiendo —integración completa de Sabre incluyendo emisión y post-venta
dentro de Ola 1— es irreal.** Las razones son tres y ninguna es de esfuerzo de ingeniería:

1. **Las credenciales ya están disponibles fuera de Git** (P-05 resuelta). La Fase 0 puede arrancar cuando se
   inyecten mediante el almacén cifrado de `provider_accounts` y se acuerde D1; ningún secreto se versiona.
2. **No hay contrato ni fee conocido** (P-01, P-02, R-01). Comprometer 50-60 d-p contra un contrato que nadie ha
   visto es la exposición más grande del expediente.
3. **La certificación es calendario, no esfuerzo** (§9). Entre 4 y 8 semanas que no se aceleran contratando gente.

**Alcance defendible para Ola 1:** Fase 2.a + Fase 0 + Fase 1 + Fase 2.b = **Sabre aparece como segunda fuente de
ofertas en el buscador, con degradación parcial visible, y nada más**. Son **23-27 d-p**, coincide literalmente con
lo que el roadmap pedía en Mes 2, y deja el ACL preparado para que las Fases 3-4 sean incrementos y no una
reescritura.

### 1.4 El roadmap está desactualizado y hay que decirlo

`07-roadmap-olas.md` es de abril y el repo se ha movido. Verificado contra `@c39ac93`:

| El roadmap dice                             | El repo tiene                                                                                |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Adapter Amadeus self-service (Mes 1)        | `providers/latam-ndc` — no hay Amadeus                                                       |
| Adapter HotelDo + Hotelbeds (Mes 2-3)       | `providers/despegar-hotels`                                                                  |
| Adapter CarTrawler (Ola 2, Mes 7)           | `providers/agent-cars` — **ya integrado**, adelantado                                        |
| Temporal self-hosted + primera saga (Mes 2) | **No existe.** Hay BullMQ (`apps/api/src/queue/`, `apps/api/src/orders/post-sale.worker.ts`) |
| Duffel como NDC provisional                 | LATAM NDC directo, 9/9 endpoints                                                             |

**Consecuencia operativa:** o el roadmap se actualiza en el mismo pase en que se apruebe este plan, o deja de ser
fuente de verdad y `CLAUDE.md` debe dejar de señalarlo como tal. Mantener un roadmap que contradice al repo
convierte cualquier discusión de secuenciación en una discusión sobre qué documento vale.

**Y sobre el calendario:** el roadmap fecha el Sabre-search en **Mes 2 = julio 2026**. Hoy es **agosto de 2026**;
las credenciales llegaron, pero el smoke test aún no se ha ejecutado. **Sabre-search ya va tarde y todavía no ha
empezado.** Cualquier plan que no parta de ahí es un plan de ficción.

### 1.5 El carril SOAP/LLS queda **fuera de alcance** — decisión, no silencio

El carril stateful SOAP/LLS son **243 de los 1.077 requests de la colección (22,6 %)**
(`00-fuentes.md` §1). **Ninguna fase de este plan lo construye**, y eso es deliberado: es la aplicación
de **D2(A)** de [10 §9](./10-requisitos-maestro.md) —_"`providers/sabre` v1 sólo REST + ATK stateless"_, la
decisión con más ahorro del expediente— y de N1 de [10 §2.2](./10-requisitos-maestro.md), que la deja
explícitamente **fuera de Ola 1, con hito propio y estimación propia**.

**Por qué se puede.** No es una omisión por coste: es que **ningún endpoint de nuestro alcance exige sesión**.
**VERIFICADO-SPEC en ocho páginas oficiales distintas** — create, get, cancel, modify, fulfill, void y refund de
Booking Management, más Flight Reshop — que dicen que el API _"is designed to operate in a stateless way, and
accepts both sessionless (ATK) and session-based (ATH) tokens"_, y que con ATH _"the session (AAA) is cleared
before and after execution"_. Get Seats agrega que _"supports ATK and ATH session tokens"_. El inventario de las
ocho citas, línea por línea, está en [08 §8.3](./08-seams-integracion-repo.md); el desmontaje del argumento
contrario —que las 201 requests SOAP de `ModifyBooking` "exigen ATH"— está en
[05 §6](./05-get-modify-cancel-booking.md), que demuestra con la secuencia completa de los flujos que el par
`SessionCreateRQ`/`SessionCloseRQ` **envuelve el montaje del escenario de laboratorio, no la modificación**.
A eso se suma que `createBooking` ya orquesta `ContextChangeLLSRQ`, `OTA_AirBookLLSRQ`, `PassengerDetailsRQ` y
`EnhancedEndTransactionRQ` **por dentro**, sin que nosotros abramos nada.

**Qué se pierde exactamente.** No es gratis, y la lista es corta y concreta
([01 §6.2](./01-autenticacion-y-conectividad.md), [10 §2.2](./10-requisitos-maestro.md) N1):

| Capacidad que NO entrega un adapter sólo-REST                      | Por qué                                                                                                |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| **Ancillaries de LCC**                                             | No hay alternativa REST: el flujo WF-20 tiene `auth=0` y su único origen de token es `SessionCreateRQ` |
| **Perfiles (EPS)** — `Sabre_OTA_ProfileCreateRQ`                   | No hay alternativa REST: la orquestación REST sólo hace `ProfileToPNR`/`ProfileRead`                   |
| **Group bookings** (alta/baja/actualización de pasajeros de grupo) | No hay alternativa REST: `PassengerDetailsRQ` + `OTA_AirBookLLSRQ` + `EnhancedEndTransactionRQ`        |
| **Disponibilidad legacy y PNR nativo** (`OTA_AirAvailLLSRQ`)       | Mundo LLS; no lo necesitamos para vender por BFM + Booking Management                                  |

Lo que **no** se pierde: el re-shop de hotel (`RateKey` → `BookingKey`) tiene camino REST — el propio contrato
dice _"Use one of the CSL shopping APIs, **REST or SOAP**, followed by the Hotel Price Check API, REST or SOAP"_
([05 §6.3](./05-get-modify-cancel-booking.md)), y así es como tendría que hacerlo la Fase 5 (§8.5) si alguna vez
pasa sus tres gates.

**Bajo qué condición se reabre.** Sólo si entra al roadmap, **por una razón de negocio explícita y escrita**, una
de estas tres: **vender LCC con ancillaries**, **perfiles EPS** o **group bookings** (D2 de
[10 §9](./10-requisitos-maestro.md)). Si eso pasa, **no es una tarea dentro de una fase existente: es un hito
nuevo, con estimación propia**, que entra **después** de la Fase 2.b y **nunca antes de la compuerta §5**. Su
diseño ya está escrito y no hay que inventarlo — [08 §8.4](./08-seams-integracion-repo.md) fija dónde vive cada
pieza (`SabreSessionPort` y sobre SOAP en `providers/sabre/`, la implementación con estado y
`OnApplicationShutdown` en `apps/api/src/providers-sabre/`), y advierte de lo caro: **un pool ATH no es un caché
de tokens** (una sesión no se comparte entre lectores concurrentes: hace falta _lease_ exclusivo), su clave es el
`provider_account.id` **y nunca el `tenant_id`**, RLS no lo protege porque vive en memoria del proceso, y **se
rompe con la segunda réplica** si no hay estado compartido. **Este plan no estima ese hito**, por la misma regla
de §2.2 que deja las Fases 3-5 sin rango.

> **Lo único que sí se hace desde ya:** la bóveda de credenciales modela **las dos formas** —OAuth
> `client_id`/`client_secret` para REST y usuario/password/PCC para SOAP— porque cambiar el esquema de
> `provider_accounts.credentials_enc` después es caro (D2 y [10 §5.1](./10-requisitos-maestro.md)). Ya está en el
> plan: `config.ts` en la Fase 1 (§6.1) y el formulario `epr`/`password`/`homePcc`/`ticketingPcc` de la Fase 2.b
> (§7). **Modelar el campo no es construir el carril.**

---

## 2. Cómo leer las estimaciones: esfuerzo ≠ calendario

### 2.1 Supuesto de dotación (publicado, porque sin él los d-p no significan nada)

| Supuesto                       | Valor                                                                               | Origen                                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Perfil                         | **1 backend senior con TypeScript/NestJS y experiencia previa en ACL de proveedor** | Es quien puede escribir un mapper de 26 secciones raíz sin supervisión                                     |
| Dotación asumida en las cifras | **1 persona a tiempo completo**                                                     | `docs/discovery/08-organizacion-equipo.md`: el equipo está por contratar                                   |
| Días útiles de foco por semana | **4**                                                                               | El quinto se va en revisión, soporte y contexto. Asumir 5 es cómo se producen los planes que no se cumplen |
| Paralelizable                  | **Sólo Fase 2.a ‖ Fase 0**                                                          | El resto es una cadena: los mappers dependen de las capturas y el registro depende del paquete             |

**Regla de conversión usada en todas las tablas: 1 semana de calendario = 4 días-persona**, con una persona.

### 2.2 Qué tan buenas son estas estimaciones

Bajo de categoría la afirmación anterior. La primera versión decía _"la única estimación defendible hoy es la de la
Fase 2"_. **No es defendible; es acotada**, y sólo lo es porque su alcance es código que ya podemos leer.

- **[08](./08-seams-integracion-repo.md) no contiene ninguna estimación.** Se citaba como fuente del número y no lo
  es: es el inventario de acoplamiento con archivo:línea. El número sale del recuento de archivos de §3.
- **Corrección al crítico sobre la infraestructura de test.** El crítico afirmó que "no hay configuración de vitest
  en todo el repo" y que la Fase 2 corre _"sobre infraestructura de test que hoy no existe"_. **Lo primero es
  cierto, lo segundo no.** Verificado @`c39ac93`: no existe ningún `vitest.config.*`, pero sí existen **29 archivos
  `*.test.ts`** y `apps/api/package.json:11` declara `"test": "vitest run"`. Es decir: **el arnés existe y los tests
  corren con los defaults de Vitest; lo que no existe es la compuerta de cobertura.** La consecuencia práctica es
  más pequeña de lo que decía el crítico (medio día, no una infraestructura nueva) pero el hallazgo se acepta:
  `vitest.config.ts` con `coverage.thresholds` es **un entregable nuevo**, no un ajuste de configuración, y se
  contabiliza como tal.
- **Lo que sí es cierto y era el punto de fondo:** `apps/api/src/search/` tiene **0 archivos de test** (verificado:
  el directorio contiene 7 `.ts`, ninguno `.test.ts`) y `search.service.ts` son 139 líneas que generan todos los
  ingresos. Ese es el argumento de RNF-14 y sigue en pie.
- **Rango honesto:** ±40 % en las fases 0, 1, 2.a y 2.b; **sin rango, es decir sin estimación, en las Fases 3, 4 y
  5**, porque dependen de decisiones (D1, D9) y de respuestas (P-01 a P-06) que hoy no existen. Los números que
  aparecen ahí son **órdenes de magnitud para dimensionar la decisión de invertir**, no compromisos.

### 2.3 Mapa de fases: esfuerzo, calendario, bloqueo

| Fase            | Entrega                                                                                | Esfuerzo           | Calendario (1 pers.)                    | ¿Bloqueada?                                   | Ola                   |
| --------------- | -------------------------------------------------------------------------------------- | ------------------ | --------------------------------------- | --------------------------------------------- | --------------------- |
| **2.a**         | Fan-out genérico multi-proveedor + red de seguridad. **Cero menciones a Sabre**        | 8 d-p              | 2 sem                                   | 🟢 **No. Empieza hoy**                        | Ola 1                 |
| **0**           | Spike de decisión contra CERT: entitlements, valor esperado, FOP sin tarjeta, capturas | 4-5 d-p            | 1,5 sem                                 | 🟠 **Inyección segura de P-05 + D1 decidida** | Ola 1                 |
| **⛔ GO/NO-GO** | Compuerta comercial                                                                    | 0 d-p              | **2-6 semanas de calendario comercial** | 🔴 P-01, P-02, P-04                           | Ola 1                 |
| **1**           | `providers/sabre/`: auth + shop + mapper a `Offer`                                     | 8-10 d-p           | 2,5 sem                                 | 🟠 Parcial: builders no, mappers sí           | Ola 1                 |
| **2.b**         | Registro de Sabre en la plataforma (factory, filtro, UI)                               | 3-4 d-p            | 1 sem                                   | 🔴 Contrato firmado + Fase 1                  | Ola 1                 |
| **3**           | price + createBooking + getBooking + cancelBooking                                     | 12-15 d-p          | 3,5 sem                                 | 🔴 Fase 0 + 2.b + **D1** + **D9**             | **Ola 2 (propuesta)** |
| **4.a**         | fulfill + checkFlightTickets + void                                                    | 9-11 d-p           | 2,5 sem                                 | 🔴 Fase 3 + **Fase C avanzada**               | **Ola 2 (propuesta)** |
| **4.b**         | refund + **modifyBooking** + asientos + ancillaries                                    | 6-7 d-p            | 2 sem                                   | 🔴 Fase 4.a + P-12                            | **Ola 2 (propuesta)** |
| **5**           | Hoteles Sabre                                                                          | **Sin estimar**    | —                                       | 🔴 3 gates de negocio                         | Condicional           |
| **C**           | **Certificación Sabre y alta productiva**                                              | 2-3 d-p de soporte | **4-8 semanas** ⚠️                      | 🔴 Contrato firmado                           | **Corre en paralelo** |

**Totales.** Alcance Ola 1 = **23-27 d-p**. Alcance completo hasta post-venta = **50-62 d-p**.
**Ninguno de los dos es una fecha**: entre la Fase 0 y la primera venta facturable hay dos esperas que no consumen
d-p y sí consumen meses — la compuerta comercial y la certificación.

**Y ninguno de los dos es el coste.** Los días-persona son **sólo la mano de obra**; el dinero que se le paga a
Sabre no está en esta tabla y **hoy no se conoce ni una sola cifra suya**:

| Concepto                                  | Estado                                                                                                                                                                                                                                                                                | Dónde se resuelve                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Setup / alta**                          | **DESCONOCIDO.** [09 §6](./09-referencia-externa-y-gaps.md) lo dice sin rodeos: _"Setup y fee por transacción **no públicos**"_. No hay rango publicado que citar, y **inventar uno sería peor que dejarlo vacío**                                                                    | **P-01**, entrada obligatoria de la compuerta §5.1                   |
| **Fee por transacción / por búsqueda**    | **DESCONOCIDO**, y es el que puede invalidar el modelo: **BFM está marcado `premium` en el propio catálogo de Sabre** (VERIFICADO-SPEC, `_productDetails.json`, [09 §1.1.1](./09-referencia-externa-y-gaps.md)) y la búsqueda es nuestro endpoint de mayor volumen y menor conversión | **P-01** + `callPolicy` desde la Fase 2.a (§3.2)                     |
| **Coste por agencia del _branch access_** | **DESCONOCIDO**: la relación se configura del lado de Sabre, **una gestión por agencia**, y no sabemos si tiene precio ([09 §5.3](./09-referencia-externa-y-gaps.md))                                                                                                                 | Correo al account manager, antes de prometer red self-service (§9.4) |

**Regla de lectura:** «23-27 d-p» no es «lo que cuesta Sabre». Es lo que cuesta **nuestra** parte. La otra mitad de
la factura es exactamente lo que la compuerta §5 existe para poner sobre la mesa **antes** de gastar los d-p.

```
Semana:  1    2    3    4    5    6    7    8    9   10   11   12   ...

Fase 2.a ████████                                          (incondicional, empieza ya)
Fase 0        ░░░░░░              (░ = pendiente de inyección segura de P-05 y decisión D1)
GO/NO-GO           ▒▒▒▒▒▒▒▒▒▒     (▒ = calendario comercial, 0 d-p)
Fase 1                       ██████████
Fase 2.b                               ████
Fase C        ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  (▓ = 4-8 sem de calendario, arranca al firmar)
─────────────────────── fin del alcance de Ola 1 ───────────────────────
Fase 3                                          ██████████████
Fase 4.a                                                      ██████████
Fase 4.b                                                                ████████
```

---

## 3. Fase 2.a — Fan-out genérico multi-proveedor (🟢 **incondicional**)

**Objetivo.** Que `apps/api/src/search/` deje de asumir un solo proveedor, **antes** de que exista un segundo, sea
cual sea ese segundo. Inventario completo con archivo:línea en [08](./08-seams-integracion-repo.md).

> **Regla de esta fase, y es la que la hace incondicional: no aparece la palabra "Sabre" en ningún archivo que
> entregue.** El segundo proveedor de los tests es un **stub anónimo in-repo**. Si Sabre no se firma nunca, esta
> fase conserva el 100 % de su valor: sirve igual para Amadeus, para Travelport o para el tercer bedbank.

**Esfuerzo: 8 días-persona. Calendario: 2 semanas. Sin dependencias externas.**

### 3.1 PR-1 — Red de seguridad (3 d-p)

`apps/api/src/search/` tiene **cero tests** y es el código que genera todos los ingresos. Refactorizar sin red
convierte cualquier regresión en un incidente que descubre un vendedor delante de un cliente (R-23).

```
apps/api/src/search/provider-fanout.test.ts     # 2 OK; 1 OK + 1 falla; ambos fallan; paralelismo real
apps/api/src/search/circuit-breaker.test.ts     # 5 fallos → abierto; half-open a 30 s (reloj falso);
                                                #   PROVIDERS_DISABLED=<code> no afecta a los demás
apps/api/src/search/memory-cache.test.ts        # TTL; invalidatePattern con '*'; eviction a 5.000;
                                                #   escapeRe con claves que llevan '.' y '+'
apps/api/src/search/search.service.test.ts      # comportamiento ACTUAL, antes de tocar nada
vitest.config.ts                                # NUEVO: coverage.thresholds (>70 % domain/, >50 % global)
```

**Criterios de salida de PR-1**

- [ ] Los cuatro archivos de test existen y pasan **contra el código de hoy, sin modificarlo**. Un test que exija
      cambiar el código para pasar no es red de seguridad: es el refactor disfrazado.
- [ ] `vitest.config.ts` existe con `coverage.thresholds` y **CI falla** si bajan. Hoy los umbrales que
      `CLAUDE.md` exige no se aplican en ninguna parte.

### 3.2 PR-2 — Registry y contrato del endpoint (3 d-p)

```
apps/api/src/providers/provider.types.ts             # FlightProviderAdapter, ProviderCapabilities,
                                                     #   TenantProviderFactory, ResolvedProvider, CallPolicy
apps/api/src/providers/flight-provider.registry.ts   # forTenant / byCode / codesForTenant, orden estable
apps/api/src/providers/providers.module.ts
apps/api/src/providers/flight-provider.registry.test.ts
apps/api/src/providers/adapter-cache-isolation.test.ts
apps/api/src/providers/__fixtures__/stub-provider.factory.ts   # segundo proveedor ANÓNIMO, sólo test
```

**Modificados** (verificados @`c39ac93`):

```
apps/api/src/search/search.service.ts        # registry en vez del factory concreto (:70);
                                             #   priceOffer enruta por provider.name (:114);
                                             #   error tipado en el apagón total (:89)
apps/api/src/search/search.controller.ts     # respuesta { offers, simulated, providers[] }
apps/api/src/search/search.module.ts         # imports: [ProvidersModule, PricingModule]
apps/api/src/providers-latam/latam-ndc.factory.ts  # implements TenantProviderFactory; devolver el tipo del
                                                   #   port; exponer code/vertical/capabilities/credentialSource
apps/api/src/orders/orders.service.ts        # registry.byCode (:138); provider del INSERT desde
                                             #   dto.offer.provider.name (:162, hoy 'latam-ndc' literal)
apps/api/src/orders/orders.controller.ts     # assertSupportsLatamOps (:141) → capabilities (RF-19)
```

**`callPolicy` — control de coste desde el día 1.** El registry declara por proveedor
`callPolicy: 'always' | 'fallback' | 'opt-in'` (llamar siempre / sólo si el primario devuelve menos de N ofertas /
sólo si el tenant lo activa), gobernado por feature flag por tenant. **Se construye ahora aunque hoy sólo haya un
proveedor**, porque el fee por búsqueda es desconocido (P-01) y la propia investigación lo señala como
potencialmente inviabilizante en el endpoint de más volumen. El día que se conozca el fee, el coste tiene que ser
gobernable **sin volver a tocar el fan-out**. Cuesta medio día ahora; cuesta una semana después.

### 3.3 PR-3 — Datos, cuota y UI (2 d-p)

```
db/migrations/00XX_multi_flight_provider.sql   # orders.provider DROP DEFAULT; search_logs.search_group_id;
                                               #   count_recent_searches por grupo; provider_catalog;
                                               #   package_items.provider_item_id VARCHAR(200) → TEXT  [D8]
packages/canonical/src/offer.ts                # ProviderRefSchema.raw + source (aditivos)
packages/canonical/src/segment.ts              # operatingFlightNumber (aditivo)
packages/domain/src/ports/order-create.port.ts # Passenger.providerPaxId (aditivo) + OrderCreateOutcome
apps/api/src/packages/packages.schemas.ts      # :21 providerItemId .max(200) → .max(2000)  [D8]
apps/web-b2b/src/app/(app)/red/page.tsx        # MATAR el fallback PROVIDERS[code] ?? LATAM_NDC (:607)
apps/web-b2b/src/app/(app)/cotizaciones/actions.ts  # SearchResult con providers[]
apps/web-b2b/src/app/(app)/cotizaciones/page.tsx    # banner global → badge por oferta + aviso de degradación
```

Las seis citas archivo:línea de este bloque están **verificadas @`c39ac93`**: `search.service.ts:89/:114`,
`orders.service.ts:138/:162`, `orders.controller.ts:141`, `red/page.tsx:607`,
`0010_sprint1_core_suite.sql:99` (`provider_item_id VARCHAR(200) NOT NULL`), `packages.schemas.ts:21`,
`reports.service.ts:48-53` (el mapa `verticalMap` hardcodeado).

**Ninguno de estos archivos nombra a Sabre.** `provider_catalog` es una tabla de catálogo de plataforma;
`red/page.tsx` deja de tener fallback silencioso y **lanza error explícito** ante un `providerCode` desconocido —
que es lo correcto con Amadeus, con Travelport o con quien sea.

### 3.4 Criterios de salida de la Fase 2.a (verificables y **no contradictorios**)

- [ ] **Bug R-07 cerrado:** test que verifica que una oferta con `provider.name === '<stub>'` invoca al adapter del
      stub en `priceOffer` y en `createOrder`. Hoy va siempre a LATAM (`search.service.ts:114`,
      `orders.service.ts:138`).
- [ ] **Degradación parcial visible:** test — el stub falla, la respuesta trae ofertas de LATAM **y**
      `providers[<stub>].status === 'error'` con razón humanizada. Hoy el array `failed` de `fanOut` se descarta.
- [ ] **Apagón total → 502**, no 500 genérico. Hoy `search.service.ts:89` lanza un `Error` pelado.
- [ ] **Cuota:** test de integración — N búsquedas × 2 proveedores devuelven **N** en `count_recent_searches`, no
      2N. Las filas anteriores a la columna siguen contando 1 (**PR-3**).
- [ ] **Cache:** mismo tenant, dos sets de proveedores → claves distintas. Resultado con `failed[]` no cacheado.
      Resultado con `simulated` no cacheado.
- [ ] **Aislamiento:** `adapter-cache-isolation.test.ts` — el adapter del tenant A no se devuelve al tenant B;
      `evictStale` descarta al rotar credenciales (R-12).
- [ ] **`assertSupportsLatamOps` ya no existe** (`grep -r assertSupportsLatamOps apps/` vacío).
- [ ] **`callPolicy` respetado:** test — un proveedor con `callPolicy: 'opt-in'` y el flag apagado **no recibe
      ninguna llamada**, y aparece en `providers[]` con `status: 'skipped'`, no como error.
- [ ] **Regresión cero de CONTENIDO** — _criterio reformulado, el anterior era autocontradictorio._
      La versión anterior exigía que _"el comportamiento observable del endpoint fuera idéntico al de hoy"_ en un
      refactor cuyo objetivo declarado es **cambiar el contrato de ese endpoint** (`search.controller.ts` con nuevo
      tipo de respuesta, 502 en vez de 500, `simulated` con semántica nueva). Es imposible de cumplir y por tanto no
      es un criterio. Se sustituye por tres verificables: - (a) **Contenido idéntico:** para el mismo criterio y un solo proveedor activo, `offers[]` y todos los
      totales son byte-a-byte los de hoy. Test de snapshot. - (b) **El sobre crece de forma aditiva:** `{offers, simulated}` sigue presente con la misma forma;
      `providers[]` se **añade**. Test de contrato que fija el sobre. - (c) **`simulated` mantiene la semántica vieja durante una release** (`true` = todo el resultado es falso) y
      la nueva (`true` = hay al menos una tarifa falsa) viaja en `providers[].simulated` por proveedor.
      `apps/web-b2b` lo lee hoy: cambiarle el significado bajo los pies es exactamente el tipo de regresión
      silenciosa que esta fase existe para evitar. La retirada del campo viejo se agenda, no se improvisa.

### 3.5 Dependencias

**Ninguna.** Ni externa ni interna. Ésta es la única fase del documento de la que eso es cierto, y lo es **porque**
se le quitó `providers-sabre/*` (que no compila sin el paquete de la Fase 1) y el formulario de Sabre de la UI.

---

## 4. Fase 0 — Spike de decisión contra CERT

**Objetivo.** No es "capturar fixtures". Es **producir el dato que permite decidir si se invierte**, y de paso dejar
las capturas. Si la Fase 0 sólo produce ficheros JSON y no produce una recomendación de Go/No-Go, ha fallado.

**Esfuerzo: 4-5 días-persona. Calendario: 1,5 semanas.**

### 4.1 Dependencias — **corregidas**

La versión anterior decía _"P-01 (credenciales). Nada más."_ **Es falso**, y lo desmentían sus propios pasos: no se
puede capturar un `createBooking` ni un `fulfillFlightTickets` sin haber decidido antes **con qué forma de pago se
reserva y se emite**.

| Dependencia                                                     | Por qué                                                                                                                           |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **P-05** — credenciales EPR + PCC + password de CERT            | **Resuelta:** están disponibles fuera de Git. Pendiente: cargarlas mediante `ProviderCredentialsService` y ejecutar el smoke test |
| **D1** — ¿nunca PAN? (decisión del founder, se puede tomar hoy) | Los pasos 3 y 4 construyen bodies de reserva y de emisión. Sin D1 no se sabe qué `formsOfPayment` se manda                        |
| **P-07** — la pregunta que materializa D1                       | Idem                                                                                                                              |

### 4.2 Secuencia — **reordenada**

El orden anterior dejaba la pregunta más cara para el final. El nuevo orden ejecuta primero lo que puede **matar el
proyecto barato**.

1. **Smoke test de entitlements** (medio día). Un request por familia de API contra
   `https://api.cert.platform.sabre.com`. Un `403 ERR.2SG.SEC.NOT_AUTHORIZED` revela al instante qué no tenemos.
   **Puede recortar el alcance de [10 §2.1](./10-requisitos-maestro.md) antes de escribir una línea.** Responde
   **P-06**. Incluye el par de `curl` que decide la versión de `getseats` y `getAncillaries` (R-26): la colección
   usa v1/v2 y el catálogo publica v3 de ambos; nacer en la versión vieja es deuda garantizada el día 1.
2. **Medición de valor esperado** (medio día). **20-30 búsquedas reales BOG/LIM/GRU** y cálculo del aporte
   incremental de Sabre sobre LATAM NDC directo, según la métrica única de
   [10 §2.3](./10-requisitos-maestro.md). **Es la entrada principal de la compuerta Go/No-Go** y responde **P-04**.
   Cada búsqueda se emite con `MultipleSourcePerItinerary.Value = true` y se repite una vez **sin** el atributo,
   para medir cuántas tarifas nos estaba ocultando el default (_"By default, the cheaper will stay"_,
   VERIFICADO-SPEC `bargain-finder-max-v5.yml:5473-5478`, idéntico en `v4:3195-3200`) — es decir, cuánto contenido
   alternativo cross-source desaparece. La cobertura de marcas y upsells se mide por separado con
   `MultipleBrandedFares`, `MaxNumberOfUpsells` y `UpsellLimit` (R-09).
3. **Reserva y emisión con forma de pago SIN TARJETA** (1 día). **Éste es el experimento que subió de posición.**
   `createBooking` + `fulfillFlightTickets` con `CASH` / `ON_ACCOUNT` / `INVOICE`, primero en **ATPCO** (donde la
   colección ya lo tiene verificado end-to-end) y después en **NDC** (donde no existe ni un solo ejemplo sin
   tarjeta — ver la refutación de [10 §8 P-03](./10-requisitos-maestro.md)). **Cierra D1, P-03 y P-07 antes de
   comprometer los 27-33 d-p de las Fases 3 y 4.** Si NDC no emite sin PAN, R-03 se queda en 🔴 y eso cambia la
   decisión de invertir, no el diseño de un builder.
4. **Captura de shop** — 6 payloads sobre `/v5/offers/shop`: ATPCO ida, ATPCO ida-y-vuelta, **NDC ida-y-vuelta**,
   multi-pax ADT+CNN, con `CabinPref`, y uno con `NDC:Enable` + `ATPCO:Enable` a la vez.
   **La pregunta de este paso cambió** (ver §4.4): ya no es "¿cuántas llamadas cuesta Sabre?" — el contrato dice que
   BFM consulta ATPCO + NDC en la misma llamada — sino **"¿qué nos devuelve realmente y qué nos oculta el dedupe
   por precio?"**.
5. **Ciclo completo de una reserva NDC**: shop → price → createBooking → getBooking → cancelBooking, con los cinco
   bodies íntegros.
6. **Capturas negativas — las que más se olvidan.** Un `200 con errors[]` poblado (forzar campo requerido ausente);
   un `200 con messages[].severity === 'Error'` en BFM; un `401` de token expirado; un `403` de entitlement; una
   oferta expirada en price; y un **`200` con `category: UNAUTHORIZED` dentro** (entitlement parcial: el vendedor ve
   datos faltantes como si fueran datos vacíos). Son la única defensa real contra **R-04**.
7. **Medición de latencia y token.** p50/p95 de `50ITINS` vs `200ITINS` en BOG→LIM y BOG→GRU; y el `expires_in`
   real del token (**P-08**). Alimenta RNF-01, que hoy se sostiene en el **presupuesto declarado por contrato**
   (15 s de reintento ATPCO + 10 s de `asynchronousUpdateWaitTime`, `booking-management-v1.yml:714-722`) y no en las
   cifras de 2021 que la primera pasada trataba como hechos.

### 4.3 Entregables

```
providers/sabre/src/fixtures/
├── README.md                        # qué credencial, qué fecha, qué PCC, qué se pidió, qué versión
├── auth/token-200.json
├── shop/v5-atpco-oneway-200.json
├── shop/v5-atpco-roundtrip-200.json
├── shop/v5-ndc-roundtrip-200.json          # ← el único que NO tiene equivalente oficial (§6.2)
├── shop/v5-multipax-adt-cnn-200.json
├── shop/v5-multisource-200.json
├── shop/v5-multisource-sin-flag-200.json   # el diff que mide lo que el default nos oculta
├── price/ndc-200.json
├── booking/{create-ndc,get-ndc,get-atpco-ticketed,cancel}-200.json
├── ticketing/{fulfill-atpco-cash,fulfill-ndc-cash-o-error,check,void}-200.json
└── errors/{200-with-errors,200-bfm-severity-error,200-unauthorized-parcial,401-token,403-entitlement,offer-expired}.json
```

Más **`docs/sabre/12-hallazgos-sandbox.md`**, que es el entregable que decide, no los JSON.

### 4.4 Lo que ya NO es la pregunta de la Fase 0 — corrección de fondo

La versión anterior decía que el payload con doble `Enable` respondía _"la pregunta que decide si Sabre cuesta 1 o 2
llamadas por búsqueda"_. **Esa pregunta está cerrada por contrato y la respuesta es: una sola llamada.**
`DataSources` no es un switch de un bit; son tres propiedades independientes sin `oneOf`/`anyOf`
([02 §3](./02-air-shop-bfm.md), reconciliado contra `bargain-finder-max-v5.yml`), y BFM consulta ATPCO + NDC + LCC
en la misma llamada. Que en los 88 requests de la colección nunca aparezcan dos fuentes juntas es un artefacto de
cómo están escritos los workflows de certificación, no un límite del API.

**La pregunta que la sustituye es de negocio:** con `MultipleSourcePerItinerary` en su default, **Sabre conserva la
más barata del solapamiento ATPCO/NDC y puede descartar la alternativa cross-source antes de que la veamos**. Eso
puede ocultar una opción de más margen, pero no demuestra por sí solo que desaparezca una tarifa con equipaje: las
marcas y upsells tienen controles propios. La Fase 0 mide ambos efectos por separado y de ahí sale la decisión que
[10 RF-06](./10-requisitos-maestro.md) deja planteada: ¿aceptamos el dedupe de Sabre, o pedimos "todo" y
deduplicamos nosotros con nuestra preferencia declarada por LATAM NDC directo?

### 4.5 Criterios de salida

- [ ] `12-hallazgos-sandbox.md` **contiene una recomendación de Go / No-Go con su número**, no sólo datos.
- [ ] **P-04 respondida con una cifra**: % de búsquedas en las que Sabre aporta una oferta inexistente en LATAM NDC
      directo o el mismo vuelo a mejor precio neto. Comparada contra el umbral **preacordado antes de medir**.
- [ ] **D1 cerrada:** existe un `fulfillFlightTickets` ATPCO exitoso sin PAN, y una respuesta —de Sabre o del
      account manager— sobre si NDC lo admite.
- [ ] Existen ≥ 20 fixtures reales versionados. **Criterio de redacción reformulado:** _"ninguna captura usa un PAN
      real, ni siquiera de prueba"_ — la formulación anterior ("todos con datos de tarjeta redactados") admitía
      implícitamente que se iban a enviar tarjetas, contra RNF-06. La PII de pasajero sí se redacta antes del
      commit, porque `getBooking` **hace eco de la request entera**.
- [ ] `P-06` respondida: el alcance de [10 §2.1](./10-requisitos-maestro.md) está confirmado o recortado, y las
      versiones de `getseats` y `getAncillaries` están elegidas contra lo que el PCC realmente sirve.
- [ ] RNF-01 tiene números medidos junto al presupuesto de contrato, y queda explícito cuál es cuál.

---

## 5. ⛔ Compuerta comercial Go/No-Go

**Esto no es una fase de ingeniería. Es la decisión de invertir, y es el hallazgo más grave que tenía este plan:
comprometía ~50 días-persona sin haber confirmado el fee por transacción ni si Sabre permite operar PCC de
terceros — que es literalmente lo que decide si nuestro BYOC es viable.**

**Esfuerzo: 0 d-p. Calendario: 2-6 semanas de gestión comercial, en paralelo con la Fase 2.a.**

### 5.1 Entradas obligatorias (las cuatro, por escrito)

| Entrada                   | Pregunta                                                                                                                                                               | Vía                                  | Sin ella                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| **Fee por transacción**   | **P-01**. ¿Se tarifa por búsqueda, por `RequestType` o por reserva? BFM está marcado `premium` en el catálogo de Sabre                                                 | Account manager, **por escrito**     | Un fee por búsqueda mal negociado hace inviable el modelo entero: alto volumen, baja conversión                 |
| **Multi-PCC de terceros** | **P-02**. ¿Puede un consolidador operar PCC de terceros bajo un contrato técnico? ¿Quién pide el _branch access_, cuánto tarda, cuánto cuesta por agencia, hay límite? | Account manager, **por escrito**     | **Si la respuesta es no, nuestro BYOC con Sabre no existe.** No es un detalle de implementación: es el producto |
| **Aporte incremental**    | **P-04**. La cifra de la Fase 0 §4.2 paso 2                                                                                                                            | Medición propia                      | Sin ella la inversión es una preferencia, no una decisión                                                       |
| **Emisión sin PAN**       | **P-03**. ¿La aerolínea NDC liquida por BSP una emisión con `CASH`/`ON_ACCOUNT`?                                                                                       | Account manager + Fase 0 §4.2 paso 3 | Determina si D1(A) es implementable o si hay que cambiar de estrategia de cobro                                 |

### 5.2 Regla de decisión — **acordada antes de medir, no después**

| Resultado                                               | Decisión                                                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Aporte incremental **< 15 %**                           | **NO-GO.** No se abre la Fase 1. El esfuerzo se reinvierte en los compromisos abiertos de Ola 1                      |
| Fee por búsqueda que no cabe en el margen del waterfall | **NO-GO en `callPolicy: always`.** Sabre entra como `fallback` u `opt-in`, no como fuente permanente                 |
| P-02 negativa (no hay multi-PCC de terceros)            | **NO-GO en BYOC.** Sabre sólo sirve en modelo A (herencia total), lo que cambia D4 y la propuesta de valor de la red |
| Las cuatro favorables                                   | **GO.** Se abre la Fase 1 y **se dispara la Fase C en el mismo día**                                                 |

**Quién decide: el founder.** No el equipo técnico, no el resultado del spike. El spike produce el número; la
decisión de invertir 50 d-p contra un contrato es de negocio.

### 5.3 Y la decisión que está por encima: **D0**

[10 §9 D0](./10-requisitos-maestro.md) recomienda ejecutar primero el spike de **Sabre CERT**, ya habilitado por la
disponibilidad de credenciales, y solicitar en paralelo propuestas Enterprise comparables de Amadeus y Travelport.
Amadeus Self-Service ya no es una opción: fue descontinuado el 17 de julio de 2026.

> La advertencia de honestidad del maestro aplica aquí: la comparación es **asimétrica**. Sabre está investigado a
> fondo (21 contratos, 81 páginas) y Amadeus y Travelport no lo están (**P-24**). Antes de firmar cualquiera hay que
> bajar los specs y las listas de errores del otro con el mismo rigor. La Fase 2.a es exactamente lo que hace que
> esa comparación sea barata: da igual quién sea el segundo proveedor.

---

## 6. Fase 1 — `providers/sabre/`: auth + shop + mapper a `Offer` canónico

**Objetivo.** Un paquete que, dado un `FlightSearchCriteria`, devuelve `Offer[]` canónico válido, con modo mock
funcional y tests. **No toca `apps/api`.**

**Esfuerzo: 8-10 días-persona. Calendario: 2,5 semanas. Condicionada al GO de §5.**

### 6.1 Entregables

```
providers/sabre/
├── package.json                     # espejo de providers/latam-ndc/package.json
├── tsconfig.json
├── spec/manifest.json               # {slug, info.version, sha256} de docs/sabre/evidence/specs/*.yml  [RNF-15]
└── src/
    ├── index.ts
    ├── config.ts                    # SabreConfig + isMockMode(cfg) → [10 §5.1]
    ├── errors.ts                    # SabreApiError(status, body, path) + clasificación ERR.2SG.*
    ├── fixtures.ts                  # buildMockOffers() para modo mock/CI
    ├── auth/token.service.ts        # secret doble-base64 + caché en el port de caché + retry 401 (RF-01)
    ├── http/sabre-http.client.ts    # JSON, Conversation-ID, REDACCIÓN de logs (RNF-07)
    ├── shop/request.builder.ts      # OTA_AirLowFareSearchRQ → POST /v5/offers/shop (RF-03)
    ├── shop/response.mapper.ts      # groupedItineraryResponse → Offer[] (RF-04)
    └── sabre-flight-search.adapter.ts
```

**Cambio de versión respecto de la primera pasada: se construye sobre `/v5`, no sobre `/v4`.** Es la decisión del
maestro (A2): v5 es la única con `POS.MultiSourceControl` —multi-PCC nativo, que es el modelo consolidador—,
penalidades NDC estructuradas y **ejemplos de respuesta oficiales**. El coste de cambio desde un diseño v4 es el
valor de un campo. Y `Version` **debe** coincidir con la URL (VERIFICADO-SPEC `bargain-finder-max-v5.yml:55`).
El campo que justifica la versión es igual de verificable: `POS.MultiSourceControl` existe **sólo en v5**
(`bargain-finder-max-v5.yml:5010-5011`, definición en `:5037`) y **no aparece ni una vez en v4**.

> **Los 21 `.yml` ya NO se copian dentro del paquete — la decisión cambió de hecho.** Cuando se escribió RNF-15 los
> contratos vivían fuera del repo y `providers/sabre/spec/` era el único sitio donde podían quedar pineados. Hoy
> están **congelados dentro del repo** en `docs/sabre/evidence/specs/` (21 `.yml`, `00-fuentes.md` §3), que es
> además la ruta a la que apuntan las ~185 citas `archivo.yml:línea` del expediente. Copiarlos otra vez a
> `providers/sabre/spec/` deja **dos originales de 3,9 MB que divergen en silencio**, que es exactamente el fallo
> contra el que RNF-15 existe (R-25). Lo que entrega la Fase 1, entonces, no es la copia sino lo que RNF-15 pedía
> de verdad: **`spec/manifest.json`** con `{slug, info.version, sha256}` por contrato, y el **test de contrato que
> resuelve los `.yml` desde `docs/sabre/evidence/specs/` y falla si cambia el hash o la `info.version`**.
> **Pendiente de reconciliar en el maestro:** [10 §4 RNF-15](./10-requisitos-maestro.md) sigue diciendo _"los 19
> `.yml` … en `providers/sabre/spec/`"_ — ni el número (son **21**) ni la ruta son ya los correctos.

### 6.2 Qué se puede escribir sin credenciales, y qué no — **la regla de proceso cambió**

La primera pasada tenía una regla dura: _"ningún `response.mapper` se mergea sin su fixture real al lado"_. **Se
retira parcialmente**, porque el contrato oficial la volvió obsoleta para una parte del trabajo. Pero **no se retira
del todo**, y aquí hay un hallazgo nuevo que ni el crítico ni el maestro tienen:

> **VERIFICADO-SPEC (nuevo).** Los **tres ejemplos de respuesta oficiales** de BFM v5
> (`bargain-finder-max-v5.yml:120`, `:667`, `:1456`) son **contenido ATPCO puro**. En las 2.188 líneas que ocupan
> los tres ejemplos **no aparece ni una sola vez** `"offer"`, `timeToLive`, `distributionModel` ni `"source"`.
> Verificable con un `grep` sobre el rango 120-2308 del `.yml`.
>
> Y la razón está en el esquema: `Offer` **sí** declara `timeToLive` como requerido en las tres versiones
> (`v5.yml:8226-8232`, `v4.yml:6060-6067`, `v3.yml:2174-2181`), **pero `offer` es una propiedad OPCIONAL de
> `PricingInformationType`** (`v5.yml:8835-8837`), descrita literalmente como _"NDC Offer related data"_, y
> `PricingInformationType` **no tiene lista `required` en absoluto** (`v5.yml:8794`).

**Las tres consecuencias, y son las que ordenan esta fase:**

1. **Esto resuelve el hallazgo 7 de la crítica, pero no como el crítico creía.** El crítico decía que `timeToLive`
   sólo existía en v5 y que construir sobre v4 lo dejaba sin cubrir. **Es incorrecto: existe y es requerido en v3,
   v4 y v5.** El problema real es otro y es peor: **existe sólo para NDC**.
2. **Esto corrige [10 RF-04 CA-2](./10-requisitos-maestro.md)**, que afirma _"`timeToLive` es campo obligatorio en
   las tres versiones: siempre viene. Nunca un default inventado."_ **Para las ofertas ATPCO no viene**, porque el
   objeto que lo contiene no viene. `Offer.expiresAt` de una oferta ATPCO **necesita una política nuestra
   declarada** (el TTL de caché de búsqueda, 90 s), etiquetada como tal en el modelo, no como si fuera dato del
   proveedor. Es la diferencia entre "esta oferta vence a las 14:32 según la aerolínea" y "nosotros dejamos de
   fiarnos de esta oferta a las 14:32". En una cotización por WhatsApp, decir lo primero cuando es lo segundo es
   prometer lo que no se puede cumplir (RNF-12, R-17).
3. **Reordena el trabajo:** la rama ATPCO del mapper es escribible **hoy** contra tres fixtures oficiales completos;
   la rama NDC **no tiene ni un ejemplo oficial** y sigue bloqueada por la Fase 0. Es exactamente al revés de lo que
   uno supondría, porque NDC es el contenido diferencial.

### 6.3 Orden de trabajo (importa)

1. `config.ts`, `errors.ts`, `http/sabre-http.client.ts` **con la redacción de logs primero**. RNF-07 se implementa
   **antes de la primera llamada real**, no después: el `secret` es base64 reversible, no un hash, y un log de debug
   filtra el password de la oficina en claro (R-13).
2. `auth/token.service.ts` con su test del algoritmo del `secret` — verificable sin credenciales, porque el
   algoritmo está escrito literalmente en el script pre-request de la colección.
3. `shop/request.builder.ts` con tests de tabla: PTC `CNN` no `CHD`; PCC inyectado desde config;
   `PriceRequestInformation.CurrencyCode` **siempre** presente (`v5.yml:7849` — corrige la afirmación de la primera
   pasada de que BFM no tenía campo de moneda); `MultipleSourcePerItinerary.Value = true` **como constante**;
   `Baggage.RequestType` y `VoluntaryChanges` siempre; índices `RPH` consistentes.
4. `shop/response.mapper.ts` **rama ATPCO**, contra los 3 ejemplos oficiales. Aquí entran las dos trampas con test
   obligatorio de RF-04 CA-4: `baseFare` ≠ `baseFareAmount`, y la fecha del tramo sale de `legDescriptions` **por
   posición**, no por `ref`.
5. `fixtures.ts` + adapter en modo mock. **Aquí la fase ya es verificable end-to-end sin credenciales.**
6. `shop/response.mapper.ts` **rama NDC**, sólo cuando exista `shop/v5-ndc-roundtrip-200.json` de la Fase 0.

### 6.4 Criterios de salida

- [ ] `isMockMode()` devuelve `true` si falta `epr`, `password` u `homePcc`; hay test para las tres.
- [ ] Test del `secret`: dado `{epr:'500001', pcc:'U9PK', password:'x'}`, el header `Authorization` es byte-a-byte
      el del algoritmo verificado. Test de caché: 2 llamadas → 1 HTTP. Test del retry: 401 → re-auth + 1 reintento;
      segundo 401 → `SabreApiError`. **Test de que el reintento NO se aplica** a `createBooking`/`fulfill`/`void`.
- [ ] **Test de redacción:** el cliente HTTP corre contra un mock y el transporte de logs **nunca** recibe
      `Authorization`, `secret`, `password`, `access_token` ni un body de reserva. Falla el build si los recibe.
- [ ] Test regla-dura de éxito: un fixture `200-with-errors.json` produce `SabreApiError`, **no** un resultado
      vacío. Y un `messages[].severity === 'Error'` también (R-04).
- [ ] **Mapper ATPCO:** produce `Offer[]` válido contra `OfferSchema` para los **3 ejemplos oficiales**.
- [ ] **Mapper NDC:** produce `Offer[]` válido para el fixture NDC de la Fase 0, con
      `Offer.expiresAt = fetchedAt + offer.timeToLive` y `Offer.source` poblado desde `offer.source`.
- [ ] **`expiresAt` de ATPCO está etiquetado como política propia**, no como TTL de proveedor. Test: una oferta sin
      `offer` en el payload produce `expiresAt` con `source: 'platform-policy'` y **nunca** un TTL inventado
      presentado como del proveedor.
- [ ] **El mapper no se da por cerrado** hasta tener el fixture de **vuelo nocturno con cambio de día**, que es el
      único caso que los ejemplos oficiales no cubren. Hasta entonces, el paquete se marca `experimental` en su
      `package.json`.
- [ ] `pnpm --filter @sales-travel/sabre test` en verde con cobertura >70 %.
- [ ] **Cero PCC de terceros en el código** — _criterio reformulado, el anterior no era verificable._
      Un PCC son 3-4 alfanuméricos: una regla de lint no puede prohibir "literales de PCC" sin prohibir media
      constante del proyecto. Se sustituye por dos cosas que sí lo son:
      (a) **denylist explícita** de los seis PCC que aparecen en la colección (`U9PK`, `G7RE`, `7KFA`, `G7HE`,
      `N87F`, `GF1I`) más `SBR-BMAPI` y el `ClientSecret` fijo original (saneado en la copia versionada — R-28); y
      (b) **test de serialización**: se construye un body con una config falsa (`homePcc: 'ZZZZ'`) y se verifica
      que en el JSON saliente **no aparece ningún PCC distinto de `ZZZZ`**.
- [x] **Anti-PAN acotado** — _criterio reformulado._ **Cumplido el 2026-08-26**; la regla vive en
      `eslint.config.mjs` acotada exactamente a los dos globs de abajo, y las tres capas están fijadas por tests
      (ver §8.1). [10 RNF-06](./10-requisitos-maestro.md) punto 3 propone una
      regla de lint que prohíbe `cardNumber`/`cardSecurityCode` en todo `providers/sabre/`. **Eso rompería una
      funcionalidad legítima**: `getBooking` devuelve la tarjeta **enmascarada** (N7) y mostrar los últimos 4
      dígitos al vendedor exige nombrar el campo en el mapper de lectura. La regla se acota a
      **`**/request.builder.ts`y`**/\*.serializer.ts`** — los archivos que construyen lo que sale. La defensa real
      es la otra: **el test de CI sobre bodies salientes**, más el tipo `SabreFormOfPayment` sin esos campos, que
      convierte el error en uno de compilación.

### 6.5 Dependencias

Fase 0 para la rama NDC del mapper y para todos los fixtures. `packages/canonical` con `ProviderRefSchema.raw`,
`Offer.source` y `SegmentSchema.operatingFlightNumber` — cambios **aditivos** que van en la Fase 2.a PR-3.

---

## 7. Fase 2.b — Registro de Sabre en la plataforma (condicionada a contrato)

> **Estado al 2026-08-26 — 🟡 CÓDIGO COMPLETO, SIN VERIFICAR CONTRA CERT.**
>
> Los entregables de esta fase existen en el repo: `apps/api/src/providers-sabre/` (`sabre.factory.ts`,
> `sabre-errors.ts`, `sabre-exception.filter.ts`, `sabre.module.ts` y sus tests) y
> `apps/api/src/search/offer-dedupe.ts` con su test. La suite del paquete proveedor está en verde
> (**2.189 tests, 58 ficheros**).
>
> **Lo que este estado NO dice.** No dice que la fase esté cerrada. Sus criterios de salida se verifican sobre la
> plataforma en marcha y **ninguno se ha ejecutado contra CERT**, porque las credenciales siguen pendientes de
> inyección segura (**P-05**). "Compila y sus tests pasan" no es "funciona contra Sabre", y en este expediente esa
> distinción ya nos costó cinco rondas.

**Esfuerzo: 3-4 días-persona. Calendario: 1 semana. Depende de: Fase 1 completa + Fase 2.a completa + contrato.**

```
apps/api/src/providers-sabre/sabre.factory.ts          # espejo de latam-ndc.factory.ts,
                                                       #   clave byoc:{ownerTenantId}:{homePcc}:{updatedAt}
apps/api/src/providers-sabre/sabre-errors.ts
apps/api/src/providers-sabre/sabre-exception.filter.ts
apps/api/src/providers-sabre/sabre.module.ts
apps/api/src/providers-sabre/sabre.factory.test.ts
apps/web-b2b/src/app/(app)/red/page.tsx                # + SABRE: ProviderForm (epr/password/homePcc/ticketingPcc)
apps/api/src/search/offer-dedupe.ts                    # RF-06: clave de producto + preferencia declarada
apps/api/src/search/offer-dedupe.test.ts
```

> **Entregable que faltaba: el dedupe (RF-06).** Ninguna fase de este plan lo construía, y **es exactamente aquí
> donde hace falta**: el día que Sabre se enciende, el mismo vuelo de LATAM aparece dos veces —directo y vía
> Sabre— en la pantalla del vendedor. No va en la Fase 2.a porque su regla de desempate **nombra a Sabre**
> ([10 RF-06 CA-5](./10-requisitos-maestro.md): preferencia por LATAM NDC directo) y la 2.a tiene prohibido
> mencionarlo; sus dos prerrequisitos canónicos —`Offer.source` y `SegmentSchema.operatingFlightNumber`— sí van en
> la 2.a PR-3 (§3.3), y la pregunta de política —aceptar el dedupe de Sabre o pedir "todo" y deduplicar nosotros—
> la responde la Fase 0 (§4.4). **El rango de 3-4 d-p de esta fase no incluía este entregable.**

**Por qué esto no estaba en la Fase 2.a y por qué el crítico tenía razón.** `sabre.factory.ts` importa
`@sales-travel/sabre`. **Un factory no puede importar un paquete que no existe.** La versión anterior declaraba la
Fase 2 "sin dependencias, empieza hoy mismo" y dos párrafos más abajo admitía que _"Sabre entra como factory que
devuelve el adapter mock de Fase 1"_ — es decir, dependía del ítem 5 de 6 del orden de trabajo de la Fase 1. La
contradicción está resuelta partiendo la fase, no reescribiendo la nota.

**Criterios de salida**

- [ ] Test de resolución BYOC (patrón `hasDb`): cuenta propia gana sobre heredada; se salta un ancestro con
      `is_inheritable=false`; un tenant con LATAM pero **sin** Sabre no resuelve Sabre.
- [ ] **Sabre no tiene fallback a credenciales de plataforma.** Test: sin cuenta y sin
      `PLATFORM_DEFAULT_FLIGHT_PROVIDERS` que lo incluya, el proveedor está **ausente**, no en modo mock
      silencioso (D5).
- [ ] El formulario de la UI **no permite guardar una cuenta Sabre sin `homePcc`** — sin él, el ATK no se puede
      derivar, porque va dentro del propio `secret`.
- [ ] La cuenta creada desde la UI nace en `status: 'sandbox'` y **la pantalla explica** que no habilita nada hasta
      promoverla, en vez de dejar que el operador descubra que su credencial no hace nada
      ([10 §6.1](./10-requisitos-maestro.md)).
- [ ] `callPolicy` de Sabre configurable por tenant y **por defecto en el valor que decidió la compuerta de §5.2**.
- [ ] **Dedupe (RF-06):** test — el mismo vuelo por las dos fuentes colapsa en **una** oferta y gana **LATAM NDC
      directo**; la misma aeronave con y sin maleta siguen siendo **dos** productos; con más de una moneda en el
      conjunto **no se deduplica nada**; y el dedupe corre **antes** de `withPricing`.

---

> ## ─── Fin del alcance defendible de Ola 1 ───
>
> Lo que sigue son **propuestas para Ola 2**, condicionadas al GO de §5 y a que el founder apruebe el cambio de
> alcance de §1.2. Sus estimaciones son órdenes de magnitud, no compromisos.

---

## 8. Fases de venta y post-venta (propuestas para Ola 2)

### 8.1 Fase 3 — price, createBooking, getBooking, cancelBooking

> **Estado al 2026-08-26 — 🟡 CÓDIGO COMPLETO, SIN VERIFICAR CONTRA CERT.**
>
> **Desbloqueada:** sus dos dependencias de decisión, **D1** y **D9**, se cerraron el 2026-08-26
> ([10 §9](./10-requisitos-maestro.md)). D9 se cerró **antes** del primer commit de la fase, que es lo que exigía
> §8.4.
>
> **Construido en el repo:** `providers/sabre/src/price/`, `providers/sabre/src/booking/`
> (`create`/`get`/`cancel`, cada uno con builder y mapper), `airline-requirements.ts`, `indices.ts`, los cuatro
> adapters (`sabre-offer-price`, `sabre-order-create`, `sabre-order-manage`), `order-manage.port.ts` en
> `packages/domain` y la saga de creación sobre BullMQ en `apps/api/src/orders/`. Suite del proveedor en verde:
> **2.189 tests en 58 ficheros**.
>
> **Lo que falta y por qué.** Los dos criterios end-to-end contra CERT —NDC y ATPCO— **no se han ejecutado**:
> dependen de las credenciales (**P-05**). Hasta que corran, esta fase **no está cerrada**, y en particular la
> rama NDC de D1 (emisión sin tarjeta) sigue siendo una suposición, no un hecho — ver **P-03**.

```
providers/sabre/src/
├── price/request.builder.ts + response.mapper.ts           # RF-07
├── booking/create.{request.builder,response.mapper}.ts     # RF-08
├── booking/get.{request.builder,response.mapper}.ts        # RF-09
├── booking/cancel.{request.builder,response.mapper}.ts     # RF-10
├── booking/airline-requirements.ts   # tabla BA/AF/AA/LATAM-PE, NO ifs dispersos
└── indices.ts                        # ÚNICO punto de conversión 0-based → 1-based (RF-08 CA-4)

packages/domain/src/ports/order-manage.port.ts   # retrieveForDisplay / retrieveForModification (RF-09)
apps/api/src/orders/                             # enrutamiento por registry + saga de creación
```

**Lo que el contrato cambió en esta fase respecto de la primera pasada:**

- **`errorHandlingPolicy` SÍ existe en `createBooking`** (VERIFICADO-SPEC `booking-management-v1.yml:698`, array de
  `CreateErrorPolicyEnum` con 8 valores y default `HALT_ON_ERROR`, `:8918-8935`). **El éxito parcial es un modo que
  el cliente elige ANTES de llamar**, no una anomalía a detectar después. Nuestro default es `HALT_ON_ERROR`; cada
  `DO_NOT_HALT_ON_*` se activa por caso de uso y **queda registrado en el `domain_event`** (RNF-08).
- **`asynchronousUpdateWaitTime` explícito**, nunca el default `0` (`:714-722`, máx. 10.000 ms): con el default,
  _la respuesta puede llegar antes de que la reserva esté completa_.
- **`bookingSignature` NO viene en `createBooking`**: toda modificación posterior exige encadenar un `getBooking`.

**Criterios de salida**

- [ ] Reserva NDC end-to-end contra CERT: shop → price → createBooking → getBooking → cancelBooking, con
      `confirmationId` real verificado manualmente en el PNR.
- [ ] Reserva ATPCO end-to-end contra CERT (sin paso de price).
- [x] **Test de CI anti-PAN** sobre los tres bodies serializados, más la regla de lint acotada de §6.4.
      **Cumplido el 2026-08-26** y **ampliado**: `providers/sabre/src/pan-egress.guard.test.ts` mide **cinco**
      cuerpos, no tres —`offers/price`, `createBooking`, `cancelBooking` y los **dos** de `getBooking`—, porque
      dejar fuera los de lectura habría dejado sin vigilar `unmaskPaymentCardNumbers`, que es precisamente el
      campo que desenmascara el PAN guardado. Detalles de la implementación que importan:

      - Entra por la **puerta pública** (`SabreHttpClient.postJson`, `fetch` espiado) y lee `init.body`: mide los
        **bytes del cable**, no el objeto que devuelve el builder. Es la regla de la casa tras cinco rondas de
        defensas que producción no ejecutaba.
      - **Corre en la suite**, no sólo en CI. Es la lección de `format.guard.test.ts`: lo que sólo vive en CI se
        descubre tarde.
      - Detecta **forma de PAN** (13-19 dígitos que pasan Luhn, atravesando guiones y espacios), no sólo el nombre
        del campo, y **nunca imprime el valor** en el mensaje de fallo — sólo longitud y offset.
      - Lleva **sonda de mutación**: inyecta un PAN en cada hoja de texto de cada entrada y **congela** la
        partición `rejected` / `carried`. La lista `carried` es el inventario declarado de campos legítimos cuya
        forma es indistinguible de un PAN (teléfonos, direcciones, identificadores de Sabre); si crece o mengua,
        el test se pone rojo y hay que decidirlo a mano.
      - **Lo que NO promete, dicho en el propio fichero:** no garantiza que un PAN no pueda llegar a Sabre. No
        puede. En los campos de la lista `carried` la defensa no es la forma, sino el tipo, el lint y la redacción.

- [x] **La regla de lint está fijada por un test**, no sólo escrita: `providers/sabre/src/pan-lint-rule.guard.test.ts`
      ejecuta ESLint de verdad con la config del repo y comprueba las **dos** mitades — que **dispara** en
      `*.request.builder.ts` y `*.serializer.ts`, y que **no dispara** ni sobre los `?: never` (la barrera de
      compilación, más fuerte que el lint) ni sobre `*.response.mapper.ts` (el carril de lectura enmascarada).
      Sin las dos mitades sería un test de que existe alguna regla, no de que la regla sirve.
- [ ] Test de propiedad de `indices.ts`: para cualquier array de N pasajeros el índice emitido es `pos + 1` y el
      round-trip es identidad. Un off-by-one **asigna el asiento al pasajero equivocado o cobra a la tarjeta
      equivocada, en silencio** (R-22).
- [ ] `retrieveForDisplay` **no expone** `bookingSignature` en su tipo. Verificable en compilación.
- [ ] Toda creación se cierra con `getBooking` de verificación; `orders.provider_raw` se llena **sin PAN**.
- [ ] La cancelación NDC ejecuta `checkFlightTickets` previo. Test que falla si se omite.
- [ ] Cada operación con dinero emite `domain_event` con actor y tenant.

**Dependencias:** Fase 0, Fase 2.b, **D1 resuelta ✅ 2026-08-26**, **D9 resuelta ✅ 2026-08-26** (§8.4). Las dos
decisiones ya no bloquean; lo que bloquea el cierre de la fase son las credenciales de CERT (**P-05**).

### 8.2 Fase 4.a — Emisión, `checkFlightTickets` y void

**Esfuerzo: 9-11 d-p. Calendario: 2,5 semanas.** Es la fase donde el software empieza a mover dinero irreversible.

El corte es deliberado: `checkFlightTickets` es lo que evita prometerle al cliente lo que no se puede cumplir, y el
void es la operación barata que cubre el grueso de la post-venta del día a día. **Refund va en 4.b.**

```
providers/sabre/src/ticketing/
├── fulfill.{request.builder,response.mapper}.ts   # RF-11
├── check.{request.builder,response.mapper}.ts     # RF-12
├── void.{request.builder,response.mapper}.ts      # RF-13
└── document-status.ts                             # TE/TO/ME/OV/TR/MR + couponStatus (RF-15)

packages/domain/src/ports/ticketing.port.ts   # issue/check/void + reconcileDocuments OBLIGATORIO
apps/api/src/orders/post-sale.worker.ts       # + tipos issue | void, con idempotencia propia
```

**Dos correcciones que el contrato impuso y que cambian entregables:**

- **`void-window.ts` NO se construye.** La primera pasada lo listaba como entregable y calculaba la ventana de void
  con la zona horaria del PCC emisor. **El contrato la publica**: `isVoidable` y, para NDC,
  `cancelOffers[].offerExpirationDate` + `offerExpirationTime` **en UTC** (`:6504`, `:8890`). Calcularla nosotros
  pasó de requisito a **riesgo** (R-11): convierte un void gratis en un refund con penalidad **sin fallar
  ruidosamente**. Para ATPCO, Sabre no publica fórmula (P-11), así que la UI muestra **semáforo, no contador**.
- **`commissionPercent` → `commissionPercentage`.** La colección manda el primero y **el contrato no lo reconoce**
  (`:7724`). Y va en `TicketingQualifiers` de `fulfillFlightTickets`, **no** en `createBooking`: eso reubica una
  pieza del pricing waterfall y obliga a corregir `docs/platform/12-modelo-consolidador-y-plan.md` **antes** de que
  alguien implemente contra el diseño viejo.

**Criterios de salida**

- [ ] Emisión end-to-end contra CERT con FOP **sin tarjeta**, número de billete real recuperado por `getBooking`.
- [ ] **`acceptPriceChanges: false` y `priceQuoteExpirationMethod: 'Quit'` explícitos.** Los defaults de Sabre son
      permisivos: sin enviarlos, **Sabre emite aunque el precio haya subido y sólo avisa con un warning**.
- [ ] Los 7 warnings oficiales de fulfill están clasificados por severidad, y `PARTIAL_FULFILLMENT`,
      `FULFILLMENT_NOT_CONFIRMED` y `UNABLE_TO_RETRIEVE_TICKETS` escalan a **`NEEDS_HUMAN`** y **no se reintentan
      jamás** — hay dinero cobrado sin documento (R-05).
- [ ] Void contra CERT dentro de la ventana; `ticketStatusCode === 'OV'` verificado. **Y la ventana se lee, no se
      calcula:** test que falla si el código deriva una fecha límite en vez de leer `isVoidable`.
- [ ] **Test de reconciliación:** se mata el worker a mitad de la emisión; al reanudar, la saga detecta el billete
      ya emitido vía `getBooking` y **no reemite**. La máquina de estados incluye **`TO`** (billete emitido en
      contenido NDC): el filtro de la primera pasada, que sólo miraba `TE`/`ME`, habría dado por **no emitida toda
      orden NDC**.
- [ ] Timeout HTTP ≥ **45 s** en las operaciones con dinero, por los 25 s de esperas declaradas en contrato.
- [ ] Ninguna operación de esta fase corre dentro del request HTTP del vendedor.
- [ ] **Fase C en estado "certificación de emisión aprobada"** (§9). Emitir contra CERT no factura.

### 8.3 Fase 4.b — Refund, modificación de reserva, asientos y ancillaries

**Esfuerzo: 6-7 d-p. Calendario: 2 semanas.**

```
providers/sabre/src/ticketing/refund.{request.builder,response.mapper}.ts   # RF-14
providers/sabre/src/booking/modify.{request.builder,response.mapper}.ts     # RF-17
providers/sabre/src/seats/            # getseats v3: 3 modos + reglas de elegibilidad (RF-16)
providers/sabre/src/ancillaries/      # CONDICIONADO a P-12
packages/domain/src/ports/{seat-map,ancillary}.port.ts
packages/domain/src/ports/order-modify.port.ts   # supportedModifications() declarativo (RF-17 CA-6)
```

> **Por qué `modifyBooking` (RF-17) cae aquí y no en la Fase 3 — requisito que no tenía fase en ninguna versión de
> este plan.** Va en la 4.b por una razón de contrato, no de gusto: **el asiento se escribe en la reserva por
> `modifyBooking`**. `seats` y `changeOfGaugeSeats` son propiedades de `FlightToModify`
> (VERIFICADO-SPEC `booking-management-v1.yml:8083-8104`), así que **RF-16 no aterriza en el PNR sin este
> builder** y separarlos crearía una dependencia entre fases que no compra nada. Su prerrequisito —un `getBooking`
> fresco **sin `returnOnly`**, el único que devuelve `bookingSignature` (RF-09 CA-1)— lo entrega la Fase 3, y como
> **no mueve dinero** no tiene por qué preceder a la 4.a. **El rango de 6-7 d-p no incluía este entregable**; por
> §2.2 las cifras de las Fases 3-5 son órdenes de magnitud, no compromisos.

- [ ] `overrideCancelFee` y `commissionPercentage` gateados por rol (`consolidator_admin` / `agency_admin`,
      **nunca** `vendedor`) con `domain_event` que registre actor e importe. Límites del contrato: ≤ 9999,99 y
      ≤ 99,99 %.
- [ ] La UI de post-venta **no ofrece "reembolsar"** sin `checkFlightTickets` previo.
- [ ] `automatedRefundsEnabled === false` **oculta** el botón, en vez de dejar que el vendedor descubra el
      `UNAUTHORIZED` delante del cliente.
- [ ] Asientos: test que **rechaza** asignar salida de emergencia a un pax cuyo `paxType` no es `ADT`.
- [ ] **`changeOfGaugeSeats`**: test con un vuelo con cambio de aeronave. Llenar sólo `seats[]` deja al pasajero sin
      asiento en la segunda mitad **sin error que lo delate** (R-24).
- [ ] **Read-modify-write con firma fresca (RF-17):** todo `modifyBooking` va precedido de un `getBooking` **sin
      `returnOnly`**, bajo lock distribuido por `confirmationId`, con 2 reintentos ante
      `UNABLE_TO_MODIFY_BOOKING_WRONG_SIGNATURE`. Test que falla si el `after` se construye sobre una lectura
      cacheada o filtrada. Y el `after` es **un documento entero, no un PATCH**: un campo omitido **se borra**.
- [ ] **`modifyBooking` no devuelve firma nueva** (`ModifyBookingResponse` `:890-909` =
      `{timestamp, booking, errors[], request}`): test de que un segundo cambio encadenado ejecuta su propio
      `getBooking`. Consecuencia de UI, no de backend: **se guarda en bloque, no campo a campo**.
- [ ] `supportedModifications()` declara **sólo** las 12 propiedades de `BookingToModify` (`:1255-1325`). Coches,
      trenes, cruceros, `contactInfo` y `travelersGroup` se rechazan con mensaje claro; en el Package Studio un
      cambio de auto se modela como **cancelar + rebookear con compensación**.
- [ ] **Ancillaries NDC no se cierra sin P-12 respondida.** El contrato de `getAncillaries` dice que muestra
      _"free-of-charge ancillaries"_ y que sus dos campos principales _"se definirán en una versión futura"_, y
      `createBooking` declara que _"ancillary services are currently not supported for NDC bookings"_. Si P-12 sale
      negativa, este entregable **se retira de la fase**, no se implementa a medias.

### 8.4 D9 se cierra **antes** de empezar la Fase 3, no durante la Fase 4 — ✅ **cerrada el 2026-08-26**

> **Resultado: (B) BullMQ hasta la emisión, (A) Temporal antes del primer `refundFlightTickets` real.**
> La regla de esta sección se cumplió: D9 se cerró **antes** del primer commit de la Fase 3, no durante la Fase 4.
> Las tres condiciones que esta sección imponía a la opción (B) están registradas en
> [10 §9 D9](./10-requisitos-maestro.md): la desviación de `CLAUDE.md` está declarada como consciente y con fecha
> de revisión (la Fase 4.a), la migración a Temporal tiene línea de esfuerzo propia en la Fase 4.b, y la
> contradicción roadmap-vs-repo queda anotada en §1.4.
>
> **Restricción de diseño que hace barata la migración:** la lógica de compensación **no vive acoplada al runner**.
> Cada paso declara su compensación como función pura del estado de la orden y BullMQ sólo la invoca. Migrar debe
> ser cambiar el orquestador, no reescribir el qué-se-deshace.

_(Ojo con la numeración: lo que la crítica llamó "D6" es **D9** en el maestro reescrito; **D6** es ahora la decisión
sobre venta de asiento en el canal conversacional.)_

El plan anterior presentaba la decisión del motor de sagas como abierta y bloqueante de la Fase 4, **pero la
Fase 3 ya la tomaba** ("saga BullMQ de creación" entre sus entregables). Después de la Fase 3 eso no es una
decisión: es una **migración cuyo coste no está en ninguna estimación**.

**Estado real verificado @`c39ac93`:** existe BullMQ (`apps/api/src/queue/`, `apps/api/src/orders/post-sale.worker.ts`,
`bullmq ^5.34.0` en `apps/api/package.json`). **Temporal no existe en el repo**, pese a que `CLAUDE.md` lo lista en
el stack "no negociable sin razón" y el roadmap lo colocaba en Ola 1 Mes 2.

**Regla de este plan:** D9 se cierra **antes del primer commit de la Fase 3**. Y si se elige (B) BullMQ:

1. Se declara **explícitamente como desviación consciente de `CLAUDE.md`**, con fecha de revisión.
2. Se añade a la Fase 4.b una **línea de esfuerzo propia para la migración a Temporal**, o el argumento escrito de
   por qué no hace falta. El punto de no retorno es la emisión: mientras sólo se reserva y se cancela, BullMQ
   alcanza; con deadlines de días (límites de tiempo de emisión, ventanas de void), los jobs de BullMQ son frágiles.
3. Se anota que el roadmap habla de Temporal en Ola 1 y el repo no lo tiene: **una de las dos cosas hay que
   corregirla** (§1.4).

### 8.5 Fase 5 — Hoteles Sabre (condicional). Autos: descartados

**Por defecto esta fase no se hace.** [10 §2.2](./10-requisitos-maestro.md) descarta autos por completo (N3:
AgentCars ya cubre más superficie, y `CarToModify` **no existe** en el contrato — los autos de Sabre no son
modificables, sólo cancelables) y deja hoteles como candidato condicionado (N2).

**Los tres gates, y tienen que pasar los tres para siquiera estimarla:**

1. **D1 resuelta a favor de FOP sin tarjeta**, y confirmado que hay inventario hotelero suficiente que acepte
   `paymentPolicy: LATE` / `AGENCY_IATA` / `CORPORATE`.
2. **Spike de captura de 1-2 días** contra CERT sobre `GetHotelAvailRS`, `HotelPriceCheckRS` y el `createBooking`
   de hotel. Con el `PageSize` por defecto de 200, **160 de cada 200 propiedades vuelven con tarifa cacheada**: hay
   que medir cuánto de ese inventario es vendible.
3. **Deduplicación resuelta.** Sin mapeo GIATA o equivalente, el mismo hotel aparece tres veces (Despegar + Sabre
   GDS `RateSource 100` + Sabre agregador `RateSource 113`), lo que ataca directamente el principio de "tiempo a
   venta < 2 minutos". El roadmap ya tenía este problema con Giata (RR4) para HotelDo+Hotelbeds; Sabre lo agrava.

**Deuda colateral independiente de Sabre**, que conviene atender igual y es ítem propio de backlog:
`apps/api/src/cars/cars.controller.ts` devuelve tipos de `@sales-travel/agent-cars` directamente al HTTP —
anti-patrón explícito de `CLAUDE.md`— y no existe `packages/canonical/src/car.ts`.

---

## 9. Fase C — Certificación Sabre y alta productiva **(la fase que faltaba)**

> **El plan anterior terminaba en la Fase 4 con criterios de salida "contra CERT". CERT no factura.** La palabra
> "certificación" no aparecía ni una vez en el documento, mientras el maestro habla de 4-8 semanas por PCC y el
> roadmap ya la declaraba como dependencia desde abril. Un lector sumaba 48-59 d-p y concluía que en ~3 meses había
> ingresos. **No los hay.**

**Esfuerzo de ingeniería: 2-3 d-p de soporte (correcciones que pida Sabre, evidencias, capturas).
Calendario: 4-8 semanas. Dueño: el founder con el account manager de Sabre, no el equipo técnico.**

### 9.1 Cuándo arranca

**El día que se firma el contrato**, es decir, **inmediatamente después del GO de §5** — no al terminar la Fase 3.
Es la regla más importante de esta fase: **la certificación es calendario, no esfuerzo**, así que su único
optimizable es empezar antes. Corre **en paralelo** con las Fases 1, 2.b y 3.

### 9.2 Qué incluye

| Hito                                           | Qué es                                                                                                                                                                                                                                                                                                | Evidencia                         |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| **Contrato firmado**                           | Fee, alcance, cupo de concurrencia, condiciones de multi-PCC                                                                                                                                                                                                                                          | Salida de §5                      |
| **Lista completa de TJR / opciones de cuenta** | El TJR es una capa de configuración por cuenta que **ni el spec ni el sandbox revelan**, y cada función nueva puede exigir una opción nueva. **Se pide la lista completa por escrito en la certificación, no se descubre error a error en producción** ([09 §5.1](./09-referencia-externa-y-gaps.md)) | Correo del account manager        |
| **Activación de productos premium**            | VERIFICADO-SPEC: _"This is a premium product. As such, special activation (`OffersFlightReshopUser` ICE attribute) is required in the production environment. Reach out to your Account Manager"_ (`help/flight-reshop-api-1.0/…-user-guide.txt:14`). BFM está marcado `premium` en el catálogo       | Confirmación por producto         |
| **`Application-ID`**                           | Recomendado en hotel y vehículo, _"work with your account manager to generate one"_. **No lo tenemos** (P-20)                                                                                                                                                                                         | Asignado o descartado por escrito |
| **Certificación funcional**                    | Sabre revisa los flujos. **`tryOut: false` en todo el carril de reserva**: shop se puede probar sin contrato, reservar y emitir no                                                                                                                                                                    | Aprobación de Sabre               |
| **Branch access por agencia**                  | Relación declarada entre el PCC del consolidador y el de **cada** agencia, configurada **del lado de Sabre**. El error `5276` dice que tarda **5 minutos en propagar** — pero la gestión previa no la hacemos nosotros                                                                                | Una gestión **por agencia**       |
| **Alta productiva**                            | Credenciales de producción                                                                                                                                                                                                                                                                            | Primer `createBooking` real       |

### 9.3 El plazo: lo que sabemos y lo que no

**Las fuentes se contradicen y no se promedian.** Una habla de **"7 a 21 días"**; AltexSoft dice que **sólo la
certificación** dura **4-8 semanas** — ambas **[TERCERO]**, ninguna es de Sabre. [09](./09-referencia-externa-y-gaps.md)
concluye **2-3 meses contando contrato + certificación [INFERIDO]**, y eso es lo que este plan usa.
**Resolver esa contradicción es P-19 y es una pregunta de correo, no de investigación.**

### 9.4 La consecuencia de producto que hay que decir en voz alta

`docs/platform/12-modelo-consolidador-y-plan.md` §3.6 promete _"nadie en LATAM permite que una agencia se dé de alta
y venda en horas"_. **En la ruta BYOC con PCC propio, con Sabre, eso es literalmente incumplible**: contrato +
IATA/ARC + 4-8 semanas de certificación + branch access gestionado agencia por agencia (R-19).

**Mitigación de producto, no técnica** (D4): el wizard de onboarding **se bifurca en dos rutas** —
ruta heredada vía `targetPcc` (horas, y es el default) y ruta BYOC (semanas, con estado
`pending_provider_certification` visible en la UI). Y la promesa de marketing se ajusta a lo primero.

### 9.5 Criterio de salida — **y es el hito real del proyecto**

- [ ] Existe un **`createBooking` + `fulfillFlightTickets` en el entorno de PRODUCCIÓN de Sabre**, con billete
      emitido, liquidable por BSP y con documento fiscal emitido por nuestro lado (RF-21).
- [ ] **Ese, y no el final de la Fase 4, es el hito "primera venta facturable por Sabre".**

---

## 10. El primer PR

**Título:** `refactor(search): registry de proveedores de vuelo y degradación parcial visible`

**Es el PR-1 de la Fase 2.a y no contiene una sola línea de Sabre.** Deliberado: es revisable, no bloquea por
credenciales, y su valor es independiente de que Sabre llegue a existir — sirve igual para Amadeus, que es lo que
D0(B) y RR1 del roadmap recomiendan probar en paralelo.

### 10.1 Alcance mínimo

Escribir la red de seguridad que hoy no existe, extraer el registry, y cerrar los tres bugs latentes que estallarían
el día 1 de cualquier segundo proveedor.

**Explícitamente fuera:** `providers/sabre/`, la migración de DB, los cambios de `packages/canonical` y todo cambio
de UI. Van en PR-2 y PR-3.

> **Esto resuelve una contradicción de la versión anterior.** El PR decía excluir migración y UI, pero se declaraba
> "de Fase 2" y la Fase 2 incluía entre sus criterios de salida la cuota por `search_group_id` (que **requiere** la
> migración) y el error explícito en `red/page.tsx` (que **es** UI). Los criterios quedaban huérfanos. Ahora la
> Fase 2.a está numerada en tres PR (§3.1-§3.3) y **cada criterio de §3.4 pertenece a un PR concreto**:
> R-07/degradación/502/cache/aislamiento/callPolicy → PR-2; cuota y `red/page.tsx` → PR-3.

### 10.2 Archivos exactos

**Nuevos — red de seguridad:**

```
apps/api/src/search/provider-fanout.test.ts
apps/api/src/search/circuit-breaker.test.ts
apps/api/src/search/memory-cache.test.ts
apps/api/src/search/search.service.test.ts
vitest.config.ts
```

**Nuevos — registry:**

```
apps/api/src/providers/provider.types.ts
apps/api/src/providers/flight-provider.registry.ts
apps/api/src/providers/providers.module.ts
apps/api/src/providers/flight-provider.registry.test.ts
apps/api/src/providers/adapter-cache-isolation.test.ts
apps/api/src/providers/__fixtures__/stub-provider.factory.ts
```

**Modificados** (líneas verificadas @`c39ac93`):

```
apps/api/src/providers-latam/latam-ndc.factory.ts   # implements TenantProviderFactory; tipo del port;
                                                    #   code/vertical/capabilities/credentialSource/callPolicy
apps/api/src/search/search.service.ts               # registry en vez del factory concreto (:70);
                                                    #   priceOffer enruta por provider.name (:114);
                                                    #   error tipado en el apagón total (:89)
apps/api/src/search/search.controller.ts            # respuesta { offers, simulated, providers[] }
apps/api/src/search/search.module.ts                # imports: [ProvidersModule, PricingModule]
apps/api/src/orders/orders.service.ts               # registry.byCode (:138); provider del INSERT
                                                    #   desde dto.offer.provider.name (:162)
apps/api/src/orders/orders.controller.ts            # assertSupportsLatamOps (:141) → capabilities
```

### 10.3 Tests que deben pasar

| Test                                                                                                      | Qué demuestra                                                                |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `search.service.test.ts` → "un proveedor falla, el otro responde"                                         | La degradación parcial deja de ser silenciosa. **Es el test central del PR** |
| `search.service.test.ts` → "priceOffer de una oferta del stub llama al adapter del stub"                  | El bug R-07 está cerrado                                                     |
| `search.service.test.ts` → "ambos fallan → 502, no 500"                                                   | El apagón total tiene error tipado                                           |
| `search.service.test.ts` → "resultado con failed[] no se cachea"                                          | Un fallo transitorio no se congela 90 s                                      |
| `search.service.test.ts` → "un solo proveedor: offers[] y totales byte-a-byte iguales a hoy"              | **Regresión cero de contenido** (§3.4)                                       |
| `search.controller` → test de contrato del sobre `{offers, simulated, providers[]}`                       | El cambio es aditivo y queda fijado                                          |
| `flight-provider.registry.test.ts` → "orden estable"                                                      | La clave de caché es determinista                                            |
| `flight-provider.registry.test.ts` → "sin cuenta y sin `PLATFORM_DEFAULT` → proveedor ausente"            | Ningún proveedor nuevo hereda credenciales de plataforma por accidente       |
| `flight-provider.registry.test.ts` → "callPolicy opt-in con flag apagado → cero llamadas, status skipped" | El coste por búsqueda es gobernable antes de conocer el fee                  |
| `adapter-cache-isolation.test.ts`                                                                         | El tenant B nunca recibe el adapter del tenant A (R-12)                      |
| `circuit-breaker.test.ts` → "`PROVIDERS_DISABLED=<code>` no afecta a los demás"                           | El kill-switch es por proveedor                                              |
| Toda la suite existente (29 archivos)                                                                     | Nada de lo que ya funciona se rompió                                         |

### 10.4 Definición de "listo"

El endpoint `/search/flights` devuelve `providers[]`; el **stub anónimo** de segundo proveedor, al fallar, produce
ofertas del primero **más** un aviso de degradación; `grep -r assertSupportsLatamOps apps/` no devuelve nada; y
`vitest run --coverage` aplica umbrales que **fallan el build** si bajan.

**Ni una sola línea del PR nombra a Sabre.** Ése es el criterio de que la Fase 2.a era realmente incondicional.

---

## 11. Trazabilidad: cada requisito funcional tiene fase, o tiene un motivo escrito para no tenerla

**Por qué esta tabla vive aquí y no en el maestro.** La matriz de [10 §7](./10-requisitos-maestro.md) es
**requisito → evidencia**: dice de dónde salió cada RF y con qué marca de verificación. No dice **quién lo
construye ni cuándo**, y ése es el único sitio donde puede quedarse un requisito huérfano sin que nadie lo note.
La auditoría encontró **cinco RF sin fase asignada** —RF-17, RF-18, RF-20, RF-22 y RF-23— y esta pasada encontró
**un sexto por contenido, RF-06**, cuyo dedupe no lo construía ninguna fase. Dos de ellos, **RF-18 y RF-20, son el
núcleo del modelo consolidador**: son lo que distingue este producto de un buscador con markup.

**Regla de lectura:** «⚠️ nuevo» marca la asignación que esta pasada añadió. Que un RF aparezca aquí **no** amplía
el alcance de Ola 1: las fases 3, 4.a, 4.b y 5 siguen siendo propuestas para Ola 2 sujetas a §1.2 y al GO de §5.

| RF        | Qué es                                      | Fase                                                                                                                                                                                                               | Ola   | Por qué ahí                                                                                                                                                                                                                            |
| --------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RF-01** | Auth ATK + caché + política de 401          | **1** (§6.1 `auth/token.service.ts`, §6.3 paso 2)                                                                                                                                                                  | 1     | El algoritmo del `secret` es testeable sin credenciales                                                                                                                                                                                |
| **RF-02** | Credenciales BYOC con herencia              | **1** (§6.1 `config.ts`, `isMockMode`) + **2.b** (§7: resolución y formulario)                                                                                                                                     | 1     | _Estaba cubierto por contenido pero sin citar su identificador._ CA-5 es criterio de salida de la Fase 1; CA-1 a CA-4 lo son de la 2.b                                                                                                 |
| **RF-03** | Búsqueda ATPCO+NDC en una llamada           | **1** (§6.3 paso 3)                                                                                                                                                                                                | 1     | Es el builder de `/v5/offers/shop`, el alcance que el roadmap pedía                                                                                                                                                                    |
| **RF-04** | Mapeo de shop a `Offer`                     | **1** (rama ATPCO §6.3 paso 4; rama **NDC** paso 6)                                                                                                                                                                | 1     | La rama ATPCO se escribe hoy contra 3 ejemplos oficiales; la NDC **no tiene ni uno** y espera a la Fase 0 (§6.2)                                                                                                                       |
| **RF-05** | Fan-out con degradación parcial             | **2.a** entera (§3)                                                                                                                                                                                                | 1     | _Cubierto por contenido:_ §3.4 es, criterio a criterio, la CA de este RF                                                                                                                                                               |
| **RF-06** | Dedupe Sabre ↔ LATAM                       | ⚠️ **2.b** (§7) + prerrequisitos canónicos en **2.a** PR-3 (§3.3) + política en **0** (§4.4)                                                                                                                       | 1     | _No lo construía ninguna fase._ El duplicado nace el día que se enciende la segunda fuente, y su regla de desempate nombra a Sabre: no cabe en la 2.a                                                                                  |
| **RF-07** | Revalidación de precio NDC                  | **3** (§8.1)                                                                                                                                                                                                       | 2     | Sin `price` no hay `offerId` que reservar                                                                                                                                                                                              |
| **RF-08** | `createBooking` con política de error       | **3** (§8.1)                                                                                                                                                                                                       | 2     | —                                                                                                                                                                                                                                      |
| **RF-09** | `getBooking` en dos modos tipados           | **3** (§8.1)                                                                                                                                                                                                       | 2     | Es el proveedor de `bookingSignature` para RF-17 y de `airlineLocators` para RF-23                                                                                                                                                     |
| **RF-10** | Cancelación                                 | **3** (§8.1)                                                                                                                                                                                                       | 2     | Cierra el ciclo sin tocar dinero irreversible                                                                                                                                                                                          |
| **RF-11** | Emisión                                     | **4.a** (§8.2)                                                                                                                                                                                                     | 2     | Primera operación irreversible; exige Fase C avanzada                                                                                                                                                                                  |
| **RF-12** | `checkFlightTickets`                        | **4.a** (§8.2)                                                                                                                                                                                                     | 2     | Es lo que evita prometer un reembolso que no existe                                                                                                                                                                                    |
| **RF-13** | Void                                        | **4.a** (§8.2)                                                                                                                                                                                                     | 2     | La operación barata que cubre el grueso de la post-venta diaria                                                                                                                                                                        |
| **RF-14** | Refund                                      | **4.b** (§8.3)                                                                                                                                                                                                     | 2     | —                                                                                                                                                                                                                                      |
| **RF-15** | Reconciliación de documentos                | **4.a** (§8.2 `document-status.ts` + test de reconciliación)                                                                                                                                                       | 2     | Es la defensa anti billete fantasma de la propia emisión                                                                                                                                                                               |
| **RF-16** | Asientos y ancillaries                      | **4.b** (§8.3); ancillaries **condicionado a P-12**; la versión de `getseats` la decide la Fase 0 (R-26)                                                                                                           | 2     | —                                                                                                                                                                                                                                      |
| **RF-17** | Modificación sin tocar la FOP               | ⚠️ **4.b** (§8.3)                                                                                                                                                                                                  | 2     | _Sin fase hasta esta pasada._ `seats`/`changeOfGaugeSeats` son propiedades de `FlightToModify` (`booking-management-v1.yml:8083-8104`): **RF-16 no aterriza en el PNR sin este builder**. No mueve dinero, así que no precede a la 4.a |
| **RF-18** | Operación bajo `targetPcc` del consolidador | ⚠️ **2.b** (modelo de cuenta y `ticketingPcc` en el formulario) + **3** (invariante de header, 4 errores de branch access, ATK sessionless; se hereda en 4.a/4.b) + **C** (§9.2 branch access agencia por agencia) | 1 / 2 | _Sin fase hasta esta pasada, siendo el primitivo consolidador._ Ver la nota de abajo: **en el alcance de Ola 1 no tiene superficie de ejecución**                                                                                      |
| **RF-19** | Capacidades declarativas                    | **2.a** PR-2 (§3.2)                                                                                                                                                                                                | 1     | `assertSupportsLatamOps` desaparece en un criterio de salida de la 2.a (§3.4)                                                                                                                                                          |
| **RF-20** | Atribución por tenant en el PNR             | ⚠️ **3** (estampado en `createBooking`, `provider_raw`, test de reconciliación) + **4.a** (`ticketingPcc` de fulfill persistido)                                                                                   | 2     | _Sin fase hasta esta pasada._ Nace con la primera reserva: si el primer `createBooking` sale sin marca de agencia, la atribución **no se recupera después**                                                                            |
| **RF-21** | Documento fiscal de la venta                | **4.a** emite el `domain_event` de "venta liquidable"; **C** lo exige en §9.5                                                                                                                                      | 2     | El módulo fiscal (`alegra`/`nubefact`/`focus-nfe`) **no es de este plan**: es el carril fiscal de Ola 1, y aquí sólo se garantiza su entrada de datos                                                                                  |
| **RF-22** | Vinculación multi-producto                  | ⚠️ **FUERA DE ALCANCE — sin fase, y es correcto**                                                                                                                                                                  | —     | Ver la nota de abajo                                                                                                                                                                                                                   |
| **RF-23** | Localizador de la aerolínea                 | ⚠️ **3** (mapper de `getBooking`) + **0** (CA-6, sale de la captura del paso 5 de §4.2)                                                                                                                            | 2     | _Sin fase hasta esta pasada._ Es un campo del mapper de recuperación; el canal conversacional lo consume en cuanto existe                                                                                                              |

Los **RNF no llevan fila**: son transversales y se verifican dentro de los criterios de salida de cada fase. La
única excepción es **RNF-15**, cuyo entregable cambió de forma y está tratado en §6.1.

### 11.1 RF-18 — dónde se construye de verdad el primitivo consolidador

**En el alcance defendible de Ola 1 (§1.3), RF-18 no tiene superficie de ejecución, y conviene decirlo antes de
que alguien lo estime.** `targetPcc` **no aparece en ningún contrato de BFM**: cero ocurrencias en
`bargain-finder-max-v5.yml`, `v4` y `v3`; los únicos contratos del corpus que lo declaran son
`booking-management-v1.yml` (8 operaciones) y `flight-reshop-api-1.0.yml` (VERIFICADO-SPEC). El multi-PCC de la
búsqueda es otra cosa y otro campo: `POS.MultiSourceControl`, sólo en v5 (§6.1). **Conclusión: mientras Sabre sea
sólo fuente de búsqueda, `targetPcc` no se ejerce.** Lo que sí entra en Ola 1 es el **modelo de cuenta**, y eso es
Fase 2.b.

**El reparto, y su trampa:**

| Pieza de RF-18                                                                              | Fase                          | Nota                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.ticketingPcc` en la bóveda y en el formulario                                       | **2.b** (§7)                  | Ya era entregable; cambiar el esquema después es caro (§1.5)                                                                                                                                                                                                                                                                  |
| Llamada de humo del onboarding (CA-4)                                                       | **3**                         | **Trampa:** la verificación usa una operación de Booking Management, que la Fase 2.b **no tiene**. Hasta la Fase 3, el formulario **captura** `ticketingPcc` pero **no puede probar la autoridad**: la UI debe mostrarlo como _no verificado_, nunca darlo por bueno                                                          |
| Invariante `targetPcc` ⇒ `X-Sabre-Group` (ATK)                                              | **3**, heredado por 4.a y 4.b | `HEADER_DATA_MISSING_TARGET_PCC` / `BAD_REQUEST` — _"Target PCC was defined but header data is missing. Please complete X-Sabre-Group (ATK) or X-Sabre-Current-City (ATH)"_ (VERIFICADO-SPEC `help/booking-management-api-v1/help-documentation-create-booking-error-list.txt:1166-1170`). Un test del ACL, no una convención |
| Los 4 errores de branch access + "el contexto NO se revierte" ⇒ **ATK sessionless siempre** | **3**                         | Es también la razón técnica de que el carril ATH quede fuera (§1.5): con sesión reutilizada, la siguiente llamada apuntaría al PCC ajeno (R-08)                                                                                                                                                                               |
| Branch access **por agencia**, del lado de Sabre                                            | **C** (§9.2)                  | No es ingeniería: es una gestión por agencia, y es lo que rompe la promesa de onboarding "en horas" (§9.4, R-19)                                                                                                                                                                                                              |
| ¿Permite Sabre operar PCC de terceros?                                                      | **compuerta §5** (**P-02**)   | Si la respuesta es no, **RF-18 no se construye**: Sabre sólo sirve en modelo de herencia total                                                                                                                                                                                                                                |

### 11.2 RF-20 — la atribución se estampa en la primera reserva o no se estampa

RF-20 nace en la Fase 3 por una razón operativa: **si el primer `createBooking` sale sin marca de agencia
vendedora, esa atribución no se reconstruye después** — Sabre ve un único actor, el consolidador. El mecanismo
está en el contrato y no hay que inventarlo:

- **DK number, que es la vía buena.** `agency.agencyCustomerNumber` es **escribible en `createBooking`**
  (VERIFICADO-SPEC `booking-management-v1.yml:4750-4754`, _"Contains the agency's customer DK number"_) y
  **legible** en `Booking.agencyCustomerNumber` (`:1086-1092`), cuyo `#source` es
  `Reservation/DKNumbers` y, **en contexto NDC**, `OrderViewResponse.order.customerNumber`. Es decir: **round-trip
  verificado en los dos carriles**. Además es modificable (`BookingToModify`, `:1261`).
  **Restricción de diseño que sale del patrón:** `^[0-9A-Z]{6}([1-9A-Z*]{1}|[0-9A-Z]{4})?$` — 6, 7 o 10
  caracteres. **No cabe un UUID de tenant**: hay que derivar un código corto de agencia y guardar la
  correspondencia de nuestro lado.
- **Remark, como segunda vía.** `remarks[]` de `BookRemark` en `CreateBookingRequest` (`:762-767`) con
  `RemarkTypeEnum` `GENERAL` (`:9094-9113`). Texto libre: sirve para trazabilidad humana, no como clave.
- **Corrección a [10 RF-20 CA-1](./10-requisitos-maestro.md), que ofrece "remark / accounting line / DK" como si
  las tres fueran equivalentes: la accounting line NO es escribible por REST.** `AccountingLine` aparece en
  `booking-management-v1.yml` **únicamente** dentro de comentarios `#source` de lectura (`:2268-2357`), en ningún
  campo de request. Verificable: `grep -n "AccountingLine" booking-management-v1.yml | grep -v "#source"` no
  devuelve nada.

El resto de RF-20 ya estaba en el plan sin su etiqueta: `orders.provider_raw` **sin PAN** es criterio de salida de
la Fase 3 (§8.1) y el `ticketingPcc` de la respuesta de fulfill se persiste en la Fase 4.a (§8.2, RF-11 CA-6).

### 11.3 RF-22 — fuera de alcance, con su razón, en vez de en silencio

**RF-22 no tiene fase y no debe tenerla en el alcance que este plan defiende.** El requisito consiste en poblar
`associatedFlightDetails`, que es **propiedad del hotel** (`booking-management-v1.yml:5072-5074`,
_"provided to the hotel vendor"_) y **del auto** (`:7212-7214`) de Sabre. Este plan **no vende ni hoteles ni autos
por Sabre**: los hoteles son la Fase 5, condicionada a tres gates y **sin estimar** (§8.5), y los autos están
**descartados** (N3 — AgentCars cubre más superficie y `CarToModify` no existe). Sin portador, el requisito no
tiene dónde ejecutarse: construirlo sería escribir un mapper para un `createBooking` que nadie va a emitir.

**Qué se pierde:** nada hoy. El gesto de Package Studio "el hotel con este vuelo" con el hotel en **Despegar**
—que es como se vende ahora— no pasa por este campo. **Cuándo se reabre:** el día que la Fase 5 pase sus tres
gates, RF-22 entra **con ella y en su estimación**, no antes. Y sigue en pie lo que RF-22 CA-2 prohíbe prometer:
ni localizador único ni cancelación atómica.

> **Nota de fixture para RF-23, que ahorra una espera.** [10 RF-23 CA-5](./10-requisitos-maestro.md) pide un test
> de contrato contra `evidence/responses/01-Add_phone_Orders_View.json`. **Ese directorio no está versionado**, pero
> el dato sí: las cuatro respuestas guardadas viven dentro de la colección versionada
> (`sabre/Booking Management API v2026.04.postman_collection.json`, donde `L4D79U` y `bookingReferences` aparecen
> **4 veces cada uno**). **El mapper y su test se escriben sin credenciales**; lo que espera a CERT es sólo la
> CA-6 (si `getBooking` puebla `flights[].confirmationId` en NDC sin una segunda llamada). Conviene reconciliar la
> ruta en `00-fuentes.md` §1.

---

## Preguntas abiertas

Sólo las que afectan a **este plan**. La lista completa y priorizada está en
[10 §8](./10-requisitos-maestro.md), con el criterio corregido **P0 = bloquea la decisión de invertir**.

**Bloquean el arranque de una fase:**

1. **P-05 (credenciales de CERT) — resuelta.** EPR, PCC y password están disponibles fuera de Git. Para arrancar la
   Fase 0 falta inyectarlos mediante `ProviderCredentialsService`, decidir D1 y ejecutar el smoke test.
2. **P-01 (fee), P-02 (multi-PCC de terceros), P-04 (aporte incremental).** Son las **entradas de la compuerta de
   §5**. Sin las tres, la Fase 1 no se abre.
3. **P-07 / D1 (¿nunca PAN?).** No es una pregunta a Sabre: es una decisión del founder, se puede tomar hoy, y es
   **dependencia de la Fase 0**, no de la Fase 3 como decía la versión anterior.
4. **D9 (motor de sagas).** Se cierra **antes** del primer commit de la Fase 3 (§8.4).
5. **Aprobación del cambio de alcance de §1.2.** Si las Fases 3-4 se quedan en Ola 2 o se adelantan.

**Bloquean el diseño de una fase, pero no su arranque:**

6. **P-06 (entitlements).** Puede recortar el alcance de las Fases 3, 4 y 5 en el **primer día** de la Fase 0. Media
   jornada de trabajo que puede ahorrar semanas.
7. **P-11 (ventana de void ATPCO).** Sin ella, la UI de la Fase 4.a muestra **semáforo, no contador**. Nótese que
   **ya no bloquea un entregable**: `void-window.ts` se retiró del plan porque la ventana se lee, no se calcula.
8. **P-12 (ancillaries NDC).** Decide si el entregable de ancillaries existe en la Fase 4.b o se retira entero.
9. **P-19 (plazo real de alta productiva).** Resuelve la contradicción "7-21 días" vs "4-8 semanas" y por tanto el
   calendario de la Fase C, que es el camino crítico hacia el primer ingreso.
10. **P-24 (specs y errores de Amadeus/Travelport con el mismo rigor).** Bloquea **D0**, que está por encima de todo
    este plan.

**Cerradas por el contrato oficial y retiradas de esta lista:**
la forma de las respuestas de shop, price, create, get, cancel, check, fulfill, void y refund (VERIFICADO-SPEC en
[10 §7](./10-requisitos-maestro.md)); si `DataSources` acepta multi-`Enable` (sí, §4.4); si `timeToLive` existe en
v4 (sí, y en v3 — §6.2); si `errorHandlingPolicy` existe en `createBooking` (sí, `:698`); y si `modifyBooking`
acepta `targetPcc` (sí, `:873-878`).

---

## Riesgos

Los riesgos **del producto** están en [10 §10](./10-requisitos-maestro.md). Éstos son los riesgos **de este plan**,
y cuatro de los seis son nuevos respecto de la versión anterior.

| #         | Riesgo del plan                                                                                                                                                                                                                                                                                                                                  | Sev | Mitigación                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- | -------------------------------------------------------------------------------------------------------------------------- |
| **RP-1**  | **Confundir CERT con producción.** El plan anterior terminaba en la Fase 4 con criterios "contra CERT" y sin fase de certificación: un lector sumaba 48-59 d-p y concluía que en tres meses había ingresos. Entre el último criterio de la Fase 4 y el primer peso facturado hay **4-8 semanas de calendario que no se aceleran con más gente**. | 🔴  | **Fase C** (§9), arrancada el día de la firma y corriendo en paralelo. El hito de proyecto es §9.5, no la Fase 4           |
| **RP-2**  | **Comprometer ~50 d-p sin contrato.** Es el riesgo dominante del expediente (R-01 del maestro) trasladado al plan: se empieza a construir y cuando llega el fee ya no hay marcha atrás psicológica.                                                                                                                                              | 🔴  | **Compuerta §5** con umbral **preacordado antes de medir**. Si se acuerda después, se acuerda para justificar el resultado |
| **RP-3**  | **Expansión de alcance silenciosa.** El roadmap pone a Sabre como adapter de **búsqueda** y el plan lo llevaba al ciclo de vida completo del billete sin declararlo. 55 % del esfuerzo estaba fuera de la Ola 1 sin que nadie lo hubiera aprobado.                                                                                               | 🔴  | **§1.2**, declarado como cambio de alcance con decisión explícita del founder                                              |
| **RP-4**  | **Trabajo condicional disfrazado de incondicional.** La antigua Fase 2 se vendía como "trabajo puro de repo que hay que hacer igual", pero entregaba `providers-sabre/*` y un formulario de Sabre: entre 3 y 4 de sus 10-12 d-p se tiraban si el contrato no se firmaba. Y no compilaba sin la Fase 1.                                           | 🟠  | Partida en **2.a** (incondicional, cero menciones a Sabre, 8 d-p) y **2.b** (condicionada, 3-4 d-p, depende de la Fase 1)  |
| **RP-5**  | **Estimaciones tratadas como compromiso.** Los rangos son ±40 % en las fases sobre código legible y **no existen** para las Fases 3-5, que dependen de decisiones y respuestas que hoy no tenemos. Y todas asumen **una persona que aún no está contratada**.                                                                                    | 🟠  | **§2**: supuesto de dotación publicado, esfuerzo separado de calendario, y "defendible" bajado a "acotada"                 |
| **RP-6**  | **Empezar por la Fase 1 mientras se espera a Sabre.** Produciría un paquete terminado que no se enchufa a nada, con la rama NDC del mapper escrita a ciegas — porque **los 3 ejemplos oficiales son ATPCO** (§6.2) y no hay ni uno de NDC.                                                                                                       | 🟠  | La Fase 2.a es lo que se hace mientras se espera: no depende de nadie y sirve para cualquier segundo proveedor             |
| **RP-7**  | **Refactorizar el camino crítico sin red.** `apps/api/src/search/` tiene **0 tests** y genera todos los ingresos. Sin PR-1, cualquier regresión la descubre un vendedor delante de un cliente.                                                                                                                                                   | 🟠  | PR-1 es **prerrequisito duro** de PR-2, y sus tests pasan contra el código de hoy **sin modificarlo**                      |
| **RP-8**  | **Coste por búsqueda sin gobierno.** El plan añadía Sabre a todas las búsquedas de todas las agencias con un TTL de 90 s como único control, mientras el fee es desconocido y la propia investigación lo señala como potencialmente inviabilizante en el endpoint de más volumen.                                                                | 🟠  | `callPolicy` en el registry desde la **Fase 2.a** (§3.2): medio día ahora, una semana después                              |
| **RP-9**  | **Decidir D9 por omisión.** La Fase 3 tomaba la decisión del motor de sagas entre sus entregables mientras la Fase 4 la presentaba como abierta. Después de la Fase 3 no es una decisión: es una migración sin estimación.                                                                                                                       | 🟠  | **§8.4**: D9 cerrada antes del primer commit de la Fase 3, con desviación de `CLAUDE.md` declarada si sale (B)             |
| **RP-10** | **El roadmap y el repo se contradicen.** Amadeus/HotelDo/Hotelbeds/Duffel/CarTrawler en el roadmap; latam-ndc/despegar-hotels/agent-cars en el repo. Temporal en Ola 1 Mes 2 y no existe. Cualquier discusión de secuenciación se convierte en una discusión sobre qué documento vale.                                                           | 🟠  | **§1.4**: o se actualiza el roadmap en el mismo pase, o deja de ser fuente de verdad y `CLAUDE.md` deja de señalarlo       |

**Los tres que hay que mirar cada semana: RP-1, RP-2 y RP-3.** Los tres son de negocio, ninguno se resuelve
escribiendo código, y los tres estaban ausentes de la versión anterior de este documento.
