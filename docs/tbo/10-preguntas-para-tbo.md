---
titulo: TBO Hotels — Preguntas para TBO
fecha: 2026-09-23
estado: borrador
---

# TBO Hotels — Preguntas para TBO

Este documento consolida y deduplica todas las preguntas para TBO que dejaron abiertas los documentos [00](./00-fuentes.md) a [07](./07-certificacion.md). Cada pregunta tiene un ID estable (`Q-01` a `Q-94`), el contexto en español con su cita, la pregunta en inglés lista para enviar a soporte, la decisión o el código que bloquea y la postura que se aplica mientras TBO no conteste. Al final está el borrador del email (§12).

Fuentes y convención de citas: [00-fuentes.md](./00-fuentes.md) §9. "(p. N)" es la página **física** del PDF V2.1; el documento de certificación se cita "(Cert, <sección>)". Niveles de evidencia: VERIFICADO-PDF, VERIFICADO-POSTMAN, VERIFICADO-CERT, VERIFICADO-CODIGO e INFERIDO. Las posturas son decisiones de diseño nuestras, no afirmaciones sobre el contrato. Las decisiones con opciones se consolidan en [08-requisitos-maestro.md](./08-requisitos-maestro.md).

---

## 0. Cómo usar este documento

### 0.1 Prioridad

| Prioridad      | Criterio                                                                                                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bloqueante** | Sin la respuesta no se puede cerrar una decisión con impacto en dinero, seguridad, contrato o en el modelo consolidador, o no se puede certificar. La postura por defecto tiene un costo alto. |
| **Importante** | La postura por defecto es segura pero cara (latencia, experiencia del vendedor, operación) o provisoria. La respuesta cambia configuración o código acotado.                                   |
| **Menor**      | Aclaración. La postura por defecto cubre el caso sin costo relevante.                                                                                                                          |

### 0.2 Estado y cierre

- Todas las preguntas están **abiertas** al 2026-09-23, salvo las marcadas **Parcial**.
- Una pregunta queda **parcial** cuando lo observado en producción responde una parte: se anota la evidencia con su fecha en la propia pregunta, se ajusta la postura y lo que sigue sin respuesta se pregunta igual. Desde el 2026-09-29 están así [Q-08](#q-08) (la ciudad sin hoteles de `TBOHotelCodeList`) y [Q-63](#q-63) (`Latitude` y `Longitude`), por la primera corrida del sync.
- Una pregunta se cierra de dos maneras: por **respuesta de TBO** (se anota la fecha, quién respondió y el texto, y se archiva el email en `docs/tbo/evidence/`) o por **sonda** (las sondas PR-01 a PR-11 del arnés, [07](./07-certificacion.md) §6.8, y las capturas de los casos de certificación). La línea "Cierre posible" de cada pregunta dice cuál aplica.
- Una sonda solo cierra lo que observa en el entorno de test. Lo que depende de live, del contrato comercial o de una política de TBO se pregunta igual.
- Al cerrar una pregunta se actualiza la postura en el documento de origen y en [08](./08-requisitos-maestro.md). El ID no se reutiliza.
- Los documentos 00 a 09 enlazan cada hueco con su pregunta (`→ [Q-NN](./10-preguntas-para-tbo.md#q-nn)`). Las listas de preguntas en prosa de esos documentos se mapean en el Anexo A.

### 0.3 Páginas ante TBO

Las preguntas en inglés citan la página física. Desde la p. 64 el pie impreso del PDF muestra la página física menos 5 (la p. 71 imprime "66"), y el índice de pp. 2–4 no sirve para ubicar nada ([00](./00-fuentes.md) §2.1). El email lo aclara al principio, y las preguntas que citan esas páginas nombran también la sección (por ejemplo "Enumeration section").

---

## 1. Resumen

- **94 preguntas**: 14 bloqueantes, 53 importantes y 27 menores.
- Las bloqueantes caen en cuatro frentes:
  - **dinero y recuperación del Book**: formato e idempotencia de `BookingReferenceId`, respuesta de `BookingDetail` cuando la reserva no existe ([Q-34](#q-34), [Q-35](#q-35), [Q-37](#q-37));
  - **contrato comercial**: precio mínimo de venta, tarifas solo-paquete, moneda del perfil, costo por búsqueda y modo `Limit` en cuentas de agencias ([Q-23](#q-23), [Q-31](#q-31), [Q-87](#q-87), [Q-88](#q-88), [Q-90](#q-90));
  - **modelo consolidador**: alcance de la certificación y catálogo por cuenta ([Q-77](#q-77), [Q-60](#q-60));
  - **conectividad y certificación**: HTTPS en test, límite de QPS, forma de una habitación sin niños y modos de pago con tarjeta ([Q-03](#q-03), [Q-10](#q-10), [Q-13](#q-13), [Q-81](#q-81)).
- Once preguntas se pueden cerrar o confirmar con las sondas PR-01 a PR-11 antes de que TBO responda ([07](./07-certificacion.md) §6.8). Las comerciales solo las cierra TBO.
- Al consolidar aparecieron diez posturas por defecto distintas entre documentos (§10). No son preguntas para TBO: [08](./08-requisitos-maestro.md) §9 fijó la regla de cada una y los documentos de origen ya están corregidos, así que las posturas de este documento citan una sola variante.

| §   | Grupo                            | Preguntas   | Bloqueantes | Importantes | Menores |
| --- | -------------------------------- | ----------- | ----------: | ----------: | ------: |
| §3  | Contrato, conectividad y errores | Q-01 a Q-12 |           2 |           7 |       3 |
| §4  | Search                           | Q-13 a Q-28 |           2 |           8 |       6 |
| §5  | PreBook y Book                   | Q-29 a Q-44 |           4 |          10 |       2 |
| §6  | Post-venta                       | Q-45 a Q-59 |           0 |          11 |       4 |
| §7  | Contenido estático               | Q-60 a Q-70 |           1 |           5 |       5 |
| §8  | Certificación                    | Q-71 a Q-86 |           2 |           7 |       7 |
| §9  | Comercial y cuenta               | Q-87 a Q-94 |           3 |           5 |       0 |
|     | **Total**                        | **94**      |      **14** |      **53** |  **27** |

---

## 2. Índice

| Q             | Tema                                                                            | Grupo         | Prioridad  | Estado  | Cierre posible           |
| ------------- | ------------------------------------------------------------------------------- | ------------- | ---------- | ------- | ------------------------ |
| [Q-01](#q-01) | Revisión vigente del contrato y avisos de cambios                               | Conectividad  | Importante | Abierta | Solo TBO                 |
| [Q-02](#q-02) | "Hotel Search Workflow" deprecado                                               | Conectividad  | Menor      | Abierta | Solo TBO                 |
| [Q-03](#q-03) | HTTPS en el host de test                                                        | Conectividad  | Bloqueante | Abierta | PR-03                    |
| [Q-04](#q-04) | URL de producción                                                               | Conectividad  | Importante | Abierta | Solo TBO                 |
| [Q-05](#q-05) | Casing de los paths y verbos HTTP                                               | Conectividad  | Importante | Abierta | PR-04                    |
| [Q-06](#q-06) | Basic Auth: juego de caracteres, rotación y allowlist de IP                     | Conectividad  | Importante | Abierta | Solo TBO                 |
| [Q-07](#q-07) | HTTP de transporte frente a `Status.Code`, y muestras de error reales           | Conectividad  | Importante | Abierta | PR-06                    |
| [Q-08](#q-08) | Códigos `Status.Code` posibles por método                                       | Conectividad  | Importante | Parcial | PR-07                    |
| [Q-09](#q-09) | Timeouts de los métodos sin recomendación                                       | Conectividad  | Menor      | Abierta | Solo TBO                 |
| [Q-10](#q-10) | Límite de QPS y concurrencia                                                    | Conectividad  | Bloqueante | Abierta | Solo TBO                 |
| [Q-11](#q-11) | Canal de soporte y logs para `UNEXPECTED_ERROR`                                 | Conectividad  | Importante | Abierta | Solo TBO                 |
| [Q-12](#q-12) | Compresión e identificador de correlación                                       | Conectividad  | Menor      | Abierta | Solo TBO                 |
| [Q-13](#q-13) | Habitación sin niños: `Children: 0` y `ChildrenAges`                            | Search        | Bloqueante | Abierta | PR-01                    |
| [Q-14](#q-14) | Límites de ocupación y de estadía                                               | Search        | Menor      | Abierta | Solo TBO                 |
| [Q-15](#q-15) | Más de 100 `HotelCodes` por request                                             | Search        | Importante | Abierta | PR-08                    |
| [Q-16](#q-16) | Semántica de `ResponseTime`                                                     | Search        | Importante | Abierta | Solo TBO                 |
| [Q-17](#q-17) | `GuestNationality`: nacionalidad o residencia                                   | Search        | Importante | Abierta | Solo TBO                 |
| [Q-18](#q-18) | `Filters`: formato de `MealType`, filtros no documentados y `NoOfRooms`         | Search        | Menor      | Abierta | PR-02                    |
| [Q-19](#q-19) | `IsDetailedResponse: true` en el detalle de un solo hotel                       | Search        | Importante | Abierta | Solo TBO                 |
| [Q-20](#q-20) | Search con varios hoteles y `201`                                               | Search        | Menor      | Abierta | Solo TBO                 |
| [Q-21](#q-21) | Desglose de precio: `DayRates`, `BasePrice` y `TotalTax`                        | Search        | Menor      | Abierta | Captura en certificación |
| [Q-22](#q-22) | `ExtraGuestCharges`                                                             | Search        | Importante | Abierta | Solo TBO                 |
| [Q-23](#q-23) | `RecommendedSellingRate`: alcance y semántica                                   | Search        | Bloqueante | Abierta | Solo TBO                 |
| [Q-24](#q-24) | `CancelPolicies`: zona horaria, base de cálculo, moneda, `Index` y `ChargeType` | Search        | Importante | Abierta | Solo TBO                 |
| [Q-25](#q-25) | Políticas de Search con detalle frente a las de PreBook                         | Search        | Menor      | Abierta | Solo TBO                 |
| [Q-26](#q-26) | `IsRefundable` frente a los tramos de cancelación                               | Search        | Importante | Abierta | Solo TBO                 |
| [Q-27](#q-27) | `Supplements`: unidad de `Price`, catálogo de `Description` y forma             | Search        | Importante | Abierta | Solo TBO                 |
| [Q-28](#q-28) | Atributos de tarifa: enumeración `MealType` y separador de `Inclusion`          | Search        | Menor      | Abierta | Solo TBO                 |
| [Q-29](#q-29) | Ventana de 30 minutos de Search a Book                                          | PreBook/Book  | Importante | Abierta | Solo TBO                 |
| [Q-30](#q-30) | `BookingCode` de PreBook frente al de Search                                    | PreBook/Book  | Importante | Abierta | Solo TBO                 |
| [Q-31](#q-31) | Tarifas "solo con billete aéreo como parte de un paquete"                       | PreBook/Book  | Bloqueante | Abierta | Solo TBO                 |
| [Q-32](#q-32) | Formato y encoding de `RateConditions`                                          | PreBook/Book  | Menor      | Abierta | Solo TBO                 |
| [Q-33](#q-33) | `TotalFare` en el Book: validación, tolerancia y decimales                      | PreBook/Book  | Importante | Abierta | PR-10                    |
| [Q-34](#q-34) | Formato y unicidad de `BookingReferenceId` y `ClientReferenceId`                | PreBook/Book  | Bloqueante | Abierta | Solo TBO                 |
| [Q-35](#q-35) | Idempotencia del Book por `BookingReferenceId`                                  | PreBook/Book  | Bloqueante | Abierta | PR-11                    |
| [Q-36](#q-36) | Desenlaces del Book que garantizan que no hubo reserva                          | PreBook/Book  | Importante | Abierta | Solo TBO                 |
| [Q-37](#q-37) | `BookingDetail` cuando la reserva no existe                                     | PreBook/Book  | Bloqueante | Abierta | PR-05                    |
| [Q-38](#q-38) | Recuperación a 120 s: inicio del conteo y calendario                            | PreBook/Book  | Importante | Abierta | Solo TBO                 |
| [Q-39](#q-39) | Estado tras un Book `200`                                                       | PreBook/Book  | Importante | Abierta | Solo TBO                 |
| [Q-40](#q-40) | Fila vacía en la respuesta del Book                                             | PreBook/Book  | Menor      | Abierta | Solo TBO                 |
| [Q-41](#q-41) | Valores de `Title`                                                              | PreBook/Book  | Importante | Abierta | Solo TBO                 |
| [Q-42](#q-42) | Nombrar a todos los huéspedes o solo al líder                                   | PreBook/Book  | Importante | Abierta | Solo TBO                 |
| [Q-43](#q-43) | Reglas de nombres: largo, caracteres y duplicados                               | PreBook/Book  | Importante | Abierta | PR-09                    |
| [Q-44](#q-44) | Uso y formato de `EmailId` y `PhoneNumber`                                      | PreBook/Book  | Importante | Abierta | Solo TBO                 |
| [Q-45](#q-45) | Request de `BookingDetail`: identificadores y `PaymentMode`                     | Post-venta    | Menor      | Abierta | Solo TBO                 |
| [Q-46](#q-46) | Respuesta de `BookingDetail` en reservas multi-habitación                       | Post-venta    | Importante | Abierta | Captura en certificación |
| [Q-47](#q-47) | Campos de `BookingDetail`: `HotelConfirmationNumber`, `VoucherStatus` y fechas  | Post-venta    | Menor      | Abierta | Solo TBO                 |
| [Q-48](#q-48) | Lista completa de `BookingStatus`                                               | Post-venta    | Importante | Abierta | Solo TBO                 |
| [Q-49](#q-49) | Semántica del `200` de Cancel y estados intermedios                             | Post-venta    | Importante | Abierta | Solo TBO                 |
| [Q-50](#q-50) | `479 CANCEL_FAIL` y Cancel repetido                                             | Post-venta    | Importante | Abierta | Solo TBO                 |
| [Q-51](#q-51) | Cancel con `429` o `500`                                                        | Post-venta    | Importante | Abierta | Solo TBO                 |
| [Q-52](#q-52) | Cargo de cancelación y reembolso por API                                        | Post-venta    | Importante | Abierta | Solo TBO                 |
| [Q-53](#q-53) | Cancelación parcial, tras el check-in y no-show                                 | Post-venta    | Menor      | Abierta | Solo TBO                 |
| [Q-54](#q-54) | Interpretación de la tabla de SLA del HCN                                       | Post-venta    | Menor      | Abierta | Solo TBO                 |
| [Q-55](#q-55) | Canal del "operations ticket" del HCN                                           | Post-venta    | Importante | Abierta | Solo TBO                 |
| [Q-56](#q-56) | `BookingDetailsbasedondate`: claves del request                                 | Post-venta    | Importante | Abierta | Solo TBO                 |
| [Q-57](#q-57) | `BookingDetailsbasedondate`: fecha filtrada, límites y respuesta vacía          | Post-venta    | Importante | Abierta | Solo TBO                 |
| [Q-58](#q-58) | `BookingDetailsbasedondate`: significado de los campos                          | Post-venta    | Importante | Abierta | Captura en certificación |
| [Q-59](#q-59) | Alcance por cuenta de la post-venta                                             | Post-venta    | Importante | Abierta | Solo TBO                 |
| [Q-60](#q-60) | Catálogo global o por cuenta                                                    | Contenido     | Bloqueante | Abierta | Captura en certificación |
| [Q-61](#q-61) | Vigencia y tamaño de `hotelcodelist`                                            | Contenido     | Menor      | Abierta | Solo TBO                 |
| [Q-62](#q-62) | `HotelDetails`: lote máximo y códigos inexistentes                              | Contenido     | Importante | Abierta | Solo TBO                 |
| [Q-63](#q-63) | `TBOHotelCodeList` con `IsDetailedResponse: false` y tipos del request          | Contenido     | Importante | Parcial | Solo TBO                 |
| [Q-64](#q-64) | `TBOHotelCodeList`: paginación, completitud y códigos de ciudad                 | Contenido     | Menor      | Abierta | Solo TBO                 |
| [Q-65](#q-65) | Detalle por habitación (`IsRoomDetailRequired`) y `RoomID`                      | Contenido     | Menor      | Abierta | Solo TBO                 |
| [Q-66](#q-66) | Idiomas de contenido                                                            | Contenido     | Importante | Abierta | Solo TBO                 |
| [Q-67](#q-67) | Uso y caducidad de las imágenes                                                 | Contenido     | Importante | Abierta | Solo TBO                 |
| [Q-68](#q-68) | Tipos de `HotelRating`                                                          | Contenido     | Menor      | Abierta | Solo TBO                 |
| [Q-69](#q-69) | Refresco del catálogo y deltas                                                  | Contenido     | Menor      | Abierta | Solo TBO                 |
| [Q-70](#q-70) | GIATA u otro código de mapeo                                                    | Contenido     | Importante | Abierta | Solo TBO                 |
| [Q-71](#q-71) | "JSON checkpoint list" y criterios del portal                                   | Certificación | Importante | Abierta | Solo TBO                 |
| [Q-72](#q-72) | Formato del workflow y del zip; qué logs entregar                               | Certificación | Menor      | Abierta | Solo TBO                 |
| [Q-73](#q-73) | Cancelar o no las reservas de prueba                                            | Certificación | Menor      | Abierta | Solo TBO                 |
| [Q-74](#q-74) | Caso 7: suplementos                                                             | Certificación | Importante | Abierta | Solo TBO                 |
| [Q-75](#q-75) | Caso 8: método y identificador                                                  | Certificación | Menor      | Abierta | Solo TBO                 |
| [Q-76](#q-76) | Entorno de staging de la verificación de portal                                 | Certificación | Importante | Abierta | Solo TBO                 |
| [Q-77](#q-77) | Alcance de la certificación en el modelo consolidador                           | Certificación | Bloqueante | Abierta | Solo TBO                 |
| [Q-78](#q-78) | Recertificación al sumar canales                                                | Certificación | Importante | Abierta | Solo TBO                 |
| [Q-79](#q-79) | Portal en español                                                               | Certificación | Importante | Abierta | Solo TBO                 |
| [Q-80](#q-80) | Production Process Form                                                         | Certificación | Importante | Abierta | Solo TBO                 |
| [Q-81](#q-81) | Modos de pago con tarjeta en la certificación                                   | Certificación | Bloqueante | Abierta | Solo TBO                 |
| [Q-82](#q-82) | Saldo `Limit` y moneda de la cuenta de test                                     | Certificación | Importante | Abierta | Captura en certificación |
| [Q-83](#q-83) | HCN en el entorno de test                                                       | Certificación | Menor      | Abierta | Solo TBO                 |
| [Q-84](#q-84) | Alternativa a Skype                                                             | Certificación | Menor      | Abierta | Solo TBO                 |
| [Q-85](#q-85) | Métodos estáticos en el workflow y contenido en el portal                       | Certificación | Menor      | Abierta | Solo TBO                 |
| [Q-86](#q-86) | Plazos entre fases                                                              | Certificación | Menor      | Abierta | Solo TBO                 |
| [Q-87](#q-87) | Costo por búsqueda o ratio búsqueda/reserva                                     | Comercial     | Bloqueante | Abierta | Solo TBO                 |
| [Q-88](#q-88) | Moneda del perfil de la cuenta                                                  | Comercial     | Bloqueante | Abierta | Solo TBO                 |
| [Q-89](#q-89) | Markup de agencia en el perfil y relación entre precios                         | Comercial     | Importante | Abierta | Solo TBO                 |
| [Q-90](#q-90) | `Limit` en cuentas propias de agencias y `300` en PreBook                       | Comercial     | Bloqueante | Abierta | Solo TBO                 |
| [Q-91](#q-91) | `AGENT_BLOCKED` (402)                                                           | Comercial     | Importante | Abierta | Solo TBO                 |
| [Q-92](#q-92) | Credenciales y cuentas de test                                                  | Comercial     | Importante | Abierta | Solo TBO                 |
| [Q-93](#q-93) | Cuenta dedicada al catálogo                                                     | Comercial     | Importante | Abierta | Solo TBO                 |
| [Q-94](#q-94) | Confidencialidad de la documentación                                            | Comercial     | Importante | Abierta | Solo TBO                 |

---

## 3. Contrato, conectividad y errores (Q-01 a Q-12)

### Q-01

**Revisión vigente del contrato y avisos de cambios** · Importante · Abierta · Origen: [00](./00-fuentes.md) §2.3, F-02.

**Contexto.** El change log tiene dos filas con versión "2.1": la del 27-dic-2023 y la del 27-oct-2025, "Hotel Detail method / To get the room wise details" (p. 6). VERIFICADO-PDF. El PDF que tenemos se exportó el 2026-02-06 (metadatos, [00](./00-fuentes.md) §1).

**Pregunta (EN).**

> The change log shows two rows as version 2.1: 27 Dec 2023 and 27 Oct 2025 ("Hotel Detail method - To get the room wise details", p. 6), so the version number no longer identifies the content. (a) Is there a revision of the Hotel API specification newer than the V2.1 PDF we have (its file metadata show 6 Feb 2026)? (b) How are contract changes announced to integrated clients (mailing list, portal, release notes)? (c) How can we tell which revision is current if the version number does not change?

**Por qué la necesitamos.** Todas las citas del set apuntan a páginas de este PDF, y la fuente se fija por SHA-256 ([00](./00-fuentes.md) §1). Un cambio silencioso del contrato rompe schemas Zod y fixtures sin aviso.

**Postura si no responden.** Se fija el PDF por hash; un PDF nuevo exige hash nuevo, diff y revisión de citas ([00](./00-fuentes.md) F-02). Los schemas de respuesta toleran claves desconocidas y registran sus nombres ([02](./02-search-y-oferta-canonica.md) §10).

### Q-02

**"Hotel Search Workflow" deprecado** · Menor · Abierta · Origen: [00](./00-fuentes.md) F-01; [02](./02-search-y-oferta-canonica.md) §1; [06](./06-seams-integracion-repo.md) §9 H6.

**Contexto.** La v2.0 (16-ago-2023) dice "Implemented Hotel Search Workflow" y la v2.1 (27-dic-2023) "Depreciated Hotel Search Workflow" (p. 6). Ninguna página describe ese workflow. VERIFICADO-PDF (por ausencia fuera de p. 6). La única búsqueda documentada es `Search` por `HotelCodes` (p. 10).

**Pregunta (EN).**

> The change log records "Implemented Hotel Search Workflow" in v2.0 (16 Aug 2023) and "Depreciated Hotel Search Workflow" in v2.1 (27 Dec 2023) (p. 6), but no page describes that workflow. (a) What was it (for example, a search by city or destination)? (b) Does any active endpoint or parameter still depend on it? (c) Please confirm that the only supported availability search is `Search` by `HotelCodes` (p. 10).

**Por qué la necesitamos.** Si existiera una búsqueda por ciudad vigente, el mapa destino → `HotelCodes` de [05](./05-contenido-estatico-e-inventario.md) §8 se simplificaría mucho.

**Postura si no responden.** Solo `Search` por `HotelCodes`, con el catálogo local para resolver el destino ([05](./05-contenido-estatico-e-inventario.md) §8).

### Q-03

**HTTPS en el host de test** · Bloqueante · Abierta · Origen: [01](./01-autenticacion-conectividad-y-errores.md) §2.2, H-01; [05](./05-contenido-estatico-e-inventario.md) CE-20; [06](./06-seams-integracion-repo.md) §9 H1; [07](./07-certificacion.md) §2.3, PR-03, R-06.

**Contexto.** "All APIs should be secured with HTTPS protocol" (p. 7), pero el Test BaseURL es `http://api.tbotechnology.in/TBOHolidays_HotelAPI` en el PDF (p. 7), en el documento de certificación (Cert, TBO Hotel API Details) y en las 10 requests de Postman. VERIFICADO-PDF / VERIFICADO-CERT / VERIFICADO-POSTMAN. Con Basic Auth sobre `http`, usuario y contraseña viajan en claro. El único indicio de TLS en ese host son las imágenes `https://api.tbotechnology.in/imageresource.aspx?img=…` (p. 62); que valga para el path de la API es INFERIDO.

**Pregunta (EN).**

> Page 7 says "All APIs should be secured with HTTPS protocol", yet the test BaseURL is `http://api.tbotechnology.in/TBOHolidays_HotelAPI` in the PDF (p. 7), in the certification document and in the Postman collection. With Basic Authentication over `http`, the credentials travel in clear text. (a) Does the test host accept `https://api.tbotechnology.in/TBOHolidays_HotelAPI` with the same credentials? (b) Is the live endpoint HTTPS-only?

**Por qué la necesitamos.** Decide la excepción `http:` del schema de configuración de la cuenta (solo con `environment: 'test'` y el host exacto) y la decisión 1 de [01](./01-autenticacion-conectividad-y-errores.md) §14. Afecta al arnés de certificación y al sync de contenido.

**Cierre posible.** Sonda PR-03 ([07](./07-certificacion.md) §6.8) responde (a).

**Postura si no responden.** `http` solo con `environment: 'test'`, host exacto `api.tbotechnology.in` y credenciales de test; `https` obligatorio en live; `redirect: 'manual'` ([01](./01-autenticacion-conectividad-y-errores.md) §2.2). La contraseña de test no se reutiliza en ningún otro sistema ([07](./07-certificacion.md) §2.3).

### Q-04

**URL de producción** · Importante · Abierta · Origen: [01](./01-autenticacion-conectividad-y-errores.md) §2.3, H-02; [06](./06-seams-integracion-repo.md) §5.2, §9 H2; [07](./07-certificacion.md) §2.8.

**Contexto.** Live BaseURL: `{Live-URL}/HotelAPI` (p. 7). El host no se publica y el path difiere del de test (`/TBOHolidays_HotelAPI`). VERIFICADO-PDF. Las credenciales live se liberan con el "Production Process Form" (Cert, Sign Off / API Live Credentials). VERIFICADO-CERT.

**Pregunta (EN).**

> Page 7 gives the live BaseURL only as the placeholder `{Live-URL}/HotelAPI`, and its path differs from the test path (`/TBOHolidays_HotelAPI`). (a) What is the exact live host and path? (b) Is it delivered together with the live credentials after the Production Process Form? (c) Are the live credentials always different from the test credentials?

**Por qué la necesitamos.** Sin host live no hay constante que usar. Decide si `baseUrl` es obligatorio en la cuenta TBO (decisión 2 de [01](./01-autenticacion-conectividad-y-errores.md) §14; [06](./06-seams-integracion-repo.md) §10) y qué valida el panel BYOC.

**Postura si no responden.** `TBO_BASE_URLS` solo tiene `test`. En live, `baseUrl` es obligatorio por cuenta y no tiene valor por defecto; sin él la cuenta queda incompleta (`ProviderAccountIncompleteError`) y nunca se envían credenciales live al host de test ([01](./01-autenticacion-conectividad-y-errores.md) §2.3).

### Q-05

**Casing de los paths y verbos HTTP** · Importante · Abierta · Origen: [00](./00-fuentes.md) §3; [01](./01-autenticacion-conectividad-y-errores.md) §3.2, H-04; [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §5.2, PV-24; [05](./05-contenido-estatico-e-inventario.md) CE-04.

**Contexto.** PDF: `BaseURL/Search` (p. 10), `BaseURL/HotelDetails` (p. 56), `BaseURL/BookingDetailsbasedondate` (p. 62) y `BaseURL/hotelcodelist` (p. 54). Postman: `/search`, `/Hoteldetails` y `/BookingDetailsBasedOnDate`. VERIFICADO-PDF / VERIFICADO-POSTMAN. La ficha de autenticación dice `Method POST` (p. 7), pero `CountryList` (p. 51) y `hotelcodelist` (p. 55) son GET. VERIFICADO-PDF.

**Pregunta (EN).**

> The PDF and the Postman collection use different casing for the same method: `/Search` (p. 10) vs `/search`, `/HotelDetails` (p. 56) vs `/Hoteldetails`, and `/BookingDetailsbasedondate` (p. 62) vs `/BookingDetailsBasedOnDate`; in the PDF, `hotelcodelist` (p. 54) is the only lower-case path. (a) Is path routing case-insensitive on both the test and the live hosts? (b) Which casing is canonical for each method? (c) The authentication table on page 7 says "Method POST", but `CountryList` (p. 51) and `hotelcodelist` (p. 55) are documented as GET. Do these two accept only GET, or also POST?

**Por qué la necesitamos.** Los paths viven en una sola constante (`TBO_OPERATIONS`). Un 404 por casing se clasifica como `CLIENT_BUG` y nunca como "sin disponibilidad" ([01](./01-autenticacion-conectividad-y-errores.md) §3.2).

**Cierre posible.** Sonda PR-04 ([07](./07-certificacion.md) §6.8), que prueba las dos grafías de `Search`, `HotelDetails`, `BookingDetailsbasedondate` y `hotelcodelist`.

**Postura si no responden.** Casing del PDF en una sola constante para todas las operaciones, verbo por operación y sonda en certificación con el casing de Postman como alternativa; la grafía que funcione queda en la constante ([01](./01-autenticacion-conectividad-y-errores.md) §3.2; [08](./08-requisitos-maestro.md) §9 C-03).

### Q-06

**Basic Auth: juego de caracteres, rotación y allowlist de IP** · Importante · Abierta · Origen: [01](./01-autenticacion-conectividad-y-errores.md) §1.2, H-19.

**Contexto.** El PDF solo dice "The API uses the Basic Auth protocol for this authentication" y "TBO provided Username and Password should be used in the authorization" (p. 7). No menciona expiración ni rotación de contraseña, ni allowlist de IP de origen. VERIFICADO-PDF (por ausencia, búsqueda en todo el texto).

**Pregunta (EN).**

> Page 7 only says to use Basic Auth with the TBO-provided username and password. (a) Which character encoding applies to non-ASCII characters in the username or password (we assume UTF-8, as in RFC 7617)? (b) What is the password rotation policy, and is there an overlap period in which the old and the new password are both valid? (c) Do you restrict access by source IP (IP whitelisting) in test and/or live? If so, how do we register our outbound IP addresses?

**Por qué la necesitamos.** Define la validación de credenciales del panel BYOC (sin `trim` en la contraseña, [01](./01-autenticacion-conectividad-y-errores.md) §1.2), la rotación sin corte de servicio y si el VPS necesita una IP de salida declarada. Una rotación sin solape abre el circuito de la cuenta por 401 ([01](./01-autenticacion-conectividad-y-errores.md) §12.3).

**Postura si no responden.** UTF-8, sin `trim`, usuario sin `:`; rotación sustituyendo la cuenta en la bóveda; IP de salida del VPS lista para declarar si TBO la pide ([01](./01-autenticacion-conectividad-y-errores.md) H-19).

### Q-07

**HTTP de transporte frente a `Status.Code`, y muestras de error reales** · Importante · Abierta · Origen: [00](./00-fuentes.md) §8.1, F-04; [01](./01-autenticacion-conectividad-y-errores.md) §8.1, H-06; [02](./02-search-y-oferta-canonica.md) C-31; [06](./06-seams-integracion-repo.md) §4.2, §9 H3.

**Contexto.** El desenlace va en `Status.Code` del cuerpo (pp. 8–10, 13). El PDF trae 14 ejemplos de respuesta: 12 con `Code` 200, 1 con 201 (p. 18) y 1 sin `Status` (p. 55); ninguno de error. Postman no guarda respuestas. VERIFICADO-PDF / VERIFICADO-POSTMAN. Varios códigos coinciden con códigos HTTP de otro significado (402, 405) o no tienen sentido como HTTP (201, 207, 300, 315, 479). INFERIDO.

**Pregunta (EN).**

> The outcome of every call is `Status.Code` in the response body (pp. 8–10), but the PDF has no error example other than `201` (p. 18), and the Postman collection has no saved responses. (a) Does the HTTP transport status mirror `Status.Code` (for example HTTP 401, 429 or 500), or is the transport always HTTP 200 with the code in the body? (b) On a Basic Auth failure, do you return HTTP 401 without a JSON body, or a JSON body with `Status.Code` 401? (c) Could you send one real response body for each of `400`, `401`, `402`, `429`, `500`, `207`, `300`, `315`, `405` and `479`?

**Por qué la necesitamos.** El clasificador de errores y los schemas Zod de error son defensivos porque no hay muestras ([01](./01-autenticacion-conectividad-y-errores.md) §8.4, §10.3). Las respuestas reales pasan a ser fixtures del ACL ([06](./06-seams-integracion-repo.md) §7.2).

**Cierre posible.** Sonda PR-06 ([07](./07-certificacion.md) §6.8) responde (b) con credenciales erróneas.

**Postura si no responden.** Manda el cuerpo si trae un envelope válido; sin envelope se clasifica por HTTP; un `Status.Code` 200 con HTTP no-2xx es respuesta inválida; nunca se decide por `res.ok` ni por `Description` ([01](./01-autenticacion-conectividad-y-errores.md) §8.4, §10.3).

### Q-08

**Códigos `Status.Code` posibles por método** · Importante · Parcial · Origen: [01](./01-autenticacion-conectividad-y-errores.md) §8.3, §8.5, H-07; [03](./03-prebook-y-book.md) §2.12, H-15; [05](./05-contenido-estatico-e-inventario.md) §2.5, §13, CE-21.

**Contexto.** La tabla "Response Status" lista 12 códigos (pp. 8–10) sin decir qué método devuelve cuál. El único ejemplo de error es el `201` de Search (p. 18). VERIFICADO-PDF.

**Evidencia (2026-09-29).** Primera corrida del sync en producción con la cuenta de test (`countries=CO`): `TBOHotelCodeList` contesta una ciudad **existente** sin hoteles con HTTP 200 y `{"Status":{"Code":500,"Description":"No Hotels Found"}}` (55 bytes). Pasó en 20 de las 197 ciudades pedidas en el primer intento; 16 lo repitieron en los 5 intentos y 4 devolvieron hoteles en el segundo o el tercero. Los 86 intentos con ese texto forman dos grupos: 36 entre 5.084 y 5.357 ms, entre ellos todos los de esas 4 (de 5.084 a 5.092 ms), y 50 entre 93 y 4.279 ms (42 por debajo de 0,7 s), ninguno de una ciudad que después devolviera hoteles. Las respuestas con hoteles de esas 4 tardaron como mucho entre ≈ 2,7 y 4,8 s, cota por marcas de tiempo ([01](./01-autenticacion-conectividad-y-errores.md) §8.5). Queda respondido el código de una ciudad sin hoteles en `TBOHotelCodeList`; el resto de la pregunta sigue abierto, y la evidencia abre la parte (c).

**Pregunta (EN).**

> The Response Status table lists 12 codes (pp. 8–10) but does not say which method can return which. Please give the list of possible `Status.Code` values for `Search`, `PreBook`, `Book`, `BookingDetail`, `Cancel`, `BookingDetailsbasedondate`, `CountryList`, `CityList`, `TBOHotelCodeList`, `HotelDetails` and `hotelcodelist`. In particular: (a) can `PreBook` return `201`, `207`, `300` or `315`? (b) What do the static methods return for a nonexistent `CountryCode` or `CityCode`, or for an account without permission? (c) In the test environment, `TBOHotelCodeList` answers some cities listed by `CityList` with HTTP 200 and `{"Status":{"Code":500,"Description":"No Hotels Found"}}`. We read it as "this city has no hotels". Is that the intended meaning? For a few cities the same request returned a normal hotel list when retried a few seconds later, and those first answers took about 5 seconds. Can "No Hotels Found" also be returned when an internal timeout expires? If so, how can we tell the two cases apart?

**Por qué la necesitamos.** La política por código ([01](./01-autenticacion-conectividad-y-errores.md) §8.3) y la clasificación del Book ([03](./03-prebook-y-book.md) §3.9) aceptan cualquier código en cualquier operación. Con el reparto real, un código imposible para ese método se convierte en alerta. La parte (c) decide si una ciudad "vacía" puede esperar 30 días (`TBO_SYNC_EMPTY_REFRESH_DAYS`) o hay que volver a pedirla antes.

**Cierre posible.** Sonda PR-07 ([07](./07-certificacion.md) §6.8): PreBook con un `BookingCode` inventado. La parte (c) solo la cierra TBO.

**Postura si no responden.** Cualquier código se acepta en cualquier operación; la política depende de la operación; un código fuera de la tabla es `UNKNOWN_CODE` con alerta al operador ([01](./01-autenticacion-conectividad-y-errores.md) §8.3, §8.4). En `TBOHotelCodeList`, el 500 "No Hotels Found" con HTTP 2xx que llega en menos de 4.500 ms (`TBO_SLOW_NO_HOTELS_FOUND_MS`) es una lista vacía en una sola llamada, sin reintento; la ciudad nueva queda con `hotel_count = 0` y vuelve con la cadencia de las vacías, y una ciudad que tenía hoteles nunca se barre con esa respuesta ([05](./05-contenido-estatico-e-inventario.md) §6.3, §6.5). El que tarda 4.500 ms o más se trata como un plazo interno vencido: `UPSTREAM` con reintento, `reason: "slow_no_hotels_found"` en el log y, si no se recupera en los 5 intentos, la ciudad fallida, que se vuelve a pedir en la próxima corrida ([01](./01-autenticacion-conectividad-y-errores.md) §8.5). Si TBO confirma el plazo y su duración, se ajusta el umbral.

### Q-09

**Timeouts de los métodos sin recomendación** · Menor · Abierta · Origen: [01](./01-autenticacion-conectividad-y-errores.md) §5.2, H-11; [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §1, PV-20; [05](./05-contenido-estatico-e-inventario.md) §10, CE-15; [06](./06-seams-integracion-repo.md) §4.3.

**Contexto.** La tabla de timeouts solo cubre Search "5-23 Seconds", PreBook "23 Seconds" y Book "120 Seconds" (p. 8). VERIFICADO-PDF.

**Pregunta (EN).**

> The timeout table on page 8 only covers `Search` (5–23 s), `PreBook` (23 s) and `Book` (120 s). What timeouts do you recommend for `BookingDetail`, `Cancel`, `BookingDetailsbasedondate`, `CountryList`, `CityList`, `TBOHotelCodeList`, `HotelDetails` and `hotelcodelist`?

**Por qué la necesitamos.** Son valores de `TBO_OPERATIONS` ([01](./01-autenticacion-conectividad-y-errores.md) §10.2) y de la configuración del sync ([05](./05-contenido-estatico-e-inventario.md) §10). Un timeout demasiado corto en Cancel deja la cancelación `UNVERIFIED` sin necesidad.

**Postura si no responden.** BookingDetail 30 s; Cancel 60 s; BookingDetailsbasedondate 60 s; CountryList y CityList 30 s; TBOHotelCodeList 60 s; hotelcodelist 180 s; HotelDetails 60 s de techo en `TBO_OPERATIONS`, con 45 s configurados en el sync ([01](./01-autenticacion-conectividad-y-errores.md) §5.2; [05](./05-contenido-estatico-e-inventario.md) §10; [08](./08-requisitos-maestro.md) RNF-01, §9 C-14). La configuración solo puede acortarlos.

### Q-10

**Límite de QPS y concurrencia** · Bloqueante · Abierta · Origen: [01](./01-autenticacion-conectividad-y-errores.md) §7.1, H-14; [02](./02-search-y-oferta-canonica.md) §4, C-08; [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) PV-21, PV-41; [05](./05-contenido-estatico-e-inventario.md) §10, CE-15; [06](./06-seams-integracion-repo.md) §4.3, §9 H9.

**Contexto.** `LIMIT_EXCEEDED` = `429`, "QPS Exceeded", "Requests have exceeded allowed QPS." (p. 9). El valor no se publica. VERIFICADO-PDF.

**Pregunta (EN).**

> Code `429 LIMIT_EXCEEDED` means "Requests have exceeded allowed QPS" (p. 9), but the allowed value is not published. (a) What is the QPS limit? (b) Is it per username or account, per source IP, per method, or global? (c) Which time window and burst apply, and is there also a limit on concurrent requests (for example, several `Search` calls in parallel with the same credentials)? (d) Do the static methods (`CountryList`, `CityList`, `TBOHotelCodeList`, `HotelDetails`, `hotelcodelist`) and the post-booking methods (`BookingDetail`, `BookingDetailsbasedondate`) share the quota with `Search`, `PreBook` and `Book`? (e) Is `429` returned as HTTP 429 or inside an HTTP 200, and do you send a `Retry-After` header? (f) Is there a recommended time window for bulk static-content downloads?

**Por qué la necesitamos.** Fija los valores por defecto del limitador por cuenta (decisión 7 de [01](./01-autenticacion-conectividad-y-errores.md) §14), cuántos lotes de 100 códigos se lanzan por búsqueda (D02-3), el ritmo y el horario del sync de contenido (decisiones 3 y 9 de [05](./05-contenido-estatico-e-inventario.md) §14) y la cuota de los jobs de HCN y conciliación.

**Postura si no responden.** Limitador por cuenta resuelta de 5 QPS y 4 concurrentes, con cupo reservado para Book, Cancel y el BookingDetail de recuperación ([01](./01-autenticacion-conectividad-y-errores.md) §7.2); una sola llamada de Search por búsqueda (D02-3 A); sync a 1 req/s con una conexión y corte tras varios 429 seguidos ([05](./05-contenido-estatico-e-inventario.md) §6.4, §10); limitador aparte para jobs de fondo ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) PV-41).

### Q-11

**Canal de soporte y logs para `UNEXPECTED_ERROR`** · Importante · Abierta · Origen: [00](./00-fuentes.md) §7, F-03; [01](./01-autenticacion-conectividad-y-errores.md) H-15, H-16; [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) PV-23; [07](./07-certificacion.md) H-11.

**Contexto.** `UNEXPECTED_ERROR` (`500`) pide enviar "complete logs (JSON request and response)" a `apisupport@tboholidays.com` (p. 9). El documento de certificación usa `apisupport@tbo.com` para el zip y para las consultas (Cert, Integration on Test Account; nota final). VERIFICADO-PDF / VERIFICADO-CERT. El RQ del Book lleva nombres, email y teléfono de huéspedes (pp. 32–33) y el RS de BookingDetail lleva sus nombres, sin email ni teléfono (pp. 44–50). VERIFICADO-PDF.

**Pregunta (EN).**

> Page 9 asks to send the complete JSON request and response logs of a `500 UNEXPECTED_ERROR` to `apisupport@tboholidays.com`, while the certification document uses `apisupport@tbo.com`. (a) Which address is current for production incidents, and which one for certification? (b) `Book` requests contain guest names, email and phone, and `BookingDetail` responses contain guest names. Do you accept request/response logs with those personal fields masked, or do you need them unmasked?

**Por qué la necesitamos.** Define el runbook de soporte y la exportación desde la bóveda de payloads (decisión 3 de [01](./01-autenticacion-conectividad-y-errores.md) §14; [01](./01-autenticacion-conectividad-y-errores.md) §11.2). Enviar datos de huéspedes por email choca con la regla de no exportar PII.

**Postura si no responden.** Certificación a `apisupport@tbo.com`; incidentes `500` a las dos direcciones; la dirección vive en el runbook y no en el código ([00](./00-fuentes.md) §7). En live se exporta redactado salvo que TBO pida el dato real ([01](./01-autenticacion-conectividad-y-errores.md) §11.2).

### Q-12

**Compresión e identificador de correlación** · Menor · Abierta · Origen: [01](./01-autenticacion-conectividad-y-errores.md) §4, H-20.

**Contexto.** El PDF no menciona compresión ni cabeceras de correlación (pp. 7–10, por ausencia). VERIFICADO-PDF.

**Pregunta (EN).**

> (a) Do responses support gzip compression (`Accept-Encoding: gzip`)? It matters for `HotelDetails` and `hotelcodelist`. (b) Is there any request or correlation identifier (header or field) that you accept or return, so that we can reference a specific call in support tickets?

**Por qué la necesitamos.** Tamaño de las descargas del sync y trazabilidad de una llamada concreta ante soporte.

**Postura si no responden.** No se envían cabeceras no documentadas; el `requestId` propio queda solo en nuestros logs; ante TBO se correlaciona con `BookingReferenceId`, `ClientReferenceId` y los RQ/RS ([01](./01-autenticacion-conectividad-y-errores.md) §4).

---

## 4. Search (Q-13 a Q-28)

### Q-13

**Habitación sin niños: `Children: 0` y `ChildrenAges`** · Bloqueante · Abierta · Origen: [02](./02-search-y-oferta-canonica.md) §2.3, §3.1, C-03, C-04; [07](./07-certificacion.md) §4.2.

**Contexto.** `Children`: "Number of Child guests (1-4) per room"; `ChildrenAges`: "The length of array is equal to the number of children in the room" (p. 11). Postman (request `Search`) envía `"Children": 0` con `"ChildrenAges": [0]`. VERIFICADO-PDF / VERIFICADO-POSTMAN. Los casos 1 y 4 de certificación no llevan niños (Cert, Integration on Test Account). VERIFICADO-CERT.

**Pregunta (EN).**

> For `PaxRooms[].Children` the table gives the range "(1-4)", and the length of `ChildrenAges` must equal the number of children (p. 11). The Postman `Search` request sends `"Children": 0` with `"ChildrenAges": [0]`. For a room with adults only (certification cases 1 and 4): (a) is `"Children": 0` valid? (b) Must `ChildrenAges` be `[]`, `[0]`, or omitted?

**Por qué la necesitamos.** Decide el builder de `PaxRooms` (`emptyChildrenAges`, [02](./02-search-y-oferta-canonica.md) §2.3) antes del primer caso de certificación.

**Cierre posible.** Sonda PR-01 ([07](./07-certificacion.md) §6.8) captura las tres formas.

**Postura si no responden.** `"Children": 0` con `"ChildrenAges": []`, con la estrategia configurable (`'empty-array' | 'omit' | 'zero'`) ([02](./02-search-y-oferta-canonica.md) §2.3).

### Q-14

**Límites de ocupación y de estadía** · Menor · Abierta · Origen: [02](./02-search-y-oferta-canonica.md) §3.1, C-05, C-06.

**Contexto.** `ChildrenAges` admite "0-18 years" y `Adults` "1-8" por habitación (pp. 10–11). No hay máximo de habitaciones por Search, ni de noches, ni de antelación (pp. 10–12, por ausencia). VERIFICADO-PDF.

**Pregunta (EN).**

> (a) `ChildrenAges` accepts "0-18 years" (p. 11). Is an 18-year-old a child or an adult? Is there an infant age cut-off with a different rate? (b) What is the maximum number of rooms (`PaxRooms` entries) per `Search`? (c) Are there limits on the number of nights per stay, or on how far in advance the check-in can be? None of these is documented on pages 10–12.

**Por qué la necesitamos.** Acota por proveedor el selector de habitaciones y el borde HTTP, que hoy admiten 1–8 habitaciones, 6 niños y edades 0–17 ([02](./02-search-y-oferta-canonica.md) §3.1).

**Postura si no responden.** 18 años es adulto en nuestro borde; `maxRoomsPerSearch` vale 8; un `400` por exceso se clasifica como error de validación nuestro; una habitación con más de 4 niños deja a TBO fuera de esa búsqueda con motivo visible ([02](./02-search-y-oferta-canonica.md) §3.1).

### Q-15

**Más de 100 `HotelCodes` por request** · Importante · Abierta · Origen: [02](./02-search-y-oferta-canonica.md) §4, C-07.

**Contexto.** `HotelCodes`: "Recommended Value; 100 hotel codes" (p. 10). VERIFICADO-PDF.

**Pregunta (EN).**

> `HotelCodes` says "Recommended Value; 100 hotel codes" (p. 10). (a) Is a request with more than 100 codes rejected (with which `Status.Code`), truncated, or only slower? (b) How does the response time scale with the number of codes?

**Por qué la necesitamos.** Decide la cobertura de hoteles TBO por búsqueda de destino (D02-3) y el tamaño de lote del fan-out ([02](./02-search-y-oferta-canonica.md) §4.3).

**Cierre posible.** Sonda PR-08 ([07](./07-certificacion.md) §6.8).

**Postura si no responden.** Lotes de hasta 100 códigos; en la salida, una sola llamada con hasta 100 códigos elegidos por relevancia (D02-3 A, [02](./02-search-y-oferta-canonica.md) §4.3).

### Q-16

**Semántica de `ResponseTime`** · Importante · Abierta · Origen: [01](./01-autenticacion-conectividad-y-errores.md) §5.3, H-12; [02](./02-search-y-oferta-canonica.md) §6.1, C-09.

**Contexto.** `ResponseTime`: Integer, "Expected response time (seconds)" (p. 11). Los ejemplos envían `23.0` (pp. 11–12) y Postman `20.0`. El timeout recomendado de Search es "5-23 Seconds" (p. 8). VERIFICADO-PDF / VERIFICADO-POSTMAN.

**Pregunta (EN).**

> `ResponseTime` is "Integer, Expected response time (seconds)" (p. 11); the examples send `23.0`, Postman sends `20.0`, and the recommended `Search` timeout is "5-23 Seconds" (p. 8). (a) Does TBO stop aggregating its suppliers when `ResponseTime` is reached and return partial results? (b) What is the valid range? (c) How should our HTTP timeout relate to `ResponseTime`? (d) Does the response time depend on the number of `HotelCodes`?

**Por qué la necesitamos.** Fija el `ResponseTime` por defecto y el timeout de Search (decisión 8 de [01](./01-autenticacion-conectividad-y-errores.md) §14), en tensión con el principio "tiempo a venta < 2 minutos" de `CLAUDE.md`.

**Postura si no responden.** `ResponseTime` configurable de 5 a 20 s, 10 s por defecto (D-TBO-17 A); timeout HTTP = `ResponseTime` + 3 s, nunca más de 23 s, dentro del "5-23 Seconds" de p. 8 ([01](./01-autenticacion-conectividad-y-errores.md) §5.3; [02](./02-search-y-oferta-canonica.md) §6.1; [08](./08-requisitos-maestro.md) §9 C-01). La certificación mide el mismo Search con 10 y con 20 s.

### Q-17

**`GuestNationality`: nacionalidad o residencia** · Importante · Abierta · Origen: [02](./02-search-y-oferta-canonica.md) §5, C-13.

**Contexto.** `GuestNationality`: "Lead guest nationality (in ISO 3166-1 alpha-2 letter country codes)", con la nota "(If Guest is resident of UAE and searching for UAE hotels then guest can send his nationality as AE)" (p. 10). Key Point 1: "We strongly recommend not to hardcode the guest nationality as this may lead to operational/financial issues. Please note TBO shall not be liable in such case." (p. 71). El Book no envía nacionalidad (pp. 32–34). VERIFICADO-PDF.

**Pregunta (EN).**

> `GuestNationality` is the lead guest's nationality, with a special note for UAE residents searching UAE hotels (p. 10), and Key Point 1 warns against hardcoding it (p. 71). (a) Outside the UAE case, should we send the guest's nationality or the country of residence (for example, a Venezuelan citizen who lives in Colombia)? (b) What happens if, at check-in, the lead guest's nationality differs from the one used in `Search`, given that `Book` does not send nationality (pp. 32–34)? (c) Does `GuestNationality` change the rate or the availability returned?

**Por qué la necesitamos.** Define el campo de nacionalidad de la búsqueda en web y WhatsApp, su rótulo (D02-1, DC-6) y si un cambio de pasajero principal obliga a buscar de nuevo.

**Postura si no responden.** Nacionalidad del pasajero principal en alfa-2, obligatoria y visible, nunca por defecto; si falta, TBO no participa en esa búsqueda; si en el Book el pasajero principal tiene otra nacionalidad, se vuelve a buscar ([02](./02-search-y-oferta-canonica.md) §5.3).

### Q-18

**`Filters`: formato de `MealType`, filtros no documentados y `NoOfRooms`** · Menor · Abierta · Origen: [02](./02-search-y-oferta-canonica.md) §2.1, §7, C-10, C-11, C-12.

**Contexto.** `Filters.MealType`: "Possible Values. All, WithMeal and RoomOnly" (p. 11); Postman envía el entero `0` y además `Filters.OrderBy`, `Filters.StarRating` y `Filters.HotelName`, que no están en la tabla (pp. 10–11). `Filters.NoOfRooms`: "Filter for the maximum number of rooms client wants to receive in the response" (p. 11); el ejemplo de una habitación envía `0` y el de dos, `2` (p. 12). VERIFICADO-PDF / VERIFICADO-POSTMAN.

**Pregunta (EN).**

> (a) `Filters.MealType` is documented as the strings "All, WithMeal and RoomOnly" (p. 11), but Postman sends the integer `0`. Which format is official? (b) Postman also sends `Filters.OrderBy`, `Filters.StarRating` and `Filters.HotelName`, which are not in the Search table (pp. 10–11). Are they supported, and with which values? (c) `Filters.NoOfRooms` is "the maximum number of rooms client wants to receive in the response" (p. 11). Does it limit the number of `Rooms[]` options per hotel, or does it refer to the number of rooms requested? What does `0` mean? The single-room example sends `0` and the two-room example sends `2` (p. 12).

**Por qué la necesitamos.** Define los filtros que envía el builder de Search (reglas S-02 y S-03 de [02](./02-search-y-oferta-canonica.md) §2.3).

**Cierre posible.** Sonda PR-02 ([07](./07-certificacion.md) §6.8) responde (a).

**Postura si no responden.** `MealType` siempre como string del enum; no se envían filtros no documentados (estrellas y nombre se filtran con el contenido estático); `NoOfRooms: 0`, leído como "sin límite" ([02](./02-search-y-oferta-canonica.md) §7).

### Q-19

**`IsDetailedResponse: true` en el detalle de un solo hotel** · Importante · Abierta · Origen: [02](./02-search-y-oferta-canonica.md) §6.2, D02-6; [07](./07-certificacion.md) §3 CK-02.

**Contexto.** Key Point 2: "It is strongly recommended to pass IsDetailedResponse as 'False', as it will decrease the overall response size and time." (p. 71). Con `true`, Search devuelve "the day-wise break-up and detailed cancel policies" (p. 11). Postman envía `true`. VERIFICADO-PDF / VERIFICADO-POSTMAN.

**Pregunta (EN).**

> Key Point 2 (p. 71) strongly recommends `IsDetailedResponse: False`. We plan to send `false` in every list search, and `true` only in a `Search` for a single `HotelCode` when the agent opens that hotel, to show cancellation policies and nightly prices before `PreBook`. Is this acceptable for certification?

**Por qué la necesitamos.** Decisión D02-6 y checkpoint CK-02 que reconstruimos en [07](./07-certificacion.md) §3.

**Postura si no responden.** D02-6 A, consolidada como D-TBO-19 (A) en [08](./08-requisitos-maestro.md). Si TBO no lo acepta, las políticas solo se muestran tras el PreBook (D-TBO-19 B) ([02](./02-search-y-oferta-canonica.md) §6.2). CK-02, la guarda G-5 y el workflow del Anexo A de [07](./07-certificacion.md) ya distinguen el Search de listado (`false`, todos los del zip) del Search de detalle (`true`, un solo hotel) ([08](./08-requisitos-maestro.md) §9 C-25).

### Q-20

**Search con varios hoteles y `201`** · Menor · Abierta · Origen: [02](./02-search-y-oferta-canonica.md) §9.10, C-31; [05](./05-contenido-estatico-e-inventario.md) §11.

**Contexto.** `201 NO_AVAILABILITY`: "No available rooms for given criteria." (p. 9). El ejemplo `201` no trae `HotelResult` (p. 18). VERIFICADO-PDF.

**Pregunta (EN).**

> When a `Search` includes several `HotelCodes`: (a) are hotels without availability simply omitted from `HotelResult`, and is `201 NO_AVAILABILITY` (p. 9, example on p. 18) returned only when none of them has availability? (b) Can a single invalid or unauthorised code make the whole request fail?

**Por qué la necesitamos.** Decide cómo se muestra un hotel ausente y cómo se trata un lote que falla ([02](./02-search-y-oferta-canonica.md) §4.3, §9.10; [05](./05-contenido-estatico-e-inventario.md) §11).

**Postura si no responden.** Un hotel ausente se trata como sin disponibilidad; `201` es una lista vacía, no un error, y no cuenta en el circuit breaker ([02](./02-search-y-oferta-canonica.md) §9.10).

### Q-21

**Desglose de precio: `DayRates`, `BasePrice` y `TotalTax`** · Menor · Abierta · Origen: [02](./02-search-y-oferta-canonica.md) §9.4, C-21.

**Contexto.** `DayRates` es "List of Array" (p. 13). En el PreBook de dos habitaciones hay dos arrays internos (p. 28), y todos los ejemplos son de una noche. VERIFICADO-PDF. La aritmética de los ejemplos de PreBook da `TotalFare` ≈ Σ `BasePrice` + `TotalTax` (pp. 24, 28). INFERIDO por cálculo.

**Pregunta (EN).**

> `DayRates` is a "List of Array" (p. 13). The two-room PreBook example has two inner arrays (p. 28), but every example is for one night. (a) Is the outer level the room and the inner level the night? (b) Does `BasePrice` exclude taxes? (c) Does `TotalFare` always include `TotalTax` (our reading of pp. 24 and 28)?

**Por qué la necesitamos.** Precio por noche que se muestra y base para comparar el total ([02](./02-search-y-oferta-canonica.md) §9.4, §13).

**Cierre posible.** Los casos de certificación usan 2 noches y cierran (a) ([07](./07-certificacion.md) §4.1).

**Postura si no responden.** `DayRates` es solo informativo; el total sale siempre de `TotalFare`; si falta el desglose, se muestra un promedio por noche rotulado como promedio ([02](./02-search-y-oferta-canonica.md) §9.4).

### Q-22

**`ExtraGuestCharges`** · Importante · Abierta · Origen: [02](./02-search-y-oferta-canonica.md) §9.4, C-26.

**Contexto.** `ExtraGuestCharges`: Decimal, "Extra Guest charges of the bookable unit (if applicable)" (p. 13), pero llega como string. Para el mismo `BookingCode` (`1120548!TB!4!TB!9a47646b-…`) vale `"17.22"` en Search (p. 17) y `"6.45"` en PreBook (p. 28), con el mismo `TotalFare` 305.75. VERIFICADO-PDF.

**Pregunta (EN).**

> `ExtraGuestCharges` is declared Decimal, "Extra Guest charges of the bookable unit (if applicable)" (p. 13), but arrives as a string. For the same `BookingCode` (`1120548!TB!4!TB!9a47646b-…`) it is `"17.22"` in the Search example (p. 17) and `"6.45"` in the PreBook example (p. 28), with the same `TotalFare`. (a) Is it included in `TotalFare`, or paid at the hotel? (b) Why did it change between Search and PreBook? (c) Must it be shown to the end customer?

**Por qué la necesitamos.** Si es un cargo en destino, hay que mostrarlo al viajero como los suplementos `AtProperty`; si está incluido, no.

**Postura si no responden.** No se suma al total ni al precio de venta; se muestra solo al vendedor como "cargo por huésped adicional informado por TBO" ([02](./02-search-y-oferta-canonica.md) §9.4).

### Q-23

**`RecommendedSellingRate`: alcance y semántica** · Bloqueante · Abierta · Origen: [02](./02-search-y-oferta-canonica.md) §9.5, C-28, D02-4; [03](./03-prebook-y-book.md) §2.2; [06](./06-seams-integracion-repo.md) TP-29; [07](./07-certificacion.md) §3 CK-09, H-09.

**Contexto.** "The minimum selling rate for the requested booking. The B2C client cannot sell the room at a rate lower than the RecommendedSellingRate returned in the response, if any." (p. 13; igual en PreBook, p. 21). Es String y puede no venir. VERIFICADO-PDF. En los ejemplos queda un 5,1 % por encima de `TotalFare` (160.67/152.88 y 321.34/305.75, pp. 15, 17). INFERIDO por cálculo.

**Pregunta (EN).**

> `RecommendedSellingRate` is "the minimum selling rate for the requested booking. The B2C client cannot sell the room at a rate lower than the RecommendedSellingRate returned in the response, if any" (p. 13; p. 21 for PreBook). Our platform serves travel agencies (B2B) that resell to their own end travellers (B2B2C), through a web portal and WhatsApp. (a) Does the floor apply when a B2B agency on our platform sells the room to its end traveller? (b) Does it apply to the hotel component when the hotel is sold inside a package with a single total price? (c) Is it expressed in the profile currency, tax-inclusive, and for the whole booking (all rooms and nights)? (d) Which value binds: the one returned by `Search` or the one returned by `PreBook`?

**Por qué la necesitamos.** Decide si el pricing waterfall aplica un piso y en qué canales (D02-4), el precio implícito del hotel dentro de un paquete (Package Studio) y el checkpoint CK-09 de la verificación de portal.

**Postura si no responden.** El piso se aplica a todo precio final al viajero, en todos los canales; si la cascada queda por debajo, el precio sube hasta el piso y la diferencia se atribuye al tenant que vende; se recalcula con el valor de PreBook (D02-4 A, consolidada como D-TBO-16 A; [02](./02-search-y-oferta-canonica.md) §9.5; [03](./03-prebook-y-book.md) §2.2; [06](./06-seams-integracion-repo.md) TP-29; [08](./08-requisitos-maestro.md) §9 C-18).

### Q-24

**`CancelPolicies`: zona horaria, base de cálculo, moneda, `Index` y `ChargeType`** · Importante · Abierta · Origen: [02](./02-search-y-oferta-canonica.md) §9.6, C-19, C-22, C-23; [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) PV-10.

**Contexto.** Cada tramo trae `Index` (String; "If missing, policies are applicable for entire booking"), `FromDate` ("Cancel policy start date"), `ChargeType` ("e.g., fixed amount, percentage value etc.") y `CancellationCharge` (p. 14). En los ejemplos `FromDate` llega como `DD-MM-YYYY HH:mm:ss` sin offset (pp. 24, 50) e `Index` no aparece. VERIFICADO-PDF. El único indicio de zona horaria es un texto de condiciones: "the cancellation policy is based on the hotel�s time" (p. 51; el apóstrofo llega como carácter de reemplazo).

**Pregunta (EN).**

> About `CancelPolicies` (p. 14): (a) In which time zone is `FromDate`? It arrives as `DD-MM-YYYY HH:mm:ss` without an offset (pp. 24, 50). Is it always the hotel's local time? (b) For `ChargeType: Percentage`, what is the base: the `TotalFare` of the whole booking, or the room identified by `Index`? (c) In which currency is a `Fixed` charge expressed? (d) Is `Index` 1-based, and does it arrive as a string or as a number? (e) Which `ChargeType` values exist besides `Fixed` and `Percentage` (the table says "etc.")? For example, is there a per-night charge?

**Por qué la necesitamos.** Con estas políticas se calcula la penalidad estimada que se muestra antes de cancelar (PV-D) y la fecha de cancelación gratuita ([02](./02-search-y-oferta-canonica.md) §9.6; [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §4.5).

**Postura si no responden.** `FromDate` como hora local del hotel sin offset, guardando el literal y el valor parseado; `Percentage` sobre el `TotalFare` del pack, o de la habitación si hay `Index`; `Fixed` en la moneda del `HotelResult`; `Index` base 1, string o número; un `ChargeType` desconocido cuenta como penalidad del 100 % ([02](./02-search-y-oferta-canonica.md) §9.6).

### Q-25

**Políticas de Search con detalle frente a las de PreBook** · Menor · Abierta · Origen: [02](./02-search-y-oferta-canonica.md) §6.2, C-34.

**Contexto.** Key Point 3: "Cancellation Policy and Norms received in the PreBook response will be considered as final for the booking itinerary." (p. 71). Search solo trae políticas con `IsDetailedResponse: true` (p. 11). VERIFICADO-PDF.

**Pregunta (EN).**

> When `Search` is called with `IsDetailedResponse: true` (p. 11), are its `CancelPolicies` expected to match the ones returned by `PreBook` for the same `BookingCode`, or can they differ? Key Point 3 (p. 71) says that the PreBook ones are final.

**Por qué la necesitamos.** Qué rótulo llevan las políticas en el detalle de hotel (D02-6).

**Postura si no responden.** Las políticas de Search se muestran como "sujetas a confirmación"; mandan las de PreBook ([02](./02-search-y-oferta-canonica.md) §6.2).

### Q-26

**`IsRefundable` frente a los tramos de cancelación** · Importante · Abierta · Origen: [02](./02-search-y-oferta-canonica.md) §9.6, C-24; [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) PV-09.

**Contexto.** En el ejemplo de BookingDetail, `IsRefundable` vale `false` y `CancelPolicies` tiene dos tramos `Fixed` de `0.00` antes del de `Percentage` 100 (p. 50). VERIFICADO-PDF.

**Pregunta (EN).**

> In the `BookingDetail` example (p. 50), `IsRefundable` is `false` while `CancelPolicies` has two `Fixed` tranches of `0.00` before the 100 % one. When the flag and the tranches disagree, which one is authoritative for the cancellation charge?

**Por qué la necesitamos.** Qué se promete al viajero ("reembolsable" o no) y cómo se calcula la penalidad estimada (PV-D).

**Postura si no responden.** Se guardan y se muestran los dos, sin derivar uno del otro ([02](./02-search-y-oferta-canonica.md) §9.6; [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) PV-09).

### Q-27

**`Supplements`: unidad de `Price`, catálogo de `Description` y forma** · Importante · Abierta · Origen: [02](./02-search-y-oferta-canonica.md) §9.7, C-25; [07](./07-certificacion.md) §4.9.

**Contexto.** `Supplements` es "List of Object" en la tabla, con `Index`, `Type` (`Included` o `AtProperty`), `Description`, `Price` y `Currency` (pp. 14–15); los ejemplos traen un array de arrays por habitación, con `mandatory_tax` 20.00 AED (pp. 15, 17). En un PreBook del mismo hotel, `RateConditions` dice "AED 20.00 per accommodation, per night" (p. 31). Key Point 4 pide mostrar los `AtProperty` antes o en el paso de reserva (p. 71). VERIFICADO-PDF.

**Pregunta (EN).**

> (a) Is `Supplements[].Price` per night, per room or per stay? One example shows `mandatory_tax` 20.00 AED (p. 15), while the matching `RateConditions` say "AED 20.00 per accommodation, per night" (p. 31), but the example is for one night only. (b) Is there a catalogue of `Description` values (such as `mandatory_tax`)? (c) The table declares a "List of Object" (p. 14), but the examples use an array of arrays, one per room (pp. 15, 17). Which format is guaranteed? (d) Is the supplement `Currency` always the hotel's local currency?

**Por qué la necesitamos.** Cómo se muestran los cargos a pagar en el hotel (Key Point 4, checkpoint CK-08, caso 7 de certificación) sin multiplicarlos por error.

**Postura si no responden.** Se muestra el importe tal cual, con su moneda y el rótulo "según condiciones del hotel"; nunca se suma al total ni se convierte; el ACL acepta las dos formas y normaliza por `Index` ([02](./02-search-y-oferta-canonica.md) §9.7; [07](./07-certificacion.md) §4.9).

### Q-28

**Atributos de tarifa: enumeración `MealType` y separador de `Inclusion`** · Menor · Abierta · Origen: [02](./02-search-y-oferta-canonica.md) §9.8, §9.9, C-20, C-30.

**Contexto.** La tabla de Search lista tres `MealType` (p. 14) y la enumeración de p. 70 tiene diez, con casing mixto (`BreakFast`, `BreakFast_Lunch` frente a `Breakfast_For_1`, `Breakfast_For_2`); el ejemplo usa `Room_Only` (p. 15). `Inclusion` es un único String (p. 13). VERIFICADO-PDF.

**Pregunta (EN).**

> (a) Is the `MealType` enumeration (Enumeration section, p. 70, ten values) closed, and is its casing stable (`BreakFast`, `BreakFast_Lunch` vs `Breakfast_For_1`)? (b) In a double room, does `Breakfast_For_1` mean breakfast for one person only? (c) Is `BreakFast_Lunch` considered half board? (d) `Inclusion` is a single string (p. 13). When a rate has several inclusions, which separator is used?

**Por qué la necesitamos.** Mapeo al `BoardType` canónico y etiqueta que se muestra al viajero ([02](./02-search-y-oferta-canonica.md) §9.8).

**Postura si no responden.** Mapeo que ignora mayúsculas y guiones bajos y conserva el literal y la etiqueta; `BreakFast_Lunch` → `HB` con la etiqueta "Desayuno y almuerzo"; `Inclusion` no se parte ([02](./02-search-y-oferta-canonica.md) §9.8, §9.9).

---

## 5. PreBook y Book (Q-29 a Q-44)

### Q-29

**Ventana de 30 minutos de Search a Book** · Importante · Abierta · Origen: [01](./01-autenticacion-conectividad-y-errores.md) §6, H-13; [02](./02-search-y-oferta-canonica.md) §9.3; [03](./03-prebook-y-book.md) §2.10, H-11.

**Contexto.** "To complete the entire booking process i.e., from search to book, the timeout is 30 minutes." (p. 8). `BOOKINGCODE_EXPIRED` = `315`, "Session expired between search to book." (p. 9). La respuesta de PreBook no trae vencimiento (pp. 20–32). VERIFICADO-PDF.

**Pregunta (EN).**

> Page 8 says that "from search to book, the timeout is 30 minutes", and `315 BOOKINGCODE_EXPIRED` means "Session expired between search to book" (p. 9). (a) Does the 30-minute clock start when the `Search` request is sent or when its response is returned? (b) Does `PreBook` reset or extend the window, or does it have its own validity? (c) Must the `Book` request start, or complete, within the 30 minutes? (d) What happens if the session expires while a `Book` is in progress?

**Por qué la necesitamos.** Fija el vencimiento de la oferta, el aviso al vendedor y el plazo del link de pago en flujos de WhatsApp donde el cliente responde tarde (decisión 9 de [01](./01-autenticacion-conectividad-y-errores.md) §14).

**Postura si no responden.** El reloj arranca al enviar el Search; PreBook no lo renueva; `expiresAt = searchSentAt + 27 min` (30 min menos 120 s del Book y 60 s de margen), y pasado ese instante no se llama a PreBook ni se encola el Book; una oferta servida desde caché conserva su `searchSentAt` ([01](./01-autenticacion-conectividad-y-errores.md) §6.3; [03](./03-prebook-y-book.md) §2.10; [08](./08-requisitos-maestro.md) RF-09, §9 C-17).

### Q-30

**`BookingCode` de PreBook frente al de Search** · Importante · Abierta · Origen: [03](./03-prebook-y-book.md) §2.2, H-12.

**Contexto.** El Book pide el `BookingCode` "same as received in the search response" (p. 32), y PreBook devuelve su propio `HotelResult[].Rooms[].BookingCode` (pp. 20, 24). En el único par comparable del PDF los dos coinciden (pp. 17, 28). VERIFICADO-PDF.

**Pregunta (EN).**

> `Book` expects the `BookingCode` "same as received in the search response" (p. 32), and `PreBook` also returns `Rooms[].BookingCode` (p. 20). Can the `BookingCode` returned by `PreBook` differ from the one sent? If it does, which one must be sent to `Book`?

**Por qué la necesitamos.** Define qué código reenvía el builder del Book desde el snapshot de revalidación ([03](./03-prebook-y-book.md) §3.1).

**Postura si no responden.** Se usa el `BookingCode` de PreBook y se emite una alerta si difiere del de Search ([03](./03-prebook-y-book.md) §2.2).

### Q-31

**Tarifas "solo con billete aéreo como parte de un paquete"** · Bloqueante · Abierta · Origen: [02](./02-search-y-oferta-canonica.md) C-33; [03](./03-prebook-y-book.md) §2.11, H-13, D-03-D.

**Contexto.** En `RateConditions` de los dos ejemplos de PreBook: "Please note that this a special rate which should be sold only with an airline ticket as part of a package." (pp. 25, 30). No hay campo estructurado, y Search no trae ninguna señal (pp. 13–15, 20–23). VERIFICADO-PDF.

**Pregunta (EN).**

> Both PreBook examples contain, in `RateConditions`, "Please note that this a special rate which should be sold only with an airline ticket as part of a package" (pp. 25, 30). There is no structured field for it, and `Search` gives no signal. (a) Is there a flag or a parameter to identify or exclude package-only rates in `Search` or `PreBook`? (b) What is the contractual consequence of selling such a rate as a standalone hotel? (c) Does selling it together with a flight booked through another supplier satisfy the condition?

**Por qué la necesitamos.** Decide D-03-D (bloquear, advertir u ocultar esas tarifas) y si el vendedor ve en el listado tarifas que después no puede vender.

**Postura si no responden.** Detección por texto tras el PreBook y bloqueo de la venta suelta hasta que exista una reserva de paquete que vincule vuelo y hotel (D-03-D A, [03](./03-prebook-y-book.md) §2.11).

### Q-32

**Formato y encoding de `RateConditions`** · Menor · Abierta · Origen: [03](./03-prebook-y-book.md) §2.4, H-14.

**Contexto.** `RateConditions`: "Hotel/Room norms associated with the bookable unit" (p. 23). Los ejemplos traen HTML escapado como entidades (`&lt;ul&gt;&lt;li&gt;`, pp. 26, 30–31), un enlace externo (pp. 26, 30) y, en BookingDetail, caracteres de reemplazo (`�`) (p. 51). VERIFICADO-PDF.

**Pregunta (EN).**

> `RateConditions` (p. 23) contains HTML escaped as entities (for example `&lt;ul&gt;&lt;li&gt;`, pp. 26, 30–31), and the `BookingDetail` example shows replacement characters (`�`) (p. 51). (a) Is the HTML always escaped as entities? (b) Which tags can appear? (c) Which character encoding do you use in responses (UTF-8)?

**Por qué la necesitamos.** Define el saneo de `RateConditions` antes de mostrarlas en web, WhatsApp y voucher ([03](./03-prebook-y-book.md) §2.4).

**Postura si no responden.** Nunca se renderiza el HTML del proveedor: una sola decodificación de entidades, conversión a texto plano estructurado y se guardan el original y el saneado ([03](./03-prebook-y-book.md) §2.4).

### Q-33

**`TotalFare` en el Book: validación, tolerancia y decimales** · Importante · Abierta · Origen: [03](./03-prebook-y-book.md) §3.4, H-09, H-20.

**Contexto.** `TotalFare`: Decimal, "Total fare for the booking." (p. 33); el PDF no dice contra qué se valida. Los ejemplos mezclan precisiones: 85.822 (`CreditCardBillingOptions` de PreBook, p. 26), 85.82 (Book, p. 35) y 107.14000000000000 (BookingDetail, p. 49). VERIFICADO-PDF.

**Pregunta (EN).**

> `TotalFare` in `Book` is "Total fare for the booking" (p. 33). (a) Must it equal the `TotalFare` returned by the latest `PreBook`? (b) What happens if it is higher or lower than the current price: which `Status.Code` do you return, and is there a rounding tolerance? (c) With how many decimals should it be sent, especially if the account profile uses a currency with 3 decimals? The examples mix 85.822 (p. 26), 85.82 (p. 35) and 107.14000000000000 (p. 49).

**Por qué la necesitamos.** El builder del Book reenvía el literal del PreBook de revalidación (D-03-B, D-03-C) y falla cerrado si la serialización no es exacta.

**Cierre posible.** Sonda PR-10 ([07](./07-certificacion.md) §6.8).

**Postura si no responden.** Se envía el `TotalFare` del PreBook inmediatamente anterior como decimal exacto; las monedas con exponente distinto de 2 se rechazan en el ACL (D02-5 A) ([03](./03-prebook-y-book.md) §3.4).

### Q-34

**Formato y unicidad de `BookingReferenceId` y `ClientReferenceId`** · Bloqueante · Abierta · Origen: [03](./03-prebook-y-book.md) §3.3, H-04; [06](./06-seams-integracion-repo.md) §5.5; [07](./07-certificacion.md) §4.1.

**Contexto.** Los dos son String: "Client reference number." y "Booking Reference number" (p. 33). BookingDetail describe `BookingReferenceId` como "Unique booking reference ID" (p. 43). No hay formato ni largo. Los ejemplos van de 8 a 24 caracteres (`"AVw12118"`, `"1626135861wq4415-5686105"`, pp. 35–40), `"AVw123218"` se repite en 8.1.3 y 8.1.4 (pp. 37, 40) y Postman usa `"742955723103628"` (Postman: `HotelBook`). VERIFICADO-PDF / VERIFICADO-POSTMAN.

**Pregunta (EN).**

> `ClientReferenceId` and `BookingReferenceId` are free strings (p. 33), and `BookingReferenceId` is described as a "Unique booking reference ID" (p. 43), yet two examples reuse `"AVw123218"` (pp. 37, 40). (a) What maximum length and which characters are allowed in each field? (b) What is the uniqueness scope: per account, per agency, or global in TBO? Several sub-agencies in our network may share one TBO account. (c) May both fields carry the same value in the same `Book`? We plan a 20-character upper-case alphanumeric value, unique across our platform, for example `STP7K2M9QX4D8R1VZ6AB`.

**Por qué la necesitamos.** Es la clave de la recuperación obligatoria tras un Book fallido (p. 42): se genera y se persiste antes del primer Book, así que el formato tiene que ser válido desde el día uno.

**Postura si no responden.** `BookingReferenceId` de 20 caracteres `[0-9A-Z]`, generado en el servidor con un generador propio (no es la clave de idempotencia del cliente), único entre tenants (índice único) y uno por request de Book; `ClientReferenceId` con el mismo valor, también en el arnés de certificación ([03](./03-prebook-y-book.md) §3.3; [06](./06-seams-integracion-repo.md) §5.5; [07](./07-certificacion.md) §4.1; [08](./08-requisitos-maestro.md) RF-19, §9 C-08 y C-26).

### Q-35

**Idempotencia del Book por `BookingReferenceId`** · Bloqueante · Abierta · Origen: [03](./03-prebook-y-book.md) §3.3, §4.4, H-05; [06](./06-seams-integracion-repo.md) §5.5; [07](./07-certificacion.md) §6.5.

**Contexto.** `BookingReferenceId` se agregó en la v1.4 "which can be further used in Booking details method to retrieve the booking details" (p. 5). El PDF no dice qué pasa si se repite (pp. 33, 42). VERIFICADO-PDF.

**Pregunta (EN).**

> If a second `Book` arrives with a `BookingReferenceId` that was already used (for example, after a timeout on our side), does TBO (a) return the existing booking, (b) reject the request (with which `Status.Code`), or (c) create another booking? Does the answer change if the `BookingCode` is different?

**Por qué la necesitamos.** Sin idempotencia documentada, un reintento puede crear una segunda reserva cargada al crédito `Limit` de la agencia. Decide PV-C y D-03-F.

**Cierre posible.** Sonda PR-11 ([07](./07-certificacion.md) §6.8).

**Postura si no responden.** El Book nunca se reintenta de forma automática; el vendedor puede volver a reservar esa venta solo cuando la conciliación confirmó la ausencia (D-TBO-24 A), y siempre con un intent y un `BookingReferenceId` nuevos ([03](./03-prebook-y-book.md) §3.3, §4.4).

### Q-36

**Desenlaces del Book que garantizan que no hubo reserva** · Importante · Abierta · Origen: [01](./01-autenticacion-conectividad-y-errores.md) §8.5, H-18; [03](./03-prebook-y-book.md) §3.9, §6, H-08.

**Contexto.** Nota de p. 42: "In case of timeout/failure/http/network related error in book response then it is mandatory to call the BookingDetail method by using BookingReferenceId after 120 seconds of book response." `BOOKING_FAIL` = `405`, "Cannot create booking" (p. 9). "failure" no se define. VERIFICADO-PDF.

**Pregunta (EN).**

> The note on page 42 makes `BookingDetail` by `BookingReferenceId` mandatory after a "timeout/failure/http/network related error" in the book response. (a) Which `Book` response codes guarantee that no booking was created? (b) Can a `405 BOOKING_FAIL`, a `429 LIMIT_EXCEEDED` or a `500 UNEXPECTED_ERROR` returned by `Book` leave a booking created? (c) Does "failure" in that note include `405`?

**Por qué la necesitamos.** Cada código tratado como incierto cuesta al menos 120 s de verificación y deja la orden pendiente.

**Postura si no responden.** `FAILED` definitivo para `400`, `401`, `402`, `300`, `315`, `207` y `201`; incierto, con verificación por BookingDetail, para `405`, `429`, `500`, timeout, red, cuerpo ilegible o `200` sin `ConfirmationNumber` ([03](./03-prebook-y-book.md) §3.9; [01](./01-autenticacion-conectividad-y-errores.md) §8.5).

### Q-37

**`BookingDetail` cuando la reserva no existe** · Bloqueante · Abierta · Origen: [03](./03-prebook-y-book.md) §4.3, H-06; [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §3.6, §7.3, PV-01; [06](./06-seams-integracion-repo.md) §5.5.

**Contexto.** El PDF no trae ejemplos de error de BookingDetail ni dice qué devuelve para un identificador sin reserva (pp. 42–51). VERIFICADO-PDF (por ausencia).

**Pregunta (EN).**

> When `BookingDetail` is called with a `BookingReferenceId`, or a `ConfirmationNumber`, for which no booking exists: (a) which `Status.Code` and which body do you return? (b) Can a booking appear in TBO after `BookingDetail` said it did not exist, for example while the `Book` is still being processed? If so, for how long after the `Book` can that happen?

**Por qué la necesitamos.** Sin una respuesta de "no existe" documentada no se distingue "no se creó" de "falló la consulta". Decide cuándo se libera un intento incierto (PV-C, D-03-F) sin riesgo de doble reserva.

**Cierre posible.** Sonda PR-05 ([07](./07-certificacion.md) §6.8).

**Postura si no responden.** Una respuesta "no encontrada" (`Status.Code` distinto de 200 o sin `BookingDetail.ConfirmationNumber`) nunca basta para concluir que no hubo reserva. Tras el calendario de verificación la orden queda `pending` y bloqueada, con escalamiento, hasta que la conciliación por fecha, con una respuesta válida que cubra su día de creación, confirme la ausencia; operaciones puede forzar esa conciliación (D-TBO-24 A; [03](./03-prebook-y-book.md) §4.2; [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §7.3, PV-C; [08](./08-requisitos-maestro.md) §9 C-07).

### Q-38

**Recuperación a 120 s: inicio del conteo y calendario** · Importante · Abierta · Origen: [03](./03-prebook-y-book.md) §4.2, H-07; [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §7.1, §7.3.

**Contexto.** "… after 120 seconds of book response." (p. 42). El calendario de reintentos cada hora con un máximo de 3 (p. 43) es solo para el HCN. VERIFICADO-PDF.

**Pregunta (EN).**

> The note on page 42 says to call `BookingDetail` "after 120 seconds of book response". (a) Are the 120 seconds counted from sending the `Book` request, or from the moment the failure or timeout is observed? (b) If the booking is not found in that first check, how many more times, and at which intervals, should we check before concluding that no booking was created?

**Por qué la necesitamos.** Programa el job diferido de verificación y el mensaje de "verificando" que ve el vendedor.

**Postura si no responden.** 120 s desde el fallo observado (240 s desde el envío si hubo timeout), y después consultas a `tf` + 5, + 15 y + 60 min, con el job `verify-hotel-booking` ([03](./03-prebook-y-book.md) §4.2; [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §7.3; [08](./08-requisitos-maestro.md) RF-21, §9 C-06). El calendario es provisorio.

### Q-39

**Estado tras un Book `200`** · Importante · Abierta · Origen: [03](./03-prebook-y-book.md) §3.8, §3.9, H-17.

**Contexto.** Un `200` en Book significa "Booking is Confirmed or Voucher" (pp. 8–9). `BookingType` solo admite `Voucher` (pp. 33, 70) y el enum `Booking Status` no tiene estados de fallo ni de pendiente de confirmación: sus únicos estados intermedios son de cancelación (`CancellationInProgress`, `CancelPending`, …) (pp. 70–71). VERIFICADO-PDF.

**Pregunta (EN).**

> A `Book` with `Status.Code` 200 means "Booking is Confirmed or Voucher" (pp. 8–9), `BookingType` only allows `Voucher` (p. 33), and the Booking Status enumeration has no failed or pending-confirmation state: its only intermediate values are cancellation states (Enumeration section, pp. 70–71). (a) Can a `Book` that returns 200 leave the booking in a state other than confirmed, for example on request or pending hotel confirmation? (b) Does a 200 always include `ConfirmationNumber`?

**Por qué la necesitamos.** Define qué `200` se consolida como confirmado y cuál pasa al protocolo de recuperación ([03](./03-prebook-y-book.md) §3.9).

**Postura si no responden.** Un `200` sin `ConfirmationNumber`, o con un `ClientReferenceId` distinto del enviado, es incierto; todo Book `200` se cierra con BookingDetail por `ConfirmationNumber` ([03](./03-prebook-y-book.md) §3.9, §5.1).

### Q-40

**Fila vacía en la respuesta del Book** · Menor · Abierta · Origen: [03](./03-prebook-y-book.md) §3.8, H-21.

**Contexto.** La tabla 8.2 de la respuesta del Book termina con una fila en blanco (p. 40). VERIFICADO-PDF.

**Pregunta (EN).**

> The `Book` response table (section 8.2, p. 40) ends with an empty row. Is a response field missing from the documentation?

**Por qué la necesitamos.** Completar el schema Zod de la respuesta del Book.

**Postura si no responden.** Schema de respuesta tolerante a claves extra ([03](./03-prebook-y-book.md) H-21).

### Q-41

**Valores de `Title`** · Importante · Abierta · Origen: [03](./03-prebook-y-book.md) §3.2, H-02; [07](./07-certificacion.md) §4.5.

**Contexto.** `Title`: "Possible Values; 'Mr', 'Mrs', 'Ms'" (p. 32). Los niños de los ejemplos llevan `Mr` o `Ms` (pp. 34, 39). Postman (request `HotelBook`) envía `"Dr"`. VERIFICADO-PDF / VERIFICADO-POSTMAN.

**Pregunta (EN).**

> `CustomerNames[].Title` allows 'Mr', 'Mrs', 'Ms' (p. 32), but the Postman `HotelBook` request sends `"Dr"`, and the children in the examples use `Mr` or `Ms` (pp. 34, 39). (a) Which `Title` values are accepted? (b) Which title should a child have? Are `Master` or `Miss` accepted?

**Por qué la necesitamos.** Opciones del selector de título en el formulario de huéspedes (U-12 de [07](./07-certificacion.md) §8).

**Postura si no responden.** Solo `Mr`, `Mrs` y `Ms`, elegidos de forma explícita; los niños con la misma elección, como en los ejemplos ([03](./03-prebook-y-book.md) §3.2).

### Q-42

**Nombrar a todos los huéspedes o solo al líder** · Importante · Abierta · Origen: [03](./03-prebook-y-book.md) §3.2, H-01; [07](./07-certificacion.md) §4.6, §3 CK-10.

**Contexto.** `FirstName` y `LastName` se describen como "Lead guest first name" y "Lead guest last name" (pp. 32–33), pero los ejemplos 8.1.1 y 8.1.4 nombran también a los niños de cada habitación (pp. 34, 39). VERIFICADO-PDF. Los ejemplos 8.1.2 y 8.1.3 traen un adulto por habitación y el PDF no da su ocupación, así que no prueban si se nombra a todos (pp. 35–37).

**Pregunta (EN).**

> `FirstName` and `LastName` are described as "Lead guest first/last name" (pp. 32–33), but examples 8.1.1 and 8.1.4 also name the children of each room (pp. 34, 39). (a) Must we send every guest in `CustomerNames`, or only the lead guest of each room? (b) Must the first guest of each room be an adult?

**Por qué la necesitamos.** Formulario de huéspedes (U-12) y checkpoint CK-10 ([07](./07-certificacion.md) §3, §8).

**Postura si no responden.** Se envían todos los huéspedes, con el adulto líder primero, en el orden de `PaxRooms` ([03](./03-prebook-y-book.md) §3.2).

### Q-43

**Reglas de nombres: largo, caracteres y duplicados** · Importante · Abierta · Origen: [03](./03-prebook-y-book.md) §3.2, H-03, D-03-H.

**Contexto.** No hay reglas de largo, caracteres, acentos ni duplicados (pp. 32–33, por ausencia). Un texto de condiciones de hotel dice "No Name change allowed any time of the year" (p. 51). VERIFICADO-PDF.

**Pregunta (EN).**

> No rules are documented for guest names (pp. 32–33). (a) What minimum and maximum length apply to `FirstName` and `LastName`? (b) Which characters are accepted: accented letters (é, á), `ñ`, apostrophes, hyphens, spaces? This is critical for Latin American guests. (c) Is there any rule for two guests with the same first and last name in one booking?

**Por qué la necesitamos.** Decide D-03-H (transliterar a ASCII o enviar UTF-8) y los límites del formulario de huéspedes.

**Cierre posible.** Sonda PR-09 ([07](./07-certificacion.md) §6.8).

**Postura si no responden.** Transliteración a ASCII (`José Muñoz` → `Jose Munoz`) con el original en el voucher; 2 a 40 caracteres; se admiten espacio, guion y apóstrofo; se rechazan duplicados exactos ([03](./03-prebook-y-book.md) §3.2).

### Q-44

**Uso y formato de `EmailId` y `PhoneNumber`** · Importante · Abierta · Origen: [03](./03-prebook-y-book.md) §3.5, H-16, D-03-E.

**Contexto.** "Email id of the guest" y "Phone number of the guest" (p. 33). En los ejemplos el teléfono va solo con dígitos, con prefijo de país y sin `+` (pp. 35–36), y los emails son direcciones de TBO. VERIFICADO-PDF / VERIFICADO-POSTMAN.

**Pregunta (EN).**

> `EmailId` and `PhoneNumber` are described as the guest's email and phone (p. 33). (a) Do TBO or the hotel use them to contact the guest? (b) May we send the agency's operational email and phone instead of the traveller's (white label)? (c) Must `PhoneNumber` contain digits only, with the country code (as in the examples, pp. 35–36), or is a leading `+` accepted?

**Por qué la necesitamos.** Decide D-03-E (qué contacto viaja a TBO) y la normalización del teléfono.

**Postura si no responden.** Contacto operativo de la agencia, configurable por tenant; teléfono en dígitos con prefijo de país y sin `+`; el contacto del huésped queda solo en la orden (D-03-E A, [03](./03-prebook-y-book.md) §3.5).

---

## 6. Post-venta (Q-45 a Q-59)

### Q-45

**Request de `BookingDetail`: identificadores y `PaymentMode`** · Menor · Abierta · Origen: [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §3.1, PV-12.

**Contexto.** El request admite `ConfirmationNumber` o `BookingReferenceId`, más `PaymentMode` (Enumeration, por defecto `Limit`) (pp. 43–44). No se dice qué pasa con los dos identificadores a la vez o con ninguno, ni para qué sirve `PaymentMode`. VERIFICADO-PDF.

**Pregunta (EN).**

> The `BookingDetail` request accepts `ConfirmationNumber` or `BookingReferenceId`, plus `PaymentMode` (pp. 43–44). (a) What happens if both identifiers are sent, or neither? (b) What is `PaymentMode` used for in `BookingDetail`, and what changes if it is omitted?

**Por qué la necesitamos.** Forma exacta del builder de BookingDetail ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §3.1; [06](./06-seams-integracion-repo.md) §4.2).

**Postura si no responden.** Exactamente un identificador; `"PaymentMode": "Limit"` siempre explícito ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §3.1).

### Q-46

**Respuesta de `BookingDetail` en reservas multi-habitación** · Importante · Abierta · Origen: [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §3.3, §3.6, PV-06, PV-07.

**Contexto.** La tabla de respuesta es plana (pp. 44–49) y el único ejemplo es de una habitación (pp. 49–51). No se confirma dónde van `Supplements`, `CreditCardOptions` y `HotelConfirmationNumber`, ni si `Rooms` trae un elemento por habitación. VERIFICADO-PDF.

**Pregunta (EN).**

> The `BookingDetail` response table is flat (pp. 44–49) and the only example has one room (pp. 49–51). (a) In a multi-room booking, does `BookingDetail.Rooms` contain one element per room, or a single element whose `Name` array has one entry per room? (b) Where exactly are `Supplements`, `CreditCardOptions` and `HotelConfirmationNumber` located: at `BookingDetail` level or inside `Rooms[]`? Could you share a complete two-room example?

**Por qué la necesitamos.** Schema Zod de BookingDetail, voucher con suplementos `AtProperty` y validación contra la ocupación guardada.

**Cierre posible.** El BookingDetail de los casos 4 y 8 de certificación es de dos habitaciones ([07](./07-certificacion.md) §4.10).

**Postura si no responden.** Se aceptan las dos formas; la cantidad de habitaciones sale de `NoOfRooms` y de la ocupación guardada; `Supplements` se busca en los dos niveles ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §3.6).

### Q-47

**Campos de `BookingDetail`: `HotelConfirmationNumber`, `VoucherStatus` y fechas** · Menor · Abierta · Origen: [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §3.6, §8.2, PV-02, PV-03, PV-05, PV-40.

**Contexto.** `HotelConfirmationNumber` está en la tabla y no en el ejemplo (pp. 45, 49). `VoucherStatus` es Boolean con la descripción "Possible Value; Confirm, Voucher" y vale `true` en el ejemplo (pp. 45, 49). `CheckIn`, `CheckOut` y `BookingDate` dicen "Format: YYYY-MM-DD", pero el ejemplo trae `"2021-10-16T00:00:00"` y un `BookingDate` imposible, `"2021-07-1317T00:00:00"` (pp. 45, 49). VERIFICADO-PDF.

**Pregunta (EN).**

> (a) Before the hotel confirmation number exists, is `HotelConfirmationNumber` absent, `null`, `""` or a placeholder such as `"NA"`, `"Pending"` or `"0"`? Can it change after it has been delivered, and is there one per booking or one per room (p. 45)? (b) `VoucherStatus` is declared Boolean but described as "Possible Value; Confirm, Voucher" (p. 45). What does `false` mean, given that `BookingType` only allows `Voucher` (p. 33)? (c) What is the real format of `CheckIn`, `CheckOut` and `BookingDate`? The table says `YYYY-MM-DD`, but the example shows `"2021-10-16T00:00:00"` and `"2021-07-1317T00:00:00"` (p. 49). In which time zone is `BookingDate`?

**Por qué la necesitamos.** Parser tolerante de BookingDetail y seguimiento del HCN ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §3.7, §8).

**Postura si no responden.** HCN `nullish`; vacío o de relleno (`NA`, `N/A`, `Pending`, `TBA`, `0`, `-`…, lista en `providers/tbo-hotels/src/detail/hotel-confirmation-number.ts`, cada uno medido) = sin HCN, y si cambia se guarda el nuevo con evento; `VoucherStatus` boolean o string, y `false` junto a `Confirmed` = confirmada con alerta; se toman los 10 primeros caracteres de las fechas y la fecha de reserva sale de nuestro intent ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §3.6, §8.2).

### Q-48

**Lista completa de `BookingStatus`** · Importante · Abierta · Origen: [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §6.1, PV-28; [03](./03-prebook-y-book.md) H-17.

**Contexto.** El enum `Booking Status` tiene seis valores: `Confirmed`, `Cancelled`, `CancellationInProgress`, `CancelPending`, `CxlRequestSentToHotel` y `CancelledAndRefundAwaited` (pp. 70–71). El ejemplo de `BookingDetailsbasedondate` devuelve `Vouchered`, que no está en el enum (p. 64). VERIFICADO-PDF.

**Pregunta (EN).**

> The Booking Status enumeration (Enumeration section, pp. 70–71) lists six values, but the `BookingDetailsbasedondate` example (p. 64) returns `"Vouchered"`, which is not in that list. (a) What is the complete list of `BookingStatus` values? (b) Are there failed, pending-confirmation or on-request states? (c) Do `BookingDetail` and `BookingDetailsbasedondate` use the same vocabulary?

**Por qué la necesitamos.** Máquina de estados de la orden de hotel y normalización de `BookingStatus` antes de emitir eventos ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §6.3).

**Postura si no responden.** Enum abierto: `Vouchered` equivale a `Confirmed`; un valor desconocido no cambia la orden y se escala con `provider-status-unknown` ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §6.1, §6.3).

### Q-49

**Semántica del `200` de Cancel y estados intermedios** · Importante · Abierta · Origen: [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §4.2, §4.6, PV-16, PV-A.

**Contexto.** Un `200` en Cancel significa "Cancel Check: Booking is Cancelled" (p. 9); el ejemplo trae `"Description": "Cancelled"` (p. 42). El enum `Booking Status` tiene `CancellationInProgress`, `CancelPending`, `CxlRequestSentToHotel` y `CancelledAndRefundAwaited` (pp. 70–71). VERIFICADO-PDF.

**Pregunta (EN).**

> A `Cancel` that returns 200 is described as "Booking is Cancelled" (p. 9), yet the Booking Status enumeration includes `CancellationInProgress`, `CancelPending`, `CxlRequestSentToHotel` and `CancelledAndRefundAwaited` (Enumeration section, pp. 70–71). (a) Does a 200 guarantee the final state `Cancelled`, or can the booking remain in one of the intermediate states? (b) How long do those states usually take to resolve? (c) Can the hotel reject a cancellation that TBO already accepted with 200?

**Por qué la necesitamos.** Decide PV-A (qué ve la agencia mientras el hotel no confirma) y el calendario del job `verify-cancellation`.

**Postura si no responden.** `200` = cancelación aceptada; el estado lo fija un BookingDetail posterior; la orden queda `pending` con subestado hasta un estado terminal (PV-A 1); `verify-cancellation` a 2 min, 15 min, 1 h, 6 h y 24 h ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §4.4).

### Q-50

**`479 CANCEL_FAIL` y Cancel repetido** · Importante · Abierta · Origen: [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §4.2, §4.6, PV-17; [06](./06-seams-integracion-repo.md) §5.5.

**Contexto.** `CANCEL_FAIL` = `479`, "Cancel Failed", "Cannot cancel booking" (p. 9). No se documenta qué devuelve Cancel sobre una reserva ya cancelada (pp. 41–42). VERIFICADO-PDF.

**Pregunta (EN).**

> (a) Is `479 CANCEL_FAIL` ("Cannot cancel booking", p. 9) a final rejection, or can it also mean that a cancellation is already in progress? (b) What does `Cancel` return for a booking that is already cancelled: 200 or 479? (c) Is `Cancel` idempotent, i.e. is it safe to repeat it after a timeout?

**Por qué la necesitamos.** Decide cómo se presenta el 479 a la política de reintentos de cancelación del repo, que clasifica por la forma del error (`classifyCancelThrownFailure`, `apps/api/src/orders/cancel-retry-policy.ts:84`, VERIFICADO-CODIGO), y si una cancelación ambigua puede repetirse (PV-B).

**Postura si no responden.** Se lee BookingDetail antes y después de cada Cancel; el 479 no se lanza: vuelve como `{ success: false }` y la lectura posterior decide; con la reserva ya cancelada cuenta como éxito idempotente; si la lectura falla, `verify-cancellation` de solo lectura; nunca se repite un Cancel sin reconciliar ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §4.3-§4.4; [01](./01-autenticacion-conectividad-y-errores.md) §9.3; [06](./06-seams-integracion-repo.md) §5.5; [08](./08-requisitos-maestro.md) RF-25, §9 C-05).

### Q-51

**Cancel con `429` o `500`** · Importante · Abierta · Origen: [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §4.3, PV-21.

**Contexto.** `429`: "Requests have exceeded allowed QPS."; `500`: "Any undefined error returned." (p. 9). El PDF no dice si la cancelación se procesó. VERIFICADO-PDF.

**Pregunta (EN).**

> If `Cancel` returns `429 LIMIT_EXCEEDED` or `500 UNEXPECTED_ERROR` (p. 9), is it guaranteed that the cancellation was not processed?

**Por qué la necesitamos.** Si un 429 garantiza que no hubo cancelación, la operación puede reintentarse sin pasar por `UNVERIFIED` ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §4.3).

**Postura si no responden.** Los dos quedan `UNVERIFIED` con lectura por BookingDetail; nunca se reenvía un Cancel sin reconciliar ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §4.3; PV-B).

### Q-52

**Cargo de cancelación y reembolso por API** · Importante · Abierta · Origen: [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §4.5, PV-18, PV-D.

**Contexto.** La respuesta de Cancel solo trae `Status` y `ConfirmationNumber` (p. 42), y BookingDetail no tiene un campo de cargo aplicado (pp. 44–51). VERIFICADO-PDF.

**Pregunta (EN).**

> `Cancel` returns only `Status` and `ConfirmationNumber` (p. 42), and `BookingDetail` has no cancellation-charge field (pp. 44–51). (a) How can we obtain by API the cancellation charge actually applied and the amount refunded to the account? (b) After a cancellation, do `BookingDetail` or `BookingPrice` in `BookingDetailsbasedondate` reflect it?

**Por qué la necesitamos.** Decide PV-D (reembolso al cliente final estimado con aprobación manual, o automático).

**Postura si no responden.** Penalidad estimada con el snapshot de políticas de PreBook y reembolso al cliente con aprobación manual hasta cuadrar con la facturación de TBO; `refundAmount` queda vacío para TBO ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §4.5; PV-D 1).

### Q-53

**Cancelación parcial, tras el check-in y no-show** · Menor · Abierta · Origen: [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §4.6, PV-19, PV-22.

**Contexto.** Cancel solo recibe `ConfirmationNumber`, sin habitación ni motivo (p. 41). VERIFICADO-PDF.

**Pregunta (EN).**

> `Cancel` only takes `ConfirmationNumber` (p. 41). (a) Can a single room of a multi-room booking be cancelled? (b) Can a booking be cancelled on or after the check-in date, or in a no-show situation?

**Por qué la necesitamos.** Qué opciones de cancelación ofrece la UI de Reservas ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §4.6).

**Postura si no responden.** La UI no ofrece cancelar una sola habitación y bloquea la cancelación desde la fecha de check-in; a partir de ahí, soporte manual ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §4.6).

### Q-54

**Interpretación de la tabla de SLA del HCN** · Menor · Abierta · Origen: [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §8.2, PV-35, PV-36, PV-37, PV-38.

**Contexto.** "HCN will only be provided if the check-in is within 30 days of the booking" (p. 42). Tabla P0–P5 por "Check-in Window" y "HCN SLA (From Booking Time)"; "Retry every 1 hour"; "Maximum 3 retries can be made"; ejemplo: "For a check-in in 2 days (P2), first API call should be made 6 hours after booking creation" (p. 43). VERIFICADO-PDF.

**Pregunta (EN).**

> About the HCN procedure on pages 42–43: (a) Is the "Check-in Window" measured from the booking time to 00:00 hotel local time on the check-in date, or to the hotel's check-in time? (b) Do the boundaries (48, 72, 120, 192 and 336 hours; 24 is unambiguous because P0 is "< 24 hours") belong to the lower or to the upper band? Is a window of exactly 720 hours P5 or out of scope? (c) Does "Maximum 3 retries" mean 3 retries after the initial call (4 calls in total) or 3 calls in total? (d) For check-ins more than 30 days after the booking, is the HCN provided once the check-in enters the 30-day window, and if so, from when is the P5 SLA counted?

**Por qué la necesitamos.** Plan de consultas del job `hcn-check` (función pura `hcnPlan`, [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §8.3) y momento del ticket de operaciones.

**Postura si no responden.** Intervalos `[a, b)` (el límite pertenece al tramo superior), instante de check-in = 00:00 local del hotel, 4 llamadas en total, y para reservas fuera de la ventana una "entrada en ventana" en check-in − 720 h, sin ticket automático ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §8.2, §8.3).

### Q-55

**Canal del "operations ticket" del HCN** · Importante · Abierta · Origen: [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §8.6, PV-39, PV-F.

**Contexto.** "If the HCN is still not available after the SLA window and 3 retry attempts, raise an operations ticket with the relevant booking details for further assistance." (p. 43). No hay canal ni formato. VERIFICADO-PDF.

**Pregunta (EN).**

> Page 43 asks us to "raise an operations ticket with the relevant booking details" when the HCN is still missing after the SLA window and 3 retries. (a) Through which channel (email address, portal, API)? (b) Which booking details must the ticket contain? (c) May our system raise it automatically?

**Por qué la necesitamos.** Decide PV-F (cola interna de operaciones, email automático a TBO o aviso a la agencia).

**Postura si no responden.** Cola interna de operaciones sin PII; la escalada a TBO la hace una persona por el canal comercial ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §8.6; PV-F 1).

### Q-56

**`BookingDetailsbasedondate`: claves del request** · Importante · Abierta · Origen: [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §5.3, PV-25.

**Contexto.** La tabla y Postman usan `FromDate`/`ToDate` (p. 62; Postman: `BookingDetailsBasedOnDate`); el ejemplo del PDF usa `fromdate`/`todate` (p. 63). VERIFICADO-PDF / VERIFICADO-POSTMAN. El casing del path es parte de [Q-05](#q-05).

**Pregunta (EN).**

> For `BookingDetailsbasedondate`, the request table and Postman use `FromDate` / `ToDate` (p. 62), but the PDF example uses `fromdate` / `todate` (p. 63). (a) Which field names are correct, and are they case-sensitive? (b) If an unknown key is sent, is it ignored (and a default range applied) or rejected?

**Por qué la necesitamos.** Si el servidor ignorara claves mal escritas y aplicara un rango por defecto, la conciliación leería datos plausibles pero equivocados ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) Riesgos, 4).

**Postura si no responden.** `FromDate`/`ToDate` en PascalCase; toda fila con `BookingDate` fuera del rango pedido invalida la corrida ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §5.3).

### Q-57

**`BookingDetailsbasedondate`: fecha filtrada, límites y respuesta vacía** · Importante · Abierta · Origen: [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §5.3, §5.6, PV-26.

**Contexto.** El rango admite un "Maximum of 60 days (about 2 months)" (p. 62). El ejemplo pide el 9 y el 10 de noviembre y devuelve reservas con `BookingDate` de esos días (pp. 63–64); el change log dice "booking details made by the agency in the specified date" (p. 6). VERIFICADO-PDF. Que filtre por fecha de creación es INFERIDO.

**Pregunta (EN).**

> For `BookingDetailsbasedondate` (pp. 62–64): (a) Does the date range filter by booking creation date (as the example and the change log on p. 6 suggest) or by check-in date? (b) Is `ToDate` inclusive? (c) In which time zone are the dates evaluated? (d) What happens if the range exceeds 60 days? (e) Is there pagination or a maximum number of rows? (f) What does the response look like when there are no bookings in the range?

**Por qué la necesitamos.** Es la base de la conciliación diaria y de la regla de "ausencia probada" que libera intentos inciertos (PV-C).

**Postura si no responden.** Tramos de 60 días o menos, con un día de solapamiento hacia cada lado; vacío = `BookingDetail` ausente, `null` o `[]` con `Status.Code` 200; cualquier otro código es error, nunca "sin reservas" ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §5.3, §5.6, §9.5).

### Q-58

**`BookingDetailsbasedondate`: significado de los campos** · Importante · Abierta · Origen: [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §5.4, §5.6, PV-31, PV-33.

**Contexto.** La respuesta trae `BookingId` ("Unique booking id"), `ConfirmationNo`, `ClientReferenceNumber` ("Client reference number"), `TripName` (sin descripción; ejemplo `"Sharma_02Dec_Dubai"`) y `BookingStatus`, que no está en la tabla (pp. 63–64). VERIFICADO-PDF.

**Pregunta (EN).**

> In the `BookingDetailsbasedondate` response (pp. 63–64): (a) Is `ClientReferenceNumber` exactly the `ClientReferenceId` sent in `Book`? (b) What is `BookingId`, and how does it relate to `BookingReferenceId`? (c) What is `TripName`, and how is it built? The example `"Sharma_02Dec_Dubai"` seems to contain the guest's surname. (d) Is `BookingStatus` the current status or the status at creation?

**Por qué la necesitamos.** El cruce de la conciliación usa `ClientReferenceNumber` para encontrar intentos inciertos sin localizador ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §9.3).

**Cierre posible.** Reservar en certificación con un `ClientReferenceId` conocido y buscarlo por fecha ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) PV-31).

**Postura si no responden.** `ClientReferenceNumber` se trata como el `ClientReferenceId` hasta verificarlo; `TripName` se descarta; toda divergencia se confirma con BookingDetail antes de actuar ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §5.6, §9.3).

### Q-59

**Alcance por cuenta de la post-venta** · Importante · Abierta · Origen: [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §3.6, §5.6, PV-15, PV-34.

**Contexto.** `BookingDetailsbasedondate` devuelve reservas con `AgencyName` (p. 63) y el change log habla de reservas "made by the agency" (p. 6). No se dice si BookingDetail y Cancel operan sobre reservas creadas con otras credenciales. VERIFICADO-PDF; el alcance es INFERIDO.

**Pregunta (EN).**

> (a) Do `BookingDetail`, `Cancel` and `BookingDetailsbasedondate` only work on bookings created with the same credentials? (b) Can one TBO account have several API users, and if so, can each user read and cancel the bookings made by the others? (c) Does `BookingDetailsbasedondate` include bookings made through the TBO web portal with the same account?

**Por qué la necesitamos.** Con BYOC una agencia puede pasar de credencial heredada a propia. Decide si se guarda `provider_account_id` por reserva, si se bloquea borrar una cuenta con reservas activas ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §11) y qué se hace con las reservas externas (PV-G).

**Postura si no responden.** La post-venta usa siempre la cuenta con la que se creó la reserva; la conciliación va por cuenta; las reservas externas solo se reportan (PV-G 1) ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §9.2, §11).

---

## 7. Contenido estático (Q-60 a Q-70)

### Q-60

**Catálogo global o por cuenta** · Bloqueante · Abierta · Origen: [05](./05-contenido-estatico-e-inventario.md) §0, §11, CE-19; [06](./06-seams-integracion-repo.md) §9 H8.

**Contexto.** Los códigos se describen como "Unique TBOH hotel code" y "Unique TBOH City code" (pp. 55, 58, 65–66), y `hotelcodelist` promete "the complete hotel code list" (p. 54). Cada cuenta tiene un perfil propio que al menos fija la moneda (p. 13). El PDF no dice si el catálogo depende de la cuenta (pp. 51–69). VERIFICADO-PDF; la lectura es INFERIDO.

**Pregunta (EN).**

> In our consolidator model, each agency may connect its own TBO account or inherit the consolidator's account. (a) Are city codes, hotel codes and `HotelDetails` content identical for every TBO account, or can they vary by account, market or contract? (b) Can an account call `Search` with `HotelCodes` that were downloaded with a different account (for example, our platform account)? (c) If an account has no access to a hotel, is that hotel simply omitted from `HotelResult`, or does the request fail?

**Por qué la necesitamos.** Decide si el catálogo se sincroniza una sola vez con una cuenta de plataforma, en tablas globales, o por cada cuenta BYOC, lo que exige otro diseño de sync, secretos y RLS ([05](./05-contenido-estatico-e-inventario.md) §11).

**Cierre posible.** Sonda de catálogo con dos cuentas de test durante la certificación ([05](./05-contenido-estatico-e-inventario.md) §11).

**Postura si no responden.** Catálogo global sincronizado con una cuenta de plataforma; la disponibilidad sí es por cuenta ([05](./05-contenido-estatico-e-inventario.md) §11).

### Q-61

**Vigencia y tamaño de `hotelcodelist`** · Menor · Abierta · Origen: [00](./00-fuentes.md) F-05; [01](./01-autenticacion-conectividad-y-errores.md) §8.1, H-22; [05](./05-contenido-estatico-e-inventario.md) §2.4, CE-05.

**Contexto.** `GET BaseURL/hotelcodelist`, "fetch the complete hotel code list" (pp. 54–55). No está en Postman y su ejemplo no trae `Status` (p. 55). VERIFICADO-PDF / VERIFICADO-POSTMAN.

**Pregunta (EN).**

> `GET hotelcodelist` (pp. 54–55) is documented but is not in the Postman collection, and its example response has no `Status` object. (a) Is this method still active? (b) Does the real response include `Status`? (c) Roughly how many codes does it return today, and how large is the response? (d) How often is it updated? (e) Is it the same set of hotels as the union of `TBOHotelCodeList` over all cities?

**Por qué la necesitamos.** Etapa E5 del sync, que detecta bajas del catálogo ([05](./05-contenido-estatico-e-inventario.md) §6.3), y excepción de envelope sin `Status` en el cliente HTTP ([01](./01-autenticacion-conectividad-y-errores.md) §8.1).

**Postura si no responden.** Uso opcional y semanal para detectar bajas, con timeout amplio; si falla, no desactiva nada; `Status` opcional solo en este método ([05](./05-contenido-estatico-e-inventario.md) §6.3; [01](./01-autenticacion-conectividad-y-errores.md) §8.1).

### Q-62

**`HotelDetails`: lote máximo y códigos inexistentes** · Importante · Abierta · Origen: [05](./05-contenido-estatico-e-inventario.md) §2.6.1, §10, CE-15.

**Contexto.** La tabla dice "Hotel Code", Integer, en singular (p. 58); la respuesta es un array (p. 59). Postman envía 13 códigos en un solo string CSV en `Hotelcodes` (Postman: `Hotel Details`). VERIFICADO-PDF / VERIFICADO-POSTMAN.

**Pregunta (EN).**

> For `HotelDetails` (pp. 56, 58): (a) What is the maximum number of codes per call in `Hotelcodes`? The Postman request sends 13 codes as one comma-separated string. (b) Does it also accept a JSON array? (c) If one of the codes does not exist, does the whole batch fail, or is only that hotel left out?

**Por qué la necesitamos.** Tamaño de lote y costo en llamadas de la descarga de contenido (decisiones 3 y 8 de [05](./05-contenido-estatico-e-inventario.md) §14).

**Postura si no responden.** Lote de 10, nunca más de 13; si un lote falla, se parte en dos hasta aislar el código ([05](./05-contenido-estatico-e-inventario.md) §10).

### Q-63

**`TBOHotelCodeList` con `IsDetailedResponse: false` y tipos del request** · Importante · Parcial · Origen: [05](./05-contenido-estatico-e-inventario.md) §2.5, §3, §6.3, CE-08, CE-22.

**Contexto.** `TBOHotelCodeList` recibe `CityCode` (Integer) e `IsDetailedResponse` (Boolean), pero el PDF y Postman envían strings (`"130452"`, `"true"`) (p. 65; Postman: `TBOHotelCodeList`). Key Point 2 recomienda `IsDetailedResponse` en 'False' sin decir a qué método aplica (p. 71). No se documenta qué campos llegan con `false`. VERIFICADO-PDF / VERIFICADO-POSTMAN.

**Evidencia (2026-09-29).** En la primera corrida del sync en producción (cuenta de test, `countries=CO`, `IsDetailedResponse: "true"`), las 181 ciudades con hoteles trajeron por hotel `Latitude` y `Longitude`, dos claves que la tabla (p. 66) no lista: el log las registró como desconocidas (`tbo.static.unknown_keys`), por nombre y sin valores. Responde que con `"true"` hay coordenadas propias además de `Map`; no dice su tipo ni qué pasa con `"false"`, así que se agrega la parte (d).

**Pregunta (EN).**

> (a) Which fields does `TBOHotelCodeList` return when `IsDetailedResponse` is false? In particular, are `Map`, `HotelRating` and `CountryCode` included? (b) Does Key Point 2 (p. 71), which recommends 'False', apply to `Search`, to `TBOHotelCodeList`, or to both? (c) Does `TBOHotelCodeList` accept a numeric `CityCode` and a JSON boolean `IsDetailedResponse`, or only the strings used in the PDF and Postman examples (p. 65)? (d) With `IsDetailedResponse` "true", every hotel also carries `Latitude` and `Longitude`, which the response table (p. 66) does not list. Are they always present? Are they numbers or strings? If they disagree with `Map`, which one is authoritative? Are they also returned when `IsDetailedResponse` is false?

**Por qué la necesitamos.** Sin `Map`, `HotelRating` y `CountryCode` no hay inventario útil, centroides de ciudad ni deduplicación ([05](./05-contenido-estatico-e-inventario.md) §6.3). Si `Latitude` y `Longitude` llegan también con `false`, esa respuesta más liviana alcanzaría para las coordenadas.

**Postura si no responden.** Etapa E3 con `"IsDetailedResponse": "true"` (string) hasta probar `"false"` en certificación ([05](./05-contenido-estatico-e-inventario.md) §6.3). `Latitude` y `Longitude` se aceptan como número o string numérico y mandan sobre `Map` cuando dan un punto válido; si no, se usa `Map` ([05](./05-contenido-estatico-e-inventario.md) §3).

### Q-64

**`TBOHotelCodeList`: paginación, completitud y códigos de ciudad** · Menor · Abierta · Origen: [05](./05-contenido-estatico-e-inventario.md) §2.3, §2.5, §3, §10.

**Contexto.** La respuesta declara `CityId`, pero el ejemplo no lo trae (p. 66). `CityList[].Code`, `TBOHotelCodeList.CityCode` y `HotelDetails[].CityId` se describen como código de ciudad, con tipo Integer y valores string en todos los ejemplos (pp. 54, 59, 62, 65). No se documenta paginación (pp. 65–69). VERIFICADO-PDF.

**Pregunta (EN).**

> (a) Does `TBOHotelCodeList` paginate or truncate the response for large cities? Is there a maximum number of hotels per city? (b) Why does the example omit `CityId`, which the response table declares (p. 66)? (c) Are `CityList[].Code`, `TBOHotelCodeList.CityCode` and `HotelDetails[].CityId` the same code? Are city codes stable over time, and can a hotel move to a different city code? (d) The tables say Integer, but every example is a string. Which type should we send and expect?

**Por qué la necesitamos.** Guarda de sanidad del barrido por ciudad y tipo de la columna `provider_city_code` ([05](./05-contenido-estatico-e-inventario.md) §6.5, §7.2).

**Postura si no responden.** Respuesta completa, con guarda de sanidad antes de barrer; la ciudad se toma del `CityCode` de la request; códigos como `TEXT`; un hotel que cambia de ciudad se mueve por upsert ([05](./05-contenido-estatico-e-inventario.md) §3, §6.5, §7.2).

### Q-65

**Detalle por habitación (`IsRoomDetailRequired`) y `RoomID`** · Menor · Abierta · Origen: [05](./05-contenido-estatico-e-inventario.md) §2.6.3, CE-06, CE-07; [02](./02-search-y-oferta-canonica.md) §9.9, C-29.

**Contexto.** La nota "IMPORTANT NOTE" agrega `"IsRoomDetailRequired": true` y describe `RoomName`, `RoomId` (número, `197354`), `RoomSize` (`"1830 ft"`), `RoomDescription` e `imageURL` (pp. 56–57), sin la clave ni la posición del contenedor y sin ejemplo completo; la tabla no los incluye (pp. 56–59). Dice que "Search API returns a RoomID", con el ejemplo `"RoomID": ["197354"]`, y que 0 significa "mapping isn't available" (p. 57); la tabla y los ejemplos de Search no lo traen (pp. 13–18). VERIFICADO-PDF.

**Pregunta (EN).**

> The note on pages 56–57 (change of 27 Oct 2025) adds `"IsRoomDetailRequired": true` to `HotelDetails` and lists `RoomName`, `RoomId`, `RoomSize`, `RoomDescription` and `imageURL`. (a) Under which key, and at which position of the response, do the room details arrive? Could you send a complete sample response? (b) The note says that "Search API returns a RoomID" (example `"RoomID": ["197354"]`), but `RoomID` is not in the Search response table or examples (pp. 13–18). Is it always returned? Does it require a parameter? Is its type an array of strings? (c) Is `RoomSize` always in square feet?

**Por qué la necesitamos.** Contenido por habitación (`hotel_room_content`) y enlace de cada habitación de la oferta con sus imágenes ([05](./05-contenido-estatico-e-inventario.md) §2.6.3; [02](./02-search-y-oferta-canonica.md) §9.9).

**Postura si no responden.** La función queda apagada hasta tener un fixture real; `RoomId`/`RoomID` se normalizan a string y `0` significa sin mapeo; sin mapeo se usa `Rooms[].Name` de Search ([05](./05-contenido-estatico-e-inventario.md) §2.6.3; [02](./02-search-y-oferta-canonica.md) §9.9).

### Q-66

**Idiomas de contenido** · Importante · Abierta · Origen: [05](./05-contenido-estatico-e-inventario.md) §2.6.1, §10, CE-11.

**Contexto.** `Language`: "AR – Arabic, ES – Spanish, PT – Portuguese, FR – French, ZH- Chinese/Traditional Chinese" (p. 58); los ejemplos usan `"EN"` (p. 58; Postman) y `"en"` (p. 56). `TBOHotelCodeList` no tiene parámetro de idioma (p. 65). VERIFICADO-PDF / VERIFICADO-POSTMAN.

**Pregunta (EN).**

> The `Language` list for `HotelDetails` is AR, ES, PT, FR and ZH (p. 58), yet the examples use `"EN"` (p. 58) and `"en"` (p. 56). (a) Is `EN` supported? (b) Is the value case-sensitive? (c) What is returned when no translation exists for the requested language? (d) In which language does `TBOHotelCodeList` return its descriptions and facilities, given that it has no language parameter?

**Por qué la necesitamos.** El mercado inicial vende en español y portugués; decide qué idiomas se guardan (decisión 8 de [05](./05-contenido-estatico-e-inventario.md) §14).

**Postura si no responden.** Se piden `ES`, `PT` y `EN` en mayúsculas; si un idioma falla, se guarda y se muestra EN de respaldo ([05](./05-contenido-estatico-e-inventario.md) §10).

### Q-67

**Uso y caducidad de las imágenes** · Importante · Abierta · Origen: [05](./05-contenido-estatico-e-inventario.md) §2.6.2, §10, CE-17.

**Contexto.** Las imágenes de hotel se sirven desde `https://api.tbotechnology.in/imageresource.aspx?img=<token>` (p. 62) y las de habitación desde `www.tboholidays.com/imageresource.aspx?img=…` (p. 57). El PDF no habla de licencia, caché ni caducidad. VERIFICADO-PDF.

**Pregunta (EN).**

> Hotel images are served from `https://api.tbotechnology.in/imageresource.aspx?img=<token>` (p. 62) and room images from `www.tboholidays.com/imageresource.aspx` (p. 57). (a) May we display these images on our agencies' white-label portals and in WhatsApp, cache them, or copy them to our own storage? (b) Do the tokens expire? (c) Does the image host change in production? (d) Are images always served over HTTPS?

**Por qué la necesitamos.** Decisión 4 de [05](./05-contenido-estatico-e-inventario.md) §14 (hotlink o copia a MinIO/S3). Una imagen `http://` queda bloqueada como contenido mixto en el panel ([05](./05-contenido-estatico-e-inventario.md) §4).

**Postura si no responden.** Hotlink: se guarda la URL y no se copia; placeholder si la imagen falla ([05](./05-contenido-estatico-e-inventario.md) §10; opción (a) de la decisión 4 de [05](./05-contenido-estatico-e-inventario.md) §14).

### Q-68

**Tipos de `HotelRating`** · Menor · Abierta · Origen: [05](./05-contenido-estatico-e-inventario.md) §3, CE-02.

**Contexto.** `HotelRating` es "Enumeration" en las dos tablas, pero `HotelDetails` devuelve el número `5` (pp. 59, 62) y `TBOHotelCodeList` el valor `"ThreeStar"` (pp. 66–67). La enumeración `StarRating` va de `OneStar` a `FiveStar`, más `All` (pp. 69–70). VERIFICADO-PDF.

**Pregunta (EN).**

> `HotelRating` is declared as an Enumeration in both methods, but `HotelDetails` returns a number (`5`, p. 62) and `TBOHotelCodeList` returns the enum string `"ThreeStar"` (p. 67). (a) Which format should we expect from each method? (b) Can it contain half stars, `0` or values outside `OneStar`–`FiveStar`?

**Por qué la necesitamos.** Normalización de estrellas en `hotel_inventory.stars` y en los filtros ([05](./05-contenido-estatico-e-inventario.md) §3).

**Postura si no responden.** Se aceptan los dos formatos y se mapea a 1–5; `All`, `0` o un valor desconocido quedan sin estrellas ([05](./05-contenido-estatico-e-inventario.md) §3).

### Q-69

**Refresco del catálogo y deltas** · Menor · Abierta · Origen: [05](./05-contenido-estatico-e-inventario.md) §2.1, §10, §13.

**Contexto.** Ningún método estático ofrece "modified since", ETag ni paginación (pp. 51–69, por ausencia). VERIFICADO-PDF.

**Pregunta (EN).**

> None of the static methods offers deltas, a "modified since" filter or an ETag (pp. 51–69). (a) How often do you recommend refreshing the static catalogue? (b) Is there any delta mechanism? (c) How are hotel additions, removals and merges communicated?

**Por qué la necesitamos.** Cadencia y presupuesto del sync de contenido ([05](./05-contenido-estatico-e-inventario.md) §6.3, §6.4).

**Postura si no responden.** Refresco completo con upsert y barrido por ciudad, cadencia según demanda y `content_hash` para no reescribir contenido igual ([05](./05-contenido-estatico-e-inventario.md) §6.3, §6.5).

### Q-70

**GIATA u otro código de mapeo** · Importante · Abierta · Origen: [05](./05-contenido-estatico-e-inventario.md) §9, §13, §14 (decisión 6).

**Contexto.** Las respuestas de los métodos estáticos no traen ningún código de mapeo de terceros (pp. 51–69, por ausencia). VERIFICADO-PDF.

**Pregunta (EN).**

> Does TBO provide a GIATA ID, or any other hotel mapping code, that we could use to deduplicate hotels against other suppliers? None appears in the static-content responses (pp. 51–69).

**Por qué la necesitamos.** Decisión 6 de [05](./05-contenido-estatico-e-inventario.md) §14: agrupar hoteles de Despegar y TBO con una heurística o mostrar duplicados etiquetados.

**Postura si no responden.** Heurística conservadora (≤ 150 m, similitud de nombre, estrellas ± 1) con revisión manual de los casos dudosos ([05](./05-contenido-estatico-e-inventario.md) §9).

---

## 8. Certificación (Q-71 a Q-86)

### Q-71

**"JSON checkpoint list" y criterios del portal** · Importante · Abierta · Origen: [07](./07-certificacion.md) §3, H-01.

**Contexto.** TBO llena una "JSON checkpoint list" y un Excel con "Issues, Observations and General queries" en la JSON Verification y en la Portal Verification (Cert, JSON Verification; Website/Portal Verification). No se publican. VERIFICADO-CERT.

**Pregunta (EN).**

> During the JSON and portal verification you fill in a "JSON checkpoint list" and an Excel sheet of issues, observations and general queries. Could you share the checkpoint list, and the criteria for the portal verification, before we submit our samples?

**Por qué la necesitamos.** Evita rondas de corrección: hoy la lista CK-01 a CK-18 es una reconstrucción nuestra ([07](./07-certificacion.md) §3).

**Postura si no responden.** Lista reconstruida (CK-01 a CK-18) y autocomprobación `selfcheck.md` antes de enviar ([07](./07-certificacion.md) §3, §6.7).

### Q-72

**Formato del workflow y del zip; qué logs entregar** · Menor · Abierta · Origen: [07](./07-certificacion.md) §2.4, §2.5, H-02.

**Contexto.** TBO pide un workflow "where you will mention what API methods are used, flow of method calls" y los RQ/RS de los 8 casos en un zip; en la JSON Verification pide "all the JSON logs" (Cert, Integration on Test Account; JSON Verification). No hay plantilla ni convención de nombres. VERIFICADO-CERT.

**Pregunta (EN).**

> (a) Is there a template for the integration workflow document? (b) Which file names and folder layout do you expect in the certification zip? (c) Do you want only the successful Search > PreBook > Book > BookingDetail > Cancel chain of each case, or "all the JSON logs", including failed attempts (no availability, rate no longer available)?

**Por qué la necesitamos.** Forma del entregable que arma el arnés `tools/tbo/cert-cases.mjs` ([07](./07-certificacion.md) §5, §6).

**Postura si no responden.** Workflow propio (Anexo A de [07](./07-certificacion.md)); zip con una carpeta por caso, archivos numerados por paso y `README.txt`; solo cadenas completas, con los intentos y los logs a pedido ([07](./07-certificacion.md) §5).

### Q-73

**Cancelar o no las reservas de prueba** · Menor · Abierta · Origen: [07](./07-certificacion.md) §2.4, H-03.

**Contexto.** El flujo pedido es "Search > Prebook > Book> BookingDetails>Cancel(If Required)" (Cert, Integration on Test Account). VERIFICADO-CERT.

**Pregunta (EN).**

> The certification flow ends with "Cancel(If Required)". Should we cancel every test booking at the end of its case, or leave some of them active for your review?

**Por qué la necesitamos.** Valor por defecto de `TBO_CANCEL_AFTER` en el arnés ([07](./07-certificacion.md) §6.2).

**Postura si no responden.** Se cancelan todas y se captura un BookingDetail posterior; el flag `TBO_CANCEL_AFTER=false` permite dejarlas activas ([07](./07-certificacion.md) §2.4).

### Q-74

**Caso 7: suplementos** · Importante · Abierta · Origen: [07](./07-certificacion.md) §2.4, §4.9, H-04, R-03.

**Contexto.** Caso 7: "Booking room with supplements (Provide JSON for any one case)" (Cert, Integration on Test Account). VERIFICADO-CERT. `Supplements` con `Type` `AtProperty` (p. 14). VERIFICADO-PDF.

**Pregunta (EN).**

> Case 7 reads "Booking room with supplements (Provide JSON for any one case)". (a) Is one booking with supplements enough, using the occupancy of any of cases 1–6? (b) Which test `HotelCodes` or cities return `Supplements` with `Type` `AtProperty` in the integration environment?

**Por qué la necesitamos.** Sin inventario de test con suplementos el caso 7 no se puede fabricar.

**Postura si no responden.** Una reserva con la ocupación del caso 4, o la del 1; el arnés toma la primera tarifa con `AtProperty`, acepta `Included` si no hay, y falla con un mensaje claro si no hay ninguna ([07](./07-certificacion.md) §4.9).

### Q-75

**Caso 8: método y identificador** · Menor · Abierta · Origen: [00](./00-fuentes.md) §4; [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §5.1; [07](./07-certificacion.md) §2.4, §4.10, H-05.

**Contexto.** Caso 8: "Kindly call HotelBookingDetail method for any of the above case post successful booking" (Cert, Integration on Test Account). VERIFICADO-CERT. Ese método no existe en el PDF: existen `BookingDetail` (p. 42) y `HotelBookingDetailBasedOnDate` (p. 62). VERIFICADO-PDF. Que sea `BookingDetail` es INFERIDO de la secuencia del mismo caso.

**Pregunta (EN).**

> Case 8 asks to call the "HotelBookingDetail method" after a successful booking. (a) Does it mean `BookingDetail` (p. 42), and not `HotelBookingDetailBasedOnDate` (p. 62)? (b) Should it be called by `ConfirmationNumber`, by `BookingReferenceId`, or both?

**Por qué la necesitamos.** Contenido de la carpeta del caso 8 en el zip ([07](./07-certificacion.md) §5).

**Postura si no responden.** `BookingDetail` sobre la reserva del caso 4, por las dos claves ([07](./07-certificacion.md) §4.10).

### Q-76

**Entorno de staging de la verificación de portal** · Importante · Abierta · Origen: [00](./00-fuentes.md) F-06; [01](./01-autenticacion-conectividad-y-errores.md) §2.1, §2.3; [07](./07-certificacion.md) §2.3, H-06.

**Contexto.** "Testing between your application and TBO must occur in our Staging environment" (Cert, Website/Portal Verification), sin URL. El endpoint de integración es `http://api.tbotechnology.in/TBOHolidays_HotelAPI` (Cert, TBO Hotel API Details; p. 7). VERIFICADO-CERT / VERIFICADO-PDF.

**Pregunta (EN).**

> The portal verification "must occur in our Staging environment". Is that the same endpoint as integration (`http://api.tbotechnology.in/TBOHolidays_HotelAPI`), with the same test credentials? If not, what is its URL and how do we get credentials for it?

**Por qué la necesitamos.** Configuración de la cuenta TBO del stack de certificación (DC-1, [07](./07-certificacion.md) §7).

**Postura si no responden.** Mismo endpoint y mismas credenciales (INFERIDO), a confirmar antes de abrir el portal ([07](./07-certificacion.md) §2.3).

### Q-77

**Alcance de la certificación en el modelo consolidador** · Bloqueante · Abierta · Origen: [07](./07-certificacion.md) §2.8, H-07, R-13.

**Contexto.** Al cerrar la certificación TBO libera las "API Live Credentials" (Cert, Sign Off / API Live Credentials). El documento no dice si certifica la aplicación o una cuenta concreta. VERIFICADO-CERT.

**Pregunta (EN).**

> We are a consolidator platform: the agencies in our network may use the consolidator's TBO account, or connect their own TBO account to our platform. (a) Does certification apply to our application, so that any TBO account can operate through it once certified, or is it tied to one TBO account? (b) What must an agency with its own TBO account do to use our certified integration: a new certification, a lighter validation, or nothing?

**Por qué la necesitamos.** Es la base del modelo BYOC con TBO: sin esta respuesta no se puede prometer TBO con credenciales propias a las agencias de la red.

**Postura si no responden.** BYOC de TBO deshabilitado; solo opera la cuenta certificada, heredada por la red ([07](./07-certificacion.md) §2.8).

### Q-78

**Recertificación al sumar canales** · Importante · Abierta · Origen: [07](./07-certificacion.md) §2.2, H-08, DC-2.

**Contexto.** El formulario pide "Client's platform where the TBO API will be integrated (like: B2B, B2C, Mobile)" (Cert, Client's Details). VERIFICADO-CERT.

**Pregunta (EN).**

> The Client's Details form asks for the platform where the API will be integrated (B2B, B2C, Mobile). If we certify our B2B web portal now, will adding B2C, WhatsApp or mobile channels later require a recertification, or only a notification to TBO?

**Por qué la necesitamos.** Decisión DC-2 (declarar solo B2B ahora o todos los canales desde el inicio).

**Postura si no responden.** Se declara solo el portal B2B y se avisa a TBO antes de habilitar otro canal (DC-2 A).

### Q-79

**Portal en español** · Importante · Abierta · Origen: [07](./07-certificacion.md) §7.1, §8, H-16, DC-3.

**Contexto.** La verificación de portal la hacen testers de TBO sobre nuestro portal (Cert, Website/Portal Verification). VERIFICADO-CERT. La web B2B está solo en español y no hay paquete de i18n ([07](./07-certificacion.md) §7.1).

**Pregunta (EN).**

> Our portal user interface is in Spanish. Is a Spanish-language portal, together with an English walkthrough guide and glossary, acceptable for the Website/Portal Verification?

**Por qué la necesitamos.** Decisión DC-3 (guía en inglés o locale EN antes de la verificación).

**Postura si no responden.** Guía de recorrido en inglés con glosario (Anexo B de [07](./07-certificacion.md)) (DC-3 A).

### Q-80

**Production Process Form** · Importante · Abierta · Origen: [07](./07-certificacion.md) §2.8, H-12.

**Contexto.** Las credenciales live se liberan "based on the Production Process Form", un formulario de Microsoft Forms enlazado en el docx (Cert, Sign Off / API Live Credentials). No se abrió. VERIFICADO-CERT.

**Pregunta (EN).**

> Which fields does the Production Process Form request (for example outbound IP addresses for whitelisting, a production contact, or company data), so that we can prepare them in advance?

**Por qué la necesitamos.** Preparar el pase a producción sin esperas ([07](./07-certificacion.md) §2.8).

**Postura si no responden.** Se piden los campos por adelantado; la URL live se configura por cuenta ([Q-04](#q-04)) ([07](./07-certificacion.md) §2.8).

### Q-81

**Modos de pago con tarjeta en la certificación** · Bloqueante · Abierta · Origen: [03](./03-prebook-y-book.md) §3.7, §7; [07](./07-certificacion.md) H-13.

**Contexto.** `PaymentMode` admite `Limit`, `SavedCard` y `NewCard` (pp. 19, 33, 70); `NewCard` y `SavedCard` envían `PaymentInfo` con datos de tarjeta o CVV (pp. 33–40). El ejemplo 8.1.3 se titula "BOOKING BY LIMIT" pero envía `"PaymentMode": "NewCard"` con `PaymentInfo` (pp. 36–38). VERIFICADO-PDF. Por la decisión D1 nunca manejamos PAN ni CVV (`docs/sabre/10-requisitos-maestro.md` §9).

**Pregunta (EN).**

> Our platform never handles card numbers or CVV, so we will only use `PaymentMode: "Limit"` in `PreBook`, `Book` and `BookingDetail`, and never `NewCard` or `SavedCard` (pp. 19, 33). (a) Is `Limit` alone enough for certification? (b) Example 8.1.3 is titled "BOOKING BY LIMIT" but sends `PaymentMode: "NewCard"` with `PaymentInfo` (pp. 36–38). Could you confirm that the title is wrong?

**Por qué la necesitamos.** Si TBO exigiera certificar un modo con tarjeta, la certificación chocaría con D1, que está cerrada y no se reabre.

**Postura si no responden.** Solo `Limit`; el workflow declara que los modos con tarjeta no se implementan (Anexo A de [07](./07-certificacion.md), §2).

### Q-82

**Saldo `Limit` y moneda de la cuenta de test** · Importante · Abierta · Origen: [07](./07-certificacion.md) §6.3, H-15.

**Contexto.** `INSUFFICIENT_BALANCE` = `300` (p. 9); la moneda es la "Configured currency in the API profile of the client" (p. 13). VERIFICADO-PDF.

**Pregunta (EN).**

> (a) Does the test account have enough `Limit` balance for about 10 test bookings plus a few probes? (b) Which currency is configured in the test account's API profile, and can it be USD?

**Por qué la necesitamos.** Sin saldo los casos fallan con 300; con una moneda de exponente distinto de 2 el ACL la rechaza (D02-5).

**Cierre posible.** El comando `check` del arnés responde (b) ([07](./07-certificacion.md) §6.3).

**Postura si no responden.** El comando `check` del arnés imprime la moneda; cada reserva de prueba se cancela para liberar crédito ([07](./07-certificacion.md) §6.3).

### Q-83

**HCN en el entorno de test** · Menor · Abierta · Origen: [07](./07-certificacion.md) §4.10, H-14.

**Contexto.** El HCN solo se entrega para check-ins dentro de los 30 días (p. 42), con los SLA de p. 43. Los casos usan check-in a 45 días ([07](./07-certificacion.md) §4.1). VERIFICADO-PDF.

**Pregunta (EN).**

> Does the test environment ever populate `HotelConfirmationNumber` in `BookingDetail`? If so, only for check-ins within 30 days of the booking (p. 42)?

**Por qué la necesitamos.** Qué se espera del caso 8 y si se puede probar el job `hcn-check` en test.

**Postura si no responden.** Un HCN vacío en el caso 8 no se trata como fallo ([07](./07-certificacion.md) §4.10).

### Q-84

**Alternativa a Skype** · Menor · Abierta · Origen: [07](./07-certificacion.md) §2.2, H-10.

**Contexto.** El formulario pide el "Skype ID" del contacto técnico (Cert, Client's Details). VERIFICADO-CERT. Skype dejó de operar en mayo de 2025 (dato externo, INFERIDO).

**Pregunta (EN).**

> The Client's Details form asks for a Skype ID. Since Skype was discontinued in May 2025, may we provide Microsoft Teams or WhatsApp instead?

**Por qué la necesitamos.** Completar el formulario de alta ([07](./07-certificacion.md) §2.2).

**Postura si no responden.** Se ofrece Teams o WhatsApp ([07](./07-certificacion.md) §2.2).

### Q-85

**Métodos estáticos en el workflow y contenido en el portal** · Menor · Abierta · Origen: [05](./05-contenido-estatico-e-inventario.md) §1, §13.

**Contexto.** El workflow debe decir "what API methods are used, flow of method calls" (Cert, Integration on Test Account); el documento de certificación no menciona los métodos estáticos. VERIFICADO-CERT.

**Pregunta (EN).**

> (a) Should the workflow we submit also declare the static-content methods (`CountryList`, `CityList`, `TBOHotelCodeList`, `HotelDetails`) and our catalogue synchronisation? (b) Does the portal verification check how hotel content is displayed (images, check-in and check-out times, check-in instructions)?

**Por qué la necesitamos.** Contenido del workflow (Anexo A de [07](./07-certificacion.md)) y pantallas de detalle de hotel ([05](./05-contenido-estatico-e-inventario.md) §4).

**Postura si no responden.** El Anexo A de [07](./07-certificacion.md) ya declara los métodos estáticos; el detalle de hotel muestra imágenes, horarios e instrucciones de check-in ([05](./05-contenido-estatico-e-inventario.md) §4).

### Q-86

**Plazos entre fases** · Menor · Abierta · Origen: [07](./07-certificacion.md) §2.9, DC-5; [09](./09-plan-implementacion.md) §20 P-14.

**Contexto.** La JSON Verification dura "a minimum of 3 days" y la de portal "a minimum of 1 weeks"; "any expressed timelines are approximate and are subject to change" (Cert, JSON Verification; Website/Portal Verification; nota final). VERIFICADO-CERT.

**Pregunta (EN).**

> (a) What is the typical lead time between the submission of the zip and the scheduled JSON Verification date? (b) And between the JSON sign-off and the start of the Portal Verification? (c) Is there a maximum time between the JSON sign-off and the Portal Verification, after which the JSON Verification must be repeated? We would like to plan the delivery of our test portal accordingly.

**Por qué la necesitamos.** Planificación de la construcción del portal, que es la ruta crítica (DC-5; [09](./09-plan-implementacion.md)). Con D-TBO-05 (A) el JSON puede aprobarse semanas antes de que el portal esté listo ([09](./09-plan-implementacion.md) §20 P-14).

**Postura si no responden.** Calendario estimado de 3 a 6 semanas desde el envío del zip ([07](./07-certificacion.md) §2.9); el zip se envía en paralelo a la UI (DC-5 A).

---

## 9. Comercial y cuenta (Q-87 a Q-94)

### Q-87

**Costo por búsqueda o ratio búsqueda/reserva** · Bloqueante · Abierta · Origen: [06](./06-seams-integracion-repo.md) §9 H10, §10.

**Contexto.** El PDF no menciona cargos por Search ni un ratio de búsquedas por reserva (look-to-book). VERIFICADO-PDF (por ausencia, en todo el documento).

**Pregunta (EN).**

> Is there any charge or commercial limit on `Search` volume, such as a fee per search or a look-to-book ratio? If so, what are the thresholds, and how are they measured (per account, per agency)?

**Por qué la necesitamos.** Define la política de llamada por defecto de TBO en el fan-out (`always` frente a `opt-in` o `fallback`) y el cupo de búsquedas por tenant ([06](./06-seams-integracion-repo.md) §9 H10).

**Postura si no responden.** `defaultCallPolicy: 'always'` solo si no hay costo por búsqueda; con costo, `opt-in` o `fallback` ([06](./06-seams-integracion-repo.md) §9 H10).

### Q-88

**Moneda del perfil de la cuenta** · Bloqueante · Abierta · Origen: [02](./02-search-y-oferta-canonica.md) §8, C-32, D02-2, D02-5; [06](./06-seams-integracion-repo.md) §9 H5.

**Contexto.** `HotelResult[].Currency` es la "Configured currency in the API profile of the client" (p. 13); el request no tiene campo de moneda (pp. 10–11). VERIFICADO-PDF.

**Pregunta (EN).**

> `HotelResult[].Currency` is the "configured currency in the API profile of the client" (p. 13), and the request has no currency field. Our first markets are Colombia, Peru and Brazil. (a) Which currencies can an account profile use (for example USD, COP, PEN, BRL, CLP)? (b) Can one account work in more than one currency, or is one set of credentials needed per currency? (c) How is the profile currency changed, and who can change it?

**Por qué la necesitamos.** Decide la puerta de moneda de la búsqueda combinada (D02-2) y el rechazo de monedas sin 2 decimales (D02-5), con credenciales BYOC que pueden tener monedas distintas.

**Postura si no responden.** Puerta de moneda como en vuelos: las ofertas en otra moneda se descartan con motivo visible y nunca se convierten; las monedas con exponente distinto de 2 se rechazan; se pide a TBO un perfil en USD o en otra moneda de 2 decimales (D02-2 A, D02-5 A).

### Q-89

**Markup de agencia en el perfil y relación entre precios** · Importante · Abierta · Origen: [02](./02-search-y-oferta-canonica.md) §9.4, C-27; [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §5.4, PV-32.

**Contexto.** El PDF no dice si `TotalFare` es neto o incluye un markup configurado en el perfil (p. 13). `BookingDetailsbasedondate` trae `AgentMarkup` ("Amount which the agent has earned on the booking. i.e.Agency's commission") y `BookingPrice` ("Booking Price including agency Commision") (p. 63). VERIFICADO-PDF.

**Pregunta (EN).**

> (a) Is `TotalFare` (p. 13) always the net amount charged to the agency, or can it include an agency markup configured in the TBO profile? (b) In `BookingDetailsbasedondate` (p. 63), how do `BookingPrice` ("including agency Commision") and `AgentMarkup` relate to the `TotalFare` sent in `Book`? (c) Is its `Currency` the account profile currency? (d) Can a markup be configured in a TBO profile, and can it be set to zero?

**Por qué la necesitamos.** Si un perfil BYOC tuviera markup en TBO y además aplicamos el pricing waterfall, habría doble margen.

**Postura si no responden.** Credenciales TBO configuradas con markup 0; la divergencia de precio en la conciliación (R6) solo se registra ([02](./02-search-y-oferta-canonica.md) §9.4; [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §9.4).

### Q-90

**`Limit` en cuentas propias de agencias y `300` en PreBook** · Bloqueante · Abierta · Origen: [03](./03-prebook-y-book.md) §6, §7.4, H-22, D-03-G.

**Contexto.** `PaymentMode` tiene `Limit` por defecto (pp. 19, 33); `INSUFFICIENT_BALANCE` = `300`, "Agency does not have sufficient funds for the requested booking." (p. 9). El PDF no define `Limit` ni liga el 300 a un modo. VERIFICADO-PDF; que `Limit` sea el crédito o saldo de la agencia en TBO es INFERIDO.

**Pregunta (EN).**

> We will only use `PaymentMode: "Limit"`. (a) Can every TBO account operate with `Limit`, including the accounts that agencies in our network connect themselves, or does `Limit` require a credit line or deposit agreed with TBO? (b) Is `Limit` the account's credit line, its prepaid deposit, or both? (c) Can `300 INSUFFICIENT_BALANCE` already be returned by `PreBook`, or only by `Book`?

**Por qué la necesitamos.** Con D1, una cuenta sin `Limit` no puede operar en la plataforma, así que el alta de una cuenta BYOC tiene que comprobarlo. Define además el control interno de crédito de las sub-agencias que heredan la cuenta del consolidador (D-03-G).

**Postura si no responden.** El alta de una cuenta BYOC exige confirmar que opera con `Limit`; el 300 se trata en cualquier método como rechazo definitivo con aviso al dueño de la credencial ([03](./03-prebook-y-book.md) §6, H-22).

### Q-91

**`AGENT_BLOCKED` (402)** · Importante · Abierta · Origen: [01](./01-autenticacion-conectividad-y-errores.md) §8.3, H-09; [03](./03-prebook-y-book.md) §6, H-23.

**Contexto.** `AGENT_BLOCKED` = `402`, "Agency blocked at TBO end.", con la columna Remarks vacía (p. 10). VERIFICADO-PDF.

**Pregunta (EN).**

> `402 AGENT_BLOCKED` ("Agency blocked at TBO end", p. 10) has no remarks. (a) What causes it (for example unpaid invoices or exhausted credit)? (b) Is it temporary or permanent, and how is it lifted? (c) Does it block only new searches and bookings, or also `BookingDetail` and `Cancel` for existing bookings?

**Por qué la necesitamos.** Decide la reacción automática ante un 402 (circuito de la cuenta frente a desactivarla, decisión 6 de [01](./01-autenticacion-conectividad-y-errores.md) §14) y si la post-venta de reservas vivas sigue operando.

**Postura si no responden.** Circuito de la cuenta abierto 15 min, aviso al dueño y al operador, sin cambiar `provider_accounts.status`; la post-venta no se bloquea por nuestra parte (D-TBO-32 A; [01](./01-autenticacion-conectividad-y-errores.md) §12.3; [03](./03-prebook-y-book.md) §6). El workflow para TBO (Anexo A de [07](./07-certificacion.md), §4) dice lo mismo: se suspenden las llamadas de esa cuenta y se avisa a su titular ([08](./08-requisitos-maestro.md) §9 C-20).

### Q-92

**Credenciales y cuentas de test** · Importante · Abierta · Origen: [00](./00-fuentes.md) §8.2; [07](./07-certificacion.md) §7.3; [09](./09-plan-implementacion.md) §17, §20 P-09.

**Contexto.** La colección trae Basic Auth vacía y la captura de p. 7 muestra el usuario ilustrativo `TBOAPI` con la contraseña enmascarada (p. 7; Postman: colección). VERIFICADO-PDF / VERIFICADO-POSTMAN.

**Pregunta (EN).**

> (a) How do we request the credentials for the test account? (b) In our consolidator model, where agencies may bring their own TBO account, is there one test account per agency or a single one for our platform? (c) Can we get more than one test account (for example, one for the certification portal and one for development)? (d) Before live credentials, can our consolidator's commercial account use the TBO B2B web portal to price a sample of real stays, so that we can compare coverage and rates with our current supplier?

**Por qué la necesitamos.** Sin credenciales de test no corren el arnés ni las sondas de [07](./07-certificacion.md) §6.8, que cierran varias preguntas de este documento. La parte (d) alimenta la medición informativa de valor, que desde el 2026-09-25 no bloquea nada (D-TBO-02 B): las tarifas de test no son representativas y las credenciales live llegan después del sign-off ([08](./08-requisitos-maestro.md) §2.3; [09](./09-plan-implementacion.md) PR-3.7, §10).

**Postura si no responden.** Una cuenta de test de plataforma; las credenciales viven en la bóveda y en `.env.tbo`, nunca en Git ([00](./00-fuentes.md) §8.2; [07](./07-certificacion.md) §6.2, §7.3). Sin el acceso de (d), la medición informativa publica solo la cobertura y se deja escrito ([09](./09-plan-implementacion.md) §10, §20 P-09).

### Q-93

**Cuenta dedicada al catálogo** · Importante · Abierta · Origen: [05](./05-contenido-estatico-e-inventario.md) §6.6, §14 (decisión 7).

**Contexto.** El sync del catálogo necesita una cuenta TBO de plataforma aunque todas las agencias traigan la suya ([05](./05-contenido-estatico-e-inventario.md) §6.6). Que una cuenta aparte tenga su propio cupo de QPS es INFERIDO.

**Pregunta (EN).**

> To download static content, we would like a platform account (test and live) used only for catalogue synchronisation, separate from the account used for sales. (a) Is that possible? (b) Would it have its own QPS quota, independent of the sales account?

**Por qué la necesitamos.** Decisiones 7 y 9 de [05](./05-contenido-estatico-e-inventario.md) §14 (cuenta del sync y horario del cron).

**Postura si no responden.** Cuenta dedicada al sync (opción (a) de la decisión 7 de [05](./05-contenido-estatico-e-inventario.md) §14); si no se consigue, el sync corre en la ventana de menor tráfico ([05](./05-contenido-estatico-e-inventario.md) §6.6).

### Q-94

**Confidencialidad de la documentación** · Importante · Abierta · Origen: [00](./00-fuentes.md) §1.

**Contexto.** El PDF, la colección Postman y el documento de certificación están sin versionar en `docs/tbo/` ([00](./00-fuentes.md) §1). VERIFICADO-CODIGO (`git status`).

**Pregunta (EN).**

> Are the "TBOH_Hotel_API_Specifications(V2.1)" PDF, the "HotelAPI Client" Postman collection and the certification process document subject to confidentiality (NDA) restrictions that would prevent us from storing them in our private Git repository?

**Por qué la necesitamos.** Decide si los originales se versionan en el repo (decisión de [00](./00-fuentes.md), que consolida [08](./08-requisitos-maestro.md)).

**Postura si no responden.** Hasta la respuesta, los originales no se versionan; los documentos del set los identifican por SHA-256 ([00](./00-fuentes.md) §1).

---

## 10. Posturas por defecto que no coincidían entre documentos (resueltas)

Al consolidar las posturas aparecieron diez temas en los que dos documentos del set proponían cosas distintas. No son huecos del contrato de TBO, así que no van en el email. [08](./08-requisitos-maestro.md) §9 fijó la regla de cada uno y los documentos de origen están corregidos al 2026-09-23; las posturas de las preguntas de arriba ya citan una sola variante. La tabla queda como registro.

| #    | Tema                                                                            | Pregunta                     | Regla adoptada                                                                                                                                                                       | Regla en 08 §9                                                               |
| ---- | ------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| D-1  | Casing de los paths                                                             | [Q-05](#q-05)                | Una sola constante `TBO_OPERATIONS` con el casing del PDF; la sonda PR-04 prueba las dos grafías de `Search`, `HotelDetails`, `BookingDetailsbasedondate` y `hotelcodelist`          | [C-03](./08-requisitos-maestro.md#9-reconciliación-entre-documentos-del-set) |
| D-2  | Timeout de `HotelDetails`                                                       | [Q-09](#q-09)                | 60 s de techo en `TBO_OPERATIONS`; el sync configura 45 s, porque la configuración solo puede acortar                                                                                | C-14                                                                         |
| D-3  | `ResponseTime` por defecto                                                      | [Q-16](#q-16)                | Rango 5-20 s, 10 s por defecto (D-TBO-17 A); timeout = `ResponseTime` + 3 s, nunca más de 23 s; el ejemplo de [07](./07-certificacion.md) §4.3 muestra el valor del builder          | C-01                                                                         |
| D-4  | Alcance del piso `RecommendedSellingRate`                                       | [Q-23](#q-23)                | Todo precio al viajero, en todos los canales (D-TBO-16 A); TP-29 pasa a obligatorio                                                                                                  | C-18                                                                         |
| D-5  | Vencimiento de la oferta (30 min)                                               | [Q-29](#q-29)                | `expiresAt = searchSentAt + 27 min`; pasado ese instante no se llama a PreBook ni se encola el Book                                                                                  | C-11, C-17                                                                   |
| D-6  | Relación entre `create_request_key`, `BookingReferenceId` y `ClientReferenceId` | [Q-34](#q-34)                | `BookingReferenceId` con generador propio, independiente de la clave de idempotencia; `ClientReferenceId` con el mismo valor, también en el arnés                                    | C-08, C-26                                                                   |
| D-7  | Cierre de un Book incierto que no aparece                                       | [Q-37](#q-37), [Q-38](#q-38) | Job `verify-hotel-booking` a +120 s, +5, +15 y +60 min; después, `pending` y bloqueada hasta que la conciliación confirme la ausencia (D-TBO-24 A); el Anexo A de 07 lo describe así | C-06, C-07                                                                   |
| D-8  | Clasificación del `479 CANCEL_FAIL`                                             | [Q-50](#q-50)                | `{ success: false }` sin lanzar y la lectura posterior decide                                                                                                                        | C-05                                                                         |
| D-9  | Reacción ante `402 AGENT_BLOCKED`                                               | [Q-91](#q-91)                | Circuito de la cuenta y aviso al titular, sin tocar `provider_accounts.status` (D-TBO-32 A); el Anexo A de 07 lo describe así                                                        | C-20                                                                         |
| D-10 | `IsDetailedResponse` en el detalle de un hotel                                  | [Q-19](#q-19)                | `false` en todo Search de listado, que son todos los del zip; `true` solo en el Search de un hotel (D-TBO-19 A), declarado en el workflow                                            | C-25                                                                         |

---

## 11. Decisión para el founder: cuándo y cómo se envían

**DQ-1 — Momento del envío.**

- **(A, recomendada)** Enviar el email completo (§12) ahora, junto con el pedido de credenciales de test ([Q-92](#q-92)), pidiendo prioridad para la Parte 1. Las sondas de [07](./07-certificacion.md) §6.8 corren cuando lleguen las credenciales y confirman o cierran lo que TBO todavía no haya contestado. Encaja con DC-5 A de [07](./07-certificacion.md) §11: las respuestas llegan mientras se construye el ACL.
- **(B)** Esperar las credenciales de test, correr las sondas PR-01 a PR-11 y enviar solo lo que no cierren. El email sale más corto, pero las bloqueantes comerciales ([Q-77](#q-77), [Q-87](#q-87), [Q-88](#q-88), [Q-90](#q-90)), que ninguna sonda cierra, esperan semanas sin necesidad.
- **(C)** Enviar ahora solo la Parte 1 y la Parte 2 junto con el zip de certificación. Hilo más corto para soporte, pero las respuestas de la Parte 2 llegan cuando el código ya está escrito.

Condiciones para cualquier opción:

- Los datos entre corchetes del email (empresa, contacto técnico, usuario de test) salen de DC-4 ([07](./07-certificacion.md) §11).
- El email no lleva contraseñas, cabeceras `Authorization` ni datos de personas reales.
- Va a `apisupport@tbo.com` con copia a `apisupport@tboholidays.com` hasta que [Q-11](#q-11) diga cuál es la vigente ([00](./00-fuentes.md) §7).

---

## 12. Borrador de email para TBO

Listo para copiar. Parte 1: las bloqueantes. Parte 2: el resto, agrupado por tema. Los IDs coinciden con los de este documento para poder registrar cada respuesta.

```text
To: apisupport@tbo.com
Cc: apisupport@tboholidays.com
Subject: [Company] - TBO Hotel API (JSON V2.1): integration questions before certification

Hello TBO API Integration team,

We are integrating the TBO Holidays Hotel API (JSON, V2.1) into the B2B travel platform of [Company]. We are a
consolidator: travel agencies in our network (initially in Colombia, Peru and Brazil) search, book and manage
hotel reservations through our web portal, and some of them may connect their own TBO account. Before we submit
our certification samples, we have a set of questions about the specification.

Notes:
- The IDs (Q-01 to Q-94) are ours. Please quote them in your answers so that we can track them.
- Page numbers are the physical pages of "TBOH_Hotel_API_Specifications(V2.1).pdf" (71 pages). From page 64
  onwards the printed footer shows the physical page minus 5 (for example, page 71 prints "66").
- We never handle card data. We only use PaymentMode "Limit" in PreBook, Book and BookingDetail.
- Part 1 contains 14 questions that block our design or our certification. We would be grateful for
  answers to these first. Part 2 contains the remaining questions, grouped by topic.
- Please also send us the credentials of the test account (see Q-92).

PART 1 - BLOCKING QUESTIONS

Q-03.
Page 7 says "All APIs should be secured with HTTPS protocol", yet the test BaseURL is http://api.tbotechnology.in/TBOHolidays_HotelAPI in the PDF (p. 7), in the certification document and in the Postman collection. With Basic Authentication over http, the credentials travel in clear text. (a) Does the test host accept https://api.tbotechnology.in/TBOHolidays_HotelAPI with the same credentials? (b) Is the live endpoint HTTPS-only?

Q-10.
Code 429 LIMIT_EXCEEDED means "Requests have exceeded allowed QPS" (p. 9), but the allowed value is not published. (a) What is the QPS limit? (b) Is it per username or account, per source IP, per method, or global? (c) Which time window and burst apply, and is there also a limit on concurrent requests (for example, several Search calls in parallel with the same credentials)? (d) Do the static methods (CountryList, CityList, TBOHotelCodeList, HotelDetails, hotelcodelist) and the post-booking methods (BookingDetail, BookingDetailsbasedondate) share the quota with Search, PreBook and Book? (e) Is 429 returned as HTTP 429 or inside an HTTP 200, and do you send a Retry-After header? (f) Is there a recommended time window for bulk static-content downloads?

Q-13.
For PaxRooms[].Children the table gives the range "(1-4)", and the length of ChildrenAges must equal the number of children (p. 11). The Postman Search request sends "Children": 0 with "ChildrenAges": [0]. For a room with adults only (certification cases 1 and 4): (a) is "Children": 0 valid? (b) Must ChildrenAges be [], [0], or omitted?

Q-23.
RecommendedSellingRate is "the minimum selling rate for the requested booking. The B2C client cannot sell the room at a rate lower than the RecommendedSellingRate returned in the response, if any" (p. 13; p. 21 for PreBook). Our platform serves travel agencies (B2B) that resell to their own end travellers (B2B2C), through a web portal and WhatsApp. (a) Does the floor apply when a B2B agency on our platform sells the room to its end traveller? (b) Does it apply to the hotel component when the hotel is sold inside a package with a single total price? (c) Is it expressed in the profile currency, tax-inclusive, and for the whole booking (all rooms and nights)? (d) Which value binds: the one returned by Search or the one returned by PreBook?

Q-31.
Both PreBook examples contain, in RateConditions, "Please note that this a special rate which should be sold only with an airline ticket as part of a package" (pp. 25, 30). There is no structured field for it, and Search gives no signal. (a) Is there a flag or a parameter to identify or exclude package-only rates in Search or PreBook? (b) What is the contractual consequence of selling such a rate as a standalone hotel? (c) Does selling it together with a flight booked through another supplier satisfy the condition?

Q-34.
ClientReferenceId and BookingReferenceId are free strings (p. 33), and BookingReferenceId is described as a "Unique booking reference ID" (p. 43), yet two examples reuse "AVw123218" (pp. 37, 40). (a) What maximum length and which characters are allowed in each field? (b) What is the uniqueness scope: per account, per agency, or global in TBO? Several sub-agencies in our network may share one TBO account. (c) May both fields carry the same value in the same Book? We plan a 20-character upper-case alphanumeric value, unique across our platform, for example STP7K2M9QX4D8R1VZ6AB.

Q-35.
If a second Book arrives with a BookingReferenceId that was already used (for example, after a timeout on our side), does TBO (a) return the existing booking, (b) reject the request (with which Status.Code), or (c) create another booking? Does the answer change if the BookingCode is different?

Q-37.
When BookingDetail is called with a BookingReferenceId, or a ConfirmationNumber, for which no booking exists: (a) which Status.Code and which body do you return? (b) Can a booking appear in TBO after BookingDetail said it did not exist, for example while the Book is still being processed? If so, for how long after the Book can that happen?

Q-60.
In our consolidator model, each agency may connect its own TBO account or inherit the consolidator's account. (a) Are city codes, hotel codes and HotelDetails content identical for every TBO account, or can they vary by account, market or contract? (b) Can an account call Search with HotelCodes that were downloaded with a different account (for example, our platform account)? (c) If an account has no access to a hotel, is that hotel simply omitted from HotelResult, or does the request fail?

Q-77.
We are a consolidator platform: the agencies in our network may use the consolidator's TBO account, or connect their own TBO account to our platform. (a) Does certification apply to our application, so that any TBO account can operate through it once certified, or is it tied to one TBO account? (b) What must an agency with its own TBO account do to use our certified integration: a new certification, a lighter validation, or nothing?

Q-81.
Our platform never handles card numbers or CVV, so we will only use PaymentMode: "Limit" in PreBook, Book and BookingDetail, and never NewCard or SavedCard (pp. 19, 33). (a) Is Limit alone enough for certification? (b) Example 8.1.3 is titled "BOOKING BY LIMIT" but sends PaymentMode: "NewCard" with PaymentInfo (pp. 36–38). Could you confirm that the title is wrong?

Q-87.
Is there any charge or commercial limit on Search volume, such as a fee per search or a look-to-book ratio? If so, what are the thresholds, and how are they measured (per account, per agency)?

Q-88.
HotelResult[].Currency is the "configured currency in the API profile of the client" (p. 13), and the request has no currency field. Our first markets are Colombia, Peru and Brazil. (a) Which currencies can an account profile use (for example USD, COP, PEN, BRL, CLP)? (b) Can one account work in more than one currency, or is one set of credentials needed per currency? (c) How is the profile currency changed, and who can change it?

Q-90.
We will only use PaymentMode: "Limit". (a) Can every TBO account operate with Limit, including the accounts that agencies in our network connect themselves, or does Limit require a credit line or deposit agreed with TBO? (b) Is Limit the account's credit line, its prepaid deposit, or both? (c) Can 300 INSUFFICIENT_BALANCE already be returned by PreBook, or only by Book?

PART 2 - OTHER QUESTIONS

-- Contract, connectivity and errors --

Q-01.
The change log shows two rows as version 2.1: 27 Dec 2023 and 27 Oct 2025 ("Hotel Detail method - To get the room wise details", p. 6), so the version number no longer identifies the content. (a) Is there a revision of the Hotel API specification newer than the V2.1 PDF we have (its file metadata show 6 Feb 2026)? (b) How are contract changes announced to integrated clients (mailing list, portal, release notes)? (c) How can we tell which revision is current if the version number does not change?

Q-02.
The change log records "Implemented Hotel Search Workflow" in v2.0 (16 Aug 2023) and "Depreciated Hotel Search Workflow" in v2.1 (27 Dec 2023) (p. 6), but no page describes that workflow. (a) What was it (for example, a search by city or destination)? (b) Does any active endpoint or parameter still depend on it? (c) Please confirm that the only supported availability search is Search by HotelCodes (p. 10).

Q-04.
Page 7 gives the live BaseURL only as the placeholder {Live-URL}/HotelAPI, and its path differs from the test path (/TBOHolidays_HotelAPI). (a) What is the exact live host and path? (b) Is it delivered together with the live credentials after the Production Process Form? (c) Are the live credentials always different from the test credentials?

Q-05.
The PDF and the Postman collection use different casing for the same method: /Search (p. 10) vs /search, /HotelDetails (p. 56) vs /Hoteldetails, and /BookingDetailsbasedondate (p. 62) vs /BookingDetailsBasedOnDate; in the PDF, hotelcodelist (p. 54) is the only lower-case path. (a) Is path routing case-insensitive on both the test and the live hosts? (b) Which casing is canonical for each method? (c) The authentication table on page 7 says "Method POST", but CountryList (p. 51) and hotelcodelist (p. 55) are documented as GET. Do these two accept only GET, or also POST?

Q-06.
Page 7 only says to use Basic Auth with the TBO-provided username and password. (a) Which character encoding applies to non-ASCII characters in the username or password (we assume UTF-8, as in RFC 7617)? (b) What is the password rotation policy, and is there an overlap period in which the old and the new password are both valid? (c) Do you restrict access by source IP (IP whitelisting) in test and/or live? If so, how do we register our outbound IP addresses?

Q-07.
The outcome of every call is Status.Code in the response body (pp. 8–10), but the PDF has no error example other than 201 (p. 18), and the Postman collection has no saved responses. (a) Does the HTTP transport status mirror Status.Code (for example HTTP 401, 429 or 500), or is the transport always HTTP 200 with the code in the body? (b) On a Basic Auth failure, do you return HTTP 401 without a JSON body, or a JSON body with Status.Code 401? (c) Could you send one real response body for each of 400, 401, 402, 429, 500, 207, 300, 315, 405 and 479?

Q-08.
The Response Status table lists 12 codes (pp. 8–10) but does not say which method can return which. Please give the list of possible Status.Code values for Search, PreBook, Book, BookingDetail, Cancel, BookingDetailsbasedondate, CountryList, CityList, TBOHotelCodeList, HotelDetails and hotelcodelist. In particular: (a) can PreBook return 201, 207, 300 or 315? (b) What do the static methods return for a nonexistent CountryCode or CityCode, or for an account without permission? (c) In the test environment, TBOHotelCodeList answers some cities listed by CityList with HTTP 200 and {"Status":{"Code":500,"Description":"No Hotels Found"}}. We read it as "this city has no hotels". Is that the intended meaning? For a few cities the same request returned a normal hotel list when retried a few seconds later, and those first answers took about 5 seconds. Can "No Hotels Found" also be returned when an internal timeout expires? If so, how can we tell the two cases apart?

Q-09.
The timeout table on page 8 only covers Search (5–23 s), PreBook (23 s) and Book (120 s). What timeouts do you recommend for BookingDetail, Cancel, BookingDetailsbasedondate, CountryList, CityList, TBOHotelCodeList, HotelDetails and hotelcodelist?

Q-11.
Page 9 asks to send the complete JSON request and response logs of a 500 UNEXPECTED_ERROR to apisupport@tboholidays.com, while the certification document uses apisupport@tbo.com. (a) Which address is current for production incidents, and which one for certification? (b) Book requests contain guest names, email and phone, and BookingDetail responses contain guest names. Do you accept request/response logs with those personal fields masked, or do you need them unmasked?

Q-12.
(a) Do responses support gzip compression (Accept-Encoding: gzip)? It matters for HotelDetails and hotelcodelist. (b) Is there any request or correlation identifier (header or field) that you accept or return, so that we can reference a specific call in support tickets?

-- Search --

Q-14.
(a) ChildrenAges accepts "0-18 years" (p. 11). Is an 18-year-old a child or an adult? Is there an infant age cut-off with a different rate? (b) What is the maximum number of rooms (PaxRooms entries) per Search? (c) Are there limits on the number of nights per stay, or on how far in advance the check-in can be? None of these is documented on pages 10–12.

Q-15.
HotelCodes says "Recommended Value; 100 hotel codes" (p. 10). (a) Is a request with more than 100 codes rejected (with which Status.Code), truncated, or only slower? (b) How does the response time scale with the number of codes?

Q-16.
ResponseTime is "Integer, Expected response time (seconds)" (p. 11); the examples send 23.0, Postman sends 20.0, and the recommended Search timeout is "5-23 Seconds" (p. 8). (a) Does TBO stop aggregating its suppliers when ResponseTime is reached and return partial results? (b) What is the valid range? (c) How should our HTTP timeout relate to ResponseTime? (d) Does the response time depend on the number of HotelCodes?

Q-17.
GuestNationality is the lead guest's nationality, with a special note for UAE residents searching UAE hotels (p. 10), and Key Point 1 warns against hardcoding it (p. 71). (a) Outside the UAE case, should we send the guest's nationality or the country of residence (for example, a Venezuelan citizen who lives in Colombia)? (b) What happens if, at check-in, the lead guest's nationality differs from the one used in Search, given that Book does not send nationality (pp. 32–34)? (c) Does GuestNationality change the rate or the availability returned?

Q-18.
(a) Filters.MealType is documented as the strings "All, WithMeal and RoomOnly" (p. 11), but Postman sends the integer 0. Which format is official? (b) Postman also sends Filters.OrderBy, Filters.StarRating and Filters.HotelName, which are not in the Search table (pp. 10–11). Are they supported, and with which values? (c) Filters.NoOfRooms is "the maximum number of rooms client wants to receive in the response" (p. 11). Does it limit the number of Rooms[] options per hotel, or does it refer to the number of rooms requested? What does 0 mean? The single-room example sends 0 and the two-room example sends 2 (p. 12).

Q-19.
Key Point 2 (p. 71) strongly recommends IsDetailedResponse: False. We plan to send false in every list search, and true only in a Search for a single HotelCode when the agent opens that hotel, to show cancellation policies and nightly prices before PreBook. Is this acceptable for certification?

Q-20.
When a Search includes several HotelCodes: (a) are hotels without availability simply omitted from HotelResult, and is 201 NO_AVAILABILITY (p. 9, example on p. 18) returned only when none of them has availability? (b) Can a single invalid or unauthorised code make the whole request fail?

Q-21.
DayRates is a "List of Array" (p. 13). The two-room PreBook example has two inner arrays (p. 28), but every example is for one night. (a) Is the outer level the room and the inner level the night? (b) Does BasePrice exclude taxes? (c) Does TotalFare always include TotalTax (our reading of pp. 24 and 28)?

Q-22.
ExtraGuestCharges is declared Decimal, "Extra Guest charges of the bookable unit (if applicable)" (p. 13), but arrives as a string. For the same BookingCode (1120548!TB!4!TB!9a47646b-…) it is "17.22" in the Search example (p. 17) and "6.45" in the PreBook example (p. 28), with the same TotalFare. (a) Is it included in TotalFare, or paid at the hotel? (b) Why did it change between Search and PreBook? (c) Must it be shown to the end customer?

Q-24.
About CancelPolicies (p. 14): (a) In which time zone is FromDate? It arrives as DD-MM-YYYY HH:mm:ss without an offset (pp. 24, 50). Is it always the hotel's local time? (b) For ChargeType: Percentage, what is the base: the TotalFare of the whole booking, or the room identified by Index? (c) In which currency is a Fixed charge expressed? (d) Is Index 1-based, and does it arrive as a string or as a number? (e) Which ChargeType values exist besides Fixed and Percentage (the table says "etc.")? For example, is there a per-night charge?

Q-25.
When Search is called with IsDetailedResponse: true (p. 11), are its CancelPolicies expected to match the ones returned by PreBook for the same BookingCode, or can they differ? Key Point 3 (p. 71) says that the PreBook ones are final.

Q-26.
In the BookingDetail example (p. 50), IsRefundable is false while CancelPolicies has two Fixed tranches of 0.00 before the 100 % one. When the flag and the tranches disagree, which one is authoritative for the cancellation charge?

Q-27.
(a) Is Supplements[].Price per night, per room or per stay? One example shows mandatory_tax 20.00 AED (p. 15), while the matching RateConditions say "AED 20.00 per accommodation, per night" (p. 31), but the example is for one night only. (b) Is there a catalogue of Description values (such as mandatory_tax)? (c) The table declares a "List of Object" (p. 14), but the examples use an array of arrays, one per room (pp. 15, 17). Which format is guaranteed? (d) Is the supplement Currency always the hotel's local currency?

Q-28.
(a) Is the MealType enumeration (Enumeration section, p. 70, ten values) closed, and is its casing stable (BreakFast, BreakFast_Lunch vs Breakfast_For_1)? (b) In a double room, does Breakfast_For_1 mean breakfast for one person only? (c) Is BreakFast_Lunch considered half board? (d) Inclusion is a single string (p. 13). When a rate has several inclusions, which separator is used?

-- PreBook and Book --

Q-29.
Page 8 says that "from search to book, the timeout is 30 minutes", and 315 BOOKINGCODE_EXPIRED means "Session expired between search to book" (p. 9). (a) Does the 30-minute clock start when the Search request is sent or when its response is returned? (b) Does PreBook reset or extend the window, or does it have its own validity? (c) Must the Book request start, or complete, within the 30 minutes? (d) What happens if the session expires while a Book is in progress?

Q-30.
Book expects the BookingCode "same as received in the search response" (p. 32), and PreBook also returns Rooms[].BookingCode (p. 20). Can the BookingCode returned by PreBook differ from the one sent? If it does, which one must be sent to Book?

Q-32.
RateConditions (p. 23) contains HTML escaped as entities (for example &lt;ul&gt;&lt;li&gt;, pp. 26, 30–31), and the BookingDetail example shows replacement characters (�) (p. 51). (a) Is the HTML always escaped as entities? (b) Which tags can appear? (c) Which character encoding do you use in responses (UTF-8)?

Q-33.
TotalFare in Book is "Total fare for the booking" (p. 33). (a) Must it equal the TotalFare returned by the latest PreBook? (b) What happens if it is higher or lower than the current price: which Status.Code do you return, and is there a rounding tolerance? (c) With how many decimals should it be sent, especially if the account profile uses a currency with 3 decimals? The examples mix 85.822 (p. 26), 85.82 (p. 35) and 107.14000000000000 (p. 49).

Q-36.
The note on page 42 makes BookingDetail by BookingReferenceId mandatory after a "timeout/failure/http/network related error" in the book response. (a) Which Book response codes guarantee that no booking was created? (b) Can a 405 BOOKING_FAIL, a 429 LIMIT_EXCEEDED or a 500 UNEXPECTED_ERROR returned by Book leave a booking created? (c) Does "failure" in that note include 405?

Q-38.
The note on page 42 says to call BookingDetail "after 120 seconds of book response". (a) Are the 120 seconds counted from sending the Book request, or from the moment the failure or timeout is observed? (b) If the booking is not found in that first check, how many more times, and at which intervals, should we check before concluding that no booking was created?

Q-39.
A Book with Status.Code 200 means "Booking is Confirmed or Voucher" (pp. 8–9), BookingType only allows Voucher (p. 33), and the Booking Status enumeration has no failed or pending-confirmation state: its only intermediate values are cancellation states (Enumeration section, pp. 70–71). (a) Can a Book that returns 200 leave the booking in a state other than confirmed, for example on request or pending hotel confirmation? (b) Does a 200 always include ConfirmationNumber?

Q-40.
The Book response table (section 8.2, p. 40) ends with an empty row. Is a response field missing from the documentation?

Q-41.
CustomerNames[].Title allows 'Mr', 'Mrs', 'Ms' (p. 32), but the Postman HotelBook request sends "Dr", and the children in the examples use Mr or Ms (pp. 34, 39). (a) Which Title values are accepted? (b) Which title should a child have? Are Master or Miss accepted?

Q-42.
FirstName and LastName are described as "Lead guest first/last name" (pp. 32–33), but examples 8.1.1 and 8.1.4 also name the children of each room (pp. 34, 39). (a) Must we send every guest in CustomerNames, or only the lead guest of each room? (b) Must the first guest of each room be an adult?

Q-43.
No rules are documented for guest names (pp. 32–33). (a) What minimum and maximum length apply to FirstName and LastName? (b) Which characters are accepted: accented letters (é, á), ñ, apostrophes, hyphens, spaces? This is critical for Latin American guests. (c) Is there any rule for two guests with the same first and last name in one booking?

Q-44.
EmailId and PhoneNumber are described as the guest's email and phone (p. 33). (a) Do TBO or the hotel use them to contact the guest? (b) May we send the agency's operational email and phone instead of the traveller's (white label)? (c) Must PhoneNumber contain digits only, with the country code (as in the examples, pp. 35–36), or is a leading + accepted?

-- Post-booking: BookingDetail, Cancel, HCN and reconciliation --

Q-45.
The BookingDetail request accepts ConfirmationNumber or BookingReferenceId, plus PaymentMode (pp. 43–44). (a) What happens if both identifiers are sent, or neither? (b) What is PaymentMode used for in BookingDetail, and what changes if it is omitted?

Q-46.
The BookingDetail response table is flat (pp. 44–49) and the only example has one room (pp. 49–51). (a) In a multi-room booking, does BookingDetail.Rooms contain one element per room, or a single element whose Name array has one entry per room? (b) Where exactly are Supplements, CreditCardOptions and HotelConfirmationNumber located: at BookingDetail level or inside Rooms[]? Could you share a complete two-room example?

Q-47.
(a) Before the hotel confirmation number exists, is HotelConfirmationNumber absent, null, "" or a placeholder such as "NA", "Pending" or "0"? Can it change after it has been delivered, and is there one per booking or one per room (p. 45)? (b) VoucherStatus is declared Boolean but described as "Possible Value; Confirm, Voucher" (p. 45). What does false mean, given that BookingType only allows Voucher (p. 33)? (c) What is the real format of CheckIn, CheckOut and BookingDate? The table says YYYY-MM-DD, but the example shows "2021-10-16T00:00:00" and "2021-07-1317T00:00:00" (p. 49). In which time zone is BookingDate?

Q-48.
The Booking Status enumeration (Enumeration section, pp. 70–71) lists six values, but the BookingDetailsbasedondate example (p. 64) returns "Vouchered", which is not in that list. (a) What is the complete list of BookingStatus values? (b) Are there failed, pending-confirmation or on-request states? (c) Do BookingDetail and BookingDetailsbasedondate use the same vocabulary?

Q-49.
A Cancel that returns 200 is described as "Booking is Cancelled" (p. 9), yet the Booking Status enumeration includes CancellationInProgress, CancelPending, CxlRequestSentToHotel and CancelledAndRefundAwaited (Enumeration section, pp. 70–71). (a) Does a 200 guarantee the final state Cancelled, or can the booking remain in one of the intermediate states? (b) How long do those states usually take to resolve? (c) Can the hotel reject a cancellation that TBO already accepted with 200?

Q-50.
(a) Is 479 CANCEL_FAIL ("Cannot cancel booking", p. 9) a final rejection, or can it also mean that a cancellation is already in progress? (b) What does Cancel return for a booking that is already cancelled: 200 or 479? (c) Is Cancel idempotent, i.e. is it safe to repeat it after a timeout?

Q-51.
If Cancel returns 429 LIMIT_EXCEEDED or 500 UNEXPECTED_ERROR (p. 9), is it guaranteed that the cancellation was not processed?

Q-52.
Cancel returns only Status and ConfirmationNumber (p. 42), and BookingDetail has no cancellation-charge field (pp. 44–51). (a) How can we obtain by API the cancellation charge actually applied and the amount refunded to the account? (b) After a cancellation, do BookingDetail or BookingPrice in BookingDetailsbasedondate reflect it?

Q-53.
Cancel only takes ConfirmationNumber (p. 41). (a) Can a single room of a multi-room booking be cancelled? (b) Can a booking be cancelled on or after the check-in date, or in a no-show situation?

Q-54.
About the HCN procedure on pages 42–43: (a) Is the "Check-in Window" measured from the booking time to 00:00 hotel local time on the check-in date, or to the hotel's check-in time? (b) Do the boundaries (48, 72, 120, 192 and 336 hours; 24 is unambiguous because P0 is "< 24 hours") belong to the lower or to the upper band? Is a window of exactly 720 hours P5 or out of scope? (c) Does "Maximum 3 retries" mean 3 retries after the initial call (4 calls in total) or 3 calls in total? (d) For check-ins more than 30 days after the booking, is the HCN provided once the check-in enters the 30-day window, and if so, from when is the P5 SLA counted?

Q-55.
Page 43 asks us to "raise an operations ticket with the relevant booking details" when the HCN is still missing after the SLA window and 3 retries. (a) Through which channel (email address, portal, API)? (b) Which booking details must the ticket contain? (c) May our system raise it automatically?

Q-56.
For BookingDetailsbasedondate, the request table and Postman use FromDate / ToDate (p. 62), but the PDF example uses fromdate / todate (p. 63). (a) Which field names are correct, and are they case-sensitive? (b) If an unknown key is sent, is it ignored (and a default range applied) or rejected?

Q-57.
For BookingDetailsbasedondate (pp. 62–64): (a) Does the date range filter by booking creation date (as the example and the change log on p. 6 suggest) or by check-in date? (b) Is ToDate inclusive? (c) In which time zone are the dates evaluated? (d) What happens if the range exceeds 60 days? (e) Is there pagination or a maximum number of rows? (f) What does the response look like when there are no bookings in the range?

Q-58.
In the BookingDetailsbasedondate response (pp. 63–64): (a) Is ClientReferenceNumber exactly the ClientReferenceId sent in Book? (b) What is BookingId, and how does it relate to BookingReferenceId? (c) What is TripName, and how is it built? The example "Sharma_02Dec_Dubai" seems to contain the guest's surname. (d) Is BookingStatus the current status or the status at creation?

Q-59.
(a) Do BookingDetail, Cancel and BookingDetailsbasedondate only work on bookings created with the same credentials? (b) Can one TBO account have several API users, and if so, can each user read and cancel the bookings made by the others? (c) Does BookingDetailsbasedondate include bookings made through the TBO web portal with the same account?

-- Static content --

Q-61.
GET hotelcodelist (pp. 54–55) is documented but is not in the Postman collection, and its example response has no Status object. (a) Is this method still active? (b) Does the real response include Status? (c) Roughly how many codes does it return today, and how large is the response? (d) How often is it updated? (e) Is it the same set of hotels as the union of TBOHotelCodeList over all cities?

Q-62.
For HotelDetails (pp. 56, 58): (a) What is the maximum number of codes per call in Hotelcodes? The Postman request sends 13 codes as one comma-separated string. (b) Does it also accept a JSON array? (c) If one of the codes does not exist, does the whole batch fail, or is only that hotel left out?

Q-63.
(a) Which fields does TBOHotelCodeList return when IsDetailedResponse is false? In particular, are Map, HotelRating and CountryCode included? (b) Does Key Point 2 (p. 71), which recommends 'False', apply to Search, to TBOHotelCodeList, or to both? (c) Does TBOHotelCodeList accept a numeric CityCode and a JSON boolean IsDetailedResponse, or only the strings used in the PDF and Postman examples (p. 65)? (d) With IsDetailedResponse "true", every hotel also carries Latitude and Longitude, which the response table (p. 66) does not list. Are they always present? Are they numbers or strings? If they disagree with Map, which one is authoritative? Are they also returned when IsDetailedResponse is false?

Q-64.
(a) Does TBOHotelCodeList paginate or truncate the response for large cities? Is there a maximum number of hotels per city? (b) Why does the example omit CityId, which the response table declares (p. 66)? (c) Are CityList[].Code, TBOHotelCodeList.CityCode and HotelDetails[].CityId the same code? Are city codes stable over time, and can a hotel move to a different city code? (d) The tables say Integer, but every example is a string. Which type should we send and expect?

Q-65.
The note on pages 56–57 (change of 27 Oct 2025) adds "IsRoomDetailRequired": true to HotelDetails and lists RoomName, RoomId, RoomSize, RoomDescription and imageURL. (a) Under which key, and at which position of the response, do the room details arrive? Could you send a complete sample response? (b) The note says that "Search API returns a RoomID" (example "RoomID": ["197354"]), but RoomID is not in the Search response table or examples (pp. 13–18). Is it always returned? Does it require a parameter? Is its type an array of strings? (c) Is RoomSize always in square feet?

Q-66.
The Language list for HotelDetails is AR, ES, PT, FR and ZH (p. 58), yet the examples use "EN" (p. 58) and "en" (p. 56). (a) Is EN supported? (b) Is the value case-sensitive? (c) What is returned when no translation exists for the requested language? (d) In which language does TBOHotelCodeList return its descriptions and facilities, given that it has no language parameter?

Q-67.
Hotel images are served from https://api.tbotechnology.in/imageresource.aspx?img=<token> (p. 62) and room images from www.tboholidays.com/imageresource.aspx (p. 57). (a) May we display these images on our agencies' white-label portals and in WhatsApp, cache them, or copy them to our own storage? (b) Do the tokens expire? (c) Does the image host change in production? (d) Are images always served over HTTPS?

Q-68.
HotelRating is declared as an Enumeration in both methods, but HotelDetails returns a number (5, p. 62) and TBOHotelCodeList returns the enum string "ThreeStar" (p. 67). (a) Which format should we expect from each method? (b) Can it contain half stars, 0 or values outside OneStar–FiveStar?

Q-69.
None of the static methods offers deltas, a "modified since" filter or an ETag (pp. 51–69). (a) How often do you recommend refreshing the static catalogue? (b) Is there any delta mechanism? (c) How are hotel additions, removals and merges communicated?

Q-70.
Does TBO provide a GIATA ID, or any other hotel mapping code, that we could use to deduplicate hotels against other suppliers? None appears in the static-content responses (pp. 51–69).

-- Certification --

Q-71.
During the JSON and portal verification you fill in a "JSON checkpoint list" and an Excel sheet of issues, observations and general queries. Could you share the checkpoint list, and the criteria for the portal verification, before we submit our samples?

Q-72.
(a) Is there a template for the integration workflow document? (b) Which file names and folder layout do you expect in the certification zip? (c) Do you want only the successful Search > PreBook > Book > BookingDetail > Cancel chain of each case, or "all the JSON logs", including failed attempts (no availability, rate no longer available)?

Q-73.
The certification flow ends with "Cancel(If Required)". Should we cancel every test booking at the end of its case, or leave some of them active for your review?

Q-74.
Case 7 reads "Booking room with supplements (Provide JSON for any one case)". (a) Is one booking with supplements enough, using the occupancy of any of cases 1–6? (b) Which test HotelCodes or cities return Supplements with Type AtProperty in the integration environment?

Q-75.
Case 8 asks to call the "HotelBookingDetail method" after a successful booking. (a) Does it mean BookingDetail (p. 42), and not HotelBookingDetailBasedOnDate (p. 62)? (b) Should it be called by ConfirmationNumber, by BookingReferenceId, or both?

Q-76.
The portal verification "must occur in our Staging environment". Is that the same endpoint as integration (http://api.tbotechnology.in/TBOHolidays_HotelAPI), with the same test credentials? If not, what is its URL and how do we get credentials for it?

Q-78.
The Client's Details form asks for the platform where the API will be integrated (B2B, B2C, Mobile). If we certify our B2B web portal now, will adding B2C, WhatsApp or mobile channels later require a recertification, or only a notification to TBO?

Q-79.
Our portal user interface is in Spanish. Is a Spanish-language portal, together with an English walkthrough guide and glossary, acceptable for the Website/Portal Verification?

Q-80.
Which fields does the Production Process Form request (for example outbound IP addresses for whitelisting, a production contact, or company data), so that we can prepare them in advance?

Q-82.
(a) Does the test account have enough Limit balance for about 10 test bookings plus a few probes? (b) Which currency is configured in the test account's API profile, and can it be USD?

Q-83.
Does the test environment ever populate HotelConfirmationNumber in BookingDetail? If so, only for check-ins within 30 days of the booking (p. 42)?

Q-84.
The Client's Details form asks for a Skype ID. Since Skype was discontinued in May 2025, may we provide Microsoft Teams or WhatsApp instead?

Q-85.
(a) Should the workflow we submit also declare the static-content methods (CountryList, CityList, TBOHotelCodeList, HotelDetails) and our catalogue synchronisation? (b) Does the portal verification check how hotel content is displayed (images, check-in and check-out times, check-in instructions)?

Q-86.
(a) What is the typical lead time between the submission of the zip and the scheduled JSON Verification date? (b) And between the JSON sign-off and the start of the Portal Verification? (c) Is there a maximum time between the JSON sign-off and the Portal Verification, after which the JSON Verification must be repeated? We would like to plan the delivery of our test portal accordingly.

-- Commercial and account --

Q-89.
(a) Is TotalFare (p. 13) always the net amount charged to the agency, or can it include an agency markup configured in the TBO profile? (b) In BookingDetailsbasedondate (p. 63), how do BookingPrice ("including agency Commision") and AgentMarkup relate to the TotalFare sent in Book? (c) Is its Currency the account profile currency? (d) Can a markup be configured in a TBO profile, and can it be set to zero?

Q-91.
402 AGENT_BLOCKED ("Agency blocked at TBO end", p. 10) has no remarks. (a) What causes it (for example unpaid invoices or exhausted credit)? (b) Is it temporary or permanent, and how is it lifted? (c) Does it block only new searches and bookings, or also BookingDetail and Cancel for existing bookings?

Q-92.
(a) How do we request the credentials for the test account? (b) In our consolidator model, where agencies may bring their own TBO account, is there one test account per agency or a single one for our platform? (c) Can we get more than one test account (for example, one for the certification portal and one for development)? (d) Before live credentials, can our consolidator's commercial account use the TBO B2B web portal to price a sample of real stays, so that we can compare coverage and rates with our current supplier?

Q-93.
To download static content, we would like a platform account (test and live) used only for catalogue synchronisation, separate from the account used for sales. (a) Is that possible? (b) Would it have its own QPS quota, independent of the sales account?

Q-94.
Are the "TBOH_Hotel_API_Specifications(V2.1)" PDF, the "HotelAPI Client" Postman collection and the certification process document subject to confidentiality (NDA) restrictions that would prevent us from storing them in our private Git repository?

Thank you in advance. We are happy to have a call if it is easier to go through some of these questions.

Best regards,
[Name], [Role]
[Company] - technical contact: [email], [phone]
```

Antes de enviar, se quitan las preguntas que una sonda ya haya cerrado (§0.2) y se completan los datos entre corchetes.

---

## Anexo A — Trazabilidad

### A.1 Marcadores reemplazados en 00 a 07

Cada `→ pregunta a TBO` de los documentos 00 a 07 se reemplazó por el enlace a su pregunta. Dos menciones sin flecha ("se pregunta a TBO", en [01](./01-autenticacion-conectividad-y-errores.md) §3.2 y [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §1) conservan el texto y suman el enlace. La tabla cuenta marcadores: uno que enlaza a dos preguntas cuenta una vez, así que el número de enlaces es mayor en 01 (37), 05 (21), 06 (26) y 07 (58).

| Documento                                                   | Marcadores |
| ----------------------------------------------------------- | ---------: |
| [00](./00-fuentes.md)                                       |          9 |
| [01](./01-autenticacion-conectividad-y-errores.md)          |         35 |
| [02](./02-search-y-oferta-canonica.md)                      |         46 |
| [03](./03-prebook-y-book.md)                                |         34 |
| [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) |         41 |
| [05](./05-contenido-estatico-e-inventario.md)               |         17 |
| [06](./06-seams-integracion-repo.md)                        |         24 |
| [07](./07-certificacion.md)                                 |         57 |
| **Total**                                                   |    **263** |

En la revisión final del set se enlazaron también los 77 marcadores de [08](./08-requisitos-maestro.md) y los 3 de [09](./09-plan-implementacion.md) (§17 y §20 P-09, P-14), que sus redactores habían dejado como "→ pregunta a TBO". Su mapeo está en A.2.

### A.2 Identificadores de cada documento

| Documento                                                   | Referencia → pregunta                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [00](./00-fuentes.md)                                       | F-01 → Q-02; F-02 → Q-01; F-03 → Q-11; F-04 → Q-07; F-05 → Q-61; F-06 → Q-76; §4 (caso 8) → Q-75; §7 (dominio de soporte) → Q-11; §8.1 → Q-07; §8.2 (credenciales de test) → Q-92; §1 (confidencialidad de los originales) → Q-94                                                                                                                                                                                                                                                                                                                                                                                                              |
| [01](./01-autenticacion-conectividad-y-errores.md)          | H-01 → Q-03; H-02 → Q-04; H-04 → Q-05; H-06 → Q-07; H-07 → Q-08; H-09 → Q-91; H-11 → Q-09; H-12 → Q-16; H-13 → Q-29; H-14 → Q-10; H-15 y H-16 → Q-11; H-18 → Q-36; H-19 → Q-06; H-20 → Q-12; H-22 → Q-61. §15 (lista en prosa): HTTPS → Q-03, Q-04; URL live y staging → Q-04, Q-76; casing → Q-05; HTTP frente a `Status.Code` → Q-07; `Status` de `hotelcodelist` → Q-61; códigos por método → Q-08; desenlaces del Book → Q-36; timeouts → Q-09; `ResponseTime` → Q-16; ventana de 30 min → Q-29; QPS → Q-10; `AGENT_BLOCKED` → Q-91; logs y email de soporte → Q-11; charset, rotación y allowlist → Q-06; compresión y correlación → Q-12 |
| [02](./02-search-y-oferta-canonica.md)                      | C-03 y C-04 → Q-13; C-05 y C-06 → Q-14; C-07 → Q-15; C-08 → Q-10; C-09 → Q-16; C-10, C-11 y C-12 → Q-18; C-13 → Q-17; C-19, C-22 y C-23 → Q-24; C-20 y C-30 → Q-28; C-21 → Q-21; C-24 → Q-26; C-25 → Q-27; C-26 → Q-22; C-27 → Q-89; C-28 → Q-23; C-29 → Q-65; C-31 → Q-20; C-32 → Q-88; C-33 → Q-31; C-34 → Q-25; D02-6 → Q-19                                                                                                                                                                                                                                                                                                                |
| [03](./03-prebook-y-book.md)                                | H-01 → Q-42; H-02 → Q-41; H-03 → Q-43; H-04 → Q-34; H-05 → Q-35; H-06 → Q-37; H-07 → Q-38; H-08 → Q-36; H-09 y H-20 → Q-33; H-11 → Q-29; H-12 → Q-30; H-13 → Q-31; H-14 → Q-32; H-15 → Q-08; H-16 → Q-44; H-17 → Q-39; H-21 → Q-40; H-22 → Q-90; H-23 → Q-91. §11, preguntas 1 a 19: Q-35, Q-37, Q-38, Q-34, Q-36, Q-33, Q-30, Q-29, Q-08, Q-41, Q-42 y Q-43, Q-44, Q-31, Q-32, Q-90, Q-91, Q-39, Q-40, Q-33                                                                                                                                                                                                                                   |
| [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) | PV-01 → Q-37; PV-02, PV-03, PV-05 y PV-40 → Q-47; PV-06 y PV-07 → Q-46; PV-09 → Q-26; PV-10 → Q-24; PV-12 → Q-45; PV-15 y PV-34 → Q-59; PV-16 → Q-49; PV-17 → Q-50; PV-18 → Q-52; PV-19 y PV-22 → Q-53; PV-20 → Q-09; PV-21 → Q-51; PV-23 → Q-11; PV-24 → Q-05; PV-25 → Q-56; PV-26 → Q-57; PV-28 → Q-48; PV-31 y PV-33 → Q-58; PV-32 → Q-89; PV-35 a PV-38 → Q-54; PV-39 → Q-55; PV-41 → Q-10. "Preguntas abiertas para TBO", 1 a 24: Q-37, Q-38, Q-45, Q-45, Q-46, Q-47, Q-47, Q-47, Q-48, Q-49, Q-50, Q-52, Q-53, Q-09, Q-51 y Q-10, Q-54, Q-54, Q-54, Q-55 y Q-11, Q-05 y Q-56, Q-57, Q-58, Q-89, Q-59                                     |
| [05](./05-contenido-estatico-e-inventario.md)               | CE-02 → Q-68; CE-04 → Q-05; CE-05 → Q-61; CE-06 y CE-07 → Q-65; CE-08 → Q-63; CE-11 → Q-66; CE-15 → Q-09, Q-10, Q-61, Q-62 y Q-64; CE-17 → Q-67; CE-19 → Q-60; CE-20 → Q-03. §13, preguntas 1 a 16: Q-62, Q-63, Q-64, Q-61, Q-10, Q-69, Q-60, Q-65, Q-66, Q-67, Q-68, Q-09, Q-08, Q-64, Q-70, Q-85. §14, decisión 7 → Q-93                                                                                                                                                                                                                                                                                                                     |
| [06](./06-seams-integracion-repo.md)                        | §9: H1 → Q-03; H2 → Q-04; H3 → Q-07; H5 → Q-88; H6 → Q-02; H8 → Q-60; H9 → Q-10; H10 → Q-87. Lista final, 1 a 11: Q-03, Q-04, Q-07, Q-10, Q-34 y Q-35, Q-37, Q-50, Q-09, Q-88, Q-60, Q-87                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| [07](./07-certificacion.md)                                 | H-01 → Q-71; H-02 → Q-72; H-03 → Q-73; H-04 → Q-74; H-05 → Q-75; H-06 → Q-76; H-07 → Q-77; H-08 → Q-78; H-09 → Q-23; H-10 → Q-84; H-11 → Q-11; H-12 → Q-80; H-13 → Q-81; H-14 → Q-83; H-15 → Q-82; H-16 → Q-79. Lista final, 1 a 24: Q-71, Q-72, Q-73, Q-74, Q-75, Q-76, Q-77, Q-78, Q-23, Q-79, Q-80, Q-81, Q-82, Q-83, Q-84, Q-11, Q-13, Q-41, Q-42, Q-34 y Q-35, Q-37, Q-27, Q-43, Q-86                                                                                                                                                                                                                                                     |
| [08](./08-requisitos-maestro.md)                            | §10: G-01 → Q-03, Q-04; G-02 → Q-05; G-03 → Q-07, Q-08; G-04 → Q-10, Q-87; G-05 → Q-09; G-06 → Q-29; G-07 → Q-35 a Q-38; G-08 → Q-49, Q-50, Q-52; G-09 → Q-48; G-10 → Q-13; G-11 → Q-41 a Q-43; G-12 → Q-88; G-13 → Q-23; G-14 → Q-27; G-15 → Q-24, Q-26; G-16 → Q-31; G-17 → Q-60; G-18 → Q-65; G-19 → Q-63, Q-19; G-20 → Q-56, Q-57; G-21 → Q-54, Q-55; G-22 → Q-11; G-23 → Q-02; G-24 → Q-77. §11, 1 a 10: Q-77; Q-35 a Q-37; Q-10 y Q-87; Q-03 y Q-04; Q-88; Q-60; Q-23; Q-49 y Q-50; Q-94; Q-78. Los requisitos, riesgos y decisiones de §2-§7 enlazan su pregunta en su línea "Depende de", "Bloquea" o "Mitigación"                     |
| [09](./09-plan-implementacion.md)                           | Cada PR enlaza sus preguntas en "Depende de". §17 (acceso comercial) → Q-92 (d). §20: P-06 → Q-78; P-07 → Q-23; P-08 → Q-37; P-09 → Q-92 (d); P-10 → Q-77; P-12 → Q-34; P-13 → Q-38; P-14 → Q-86 (b, c); P-15 → Q-76                                                                                                                                                                                                                                                                                                                                                                                                                           |

### A.3 Sondas de certificación

| Sonda ([07](./07-certificacion.md) §6.8) | Pregunta      |
| ---------------------------------------- | ------------- |
| PR-01                                    | [Q-13](#q-13) |
| PR-02                                    | [Q-18](#q-18) |
| PR-03                                    | [Q-03](#q-03) |
| PR-04                                    | [Q-05](#q-05) |
| PR-05                                    | [Q-37](#q-37) |
| PR-06                                    | [Q-07](#q-07) |
| PR-07                                    | [Q-08](#q-08) |
| PR-08                                    | [Q-15](#q-15) |
| PR-09                                    | [Q-43](#q-43) |
| PR-10                                    | [Q-33](#q-33) |
| PR-11                                    | [Q-35](#q-35) |
