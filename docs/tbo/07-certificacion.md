---
titulo: TBO Hotels — Certificación y arnés de captura
fecha: 2026-09-23
estado: borrador
---

# TBO Hotels — Certificación y arnés de captura

Qué cubre: el proceso de certificación de TBO completo, los 8 casos con su ocupación exacta y lo que creemos que TBO revisa en cada uno, el diseño del arnés `tools/tbo/cert-cases.mjs` que genera el zip, el entorno de pruebas que le damos a TBO para la verificación de portal y el checklist de UI. Al final están los anexos en inglés listos para enviar: el documento de workflow, la nota de acceso al portal y el email del zip.

Fuentes y convención de citas: [00-fuentes.md](./00-fuentes.md) §9. El documento de certificación se cita "(Cert, <sección>)" con los nombres de sección de [00](./00-fuentes.md) §4. Los checkpoints de TBO no se publican: toda la lista de §3 es una **reconstrucción nuestra** (INFERIDO) a partir de los Key Points y de las reglas del PDF.

---

## 1. Resumen

1. **Hay cinco fases y cada una se cierra antes de pasar a la siguiente**: integración en cuenta de test (workflow + 8 casos en zip), JSON Verification (≥ 3 días), Portal Verification (≥ 1 semana, en el staging de TBO y con acceso a **nuestro** portal de pruebas), sign-off y Production Process Form para recibir las credenciales live. VERIFICADO-CERT (todas las secciones).
2. **Los RQ del zip tienen que ser los bytes que manda la aplicación.** El arnés no arma JSON propio: maneja el adapter público de `@sales-travel/tbo-hotels` con un `fetch` grabador inyectado. Un script que construya sus propios requests certifica el script, no el producto, y la verificación de portal lo pondría en evidencia. §6.1.
3. **El portal de pruebas no puede ser producción tal como está hoy.** Solo existe un entorno desplegado (`.github/workflows/deploy.yml:3-6`, un solo VPS; `infrastructure/hostinger/Caddyfile:20,34`), y un tenant sin cuenta propia de Despegar cae a las credenciales de plataforma (`apps/api/src/providers-despegar/despegar-hotels.factory.ts:27-35`). Un tester de TBO podría reservar un hotel real con otro proveedor. Recomendación: un stack de certificación sin credenciales reales de ningún proveedor. VERIFICADO-CODIGO; decisión DC-1 (§11).
4. **La web de hoteles solo busca.** No hay detalle, PreBook, formulario de huéspedes, Book, reservas ni cancelación de hotel, y el formulario no pide nacionalidad (`apps/web-b2b/src/app/(app)/hoteles/actions.ts:101,174`, las dos únicas llamadas a la API). La verificación de portal depende de construir todo el checkout (§8). VERIFICADO-CODIGO.
5. **Nombres sin redactar, porque son sintéticos por construcción.** TBO necesita los RQ completos. El arnés solo acepta nombres de su lista sintética, usa un buzón de rol y un teléfono ficticio, y aborta el zip si encuentra credenciales, campos de tarjeta o un `PaymentMode` distinto de `Limit`. §6.6–6.7.
6. **`.env.tbo` hoy NO está ignorado por Git.** `.gitignore:32` ignora solo `.env` exacto y `.gitignore:105` solo `.env.sabre`; `git check-ignore .env.tbo` no devuelve nada. Hay que añadir `.env.tbo` y `.tbo-cert/` antes de crear el primero. VERIFICADO-CODIGO.
7. **Calendario**: el mínimo del contrato es de unos 10 días de pruebas de TBO (3 + 7); lo realista son de 3 a 6 semanas desde el envío del zip, sin contar la construcción del portal. INFERIDO, §2.9.

---

## 2. El proceso de TBO, fase por fase

### 2.1 Mapa de fases

| Fase                           | Qué pasa                                                                                                                                                                                   | Entregable nuestro                                                                                            | Duración        | Quién la cierra                          | Fuente                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | --------------- | ---------------------------------------- | --------------------------------------------------- |
| 0. Alta                        | Completamos "Client's Details". TBO entrega credenciales de test para el endpoint de integración                                                                                           | Formulario (§2.2)                                                                                             | —               | TBO, al entregar credenciales (INFERIDO) | Cert, Client's Details; Cert, TBO Hotel API Details |
| 1. Integration on Test Account | TBO pide un documento de workflow ("what API methods are used, flow of method calls") para definir sus criterios, más RQ y RS de los 8 casos                                               | Workflow ([Anexo A](#anexo-a--integration-workflow-listo-para-enviar)) + zip por email a `apisupport@tbo.com` | —               | Nosotros, al enviar                      | Cert, Integration on Test Account                   |
| 2. JSON Verification           | TBO agenda una fecha, pide "all the JSON logs", llena su "JSON checkpoint list" y un Excel de Issues, Observations y General queries. Un miembro del equipo de API da sign-off de los JSON | Logs y correcciones                                                                                           | **≥ 3 días**    | TBO                                      | Cert, JSON Verification                             |
| 3. Website/Portal Verification | Pruebas en el "Staging environment" de TBO. TBO pide acceso a nuestro "Test Portal" con credenciales de login, identifica sus propios casos y prueba. Mismo checkpoint list y Excel        | URL y usuario del portal ([Anexo B](#anexo-b--test-portal-access-listo-para-enviar))                          | **≥ "1 weeks"** | TBO                                      | Cert, Website/Portal Verification                   |
| 4. Sign Off                    | TBO resume los hallazgos de JSON y portal en una tabla y la envía por email                                                                                                                | —                                                                                                             | —               | TBO                                      | Cert, Sign Off / API Live Credentials               |
| 5. Producción                  | TBO libera las credenciales live según el "Production Process Form" (Microsoft Forms enlazado en el docx)                                                                                  | Formulario de producción                                                                                      | —               | TBO                                      | Cert, Sign Off / API Live Credentials               |

Regla transversal (Cert, nota final): en cada etapa hay que resolver lo pendiente antes de avanzar; los plazos son aproximados; el entorno de certificación recibe actualizaciones frecuentes y puede tener cortes breves sin aviso; las dudas van a `apisupport@tbo.com`. VERIFICADO-CERT.

### 2.2 Datos que TBO pide del cliente ("Client's Details")

| Bloque                                      | Campo (literal)                                                                   | Qué ponemos                                                 | Dueño      | Estado                                       |
| ------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------- | -------------------------------------------- |
| Client's Company Details                    | Company Name                                                                      | Razón social de la entidad que firma con TBO                | Founder    | Abierto (DC-4)                               |
|                                             | Address                                                                           | Dirección legal                                             | Founder    | Abierto (DC-4)                               |
|                                             | City/Country                                                                      | Ciudad y país de la entidad                                 | Founder    | Abierto (DC-4)                               |
| Client's Technical Contact Person           | Name                                                                              | Responsable técnico de la integración                       | Founder    | Abierto (DC-4); el equipo está por contratar |
|                                             | Email                                                                             | Buzón nominal del responsable, más un buzón de rol en copia | Founder    | Abierto                                      |
|                                             | Skype ID                                                                          | No aplica: ver nota                                         | —          | → [Q-84](./10-preguntas-para-tbo.md#q-84)    |
|                                             | Phone/Mobile Number                                                               | Teléfono del responsable                                    | Founder    | Abierto                                      |
| Client's Application/Infrastructure Details | Client's platform where the TBO API will be integrated ("like: B2B, B2C, Mobile") | "B2B web portal" en la primera ronda (DC-2)                 | Founder    | Abierto (DC-2)                               |
|                                             | Test Application URL                                                              | URL del portal de certificación (§7)                        | Ingeniería | Depende de DC-1                              |
|                                             | Application Credentials                                                           | Usuario `vendedor` del tenant de certificación (§7.4)       | Ingeniería | Depende de DC-1                              |

VERIFICADO-CERT (Client's Details) para los campos. Las columnas "Qué ponemos" y "Estado" son propuesta nuestra.

- **Skype ID**: Microsoft cerró Skype en mayo de 2025. Es un dato externo, no de las fuentes de TBO, y se marca INFERIDO. El docx se modificó por última vez el 2025-05-29 ([00](./00-fuentes.md) §1), así que el campo quedó desactualizado. Postura: ofrecer Microsoft Teams o WhatsApp y preguntar cuál aceptan. → [Q-84](./10-preguntas-para-tbo.md#q-84).
- **Las credenciales de la aplicación no van en el mismo email que el zip.** Postura: se entregan por un canal aparte y se rotan al terminar la verificación de portal (§7.4).

### 2.3 Entorno de integración

| Aspecto                                            | Valor                                                                           | Evidencia                                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Endpoint de integración                            | `http://api.tbotechnology.in/TBOHolidays_HotelAPI`                              | VERIFICADO-CERT (TBO Hotel API Details); VERIFICADO-PDF (p. 7, mismo Test BaseURL) |
| Protocolo                                          | `http://`, aunque la p. 7 dice "All APIs should be secured with HTTPS protocol" | VERIFICADO-PDF (p. 7); VERIFICADO-POSTMAN (las 10 URLs)                            |
| Autenticación                                      | Basic Auth con usuario y contraseña de TBO                                      | VERIFICADO-PDF (p. 7)                                                              |
| "Staging environment" de la verificación de portal | No se da URL                                                                    | VERIFICADO-CERT (Website/Portal Verification), por ausencia                        |
| URL live                                           | `{Live-URL}/HotelAPI`: cambian el host **y** el path                            | VERIFICADO-PDF (p. 7)                                                              |

Consecuencias:

- Las credenciales de test viajan en claro por `http://`. Postura: se tratan como material de un solo uso, nunca se reutiliza esa contraseña en ningún otro sistema, y el arnés prueba primero si el host acepta `https://` (sonda PR-03, §6.8). El detalle de transporte está en [01](./01-autenticacion-conectividad-y-errores.md).
- Postura sobre el staging: asumimos que es el mismo endpoint de integración con las mismas credenciales (INFERIDO) y lo confirmamos antes de abrir el portal. → [Q-76](./10-preguntas-para-tbo.md#q-76).

### 2.4 Fase 1 — workflow, 8 casos y zip

Lo que exige TBO (Cert, Integration on Test Account):

- Un **workflow** que diga qué métodos de la API usamos y en qué orden los llamamos, "to define the criteria for verifying the integration". Está en el [Anexo A](#anexo-a--integration-workflow-listo-para-enviar), en inglés y listo para enviar.
- **Muestras JSON (RQ y RS) "from your application"** de los casos 1 a 8, con la secuencia "Search > Prebook > Book> BookingDetails>Cancel(If Required)". En el docx esa secuencia va en una línea propia dentro del párrafo del caso 8. Que rija para los casos 1 a 7 es INFERIDO, aunque es la lectura natural.
- Los archivos **en un zip**, por email a `apisupport@tbo.com`.

Lo que el documento no dice, y postura:

| Hueco                                                                                    | Postura                                                                                                                                                                                   | TBO                                       |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Nombres de archivo y estructura del zip                                                  | Estructura de §5, con un `README.txt` en inglés que indexa cada caso                                                                                                                      | → [Q-72](./10-preguntas-para-tbo.md#q-72) |
| ¿Hay que cancelar todas las reservas de prueba? ("Cancel (If Required)")                 | Se cancelan todas al final de su cadena, y se captura un BookingDetail posterior para mostrar el estado final. Con `TBO_CANCEL_AFTER=false` (§6.2) se pueden dejar activas si TBO lo pide | → [Q-73](./10-preguntas-para-tbo.md#q-73) |
| Caso 7 "(Provide JSON for any one case)"                                                 | Basta **una** reserva con suplementos, usando la ocupación de uno de los casos 1 a 6 (§4.9)                                                                                               | → [Q-74](./10-preguntas-para-tbo.md#q-74) |
| Caso 8: ¿BookingDetail por `ConfirmationNumber`, por `BookingReferenceId` o por los dos? | Los dos, sobre la reserva del caso 4 (§4.10)                                                                                                                                              | → [Q-75](./10-preguntas-para-tbo.md#q-75) |
| Formato del workflow                                                                     | Documento propio (Anexo A); no hay plantilla                                                                                                                                              | → [Q-72](./10-preguntas-para-tbo.md#q-72) |

### 2.5 Fase 2 — JSON Verification

- TBO trabaja sobre "the JSON provided by you for above Test Cases", pero también pide "all the JSON logs" (Cert, JSON Verification). VERIFICADO-CERT.
- Postura: el zip lleva solo las cadenas exitosas de cada caso. Todos los intentos descartados (sin disponibilidad, tarifa caída, sin suplementos) quedan en `attempts/` de la corrida (§6.3) y se entregan si TBO los pide. La aplicación, además, conserva RQ/RS crudos de cada llamada. Ese archivo de payloads en runtime es un requisito del maestro ([08](./08-requisitos-maestro.md)); aquí solo importa que pueda exportarse por rango de tiempo y por reserva.
- El Excel de TBO trae tres categorías: **Issues**, **Observations** y **General queries**. Postura operativa: cada fila se registra como ítem con dueño y se contesta en el mismo Excel. Ninguna "Observation" se deja sin respuesta, porque la nota final del Cert exige cerrar lo pendiente antes de avanzar. INFERIDO.

### 2.6 Fase 3 — Website/Portal Verification

- La prueba ocurre "in our Staging environment", o sea el de TBO. TBO pide "access of Test Portal along with Login Credentials", "identify the cases" y prueba (Cert, Website/Portal Verification). VERIFICADO-CERT.
- Entonces el portal es **nuestro**, y lo que TBO prueba es el producto real conectado al staging de TBO: los mismos builders, la misma UI y las mismas reglas que irán a producción. El entorno y el tenant se definen en §7 y lo que TBO verá está en el checklist de §8.
- TBO elige sus propios casos. Postura: el portal tiene que soportar cualquier ocupación dentro del contrato (1–8 adultos, 0–4 niños, edades 0–18 por habitación, p. 10–11), no solo las de los 8 casos. El PDF escribe "(1-4)" para `Children`; que 0 sea válido es INFERIDO de los casos sin niños del Cert (§4.2).

### 2.7 Fase 4 — Sign-off

TBO resume los hallazgos en una tabla y la manda por email; con eso la certificación queda completa (Cert, Sign Off / API Live Credentials). VERIFICADO-CERT. Postura: la tabla de sign-off se archiva junto al zip enviado (§6.9), porque es la evidencia de lo que TBO aceptó y en qué versión del código (el SHA de git está en `run.json`).

### 2.8 Fase 5 — Production Process Form y credenciales live

- Las credenciales live se liberan "based on the Production Process Form" (Cert, Sign Off / API Live Credentials). El formulario es de Microsoft Forms y **no se abrió** para este documento, así que sus campos no se conocen. → [Q-80](./10-preguntas-para-tbo.md#q-80) (qué datos pide, por ejemplo IPs de salida, para prepararlos antes).
- La URL live llega con las credenciales: `{Live-URL}/HotelAPI` (p. 7). En la bóveda, test y live no pueden convivir como dos cuentas `active` del mismo tenant, porque `resolve_provider_account` devuelve una sola sin desempate por `label` (`db/migrations/0012_provider_accounts.sql:59-77`). El pase a live es sustituir la cuenta, no añadir otra. El detalle está en [06](./06-seams-integracion-repo.md). VERIFICADO-CODIGO.
- **Alcance de la certificación en el modelo consolidador.** El Cert no dice si certifica la aplicación (y cualquier cuenta TBO puede usarla) o una cuenta concreta. Para BYOC importa mucho: una agencia de la red con su propia cuenta TBO, ¿puede operar por nuestra integración certificada, o TBO exige algo por agencia? → [Q-77](./10-preguntas-para-tbo.md#q-77). Hasta tener la respuesta, **BYOC de TBO queda deshabilitado** y solo opera la cuenta que se certificó (heredada por la red).

### 2.9 Calendario estimado (INFERIDO)

| Tramo                             | Mínimo del contrato     | Estimación realista                           | Qué lo alarga                                                                                            |
| --------------------------------- | ----------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Formulario → credenciales de test | —                       | 2–5 días hábiles                              | Respuesta de TBO                                                                                         |
| Credenciales → zip enviado        | —                       | 1–3 días, **si el ACL y el arnés ya existen** | Disponibilidad del entorno de test (Cert, nota final); inventario de test sin suplementos para el caso 7 |
| Zip → fecha de JSON Verification  | —                       | 3–10 días hábiles                             | Agenda de TBO                                                                                            |
| JSON Verification                 | 3 días                  | 3–8 días                                      | Idas y vueltas del Excel                                                                                 |
| Portal Verification               | 1 semana                | 1–3 semanas                                   | Hallazgos de UI, idioma (§10 R-08)                                                                       |
| Sign-off → credenciales live      | —                       | 2–7 días hábiles                              | Production Process Form                                                                                  |
| **Total desde el envío del zip**  | **≈ 10 días de prueba** | **3–6 semanas**                               | —                                                                                                        |

El contrato solo fija los mínimos (VERIFICADO-CERT); todo lo demás es estimación. La construcción del portal (§8) no está incluida y es la ruta crítica ([09](./09-plan-implementacion.md)).

---

## 3. Checkpoints que esperamos que TBO revise

TBO no publica su "JSON checkpoint list" (Cert, JSON Verification). Esta lista la reconstruimos nosotros: es INFERIDO que TBO la revise así, pero cada regla tiene su fuente. J = visible en el zip; P = visible solo en el portal.

| ID    | Checkpoint                                                                                                                                                                                                                                                              | Fuente de la regla                                                                                                                                                                                                | Dónde se ve                  | Dónde se cumple                                                                                    |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------- |
| CK-01 | `GuestNationality` = nacionalidad del huésped líder, **no fija**: varía entre casos y la elige el usuario                                                                                                                                                               | KP-1 (p. 71); p. 10. VERIFICADO-PDF                                                                                                                                                                               | J, P                         | UI (campo obligatorio) y ACL (no hay default)                                                      |
| CK-02 | `IsDetailedResponse: false` en todo Search de listado, que son todos los del zip. El detalle de un hotel repite Search con `true` y un solo `HotelCode` (D-TBO-19 A); se declara en el workflow (Anexo A) y se pregunta a TBO → [Q-19](./10-preguntas-para-tbo.md#q-19) | KP-2 (p. 71); p. 11. VERIFICADO-PDF                                                                                                                                                                               | J, P                         | Builder de Search ([02](./02-search-y-oferta-canonica.md) §6.2)                                    |
| CK-03 | `PaxRooms` exactos: un elemento por habitación, `Adults` 1–8, `ChildrenAges` con longitud = `Children` y edades 0–18                                                                                                                                                    | p. 10–11. VERIFICADO-PDF                                                                                                                                                                                          | J, P                         | Zod del ACL y selector de habitaciones                                                             |
| CK-04 | `HotelCodes` como un solo string CSV, ≤ 100 códigos por request                                                                                                                                                                                                         | p. 10 ("Recommended Value; 100"). VERIFICADO-PDF                                                                                                                                                                  | J                            | Fan-out del ACL                                                                                    |
| CK-05 | Orden Search > PreBook > Book > BookingDetail > Cancel, dentro de 30 min de Search a Book                                                                                                                                                                               | Cert, Integration on Test Account; p. 8. VERIFICADO-CERT / VERIFICADO-PDF                                                                                                                                         | J, P                         | Saga de reserva ([03](./03-prebook-y-book.md))                                                     |
| CK-06 | PreBook con el `BookingCode` de Search y `PaymentMode: "Limit"`                                                                                                                                                                                                         | p. 19; D1 ([08](./08-requisitos-maestro.md)). VERIFICADO-PDF                                                                                                                                                      | J                            | ACL                                                                                                |
| CK-07 | Política de cancelación y `RateConditions` de PreBook mostradas y guardadas como finales                                                                                                                                                                                | KP-3 (p. 71); p. 23. VERIFICADO-PDF. "Norms" = `RateConditions` sale de la descripción del campo, "Hotel/Room norms associated with the bookable unit" (p. 23), porque KP-3 no nombra el campo                    | P                            | UI de PreBook y reserva                                                                            |
| CK-08 | Suplementos visibles al cliente final; `AtProperty` antes o en el paso de reserva                                                                                                                                                                                       | p. 14, 23, 48 ("Please ensure same are visible to end customer"); KP-4 (p. 71). VERIFICADO-PDF                                                                                                                    | J (caso 7), P                | UI de resultados, PreBook, confirmación y voucher                                                  |
| CK-09 | Precio de venta al viajero ≥ `RecommendedSellingRate`                                                                                                                                                                                                                   | p. 13, 21. VERIFICADO-PDF. El texto dice "B2C client"; con D-TBO-16 (A) el piso aplica en todo canal, también en el portal B2B ([08](./08-requisitos-maestro.md) RF-12) → [Q-23](./10-preguntas-para-tbo.md#q-23) | P                            | Pricing waterfall ([02](./02-search-y-oferta-canonica.md) §9.5)                                    |
| CK-10 | Book: un `CustomerDetails` por habitación, en el orden de `PaxRooms`, con todos los pax nombrados y `Type` correcto                                                                                                                                                     | p. 32–33; ejemplos p. 34, 39. VERIFICADO-PDF. Son INFERIDOS que sea obligatorio nombrar a todos y el orden de `PaxRooms`, que no está escrito (§4.8)                                                              | J, P                         | Formulario de huéspedes y builder de Book                                                          |
| CK-11 | Book: `TotalFare` = el de PreBook, `BookingType: "Voucher"`, `PaymentMode: "Limit"`, sin `PaymentInfo`                                                                                                                                                                  | p. 33; D1. VERIFICADO-PDF. Que `TotalFare` tenga que ser el de PreBook es INFERIDO: p. 33 solo dice "Total fare for the booking"                                                                                  | J                            | ACL                                                                                                |
| CK-12 | `BookingReferenceId` único por reserva y `ClientReferenceId` enviados                                                                                                                                                                                                   | p. 33, 43; change log v1.4 (p. 5). VERIFICADO-PDF                                                                                                                                                                 | J                            | Intent de orden antes del Book ([03](./03-prebook-y-book.md))                                      |
| CK-13 | BookingDetail después de un Book exitoso                                                                                                                                                                                                                                | Cert (caso 8); p. 42. VERIFICADO-CERT                                                                                                                                                                             | J, P                         | Saga de reserva                                                                                    |
| CK-14 | Ante timeout o error del Book: BookingDetail por `BookingReferenceId` pasados 120 s, sin re-Book automático                                                                                                                                                             | p. 42 ("mandatory"). VERIFICADO-PDF. "Sin re-Book automático" es INFERIDO: el PDF no lo prohíbe                                                                                                                   | J (si ocurre), P             | Saga de reserva y cola de post-venta ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md)) |
| CK-15 | Cancel por `ConfirmationNumber` y estado final confirmado con BookingDetail                                                                                                                                                                                             | p. 41–42; enumeración p. 70–71. VERIFICADO-PDF. Confirmar con BookingDetail es INFERIDO de los estados intermedios; la secuencia del Cert pone BookingDetail antes de Cancel                                      | J, P                         | Post-venta ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md))                           |
| CK-16 | Decisión por `Status.Code` del body, nunca por `Description` (201 sin disponibilidad, 207, 315, 300, 402…)                                                                                                                                                              | p. 8–10, 18. VERIFICADO-PDF. "Nunca por `Description`" es INFERIDO: el texto de éxito varía entre métodos ("Successful", "Cancelled" en la p. 42, "Success" en la p. 52)                                          | P                            | Clasificador ([01](./01-autenticacion-conectividad-y-errores.md))                                  |
| CK-17 | Basic Auth, `POST`, `Content-Type: application/json`, timeouts por método (Search 5–23 s, PreBook 23 s, Book 120 s)                                                                                                                                                     | p. 7–8. VERIFICADO-PDF                                                                                                                                                                                            | — (TBO lo ve en su servidor) | Cliente HTTP del ACL                                                                               |
| CK-18 | Cambio de precio Search → PreBook detectado y reconfirmado por el usuario                                                                                                                                                                                               | p. 19 ("up-to-date availability and prices"). La regla es VERIFICADO-PDF; que sea checkpoint es INFERIDO                                                                                                          | P                            | UI de PreBook                                                                                      |

---

## 4. Los 8 casos

### 4.1 Parámetros comunes a todos los casos

| Parámetro                                                                         | Valor en el arnés                                                                                                                                                                                                                                                         | Por qué                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CheckIn`                                                                         | Hoy + 45 días (`TBO_CHECKIN_OFFSET_DAYS`). Con hoy = 2026-09-23 da `2026-11-07`                                                                                                                                                                                           | Lejos de cualquier efecto operativo. El HCN no aplica a check-ins a más de 30 días (p. 42), y eso no importa para certificar                                                                                |
| Noches                                                                            | 2 (`TBO_NIGHTS`) → `CheckOut` `2026-11-09`                                                                                                                                                                                                                                | Con 1 noche no se puede saber si `DayRates` es por habitación o por noche; todos los ejemplos del PDF son de 1 noche (p. 24, 28). La captura cierra esa ambigüedad ([02](./02-search-y-oferta-canonica.md)) |
| `HotelCodes`                                                                      | `TBO_HOTEL_CODES`; por defecto los 13 de la colección (`376565,1345318,1345320,1200255,1128760,1250333,1078234,1347149,1358855,1345321,1108025,1356271,1267547`). Con `TBO_CITY_CODE` se toman de `TBOHotelCodeList` en lotes de ≤ 100                                    | VERIFICADO-POSTMAN (Search); p. 10, 65                                                                                                                                                                      |
| `GuestNationality`                                                                | **Distinta en cada caso** y siempre la del huésped líder sintético (tabla §4.2)                                                                                                                                                                                           | CK-01                                                                                                                                                                                                       |
| `IsDetailedResponse`                                                              | `false`                                                                                                                                                                                                                                                                   | CK-02                                                                                                                                                                                                       |
| `ResponseTime` y `Filters`                                                        | Lo que envíe el builder del ACL; el arnés no los toca                                                                                                                                                                                                                     | El RQ tiene que ser el de la aplicación ([02](./02-search-y-oferta-canonica.md))                                                                                                                            |
| `PaymentMode`                                                                     | `"Limit"` en PreBook, Book y BookingDetail                                                                                                                                                                                                                                | D1; CK-06, CK-11                                                                                                                                                                                            |
| `EmailId`                                                                         | Buzón de rol propio (`TBO_CERT_EMAIL`), nunca personal ni el de la colección                                                                                                                                                                                              | [00](./00-fuentes.md) §3 prohíbe copiar el `EmailId` de `HotelBook`                                                                                                                                         |
| `PhoneNumber`                                                                     | Ficticio, solo dígitos con prefijo país y sin `+` (`TBO_CERT_PHONE`, por ejemplo `573000000000`)                                                                                                                                                                          | Formato de los ejemplos (p. 35–36). INFERIDO                                                                                                                                                                |
| `BookingReferenceId`                                                              | Generado por el ACL con la misma regla que producción: `ST` + `T` (entorno de test) + 17 caracteres Crockford base32, 20 en total, único por request de Book ([03](./03-prebook-y-book.md) §3.3)                                                                          | Formato y longitud no documentados (p. 33, 43). → [Q-34](./10-preguntas-para-tbo.md#q-34)                                                                                                                   |
| `ClientReferenceId`                                                               | El mismo valor que `BookingReferenceId`, como en producción ([03](./03-prebook-y-book.md) §3.3; [08](./08-requisitos-maestro.md) RF-19). El arnés no lo arma: el RQ tiene que ser el de la aplicación (§6.1). La corrida y el caso se trazan en `README.txt` y `run.json` | Formato no documentado (p. 33). INFERIDO                                                                                                                                                                    |
| Nombres                                                                           | Lista sintética fija del arnés, solo ASCII; apellido `Test` + número del caso en letras                                                                                                                                                                                   | §6.6. Las tildes y la `ñ` se prueban aparte (PR-09)                                                                                                                                                         |
| Selección de tarifa                                                               | Casos 1–6: la opción `IsRefundable: true` más barata; si no hay, la más barata. Caso 7: la primera con `Supplements` de `Type: "AtProperty"` (§4.9)                                                                                                                       | Una tarifa reembolsable permite cancelar sin cargo en test                                                                                                                                                  |
| Sin disponibilidad (`Status.Code` 201), tarifa caída (207) o sesión vencida (315) | Se reintenta con el check-in corrido 7 días, hasta 3 veces. Cada intento fallido va a `attempts/`                                                                                                                                                                         | CK-16. Book nunca se reintenta (§6.5)                                                                                                                                                                       |

### 4.2 Tabla maestra

| Caso | Texto de TBO (Cert)                                                                     | `PaxRooms` exactos                                                                              | `CustomerDetails` (A = Adult, C = Child) | `GuestNationality` |
| ---- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------ |
| 1    | Room 1 – Adult 1                                                                        | `[{"Adults":1,"Children":0,"ChildrenAges":[]}]`                                                 | `[[A]]`                                  | `CO`               |
| 2    | Room 1 – Adult 1, Child 1                                                               | `[{"Adults":1,"Children":1,"ChildrenAges":[7]}]`                                                | `[[A,C]]`                                | `PE`               |
| 3    | Room 1 – Adult 2, Child 2                                                               | `[{"Adults":2,"Children":2,"ChildrenAges":[4,10]}]`                                             | `[[A,A,C,C]]`                            | `BR`               |
| 4    | Room 1 – Adult 1 Room 2 – Adult 1                                                       | `[{"Adults":1,"Children":0,"ChildrenAges":[]},{"Adults":1,"Children":0,"ChildrenAges":[]}]`     | `[[A],[A]]`                              | `MX`               |
| 5    | Room 1 – Adult 1, Child 1 Room 2 – Adult 1                                              | `[{"Adults":1,"Children":1,"ChildrenAges":[8]},{"Adults":1,"Children":0,"ChildrenAges":[]}]`    | `[[A,C],[A]]`                            | `CL`               |
| 6    | Room 1 – Adult 1, Child 2 Room 2 – Adult 2                                              | `[{"Adults":1,"Children":2,"ChildrenAges":[3,11]},{"Adults":2,"Children":0,"ChildrenAges":[]}]` | `[[A,C,C],[A,A]]`                        | `AR`               |
| 7    | Booking room with supplements (Provide JSON for any one case)                           | La del caso 4; si no hay suplementos, la del caso 1                                             | Según la ocupación usada                 | `EC`               |
| 8    | Kindly call HotelBookingDetail method for any of the above case post successful booking | Reutiliza la reserva del caso 4                                                                 | —                                        | —                  |

VERIFICADO-CERT (columna "Texto de TBO"). Las demás columnas son diseño nuestro.

**Edades de niños**: se eligen edades de 3 a 11 años distintas entre sí, para que cada edad sea rastreable en la respuesta. Se evitan 0 y 18 porque el contrato no aclara si 18 cuenta como niño (p. 11); esos bordes se prueban en las sondas.

**Habitaciones sin niños**: `"Children": 0` con `"ChildrenAges": []`. Choca con dos cosas:

- el rango "(1-4)" de `Children` (p. 11);
- la colección, que envía `"ChildrenAges": [0]` con `Children: 0` (Postman: Search).

Postura: se sigue la regla escrita "The length of array is equal to the number of children in the room" (p. 11), y la sonda PR-01 captura `[]`, `[0]` y el campo omitido antes de la primera corrida. Si TBO rechaza `[]`, el cambio es una línea del builder, no del arnés. → [Q-13](./10-preguntas-para-tbo.md#q-13).

### 4.3 Request de Search completo (caso 1)

Así saldría el RQ del caso 1, con las fechas de §4.1. `ResponseTime` y `Filters` los define el builder de [02](./02-search-y-oferta-canonica.md) §2.3, no el arnés: `ResponseTime` es el valor por defecto de D-TBO-17 (A), 10 s ([08](./08-requisitos-maestro.md) §9 C-01), y `Filters` son los de los ejemplos del PDF (p. 11–12) corregidos a JSON válido.

```json
{
  "CheckIn": "2026-11-07",
  "CheckOut": "2026-11-09",
  "HotelCodes": "376565,1345318,1345320,1200255,1128760,1250333,1078234,1347149,1358855,1345321,1108025,1356271,1267547",
  "GuestNationality": "CO",
  "PaxRooms": [{ "Adults": 1, "Children": 0, "ChildrenAges": [] }],
  "ResponseTime": 10,
  "IsDetailedResponse": false,
  "Filters": { "Refundable": false, "NoOfRooms": 0, "MealType": "All" }
}
```

Los dos ejemplos de request del PDF no son JSON válido: llevan comillas tipográficas en `"MealType": “All”` y les falta una `}` (p. 11–12). No se copian.

PreBook, igual en todos los casos (p. 19):

```json
{ "BookingCode": "<BookingCode de la opción elegida en Search>", "PaymentMode": "Limit" }
```

### 4.4 Caso 1 — Room 1: Adult 1

- **Book**: `CustomerDetails` de 1 elemento con 1 `CustomerNames` `Type: "Adult"`.
- **Qué verifica TBO** (INFERIDO): CK-01 a CK-06, CK-10 a CK-13 y CK-15. Lo propio del caso es la habitación sin niños (CK-03) y la forma de `ChildrenAges`.
- **Riesgo**: es el caso que más probablemente dispare la discusión `[]` frente a `[0]` (§4.2).

### 4.5 Caso 2 — Room 1: Adult 1, Child 1

- **Book**: 1 `CustomerDetails` con 2 nombres: `Adult` primero y `Child` después.
- **Qué verifica TBO** (INFERIDO): CK-03 (`ChildrenAges` de longitud 1) y CK-10 (el niño nombrado y con `Type: "Child"`).
- **Título del niño**: `Mr` o `Ms`, como en los ejemplos del PDF (p. 34, 39). El contrato solo admite `'Mr'`, `'Mrs'`, `'Ms'` (p. 32) y no tiene `Master` ni `Miss`. → [Q-41](./10-preguntas-para-tbo.md#q-41).
- La edad del niño **no viaja en el Book** (p. 32–34): la fija el Search. El ACL guarda la ocupación asociada al `BookingCode` ([03](./03-prebook-y-book.md)).

### 4.6 Caso 3 — Room 1: Adult 2, Child 2

- **Book**: 1 `CustomerDetails` con 4 nombres, en orden `Adult`, `Adult`, `Child`, `Child`.
- **Qué verifica TBO** (INFERIDO): CK-03 (dos edades distintas) y CK-10 (todos los pax nombrados). El PDF describe `FirstName` como "Lead guest first name" (p. 32), pero todos sus ejemplos nombran a cada pax (p. 34, 39). Postura: se nombra a todos. → [Q-42](./10-preguntas-para-tbo.md#q-42).

### 4.7 Caso 4 — Room 1: Adult 1; Room 2: Adult 1

- **Search**: `PaxRooms` de 2 elementos. La opción devuelta es un roompack: `Name` trae 2 entradas, un solo `BookingCode` y un solo `TotalFare` (p. 13, 16–17).
- **Book**: `CustomerDetails` de 2 elementos, 1 `Adult` cada uno.
- **Qué verifica TBO** (INFERIDO): CK-10 (un elemento por habitación y en orden) y CK-11 (`TotalFare` del conjunto).
- Su reserva es la base del caso 8 (§4.10), porque el único ejemplo de BookingDetail del PDF es de 1 habitación (p. 49–51) y no se sabe cómo viene `Rooms[]` con 2.

### 4.8 Casos 5 y 6 — ocupación asimétrica

- **Caso 5**: `CustomerDetails[0]` = Adult + Child; `CustomerDetails[1]` = Adult.
- **Caso 6**: `CustomerDetails[0]` = 1 Adult + 2 Child; `CustomerDetails[1]` = 2 Adult.
- **Qué verifica TBO** (INFERIDO): que el orden de habitaciones se conserve de Search a Book. Si se invierte, la habitación con niños recibe nombres de adultos. El orden no está escrito en el contrato; se deduce de "first element represents the first room" (p. 13, 20) y de los ejemplos multi-habitación (p. 35–40).

Book del caso 6 como plantilla. Los `<…>` los rellena el arnés, así que el bloque no es JSON literal:

```text
{
  "BookingCode": "<BookingCode de Search (p. 32), el mismo que devuelve PreBook (p. 17 y 28)>",
  "CustomerDetails": [
    { "CustomerNames": [
        { "Title": "Mr",  "FirstName": "Mateo",  "LastName": "Testseis", "Type": "Adult" },
        { "Title": "Ms",  "FirstName": "Lucia",  "LastName": "Testseis", "Type": "Child" },
        { "Title": "Mr",  "FirstName": "Tomas",  "LastName": "Testseis", "Type": "Child" } ] },
    { "CustomerNames": [
        { "Title": "Mrs", "FirstName": "Paula",  "LastName": "Testseis", "Type": "Adult" },
        { "Title": "Mr",  "FirstName": "Andres", "LastName": "Testseis", "Type": "Adult" } ] }
  ],
  "ClientReferenceId": "<generado por el ACL: el mismo valor que BookingReferenceId>",
  "BookingReferenceId": "<generado por el ACL, por ejemplo STT…, 20 caracteres>",
  "TotalFare": <TotalFare de la respuesta de PreBook>,
  "EmailId": "<TBO_CERT_EMAIL>",
  "PhoneNumber": "<TBO_CERT_PHONE>",
  "BookingType": "Voucher",
  "PaymentMode": "Limit"
}
```

Campos y casing: p. 32–34. `PaymentInfo` no existe en nuestro builder (D1). VERIFICADO-PDF.

### 4.9 Caso 7 — reserva con suplementos

- **Selección**: el arnés recorre las opciones de Search y toma la primera con `Supplements` no vacío y al menos un `Type: "AtProperty"`. Si ninguna tiene `AtProperty`, acepta `Included` y lo anota en el `README.txt`. Si no hay suplementos en ningún lote de `HotelCodes`, falla con un mensaje claro: el caso no se puede fabricar, depende del inventario de test. → [Q-74](./10-preguntas-para-tbo.md#q-74) (hoteles de test con suplementos).
- **Ocupación**: la del caso 4, porque dos habitaciones muestran la forma real de `Supplements` (un array por habitación con `Index` 1 y 2, p. 17, 28–29). Si no aparece, se usa la del caso 1.
- **Qué verifica TBO** (INFERIDO): en el JSON, que la cadena completa se hizo sobre una tarifa con suplementos. En el portal, CK-08: que el suplemento `AtProperty` se vea con importe y moneda (que puede no ser la de la reserva: `AED` frente a `USD`, p. 15) antes o en el paso de reserva, y que no se sume al total cobrado.
- La unidad de `Price` (por noche, por habitación o por estadía) no está documentada (p. 14–15, 28–31). Postura: la UI muestra el importe tal cual, con la leyenda "según condiciones del hotel", y nunca lo multiplica. → [Q-27](./10-preguntas-para-tbo.md#q-27).

### 4.10 Caso 8 — BookingDetail después de reservar

- **Sobre qué reserva**: la del caso 4, antes de su Cancel.
- **Dos llamadas**:
  1. `{"ConfirmationNumber": "<del Book>", "PaymentMode": "Limit"}` (p. 44, 10.1.1).
  2. `{"BookingReferenceId": "<el enviado en el Book>", "PaymentMode": "Limit"}` (p. 44, 10.1.2).
- **Por qué las dos**: la segunda es la llamada del camino de recuperación obligatorio (p. 42, CK-14). Mostrar que funciona antes de necesitarla es la mejor evidencia de ese checkpoint.
- **Qué verifica TBO** (INFERIDO): CK-13 y CK-14.
- **Qué no esperar**: `HotelConfirmationNumber` probablemente llegue vacío o ausente, porque el check-in está a más de 30 días (p. 42). El arnés lo anota y no lo trata como fallo.
- **Secuencia completa de la reserva del caso 4**: Search → PreBook → Book → BookingDetail (por `ConfirmationNumber`, carpeta del caso 4) → **caso 8** (por `ConfirmationNumber` y por `BookingReferenceId`) → Cancel → BookingDetail posterior a la cancelación.

---

## 5. Entrega: zip, nombres de archivo e índice

Nombre del zip: `<Empresa>_TBO_HotelAPI_JSON_Certification_<YYYYMMDD>.zip`. `<Empresa>` sale de DC-4.

```text
<Empresa>_TBO_HotelAPI_JSON_Certification_20261015.zip
├── README.txt                                  índice en inglés (ver abajo)
├── Case01_1Room_1A/
│   ├── 01_Search_RQ.json        01_Search_RS.json
│   ├── 02_PreBook_RQ.json       02_PreBook_RS.json
│   ├── 03_Book_RQ.json          03_Book_RS.json
│   ├── 04_BookingDetail_RQ.json 04_BookingDetail_RS.json
│   ├── 05_Cancel_RQ.json        05_Cancel_RS.json
│   └── 06_BookingDetail_AfterCancel_RQ.json  06_BookingDetail_AfterCancel_RS.json
├── Case02_1Room_1A1C/ …
├── Case03_1Room_2A2C/ …
├── Case04_2Rooms_1A_1A/ …
├── Case05_2Rooms_1A1C_1A/ …
├── Case06_2Rooms_1A2C_2A/ …
├── Case07_Supplements_2Rooms_1A_1A/ …
└── Case08_BookingDetail_OfCase04/
    ├── 01_BookingDetail_ByConfirmationNumber_RQ.json    …_RS.json
    └── 02_BookingDetail_ByBookingReferenceId_RQ.json    …_RS.json
```

Reglas de los archivos:

- **Bytes exactos**. El RQ es el cuerpo tal como salió por el socket y el RS es el texto tal como llegó, sin re-serializar ni reformatear. Si TBO duda de un archivo, tiene que ser lo que vio su servidor. Los RS de TBO pueden traer HTML escapado y caracteres rotos (p. 26, 51); re-serializarlos los alteraría.
- **Numeración por paso**, para que el orden de la cadena se lea en el nombre (CK-05).
- **Solo cadenas completas.** Los intentos descartados quedan fuera del zip (§2.5).

`README.txt` (en inglés, lo genera el arnés):

```text
TBO Holidays Hotel API (JSON V2.1) - certification samples
Company: <Empresa>   Run: <runId>   Endpoint: http://api.tbotechnology.in/TBOHolidays_HotelAPI
Application build: <git sha>        Generated: <UTC timestamp>

Case | Occupancy (as requested by TBO)      | HotelCode | BookingCode | ConfirmationNumber | BookingReferenceId | Cancelled
01   | Room 1 - Adult 1                     | ...       | ...         | ...                | ...                | yes
...
07   | Supplements (occupancy of case 04)   | ...  supplements found: AtProperty mandatory_tax 20.00 AED (room 1, room 2)
08   | BookingDetail of case 04 by ConfirmationNumber and by BookingReferenceId

Every call: UTC start time, HTTP status, Status.Code, latency (ms).
PaymentMode is "Limit" in every PreBook, Book and BookingDetail. No card data is sent.
All guest names, email and phone are synthetic test data.
```

---

## 6. Arnés `tools/tbo/cert-cases.mjs`

Es el análogo de `tools/sabre/cert-probe.mjs`: un `.mjs` sin dependencias, que lee credenciales de un `.env.<proveedor>` ignorado por Git y graba evidencia en disco. Difiere en tres cosas (tabla de §6.10): **reserva** (Sabre lo evitaba a propósito, `tools/sabre/cert-probe.mjs:4-7`), **no arma los requests** y **empaqueta el zip**.

### 6.1 Principio: los RQ los construye la aplicación

- TBO pide muestras "from your application" (Cert, Integration on Test Account). VERIFICADO-CERT.
- El arnés importa el adapter público del ACL desde `providers/tbo-hotels/dist/index.js` y le inyecta dos cosas:

  - un `fetch` grabador;
  - un logger silencioso.

  Ambas están previstas en la forma del paquete ([06](./06-seams-integracion-repo.md)). El precedente está en Sabre: la captura "vale para prod" porque el flag se coloca donde lo pone el builder de producción (`tools/sabre/cert-probe.mjs:272-282`). Aquí se va un paso más allá: el builder **es** el de producción.

- **Consecuencia**: el arnés no se puede escribir ni correr antes que el ACL. Si `dist/` no existe, se detiene con el mensaje "corre `pnpm --filter @sales-travel/tbo-hotels build`".
- **Contraste manual antes del portal**: los 8 casos se repiten a mano por la UI del portal de certificación, se exportan del archivo de payloads de la aplicación y se comparan con los del arnés. Deben diferir solo en valores dinámicos (fechas, `BookingCode`, referencias). Si difieren en forma, alguna capa entre la UI y el ACL transforma el request, y TBO lo encontraría en la fase de portal.

### 6.2 Archivos y configuración

| Archivo                                | Versionado                                                                                                                                                                                                 | Contenido                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `tools/tbo/cert-cases.mjs`             | Sí                                                                                                                                                                                                         | El arnés                                              |
| `tools/tbo/README.md`                  | Sí                                                                                                                                                                                                         | Uso, al estilo de `tools/sabre/README.md`             |
| `.env.tbo.example`                     | Sí                                                                                                                                                                                                         | Plantilla sin valores, espejo de `.env.sabre.example` |
| `.env.tbo`                             | **No**. Hay que añadirlo a `.gitignore`: hoy no lo cubre ninguna regla (`.gitignore:32` es solo `.env`; `.gitignore:105` es solo `.env.sabre`). VERIFICADO-CODIGO (`git check-ignore .env.tbo` sin salida) | Credenciales y parámetros                             |
| `.tbo-cert/<runId>/`                   | **No**. También hay que añadirlo a `.gitignore`                                                                                                                                                            | Corridas completas, incluidos intentos y sondas       |
| `docs/tbo/evidence/cert/<YYYY-MM-DD>/` | Sí, solo el set enviado y tras las guardas (§6.9)                                                                                                                                                          | Copia exacta del zip enviado y tabla de sign-off      |

`.env.tbo.example`:

```text
# Credenciales de TEST de TBO para tools/tbo/cert-cases.mjs
# Copia este archivo a .env.tbo (ignorado por Git) y rellénalo. NUNCA commitear .env.tbo.
TBO_USERNAME=
TBO_PASSWORD=
# El arnés se niega a correr contra otro host salvo con --allow-non-test-host.
TBO_BASE_URL=http://api.tbotechnology.in/TBOHolidays_HotelAPI

# Inventario. Por defecto, los 13 HotelCodes de la colección Postman.
# TBO_HOTEL_CODES=376565,1345318,...
# TBO_CITY_CODE=

# Fechas: hoy + offset, N noches.
TBO_CHECKIN_OFFSET_DAYS=45
TBO_NIGHTS=2

# Contacto de las reservas de prueba: buzón de rol y teléfono ficticio. Nunca datos personales.
TBO_CERT_EMAIL=
TBO_CERT_PHONE=

# Para el nombre del zip.
TBO_COMPANY_SLUG=
# false = no cancela las reservas al final de cada caso.
TBO_CANCEL_AFTER=true
```

La carga de `.env.tbo` copia `loadDotEnv()` de Sabre (`tools/sabre/cert-probe.mjs:33-42`): el entorno del proceso tiene prioridad sobre el archivo, y el archivo es opcional.

### 6.3 Comandos

| Comando                               | Qué hace                                                                                                                                                                    | ¿Reserva? |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `node tools/tbo/cert-cases.mjs check` | Valida las credenciales con un Search de la ocupación del caso 1, sin reservar. Imprime `Status.Code`, la `Currency` del perfil (p. 13), la latencia y cuántas opciones hay | No        |
| `… probe`                             | Corre las sondas de contrato de §6.8. Salida en `.tbo-cert/<runId>/probes/`. **Nunca entra al zip**                                                                         | No        |
| `… probe --bookings`                  | Además corre las sondas que crean reservas de test y las cancela                                                                                                            | Sí (test) |
| `… run [--cases 1,2,4]`               | Corre las cadenas de los casos pedidos (por defecto 1–8) y escribe `.tbo-cert/<runId>/CaseNN_*/`                                                                            | Sí (test) |
| `… verify <runId>`                    | Pasa las guardas de §6.7 sobre la corrida y escribe `selfcheck.md` con el estado de cada CK visible en JSON                                                                 | No        |
| `… zip <runId>`                       | Vuelve a pasar las guardas, escribe `README.txt` y `manifest.json` (SHA-256 por archivo) y arma el zip                                                                      | No        |
| `… all`                               | `check` → `run` → `verify` → `zip`                                                                                                                                          | Sí (test) |

Estructura de una corrida:

```text
.tbo-cert/2026-10-15T14-03-22Z/
├── run.json          parámetros, git SHA, versión del ACL, baseUrl y versión de Node. Sin credenciales
├── Case01_1Room_1A/  … los archivos de §5, más calls.jsonl (una línea por llamada: método, path,
│                     HTTP status, Status.Code, latencia, timestamps, headers con Authorization redactado)
├── …
├── attempts/         cadenas descartadas (201, 207, 315, sin suplementos), con su motivo
├── probes/           solo con `probe`
├── selfcheck.md      salida de `verify`
└── <zip>             solo con `zip`
```

### 6.4 Grabación en el transporte

El `fetch` grabador envuelve el `fetch` real y guarda los bytes **antes** de que el ACL parsee nada. Así queda evidencia aunque la respuesta rompa el Zod del ACL. Ese caso es un hallazgo: el arnés lo reporta en `selfcheck.md` y no aborta, porque es exactamente lo que certificar debe descubrir.

```js
// Boceto: la forma, no el código final.
function recordingFetch(realFetch, sink) {
  return async (url, init = {}) => {
    const startedAt = new Date().toISOString();
    const t0 = performance.now();
    const requestBody = typeof init.body === 'string' ? init.body : '';
    try {
      const res = await realFetch(url, init);
      const responseText = await res.text(); // bytes tal cual llegaron
      sink.push({
        url,
        method: init.method ?? 'GET',
        startedAt,
        latencyMs: Math.round(performance.now() - t0),
        httpStatus: res.status,
        requestBody,
        responseText,
        headers: redactAuth(init.headers),
      });
      return new Response(responseText, { status: res.status, headers: res.headers });
    } catch (err) {
      // timeout / red: también es evidencia
      sink.push({
        url,
        method: init.method ?? 'GET',
        startedAt,
        requestBody,
        error: String(err?.name ?? 'Error'),
        headers: redactAuth(init.headers),
      });
      throw err;
    }
  };
}
```

El nombre del método se toma del sufijo del path (`/Search`, `/PreBook`, `/Book`, `/BookingDetail`, `/Cancel`) sin distinguir mayúsculas, porque la colección usa otros casings (`/search`, Postman: Search).

### 6.5 Reintentos: solo donde no hay dinero

| Llamada       | Reintento en el arnés                                                                                                                                                                                                               | Por qué                                                                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Search        | Los del cliente del ACL: 1 reintento ante `429`, `500` o conexión rechazada, nunca después de un timeout ([01](./01-autenticacion-conectividad-y-errores.md) §10.4). El arnés no suma los suyos. Ante 201, se corre la fecha (§4.1) | Es una lectura, pero el RQ grabado tiene que ser el del producto                                                                                  |
| PreBook       | Los del cliente del ACL: 1 reintento solo si el primer fallo fue rápido y el total no pasa de 23 s, nunca después de un timeout ([08](./08-requisitos-maestro.md) §9 C-24). Ante 207 o 315, se reinicia el caso desde Search        | No crea nada. INFERIDO de p. 19 ("up-to-date availability and prices")                                                                            |
| **Book**      | **Nunca.** Ante timeout, error HTTP o error de red: esperar 120 s y llamar a BookingDetail por `BookingReferenceId`. Esa captura va a la carpeta del caso como `03b_BookingDetail_Recovery_*`                                       | p. 42 (CK-14). No está documentado si Book es idempotente respecto de `BookingReferenceId` (p. 33, 43). → [Q-35](./10-preguntas-para-tbo.md#q-35) |
| BookingDetail | 1 reintento                                                                                                                                                                                                                         | Es una lectura                                                                                                                                    |
| **Cancel**    | **Nunca.** Ante timeout o error: BookingDetail para ver el estado real                                                                                                                                                              | La cancelación puede ser asíncrona (estados intermedios, p. 70–71)                                                                                |

Es la misma regla que el ACL en producción: cero reintentos en paths con dinero ([01](./01-autenticacion-conectividad-y-errores.md), [03](./03-prebook-y-book.md)).

### 6.6 Redacción: qué se redacta y qué no

| Dato                                                 | ¿Aparece en los bodies?                          | Tratamiento                                                                                                                                                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Usuario y contraseña de TBO                          | No: viajan en la cabecera `Authorization` (p. 7) | La cabecera se graba como `Basic «REDACTADO»` en `calls.jsonl` y no entra al zip. Guarda G-1                                                                                                                                |
| Nombres de huéspedes                                 | Sí (Book RQ y BookingDetail RS)                  | **No se redactan.** TBO necesita los RQ completos para revisar CK-10, y los nombres son sintéticos por construcción: el arnés solo acepta nombres de su lista fija (guarda G-4). Nunca puede entrar un dato de persona real |
| `EmailId`                                            | Sí                                               | Buzón de rol propio (`TBO_CERT_EMAIL`). No es dato personal. Sin redactar                                                                                                                                                   |
| `PhoneNumber`                                        | Sí                                               | Ficticio. Sin redactar                                                                                                                                                                                                      |
| Datos de tarjeta                                     | No deben existir                                 | Si aparecen, el zip aborta (guarda G-2)                                                                                                                                                                                     |
| `ConfirmationNumber`, `InvoiceNumber`, `BookingCode` | Sí                                               | Identificadores de test, sin valor fuera de TBO. Sin redactar                                                                                                                                                               |

Diferencia con Sabre: `cert-probe.mjs` redacta por nombre de clave (`PII_KEYS`, `tools/sabre/cert-probe.mjs:211-223`) porque sus capturas se versionan y `getBooking` hace eco de datos del pasajero. Aquí redactar rompería el entregable. Por eso se garantiza que no haya PII **en la entrada** y no se tacha a la salida.

**Si el founder quisiera usar nombres reales** (por ejemplo, para que la reserva de test se parezca a una real), habría que redactar a la salida y TBO no podría revisar CK-10. No se recomienda.

### 6.7 Guardas antes de escribir el zip

`verify` y `zip` recorren todos los archivos de la corrida. Cualquier fallo **aborta** el zip; las demás advertencias van a `selfcheck.md`.

| ID   | Guarda                                                                                                                                                                                                                                                                                                                                               | Si falla                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| G-1  | Ningún archivo contiene el literal de `TBO_USERNAME`, el de `TBO_PASSWORD` ni `base64(usuario:contraseña)`; ningún archivo del zip contiene la cadena `Authorization`                                                                                                                                                                                | Aborta                                                                                        |
| G-2  | Ningún RQ contiene `PaymentInfo` ni ninguna de sus claves (p. 33–34): `CvvNumber`, `CardNumber`, `CardExpirationMonth`, `CardExpirationYear`, `CardHolderFirstName`, `CardHolderLastName` (casing de la tabla, p. 33) y `CardHolderlastName` (la `l` minúscula de los ejemplos, p. 35 y 38), `BillingAmount`, `BillingCurrency`, `CardHolderAddress` | Aborta. Es la capa "test sobre los bytes de salida" de D1 aplicada a la evidencia             |
| G-3  | `PaymentMode === "Limit"` en todo RQ de PreBook, Book y BookingDetail                                                                                                                                                                                                                                                                                | Aborta                                                                                        |
| G-4  | Todo `FirstName` y `LastName` del Book pertenece a la lista sintética del arnés                                                                                                                                                                                                                                                                      | Aborta                                                                                        |
| G-5  | `IsDetailedResponse === false` en todo RQ de Search del zip, que son búsquedas de listado (el Search de detalle de D-TBO-19 A no entra en las cadenas de los casos)                                                                                                                                                                                  | Aborta (CK-02)                                                                                |
| G-6  | `GuestNationality` toma al menos 3 valores distintos entre los casos 1–7                                                                                                                                                                                                                                                                             | Aborta (CK-01)                                                                                |
| G-7  | `PaxRooms` del Search y `CustomerDetails` del Book coinciden en cantidad de habitaciones, orden y número de `Adult` y `Child` por habitación                                                                                                                                                                                                         | Aborta (CK-03, CK-10)                                                                         |
| G-8  | `Book.TotalFare` = `TotalFare` de la respuesta de PreBook del mismo caso                                                                                                                                                                                                                                                                             | Aborta (CK-11)                                                                                |
| G-9  | Cada caso tiene la cadena completa y Book con `Status.Code` 200 y `ConfirmationNumber`                                                                                                                                                                                                                                                               | Aborta                                                                                        |
| G-10 | Entre Search y Book de cada caso pasaron menos de 30 min                                                                                                                                                                                                                                                                                             | Advertencia (CK-05, p. 8)                                                                     |
| G-11 | El caso 7 tiene al menos un suplemento; se indica si hay `AtProperty`                                                                                                                                                                                                                                                                                | Aborta si no hay ninguno                                                                      |
| G-12 | `baseUrl` es el host de test (`api.tbotechnology.in/TBOHolidays_HotelAPI`)                                                                                                                                                                                                                                                                           | Aborta salvo `--allow-non-test-host`. Evita reservar contra live, que consume el `Limit` real |
| G-13 | Cada RS parsea como JSON                                                                                                                                                                                                                                                                                                                             | Advertencia: un RS no parseable también es hallazgo y se entrega                              |

### 6.8 Sondas de contrato (`probe`)

Cada sonda responde con evidencia una pregunta que el PDF deja abierta. El resultado alimenta [10-preguntas-para-tbo.md](./10-preguntas-para-tbo.md): una pregunta que la sonda ya contestó se marca cerrada. **Las sondas nunca entran al zip.** Es el mismo papel que cumple el paso `errors` de Sabre (`tools/sabre/cert-probe.mjs:479-526`).

| ID    | Sonda                                                                                                                                                                                                                                       | Pregunta que responde                                                                                                         | Fuente                      | ¿Reserva?                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------- | -------------------------- |
| PR-01 | Search con `Children: 0` y `ChildrenAges` = `[]`, `[0]` y campo omitido                                                                                                                                                                     | Forma válida sin niños                                                                                                        | p. 11; Postman: Search      | No                         |
| PR-02 | `Filters.MealType` como `"All"` y como `0`                                                                                                                                                                                                  | ¿Acepta el ordinal?                                                                                                           | p. 11; Postman: Search      | No                         |
| PR-03 | El mismo Search por `https://`                                                                                                                                                                                                              | ¿Hay TLS en test?                                                                                                             | p. 7                        | No                         |
| PR-04 | Cada path cuyo casing difiere entre PDF y Postman, con las dos grafías: `/Search` y `/search`; `/HotelDetails` y `/Hoteldetails`; `/BookingDetailsbasedondate` y `/BookingDetailsBasedOnDate`; y `/hotelcodelist` frente a `/HotelCodeList` | ¿El routing distingue mayúsculas? La grafía que funcione queda en `TBO_OPERATIONS` ([08](./08-requisitos-maestro.md) §9 C-03) | pp. 10, 54, 56, 62; Postman | No                         |
| PR-05 | BookingDetail con un `BookingReferenceId` inexistente                                                                                                                                                                                       | Forma de "no existe", clave para la recuperación de CK-14                                                                     | p. 42–44                    | No                         |
| PR-06 | Credenciales erróneas                                                                                                                                                                                                                       | ¿HTTP 401, `Status.Code` 401 en el body, o los dos?                                                                           | p. 9                        | No                         |
| PR-07 | PreBook con un `BookingCode` inventado                                                                                                                                                                                                      | ¿207, 400 o 500?                                                                                                              | p. 9, 19                    | No                         |
| PR-08 | Search con 101 `HotelCodes`                                                                                                                                                                                                                 | ¿100 es un límite duro o una recomendación?                                                                                   | p. 10                       | No                         |
| PR-09 | Book con tildes y `ñ` en los nombres (`Muñoz`, `José`) y cancelación inmediata                                                                                                                                                              | Juego de caracteres aceptado; crítico para LATAM                                                                              | p. 32–33                    | Sí (test)                  |
| PR-10 | Book con `TotalFare` distinto en +0.01 del de PreBook                                                                                                                                                                                       | ¿Qué hace TBO si no coincide?                                                                                                 | p. 33                       | Sí (test)                  |
| PR-11 | Dos Book con el mismo `BookingReferenceId` y `BookingCode` distintos                                                                                                                                                                        | ¿Book es idempotente o crea duplicados?                                                                                       | p. 33, 42–43                | Sí (test), cancelando todo |

### 6.9 Qué se versiona

- **Sí**: el set enviado, copiado a `docs/tbo/evidence/cert/<YYYY-MM-DD>/` después de pasar las guardas, junto con la tabla de sign-off (§2.7). No lleva secretos (G-1) ni PII (G-4). Es la mejor fuente de fixtures reales para los tests del ACL ([06](./06-seams-integracion-repo.md)): los RS de test entran al paquete como fixtures, con la marca de su origen. Que el set se versione es decisión del founder (DC-7).
- **No**: `.tbo-cert/`, las corridas intermedias ni las sondas. Si una sonda cierra una pregunta, lo que se versiona es la respuesta en [10](./10-preguntas-para-tbo.md), no la captura cruda.

### 6.10 Diferencias con `tools/sabre/cert-probe.mjs`

| Aspecto                | Sabre `cert-probe.mjs`                                 | TBO `cert-cases.mjs`                                               |
| ---------------------- | ------------------------------------------------------ | ------------------------------------------------------------------ |
| Objetivo               | Medir entitlements, valor, latencia y errores (Fase 0) | Producir el entregable de certificación                            |
| Reservas               | Excluidas a propósito (`:4-7`)                         | Obligatorias (8 cadenas)                                           |
| Quién arma el request  | El script (`shopBody`, `:240-303`)                     | El ACL de producción (§6.1)                                        |
| Credenciales           | `.env.sabre` (`:33-42`)                                | `.env.tbo`, con el mismo cargador                                  |
| Redacción              | Por clave, a la salida (`:211-223`)                    | PII imposible a la entrada; solo se redacta `Authorization` (§6.6) |
| Clasificación de éxito | `classify()` sobre HTTP y `errors[]` (`:173-197`)      | La del ACL, por `Status.Code` del body (p. 8–10)                   |
| Salida                 | JSON en `docs/sabre/evidence/captures/` (`:26`)        | `.tbo-cert/<runId>/` + zip; solo el set enviado se versiona        |

---

## 7. Entorno y tenant de pruebas para la verificación de portal

### 7.1 Lo que hay hoy

| Hecho                                                                                                                                                   | Evidencia                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Hay un solo entorno desplegado: el push a `main` despliega en un único VPS (`secrets.HOSTINGER_HOST`), y no hay stack de staging                        | `.github/workflows/deploy.yml:3-6`, `:110`. VERIFICADO-CODIGO                                                       |
| Caddy sirve solo `api.planetour.cloud` y `app.planetour.cloud`. El wildcard de tenants está comentado                                                   | `infrastructure/hostinger/Caddyfile:20`, `:34`, `:68`. VERIFICADO-CODIGO                                            |
| Un tenant sin cuenta propia de Despegar usa las credenciales de plataforma del entorno                                                                  | `apps/api/src/providers-despegar/despegar-hotels.factory.ts:27-35`. VERIFICADO-CODIGO                               |
| En vuelos, solo los proveedores `opt-in` se pueden apagar por tenant; los de política `always` se llaman para todos                                     | `apps/api/src/providers/flight-provider.registry.ts:117-123`. VERIFICADO-CODIGO                                     |
| LATAM, sin cuenta resoluble, también cae a credenciales de entorno                                                                                      | `apps/api/src/providers-latam/latam-ndc.factory.ts:80-81`, `:148-153`. VERIFICADO-CODIGO                            |
| `resolve_provider_account` hereda cuentas `active` de cualquier ancestro con `is_inheritable`                                                           | `db/migrations/0012_provider_accounts.sql:59-77`. VERIFICADO-CODIGO                                                 |
| El rol `vendedor` puede reservar (`SELLING_ROLES`) y no exige MFA (`MFA_REQUIRED_ROLES` = superadmin, platform_admin, consolidator_admin, tenant_admin) | `apps/api/src/auth/roles.ts:60`, `:91-96`. VERIFICADO-CODIGO                                                        |
| Existe cartera por agencia (`agency_portfolios`) y límite de crédito por tenant                                                                         | `db/migrations/0010_sprint1_core_suite.sql:32`; `db/migrations/0007_tenant_business_rules.sql:5`. VERIFICADO-CODIGO |
| La web de B2B está solo en español; no hay paquete de i18n (`packages/` = `canonical`, `core`, `domain`, `validation`)                                  | Listado de `packages/`. VERIFICADO-CODIGO                                                                           |

**Consecuencia**: si el portal de certificación fuera un tenant en producción, un tester de TBO logueado como `vendedor` vería y podría reservar hoteles de Despegar con las credenciales de plataforma, y vuelos de LATAM con las credenciales de entorno si su política es `always`. Serían reservas reales, hechas por terceros, con dinero real. INFERIDO de las filas anteriores.

### 7.2 Opciones

- **(A) Stack de certificación separado — recomendada.**
  - Segundo proyecto compose detrás del mismo Caddy (o en un VPS aparte), con subdominios propios (por ejemplo `cert-app.planetour.cloud` y `cert-api.planetour.cloud`), base de datos y Redis propios.
  - Un `.env` **sin ninguna credencial real** de proveedor: la única cuenta que resuelve es la `tbo-hotels` de test.
  - Se despliega por `workflow_dispatch` desde el mismo `deploy.yml`, con la misma imagen que producción.
  - _Consecuencia_: aislamiento por construcción. Aunque haya un bug de flags o de herencia, no existe credencial real que filtrar ni con la que reservar. Coste: trabajo de infraestructura (compose, DNS, Caddy, secrets, un seed) y un entorno más que mantener. Además cumple el `staging` que CLAUDE.md prevé y que hoy no existe.
- **(B) Tenant de certificación dentro de producción.**
  - Nodo raíz propio, fuera de la red real, para no heredar cuentas.
  - Allowlist de proveedores por tenant aplicada **en servidor** a todas las verticales, sin fallback a credenciales de entorno para ese tenant, y un test que lo fije.
  - _Consecuencia_: más barato en infraestructura y TBO prueba el binario de producción. Pero la seguridad depende de tocar el fallback de Despegar, AgentCars y LATAM, y de un flag por tenant que hoy no existe para hoteles ni para los proveedores `always`. Un solo olvido expone credenciales reales a terceros. Además, los datos de test quedan en la base de producción y ensucian reportes.

Postura: (A). Es la decisión DC-1 (§11). Con (B), los pasos de §7.3 se mantienen y se añade como prerequisito la allowlist.

### 7.3 Configuración del tenant de certificación

1. **Tenant** raíz `tbo-cert` ("Sales-Travel Certification" o el nombre de DC-4), sin hijos. Branding neutro: el white-label no debe imitar a ninguna agencia real.
2. **Cuenta `tbo-hotels`** en la bóveda del tenant con las credenciales de test, `config.baseUrl` = endpoint de integración y `status: 'active'`. El default de `upsert` es `'sandbox'` (`apps/api/src/provider-credentials/provider-credentials.service.ts:124`, `:140`), y una cuenta `sandbox` **no resuelve** (`0012_provider_accounts.sql:70`). VERIFICADO-CODIGO.
3. **Sin ninguna otra cuenta de proveedor.** En la opción (A) tampoco hay variables de entorno de otros proveedores.
4. **Cartera y crédito** del tenant con saldo ficticio suficiente para las reservas de TBO, para que el checkout B2B no pida tarjeta. Si el flujo del portal pasa por hosted checkout, el PSP va en modo test. Nunca PAN/CVV en ningún caso (D1).
5. **Reglas de markup** de la vertical `hotels` con un margen visible, para que TBO vea precio de venta distinto del neto, y una regla que, sin el piso, quedaría por debajo de `RecommendedSellingRate`, para demostrar CK-09. Con D-TBO-16 (A) el piso aplica también en el portal B2B que se declara (DC-2 A).
6. **Contenido estático** sincronizado para al menos las ciudades de los `HotelCodes` de test: nombre, estrellas, dirección e imágenes ([05](./05-contenido-estatico-e-inventario.md)). Sin eso, los resultados muestran códigos en vez de hoteles.
7. **Clientes del CRM** ficticios. Ningún dato de persona real.

### 7.4 Usuario para TBO

- **Rol `vendedor`** (`apps/api/src/auth/roles.ts:60`): puede cotizar, reservar y cancelar, no administra credenciales ni red, y **no exige MFA** (`:91-96`). Si se le diera un rol de administración, el login exigiría un TOTP que los testers de TBO no tienen.
- Un usuario por tester si TBO da nombres; si no, uno compartido.
- La contraseña se entrega por un canal distinto del zip, se rota al terminar la verificación de portal y el usuario se deshabilita después del sign-off.
- Todas sus acciones quedan en la auditoría normal de la plataforma. Ante una discusión del Excel ("reservamos X y vimos Y"), la evidencia está en `domain_events` y en el archivo de payloads.

---

## 8. Checklist de UI que TBO revisará en el portal

Es lo mínimo que el portal tiene que hacer para que TBO pueda recorrer la Fase 3. Que TBO revise exactamente esto es INFERIDO de los CK de §3. La columna "Hoy" es el estado del código al 2026-09-23.

| ID   | Pantalla               | Qué debe hacer o mostrar                                                                                                                                                                      | CK                  | Hoy                                                                                                                                                                 |
| ---- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U-01 | Login                  | Entrar con el usuario `vendedor`, sin MFA                                                                                                                                                     | —                   | Existe (VERIFICADO-CODIGO, `roles.ts:91-96`)                                                                                                                        |
| U-02 | Búsqueda               | Destino resuelto a hoteles TBO y fechas                                                                                                                                                       | CK-04               | Solo destinos de Despegar; el subtítulo dice "vía Despegar/HotelDo" (`apps/web-b2b/src/app/(app)/hoteles/page.tsx:38-40`)                                           |
| U-03 | Búsqueda               | **Nacionalidad del huésped líder**: campo obligatorio, sin valor silencioso                                                                                                                   | CK-01               | No existe; no hay campo de nacionalidad en `hoteles/` (VERIFICADO-CODIGO, por ausencia)                                                                             |
| U-04 | Búsqueda               | Habitaciones con 1–8 adultos, 0–4 niños y edad de cada niño de 0 a 18, dentro de los límites de TBO                                                                                           | CK-03               | El selector permite 6 niños (`rooms-picker.tsx:15`) y la API edades 0–17 con 6 niños (`apps/api/src/hotels/hotels.schemas.ts:7-10`); hay que acotarlo por proveedor |
| U-05 | Resultados             | Nombre, estrellas, dirección e imagen del hotel (contenido estático); nombre de cada habitación; régimen; reembolsable o no; promociones; `Inclusion`                                         | —                   | Parcial, sobre el contrato de Despegar                                                                                                                              |
| U-06 | Resultados             | **Precio de venta** (waterfall), no el neto                                                                                                                                                   | CK-09               | Pinta el neto `price.total` (`hotel-result-card.tsx:62`, `:118`)                                                                                                    |
| U-07 | Resultados             | Suplementos: `AtProperty` rotulado "a pagar en el hotel", con importe y moneda propios, separado del total                                                                                    | CK-08               | Solo un "A pagar en destino" agregado de Despegar (`hotel-result-card.tsx:110-112`)                                                                                 |
| U-08 | Resultados             | Mensaje claro ante `Status.Code` 201 (sin disponibilidad)                                                                                                                                     | CK-16               | Por construir para TBO                                                                                                                                              |
| U-09 | PreBook                | Al elegir una opción: PreBook; precio final y **aviso de cambio** si difiere de Search, con aceptación explícita                                                                              | CK-06, CK-18        | No existe                                                                                                                                                           |
| U-10 | PreBook                | Política de cancelación de PreBook, con tramos, fechas y la aclaración "hora local del hotel", más la penalidad estimada                                                                      | CK-07               | No existe                                                                                                                                                           |
| U-11 | PreBook                | `RateConditions` legibles: HTML desescapado y **sanitizado**, texto completo. Aviso destacado si la tarifa es "sólo con billete aéreo"                                                        | CK-07               | No existe                                                                                                                                                           |
| U-12 | Huéspedes              | Un bloque por habitación, en el orden de la búsqueda. Por cada pax: `Title` (`Mr`, `Mrs`, `Ms`), nombre, apellido y tipo fijo (adulto o niño según la búsqueda). Email y teléfono de contacto | CK-10               | No existe                                                                                                                                                           |
| U-13 | Confirmar              | Resumen con suplementos `AtProperty` visibles **en el paso de reserva**; un solo envío (doble clic no reserva dos veces); espera hasta 120 s con estado "confirmando"                         | CK-08, CK-11, CK-12 | No existe                                                                                                                                                           |
| U-14 | Confirmar              | Resultado incierto (timeout): la pantalla dice "verificando con el proveedor", no "fallida". A los 120 s se resuelve por BookingDetail                                                        | CK-14               | No existe; la cola no admite `delay` hoy (`apps/api/src/queue/post-sale-queue.service.ts:110`)                                                                      |
| U-15 | Confirmación y voucher | `ConfirmationNumber`, estado, HCN "pendiente", habitaciones, huéspedes, política, `RateConditions` y suplementos `AtProperty`                                                                 | CK-08, CK-13        | No existe                                                                                                                                                           |
| U-16 | Reservas               | Lista y detalle de reservas de hotel; refresco por BookingDetail                                                                                                                              | CK-13               | `reservas/` solo distingue vuelos y autos ([06](./06-seams-integracion-repo.md))                                                                                    |
| U-17 | Cancelar               | Penalidad estimada según la política de PreBook, confirmación explícita, Cancel y estado final (`Cancelled`, `CancellationInProgress`…)                                                       | CK-15               | No existe                                                                                                                                                           |
| U-18 | Sesión                 | Pasados 30 min desde la búsqueda: "la tarifa venció, busca de nuevo" (315), sin error genérico                                                                                                | CK-05, CK-16        | No existe                                                                                                                                                           |
| U-19 | Errores                | `INSUFFICIENT_BALANCE` (300) y `AGENT_BLOCKED` (402) con mensaje de negocio, sin reintento                                                                                                    | CK-16               | No existe                                                                                                                                                           |
| U-20 | Idioma                 | Recorrible por un tester que no lee español: guía en inglés (Anexo B) o locale EN (DC-3)                                                                                                      | —                   | Solo español                                                                                                                                                        |

Fuera del portal, pero con la misma obligación contractual: el canal WhatsApp tiene que enunciar los suplementos `AtProperty` y la política antes de confirmar (KP-4, p. 71). TBO no lo verifica en esta ronda si solo declaramos B2B (DC-2), pero la regla aplica a todo canal que venda.

---

## 9. Contradicciones y huecos del proceso

| ID   | Hueco                                                                                                                                                   | Postura de diseño                                                                                                                                                                                                                            | TBO                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| H-01 | No se publica el "JSON checkpoint list" (Cert, JSON Verification)                                                                                       | Reconstrucción propia (§3) y `selfcheck.md` antes de enviar                                                                                                                                                                                  | → [Q-71](./10-preguntas-para-tbo.md#q-71) (pedir la lista antes del envío) |
| H-02 | No hay convención de nombres ni de contenido para el zip; "all the JSON logs" frente a "samples" (Cert, Integration on Test Account; JSON Verification) | §5; intentos y logs completos a pedido                                                                                                                                                                                                       | → [Q-72](./10-preguntas-para-tbo.md#q-72)                                  |
| H-03 | "Cancel (If Required)" (Cert, Integration on Test Account)                                                                                              | Cancelar todo al final, con un flag para no hacerlo (§2.4)                                                                                                                                                                                   | → [Q-73](./10-preguntas-para-tbo.md#q-73)                                  |
| H-04 | Caso 7, "any one case"                                                                                                                                  | Una sola reserva con suplementos, con la ocupación del caso 4 o del 1 (§4.9)                                                                                                                                                                 | → [Q-74](./10-preguntas-para-tbo.md#q-74)                                  |
| H-05 | Caso 8 llama al método "HotelBookingDetail", que no existe en el PDF; el endpoint es `BookingDetail` (p. 7–8, 42)                                       | Tratarlo como `BookingDetail` y no como `HotelBookingDetailBasedOnDate` (p. 62). Es INFERIDO de la secuencia "Search > Prebook > Book> BookingDetails>Cancel(If Required)" ([00](./00-fuentes.md) §4). Se captura por las dos claves (§4.10) | → [Q-75](./10-preguntas-para-tbo.md#q-75)                                  |
| H-06 | "Staging environment" sin URL (Cert, Website/Portal Verification)                                                                                       | Mismo endpoint de integración (INFERIDO), a confirmar antes de abrir el portal                                                                                                                                                               | → [Q-76](./10-preguntas-para-tbo.md#q-76)                                  |
| H-07 | El Cert no dice si certifica la aplicación o la cuenta, ni qué pasa con las cuentas BYOC de agencias                                                    | BYOC de TBO deshabilitado hasta tener respuesta (§2.8)                                                                                                                                                                                       | → [Q-77](./10-preguntas-para-tbo.md#q-77)                                  |
| H-08 | El campo "Client's platform where the TBO API will be integrated (like: B2B, B2C, Mobile)" no dice si añadir un canal después obliga a recertificar     | Declarar B2B y preguntar (DC-2)                                                                                                                                                                                                              | → [Q-78](./10-preguntas-para-tbo.md#q-78)                                  |
| H-09 | `RecommendedSellingRate` habla de "B2C client" (p. 13, 21); no está claro si alcanza a la venta B2B2C (agencia que vende a cliente final)               | El piso se aplica en todo canal que venda a cliente final, aunque lo opere una agencia                                                                                                                                                       | → [Q-23](./10-preguntas-para-tbo.md#q-23)                                  |
| H-10 | Skype ID en el formulario (Cert, Client's Details)                                                                                                      | Ofrecer Teams o WhatsApp                                                                                                                                                                                                                     | → [Q-84](./10-preguntas-para-tbo.md#q-84)                                  |
| H-11 | Soporte: `apisupport@tbo.com` (Cert) frente a `apisupport@tboholidays.com` (p. 9)                                                                       | Certificación a `apisupport@tbo.com` ([00](./00-fuentes.md) §7)                                                                                                                                                                              | → [Q-11](./10-preguntas-para-tbo.md#q-11)                                  |
| H-12 | Campos del Production Process Form desconocidos (Cert, Sign Off)                                                                                        | Pedirlos por adelantado                                                                                                                                                                                                                      | → [Q-80](./10-preguntas-para-tbo.md#q-80)                                  |
| H-13 | El Cert no dice si hay que certificar `NewCard` y `SavedCard`; el PDF los documenta (p. 19, 33–40)                                                      | Solo `Limit` (D1). Se declara en el workflow que los modos con tarjeta no se implementan                                                                                                                                                     | → [Q-81](./10-preguntas-para-tbo.md#q-81)                                  |
| H-14 | No se sabe si el HCN se llena en test (p. 42–43)                                                                                                        | No se trata como fallo en el caso 8                                                                                                                                                                                                          | → [Q-83](./10-preguntas-para-tbo.md#q-83)                                  |
| H-15 | Saldo `Limit` de la cuenta de test y su moneda de perfil (p. 9 código 300, p. 13)                                                                       | `check` imprime la moneda; se cancela cada reserva para liberar crédito                                                                                                                                                                      | → [Q-82](./10-preguntas-para-tbo.md#q-82)                                  |
| H-16 | Si el portal en español es aceptable para los testers (Cert, Website/Portal Verification)                                                               | Guía en inglés (DC-3)                                                                                                                                                                                                                        | → [Q-79](./10-preguntas-para-tbo.md#q-79)                                  |

---

## 10. Riesgos del proceso

| ID   | Riesgo                                                                                                                              | Probabilidad / impacto                    | Mitigación                                                                                                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-01 | Entorno de test inestable: "brief system outages … without prior notification" (Cert, nota final)                                   | Alta / medio                              | `calls.jsonl` con timestamps UTC y latencias para documentar cortes ante TBO. Reintentos solo en lecturas (§6.5). Corridas por caso (`--cases`), para no repetir las que ya pasaron |
| R-02 | Los plazos de TBO son "approximate and subject to change" (Cert, nota final)                                                        | Alta / alto en calendario                 | No comprometer una fecha de salida a producción atada a TBO. El calendario de §2.9 es un rango                                                                                      |
| R-03 | El inventario de test no tiene suplementos, ni disponibilidad para 2 habitaciones con niños                                         | Media / bloquea los casos 5–7             | Lotes de `HotelCodes` vía `TBO_CITY_CODE`, corrimiento de fechas y pedido a TBO de hoteles de test (H-04)                                                                           |
| R-04 | Los RQ del arnés difieren de los de la aplicación                                                                                   | Baja con §6.1 / alto                      | El arnés usa el ACL y se contrasta a mano antes del portal (§6.1)                                                                                                                   |
| R-05 | Un tester de TBO reserva con credenciales reales de otro proveedor                                                                  | Alta si el portal es producción / crítico | DC-1 (A): no hay credenciales reales en el entorno (§7.2)                                                                                                                           |
| R-06 | Credenciales de test por `http://` en claro (p. 7)                                                                                  | Cierta / bajo (son de test)               | Contraseña de un solo uso, nunca reutilizada. PR-03 prueba TLS                                                                                                                      |
| R-07 | El portal no está listo cuando TBO agenda la Fase 3                                                                                 | Media / alto                              | DC-5. El plan pone la UI completa (§8) en la ruta crítica ([09](./09-plan-implementacion.md))                                                                                       |
| R-08 | Los testers no leen español                                                                                                         | Media / medio                             | Guía en inglés con capturas y glosario (Anexo B); si TBO lo exige, locale EN (DC-3)                                                                                                 |
| R-09 | Book no idempotente: un reintento humano durante la Fase 3 duplica la reserva                                                       | Media / medio en test, alto en live       | Un solo envío en la UI, intent durable y `BookingReferenceId` antes del Book, recuperación a los 120 s (CK-14). PR-11 mide el comportamiento real                                   |
| R-10 | `.env.tbo` commiteado por error, porque hoy no está ignorado                                                                        | Media / alto                              | Añadir `.env.tbo` y `.tbo-cert/` a `.gitignore` **antes** de crear el archivo (§6.2). G-1 impide que la credencial llegue al zip                                                    |
| R-11 | El ACL rechaza con Zod respuestas reales de TBO (el PDF tiene ejemplos inválidos y tipos contradictorios, [00](./00-fuentes.md) §8) | Alta / medio                              | El arnés graba antes de parsear (§6.4) y reporta el fallo como hallazgo. Esas RS pasan a ser fixtures                                                                               |
| R-12 | TBO revisa un checkpoint que no anticipamos (su lista es privada)                                                                   | Media / medio                             | H-01: pedir la lista. El Excel de hallazgos se trata como backlog con dueño                                                                                                         |
| R-13 | La certificación queda atada a una sola cuenta y la red BYOC no puede operar TBO                                                    | Media / alto para el modelo consolidador  | H-07 antes de prometer TBO con credenciales propias a agencias                                                                                                                      |

---

## 11. Decisiones para el founder

Resumen; el formato final con opciones está en [08](./08-requisitos-maestro.md).

**Estado al 2026-09-25:** el founder firmó D-TBO-02 (B), D-TBO-03 (A), D-TBO-06 (A) y D-TBO-07 (A) y pidió aplicar
la opción recomendada en todas las demás hasta nuevo aviso; lo que manda es el
[Registro de decisiones](./08-requisitos-maestro.md#registro-de-decisiones) de 08.

- **DC-1 — Dónde vive el portal de pruebas que usa TBO.**
  - (A) Stack de certificación separado, sin credenciales reales de ningún proveedor.
  - (B) Tenant aislado dentro de producción, con allowlist de proveedores por tenant aplicada en servidor.
  - Recomendación: (A), porque con el código de hoy un tenant de producción sin cuentas propias cae a las credenciales de plataforma de Despegar (`despegar-hotels.factory.ts:27-35`) y de LATAM (`latam-ndc.factory.ts:80-81`).
- **DC-2 — Qué plataformas se declaran en "Client's Details".**
  - (A) Solo el portal B2B web ahora.
  - (B) B2B + B2C + WhatsApp o mobile desde el inicio.
  - Con (B), TBO verificaría también el piso de `RecommendedSellingRate` en B2C, y `apps/web-b2c` no existe.
  - Recomendación: (A), salvo que TBO confirme que añadir canales no obliga a recertificar.
- **DC-3 — Idioma del portal para los testers de TBO.**
  - (A) Guía de recorrido en inglés con glosario sobre la UI en español.
  - (B) Construir un locale EN (no hay paquete i18n).
  - Recomendación: (A), y (B) solo si TBO lo exige.
- **DC-4 — Entidad legal, cuenta TBO y contacto técnico que figuran en la certificación.** Hace falta la razón social, la dirección y el contacto técnico, con un email nominal y un teléfono. El equipo técnico todavía no está contratado.
- **DC-5 — Cuándo se abre la certificación.**
  - (A) Enviar formulario, workflow y zip en cuanto el ACL y el arnés pasen los 8 casos, en paralelo a la UI. Las respuestas de TBO a las ambigüedades llegan antes y condicionan la UI.
  - (B) Esperar a tener el portal completo para encadenar las fases sin huecos.
  - Recomendación: (A), avisando a TBO de la fecha estimada del portal.
- **DC-6 — Nacionalidad del huésped.**
  - (A) Campo obligatorio en cada búsqueda, sin valor por defecto en la configuración del proveedor.
  - (B) Prellenada desde el perfil del cliente o del tenant, siempre visible y editable.
  - Una clave `guestNationality` en la config de la cuenta TBO, enviada en silencio, es exactamente lo que KP-1 desaconseja (p. 71).
  - Recomendación: (A).
- **DC-7 — Versionado del set enviado.**
  - (A) Versionar en `docs/tbo/evidence/cert/<fecha>/` el zip enviado y el sign-off. No llevan secretos ni PII, por las guardas G-1 y G-4.
  - (B) Guardarlos fuera de Git.
  - Recomendación: (A), porque son la mejor fuente de fixtures reales.

---

## Anexo A — Integration workflow (listo para enviar)

> Se envía como PDF o como cuerpo del email junto con el zip. Los `[…]` salen de DC-2 y DC-4. Los nombres de métodos y campos respetan el casing del PDF.

**[Company legal name] — TBO Holidays Hotel API (JSON, V2.1) — Integration workflow**
Version 1.0 · [date] · Technical contact: [name, email, phone]

**1. Platform**

- [Company] operates a B2B travel platform. Travel agencies in our network use a web portal to search, book and manage hotel reservations. Declared channel for this certification: **B2B web portal**. [Other channels are planned; we will notify TBO before enabling them.]
- Test portal: [URL]. Access details are sent separately.
- TBO endpoint used: `http://api.tbotechnology.in/TBOHolidays_HotelAPI` with Basic Authentication and `Content-Type: application/json`.

**2. API methods used**

| Method                        | Endpoint                          | Purpose                                                       | When it is called                                                                                                                                         |
| ----------------------------- | --------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CountryList                   | `GET /CountryList`                | Static content                                                | Periodic catalogue sync                                                                                                                                   |
| CityList                      | `POST /CityList`                  | Static content                                                | Periodic catalogue sync, per country in scope                                                                                                             |
| TBOHotelCodeList              | `POST /TBOHotelCodeList`          | Hotel codes per city                                          | Periodic catalogue sync, per city in scope                                                                                                                |
| HotelCodeList                 | `GET /hotelcodelist`              | Full hotel code list                                          | Weekly catalogue check to deactivate hotels no longer listed (optional)                                                                                   |
| HotelDetails                  | `POST /HotelDetails`              | Hotel content: name, address, rating, images, room details    | Periodic catalogue sync; on demand for one hotel without content                                                                                          |
| Search                        | `POST /Search`                    | Availability                                                  | Each agent search (`IsDetailedResponse: false`); when the agent opens one hotel, one `Search` for that single `HotelCode` with `IsDetailedResponse: true` |
| PreBook                       | `POST /PreBook`                   | Up-to-date price, availability, cancellation policy and norms | When the agent selects a room option                                                                                                                      |
| Book                          | `POST /Book`                      | Booking and voucher                                           | When the agent confirms the booking                                                                                                                       |
| BookingDetail                 | `POST /BookingDetail`             | Booking status and details; HCN                               | After every successful Book; after any Book failure or timeout; for HCN; after Cancel                                                                     |
| Cancel                        | `POST /Cancel`                    | Cancellation                                                  | When the agent cancels                                                                                                                                    |
| HotelBookingDetailBasedOnDate | `POST /BookingDetailsbasedondate` | Reconciliation                                                | Daily, date ranges of at most 60 days                                                                                                                     |

Not used: `PaymentMode` `NewCard` and `SavedCard`. We never send card data to TBO.

**3. Booking flow**

1. **Search.** The agent enters destination, dates, rooms (adults, children and each child's age) and the **lead guest's nationality**. Nationality is a mandatory field with no default; we never hardcode `GuestNationality`. We resolve the destination to TBO hotel codes from our synced catalogue and call `Search` with at most 100 `HotelCodes` per request (comma-separated) and `IsDetailedResponse: false`. Parallel requests are rate-limited.
2. **Results.** We show hotel content, room names, meal type, refundability, promotions and inclusions. `Supplements` are always visible. `AtProperty` supplements are labelled "payable at the hotel" with their own amount and currency and are never added to the price we charge. The selling price is never below `RecommendedSellingRate` on any channel that sells to end customers.
3. **PreBook.** When the agent selects an option, we call `PreBook` with the `BookingCode` and `PaymentMode: "Limit"`. If `TotalFare` differs from Search, the agent must accept the new price before continuing. We display the PreBook cancellation policy, `RateConditions`, supplements and amenities, and store them with the booking as **final**.
4. **Guest details.** One `CustomerDetails` entry per room, in the same order as `PaxRooms`. Every guest is named, with `Title`, `FirstName`, `LastName` and `Type` (`Adult`/`Child`).
5. **Book.** Before calling TBO we create our internal booking record and generate a unique `BookingReferenceId` and a `ClientReferenceId`. We then call `Book` with the PreBook `TotalFare`, `BookingType: "Voucher"` and `PaymentMode: "Limit"`. Timeout: 120 s. **Book is never retried automatically.**
6. **After a successful Book.** We call `BookingDetail` by `ConfirmationNumber`, store status and details, and issue our voucher, which includes the `AtProperty` supplements and the cancellation policy.
7. **Book failure or timeout.** We wait 120 seconds after the failure and call `BookingDetail` by `BookingReferenceId`, and again after 5, 15 and 60 minutes if the booking is not found. If the booking exists, it is recorded as confirmed. If it does not appear, the booking stays in "verifying" status and blocked, and it is only marked failed when our daily reconciliation with `BookingDetailsbasedondate` (a valid response covering its creation date) does not find it either; our operations team can trigger that reconciliation on demand. It is never re-booked automatically.
8. **Hotel Confirmation Number.** For check-ins within 30 days, we call `BookingDetail` when the SLA for the check-in window expires (P0–P5 table), then hourly up to 3 retries. If there is still no HCN, we open an operations ticket with TBO.
9. **Cancel.** Before confirming, we show the agent the penalty according to the PreBook policy. We call `Cancel` with `ConfirmationNumber`, then `BookingDetail` to confirm the final status (`Cancelled`, `CancellationInProgress`, `CancelPending`, `CxlRequestSentToHotel`, `CancelledAndRefundAwaited`).

**4. Error handling**

- We read `Status.Code` from the response body and never rely on `Description`.
- 201: no availability message.
- 207 and 315: the rate or session is no longer valid, so we start a new search. The whole Search-to-Book flow is kept under 30 minutes.
- 300: insufficient balance, no retry; the account holder is notified.
- 402: agency blocked; we suspend calls with that account for a period and notify the account holder.
- 401: credentials alert.
- 400: request defect, fixed on our side.
- 429: back-off.
- 405: treated as uncertain; we follow the 120-second `BookingDetail` recovery of step 7.
- 479: cancellation rejected; we read `BookingDetail` to record the real status and never repeat the `Cancel` automatically.
- 500: complete RQ/RS logs are sent to TBO support.
- Timeouts: Search within the 5–23 s range, PreBook 23 s, Book 120 s.

**5. Logging**

- We store the complete JSON request and response of every call, with restricted access, and can provide them to TBO on request.
- Credentials are never logged.

**6. Certification samples**
The attached zip contains cases 1–8 as requested. Each case runs Search > PreBook > Book > BookingDetail > Cancel > BookingDetail. Case 8 is `BookingDetail` of case 4, called both by `ConfirmationNumber` and by `BookingReferenceId`. `README.txt` indexes every file.

---

## Anexo B — Test portal access (listo para enviar)

> Va por un canal distinto del zip. No lleva la contraseña si el canal no es seguro.

**Test portal access — [Company] B2B platform (TBO certification)**

- URL: [portal URL]
- User: [username]. The password is sent separately. The account is a **sales agent** of a test agency, has no admin rights and does not require MFA.
- The portal is connected only to the TBO integration environment. No other supplier is active in this environment.
- Payments: bookings are charged to the test agency's internal balance and to the TBO `Limit`. No card is requested.
- Path: _Hoteles_ (Hotels) → search → select a room option (PreBook) → _Huéspedes_ (Guests) → _Confirmar_ (Confirm) → _Reservas_ (Bookings) → _Cancelar_ (Cancel).
- The interface is in Spanish. Glossary: _Nacionalidad del huésped principal_ = lead guest nationality; _A pagar en el hotel_ = payable at the hotel (AtProperty); _Política de cancelación_ = cancellation policy; _Condiciones del hotel_ = rate conditions/norms; _Reembolsable_ = refundable; _Reservar_ = book; _Reservas_ = bookings.
- Contact during testing: [name, email, phone, hours in UTC].

## Anexo C — Email del zip (plantilla)

```text
To: apisupport@tbo.com
Subject: [Company] - Hotel API JSON certification samples (cases 1-8)

Hello TBO API Integration team,

Please find attached:
1. Our integration workflow (methods used and call sequence).
2. <zip name>: RQ/RS JSON for certification cases 1-8, indexed in README.txt.

Account (test): [TBO test username - no password]
Technical contact: [name, email, phone]

Could you also share, if possible, the JSON checkpoint list you use for verification, and confirm
the staging endpoint for the portal verification phase?

Regards,
[name]
```

---

## Preguntas abiertas

Todas se consolidan en [10-preguntas-para-tbo.md](./10-preguntas-para-tbo.md). Las sondas PR-01 a PR-11 (§6.8) pueden cerrar varias antes de preguntar.

1. → [Q-71](./10-preguntas-para-tbo.md#q-71): ¿nos pueden compartir el "JSON checkpoint list" y los criterios de la Portal Verification antes del envío? (Cert, JSON Verification; Website/Portal Verification)
2. → [Q-72](./10-preguntas-para-tbo.md#q-72): ¿qué nombres de archivo y estructura esperan en el zip? ¿Quieren solo las cadenas exitosas o "all the JSON logs", incluidos los intentos fallidos? (Cert, Integration on Test Account; JSON Verification)
3. → [Q-73](./10-preguntas-para-tbo.md#q-73): "Cancel (If Required)", ¿hay que cancelar todas las reservas de prueba o dejar alguna activa para su revisión? (Cert, Integration on Test Account)
4. → [Q-74](./10-preguntas-para-tbo.md#q-74): caso 7, ¿basta una reserva con suplementos usando la ocupación de cualquiera de los casos 1–6? ¿Qué `HotelCodes` de test devuelven suplementos `AtProperty`? (Cert, Integration on Test Account; p. 14)
5. → [Q-75](./10-preguntas-para-tbo.md#q-75): caso 8, el "HotelBookingDetail method", ¿es `BookingDetail`? ¿Por `ConfirmationNumber`, por `BookingReferenceId` o por los dos? (Cert, Integration on Test Account; p. 42–44, 62)
6. → [Q-76](./10-preguntas-para-tbo.md#q-76): el "Staging environment" de la Portal Verification, ¿es el mismo `http://api.tbotechnology.in/TBOHolidays_HotelAPI` y con las mismas credenciales de test? (Cert, Website/Portal Verification; p. 7)
7. → [Q-77](./10-preguntas-para-tbo.md#q-77): ¿la certificación vale para nuestra aplicación, de modo que cualquier cuenta TBO (por ejemplo, la de una agencia de la red con credenciales propias) puede operar por ella, o se certifica por cuenta? (Cert, Sign Off / API Live Credentials)
8. → [Q-78](./10-preguntas-para-tbo.md#q-78): si certificamos el portal B2B, ¿añadir después B2C, WhatsApp o mobile obliga a recertificar? (Cert, Client's Details)
9. → [Q-23](./10-preguntas-para-tbo.md#q-23): ¿`RecommendedSellingRate` aplica también cuando una agencia B2B vende a un cliente final (B2B2C)? (p. 13, 21)
10. → [Q-79](./10-preguntas-para-tbo.md#q-79): ¿es aceptable un portal en español para la Portal Verification? (Cert, Website/Portal Verification)
11. → [Q-80](./10-preguntas-para-tbo.md#q-80): ¿qué campos pide el Production Process Form (por ejemplo, IPs de salida para whitelisting o URL live)? (Cert, Sign Off / API Live Credentials; p. 7)
12. → [Q-81](./10-preguntas-para-tbo.md#q-81): ¿la certificación exige los modos `NewCard` o `SavedCard`, o basta con `Limit`? (p. 19, 33–40)
13. → [Q-82](./10-preguntas-para-tbo.md#q-82): ¿el test tiene saldo `Limit` suficiente para unas 10 reservas, y en qué moneda está configurado el perfil de la cuenta de test? (p. 9, código 300; p. 13)
14. → [Q-83](./10-preguntas-para-tbo.md#q-83): ¿el entorno de test llena `HotelConfirmationNumber` en BookingDetail? (p. 42–43)
15. → [Q-84](./10-preguntas-para-tbo.md#q-84): el formulario pide Skype ID y Skype ya no opera, ¿aceptan Microsoft Teams o WhatsApp? (Cert, Client's Details)
16. → [Q-11](./10-preguntas-para-tbo.md#q-11): ¿la dirección de soporte vigente es `apisupport@tbo.com` o `apisupport@tboholidays.com`? (Cert, Integration on Test Account; p. 9)
17. → [Q-13](./10-preguntas-para-tbo.md#q-13): con `Children: 0`, ¿`ChildrenAges` va como `[]`, `[0]` o se omite? El rango escrito de `Children` es "(1-4)" y la colección manda `[0]`. (p. 11; Postman: Search)
18. → [Q-41](./10-preguntas-para-tbo.md#q-41): ¿qué `Title` llevan los niños (`Master`, `Miss`)? ¿Se acepta `Dr`, que usa la colección? (p. 32, 34, 39; Postman: HotelBook)
19. → [Q-42](./10-preguntas-para-tbo.md#q-42): ¿hay que nombrar a todos los huéspedes de cada habitación o solo al líder? La tabla dice "Lead guest first name" y los ejemplos nombran a todos. (p. 32–34, 39)
20. → [Q-34](./10-preguntas-para-tbo.md#q-34), [Q-35](./10-preguntas-para-tbo.md#q-35): ¿qué formato y longitud máxima admiten `BookingReferenceId` y `ClientReferenceId`? ¿Book es idempotente respecto de `BookingReferenceId`? (p. 33, 42–43)
21. → [Q-37](./10-preguntas-para-tbo.md#q-37): ¿qué devuelve BookingDetail cuando no existe una reserva con ese `BookingReferenceId`? (p. 42–44)
22. → [Q-27](./10-preguntas-para-tbo.md#q-27): ¿`Supplements[].Price` es por noche, por habitación o por estadía? (p. 14–15, 28–31)
23. → [Q-43](./10-preguntas-para-tbo.md#q-43): ¿qué juego de caracteres y qué longitud admiten `FirstName` y `LastName`? ¿Se aceptan tildes y `ñ`? (p. 32–33)
24. → [Q-86](./10-preguntas-para-tbo.md#q-86): ¿cuánto suele pasar entre el envío del zip y la fecha de JSON Verification? (Cert, JSON Verification)

## Riesgos

Los riesgos del proceso están en §10. Los tres que pueden cambiar decisiones de producto son:

- **R-05**: exponer credenciales reales a testers de TBO. Lo decide DC-1.
- **R-13**: que la certificación no alcance a las cuentas BYOC. Lo decide la pregunta 7.
- **R-07**: que el portal no esté listo cuando TBO agende la Fase 3. Lo deciden DC-5 y [09](./09-plan-implementacion.md).
