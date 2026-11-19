# 19 · Auditoría de los flujos de venta (vuelos, autos, hoteles)

> Revisión del 2026-11-19, de punta a punta: búsqueda → selección → cotización/checkout → reserva →
> post-venta. Fuentes: logs de producción (`docker compose logs api|web-b2b`), lectura del código
> en `main` (`ccbf4027`) y tests. Cada hallazgo dice si está **verificado** (camino leído entero y
> reproducido en test) o **sospechado** (depende de cómo responde el proveedor).

## 0. Lo que no se pudo hacer

- **Reservas de prueba en vivo: no se hicieron.** El panel de producción
  (`app.planetour.cloud`) pide iniciar sesión y la sesión de Claude no escribe contraseñas. No
  hay Docker local para levantar API + Postgres con las credenciales sandbox. Sin reservas, no hay
  nada que cancelar.
- **Tiempos medidos: no hay.** Caddy no tiene access log y el API sólo loguea `durationMs` en
  `sabre.shop` (534 ms en el único shop del log). Los tiempos de este informe salen del código:
  timeouts configurados, cuántas llamadas al proveedor se hacen en serie y qué tiene caché.
- **Base de producción: no se consultó** (permiso denegado). La evidencia de producción son los logs.

Para cerrar esto hace falta una sesión iniciada en el panel con un usuario de agencia de prueba.
Con eso se corre cada flujo contra los sandbox (Despegar `api-dev`, Sabre cert, LATAM test,
AgentCars dev) y se miden los tiempos en la pestaña de red.

## 1. Estado de producción (logs, 2026-11-19)

| Señal                                                                             | Qué es                                                                                | Acción                               |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------ |
| `hotels.search_context.packs_sin_contexto provider=despegar-hotels dropped=14/16` | La ficha de Despegar descarta **todas** las tarifas: no hay venta de hoteles Despegar | PR #42 (abierto) + §4.1              |
| `hotels.content_batch.filas_rechazadas provider=despegar-hotels rejected=1`       | La base rechaza la fila de contenido del hotel                                        | PR #48                               |
| `Failed to find Server Action "…"` (web-b2b)                                      | Pestaña abierta antes de un deploy                                                    | PR #43                               |
| `currency mismatch: requested COP, LATAM returned BRL`                            | LATAM test responde en BRL; la búsqueda lo deja pasar (habilitado para pruebas)       | PR #46 (markup) — el BRL es de LATAM |
| `sabre.shop.warnings {"baggage-not-mapped":3}`                                    | Ruido: se emite cuando el equipaje facturado **sí** se mapeó; falta el de mano        | §2, pendiente                        |
| TBO test: HTTP 500 «Unexpected Error» a toda búsqueda desde el 17-nov             | Del lado de TBO                                                                       | Escribir a soporte con request IDs   |

## 2. Vuelos (Sabre, LATAM NDC)

**Funciona:** búsqueda multi-proveedor con caché y single-flight, revalidación (OfferPrice /
Flight Check) antes de reservar, idempotencia de la reserva (`q:<quotationId>` con índice único,
se libera sólo si el proveedor no fue llamado), post-venta de emisión/anulación.

| #   | Hallazgo                                                                                                                                                      | Estado                | PR  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | --- |
| V1  | La orden sumaba el **markup fijo** a una tarifa en otra moneda (LATAM BRL para agencia COP): orden y retención de cartera más caras que el precio aceptado    | Verificado, corregido | #46 |
| V2  | LATAM: OfferPrice conservaba la vigencia de la búsqueda; una cotización reservada > 30 min después daba «ya venció» tras un OfferPrice exitoso                | Verificado, corregido | #47 |
| V3  | Desde las 19:00 de Bogotá/Lima la búsqueda rechazaba vuelos del mismo día («anterior a hoy»): el servidor compara en UTC                                      | Verificado, corregido | #50 |
| V4  | Teléfono de contacto siempre `+57`, área `1` (`passenger-form.tsx`) → LATAM recibe un teléfono mal para agencias de PE/BR                                     | En PR                 | #55 |
| V5  | `quote_number` = `MAX+1` sin índice único: dos cotizaciones simultáneas pueden repetir número                                                                 | En PR                 | #59 |
| V6  | Equipaje facturado de Sabre: toma el primer pasajero y el primer tramo; la vuelta con otra franquicia muestra la de la ida. Equipaje de mano no se decodifica | En PR                 | #64 |

**Tiempos (del código):**

- Ida y vuelta: elegir una ida hace un **shop anclado nuevo sin caché** (`searchReturns`), 3–8 s cada vez. Volver a elegir la misma ida lo repite. Es el único camino de búsqueda sin caché.
- Peor caso de Sabre: la escalera de degradación (hasta 4 shops + reintento sin marcas, 30 s de timeout cada uno) supera los **100 s** de Cloudflare: el vendedor recibiría un 524. Falta un plazo global (~45 s).
- Reservar: si el precio confirmado tiene más de 5 min (normal cargando 3–4 pasajeros), se revalida en el navegador **y** otra vez en el servidor (+2–5 s). Antes, `saveBeforeBooking` guarda el CRM y la cotización en serie, con hasta 8 s de timeout cada uno.
- «Más tarifas» consulta los proveedores en serie (`for…await`).
- El listado de cotizaciones trae `selected_offer` completo con `provider.raw` de 100 filas.

**UX:** el botón atrás desde la cotización pierde la búsqueda: el estado vive en React, no en la URL. Tampoco hay un «buscar de nuevo con estos criterios» cuando la oferta vence.

## 3. Autos (AgentCars)

**Funciona:** fechas en el huso de la oficina, validación de edad, candado contra doble clic, cuenta regresiva de 15 min y renovación de la tarifa, y una confirmación sin código no se da por hecha.

| #   | Hallazgo                                                                                                                                                                                                                                                                     | Estado                | PR  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | --- |
| A1  | Una confirmación que tardaba > 15 s o devolvía 5xx decía «**Prueba de nuevo**»: el segundo clic con el mismo `uniqid` era otra reserva y la primera quedaba sin orden                                                                                                        | Verificado, corregido | #44 |
| A2  | «Gestionar reserva» (consultar/cancelar/activar por apellido + código) no miraba `orders`: con la cuenta heredada del consolidador, una agencia abría o cancelaba reservas de otra. Cancelar no actualizaba la orden. El reporte diario traía las reservas de toda la cuenta | Verificado, corregido | #45 |
| A3  | Reservas «en espera» (on hold / on request) quedan `pending` para siempre: nada las refresca (`retrieve: false`, sin barrido)                                                                                                                                                | En PR                 | #63 |
| A4  | Si la persistencia falla después de confirmar, sólo se loguea: reserva viva sin orden ni evento                                                                                                                                                                              | En PR                 | #58 |
| A5  | La selección toma la primera tarifa (ppd) aunque se haya buscado «pago en destino»                                                                                                                                                                                           | Sospechado, pendiente | —   |
| A6  | El cambio de precio entre la lista, la selección y la renovación no se muestra                                                                                                                                                                                               | En PR                 | #66 |
| A7  | Un error en el autocompletado de oficinas queda en caché como «sin resultados» hasta recargar                                                                                                                                                                                | En PR                 | #54 |

**Tiempos:** el checkout espera get-selection **y luego** get-rate-information (una ida y vuelta más, 0,5–2 s) aunque el detalle sólo hace falta para el desglose de mostrador. Cada llamada hace 4–5 lecturas de base en serie (20–60 ms).

**UX:** refrescar o tocar «atrás» en el móvil pierde la búsqueda, la selección y hasta el código de la reserva hecha (todo vive en estado de React). En el móvil, «Confirmar» queda al fondo de tres tarjetas: falta una barra fija con el total y el botón.

## 4. Hoteles (Despegar, TBO)

**Funciona:** búsqueda multi-proveedor con `allSettled` y circuit breaker (la caída de TBO no rompe la búsqueda: el resultado sale `partial`), idempotencia del Book, comparación C1/C2 con aceptación del cambio y prebook bloqueado si la agencia no vende no reembolsables.

### 4.1 Despegar: la ficha sin tarifas (bloquea la venta)

`keepSearchContext` descarta todo pack sin un único `choice_id` (o sin `roomReferences`), y `PackContextSchema` exige `hotelId` y `offerRef` no vacíos. PR #42 cubre dos causas: `choice_id` en el roompack y falta del `id` de nivel superior. Quedan sin cubrir:

- Packs con varias habitaciones, cada una con su propio `choice_id` (`choices.size !== 1`).
- Roompack sin `id` (`offerRef = ''`).
- Los packs sin `room_type_id` se filtran antes y no se cuentan.

Recomendaciones para PR #42 o un PR siguiente:

- Contar los descartes **por motivo** (`no-choice`, `multi-choice`, `no-hotel-id`, `empty-ref`).
- Que el log de forma siempre incluya las rutas con `choice`, porque corta en 150 rutas.
- Que la UI diga «N tarifas no reservables» en vez de «sin tarifas».

### 4.2 Hallazgos

| #   | Hallazgo                                                                                                                                                      | Estado                | PR  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | --- |
| H1  | La descripción de Despegar con `&`, comillas o entidades rechazaba la fila de contenido entera (sin descripción ni fotos del lote)                            | Verificado, corregido | #48 |
| H2  | Sin datos de facturación (cuenta corriente) se fallaba recién en el Book, con un mensaje técnico. Una factura cargada pero inválida se descartaba en silencio | Verificado, corregido | #49 |
| H3  | Despegar: la cancelación gratis «hasta 72 h antes» nunca se compara con el reloj. Con check-in mañana no se pide la aceptación de no reembolsable             | En PR                 | #56 |
| H4  | Prebook en la moneda de la cuenta (USD) distinta a la buscada (COP): se avisa con un warning que la UI no lee                                                 | En PR                 | #60 |
| H5  | El nombre del huésped rechaza guiones y apóstrofos (García-López, O'Brien)                                                                                    | En PR                 | #62 |
| H6  | Las claves de localStorage del handoff (`hoteles:busquedas`, `hoteles:tarifas`) no van por usuario/tenant ni se borran al cerrar sesión                       | En PR                 | #67 |
| H7  | Un link de la ficha abierto en otro navegador o dispositivo dice «busca de nuevo»: la estadía vive sólo en localStorage                                       | Verificado, pendiente | —   |

**Tiempos:**

- **Venta Despegar = ~6 llamadas en serie:** detalle → C1 (detalle + prebook) → C2 (detalle + prebook) → book. Guardar el `choiceId` en `providerData` (cabe en los 8 KB) y volver a pedir el detalle sólo ante un 410 ahorra 2 llamadas (2–4 s).
- **Ficha:** `Promise.all` por proveedor. Las tarifas de Despegar esperan a TBO: hasta ~13 s si TBO se cuelga, 1–2 s con su 500 rápido. Hay que mostrar cada proveedor apenas responde (**en PR #57**).
- **Búsqueda con TBO caído:** mientras el breaker está cerrado, y en cada sonda (cada 30 s), la búsqueda espera a TBO. Mientras TBO siga en 500, conviene apagarlo con el kill-switch del panel de superadmin y agregar un plazo por ola (6–8 s; **en PR #61**, con 8 s).
- **Fotos:** el chequeo de fotos del CDN comparte una cola de 24 HEAD para todo el proceso. Un lote de 50 hoteles encola cientos y la ficha de un hotel espera detrás.

## 5. Transversal

| #   | Hallazgo                                                                                                                 | Estado                | PR  |
| --- | ------------------------------------------------------------------------------------------------------------------------ | --------------------- | --- |
| T1  | Tras cada deploy, las pestañas abiertas fallan («Failed to find Server Action»), con un «Reintentar» que repite el fallo | Verificado, corregido | #43 |
| T2  | `mfa.integration.test.ts` deja un rechazo sin manejar que a veces tumba el job de integración (visto en el CI de #46)    | En PR                 | #53 |

## 6. PRs de esta revisión

La primera tanda (#42–#51) se mergeó el 2026-11-19 por pedido del founder.

| PR  | Tema                                                                 |
| --- | -------------------------------------------------------------------- |
| #43 | Una pestaña de un deploy anterior pide recargar en vez de fallar     |
| #44 | Autos: una confirmación cortada no invita a reservar dos veces       |
| #45 | Autos: la gestión por código sólo abre reservas de la propia agencia |
| #46 | Vuelos: la orden no suma el markup fijo a una tarifa en otra moneda  |
| #47 | LATAM: la oferta revalidada vale 30 min desde OfferPrice             |
| #48 | Despegar: la descripción del hotel se escapa como pide el catálogo   |
| #49 | Despegar: sin datos de facturación se avisa en el primer prebook     |
| #50 | Vuelos: un vuelo para esta noche no vuelve «anterior a hoy»          |

### 6.1 Segunda tanda (abiertos, CI en verde)

Cada uno se mergea con la aprobación del founder **para ese PR**. Ninguno se probó en el navegador ni contra proveedores reales.

| PR  | Hallazgo | Tema                                                                         | Decisión pendiente                                                                       |
| --- | -------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| #53 | T2       | El test de carrera del 2FA no deja un rechazo sin manejar                    | —                                                                                        |
| #54 | A7       | Autos: un error del autocompletado no se cachea; «Reintentar»                | —                                                                                        |
| #55 | V4       | Vuelos: prefijo del teléfono según el país de la agencia, editable           | ¿Sabre recibe el teléfono con `+prefijo`? Probar en sandbox (cambia el PNR)              |
| #56 | H3       | Despegar: plazo de cancelación gratis con fecha; vencido = no reembolsable   | Las horas se cuentan desde las 00:00 del check-in; sin cargo informado se asume 100 %    |
| #57 | —        | Ficha de hotel: tarifas de cada proveedor apenas responde                    | —                                                                                        |
| #58 | A4       | Autos: reintento al guardar la orden; evento `CarReservationUnrecorded`      | Si Postgres cae del todo sólo queda el log (outbox fuera de PG sin decidir)              |
| #59 | V5       | Vuelos: `quote_number` bajo lock por agencia + índice único (migración 0097) | Contar duplicados en producción antes; los viejos se marcan, no se renumeran             |
| #60 | H4       | Hoteles: aviso de moneda de la cuenta en el prebook                          | ¿Pedir que el vendedor lo marque como leído?                                             |
| #61 | —        | Búsqueda de hoteles: plazo de 8 s por proveedor; el plazo no abre el breaker | Mirar el p95 de TBO antes: su `ResponseTime` es 10 s                                     |
| #62 | H5       | Despegar: nombres con guion/apóstrofo se adaptan en vez de rechazarse        | `O'Brien` → `OBrien` (¿o `O Brien`?)                                                     |
| #63 | A3       | Autos: barrido cada 30 min de las reservas en espera                         | Textos de cancelada/rechazada supuestos (confirmar en sandbox); usa la credencial actual |
| #64 | V6       | Sabre: equipaje por tramo y del primer adulto, con equipaje de mano          | `B` = mano según docs, sin fixture real; resumen/PDF muestra el menor de ida y vuelta    |
| #66 | A6       | Autos: aviso de cambio de precio; una subida pide aceptación                 | ¿Aceptación explícita o sólo aviso? ¿Umbral?                                             |
| #67 | H6       | Hoteles: localStorage por usuario y agencia, se limpia al salir              | #65 cerrado por un falso positivo de GitGuardian (UUID de test)                          |

Conflictos esperables al mergear: #58, #63 y #66 tocan `audit-format.ts` y los mismos tests; el segundo necesita un rebase simple.

### 6.2 Caída de producción del 2026-11-19

Al desplegar #42–#51, el deploy bajó una imagen nueva de la etiqueta flotante `timescale/timescaledb-ha:pg16`, sin la versión de TimescaleDB instalada en la base (2.26.4). Todo SQL falló, `migrate` cayó con exit 1 y el API y la web quedaron abajo (~20:00 UTC). No tuvo que ver con el código mergeado. El arreglo, a cargo de la sesión principal, es fijar la imagen en `pg16-ts2.26` en el servidor y en `infrastructure/hostinger/docker-compose.{prod,cert}.yml`. Lección: ninguna imagen de base de datos con etiqueta flotante.

## 7. Siguiente, por impacto en la venta

1. Revisar y mergear la segunda tanda (§6.1), resolviendo antes sus decisiones pendientes.
2. Leer el log `despegar.forma` abriendo un hotel (con #42 ya en producción) y completar §4.1: packs de varias habitaciones con `choice_id` distinto y roompacks sin `id`; descartes por motivo.
3. Apagar TBO con el kill-switch mientras su test siga en 500, y escribir a soporte de TBO.
4. Tiempos: `choiceId` guardado en Despegar, caché de `searchReturns`, plazo global de Sabre.
5. Estado en la URL (vuelos, autos, H7 en hoteles) para que «atrás», refrescar y otro dispositivo no pierdan la búsqueda.
6. A5 (tarifa de pago en destino) y las pruebas en vivo en sandbox: necesitan una sesión del panel.
7. Sabre H-07: sigue el rodeo `bookOnTicketingPcc` → `targetPcc` hasta que Sabre active «Store Passenger Type In PNR» (`docs/sabre/12-hallazgos-sandbox.md`).
