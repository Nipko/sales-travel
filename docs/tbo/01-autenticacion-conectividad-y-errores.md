---
titulo: 'TBO Hotels — Autenticación, conectividad y errores'
fecha: 2026-09-23
estado: borrador
---

# TBO Hotels — Autenticación, conectividad y errores

> **Cómo leer este documento.** Las fuentes y su procedencia están en [00-fuentes.md](./00-fuentes.md). Cada
> afirmación lleva cita: página **física** del PDF "(p. N)", "(Postman: <request>)", "(Cert, <sección>)" para el
> documento de certificación (nunca por línea de `cert.txt`, [00](./00-fuentes.md) §4), o `ruta/archivo.ts:línea`
> para el código del repo. Niveles de evidencia:
> **VERIFICADO-PDF**, **VERIFICADO-POSTMAN**, **VERIFICADO-CERT**, **VERIFICADO-CODIGO** e **INFERIDO**. Los párrafos
> marcados **Postura** son decisiones de diseño nuestras, no afirmaciones sobre el contrato.
>
> **Alcance.** Transporte y contrato transversal de la API JSON de hoteles de TBO V2.1: autenticación, entornos,
> paths, headers, timeouts, la ventana de 30 minutos, el límite de QPS, los códigos `Status.Code`, el modelo de
> errores tipados del ACL, el diseño del cliente HTTP, el logging, el circuit breaker y el kill-switch.
> **No cubre:** el request y la oferta de Search ([02](./02-search-y-oferta-canonica.md)), PreBook, Book y la
> guarda de pago `Limit` ([03](./03-prebook-y-book.md)), BookingDetail, Cancel y conciliación
> ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md)), contenido estático
> ([05](./05-contenido-estatico-e-inventario.md)), ni los cambios en `apps/api` para enchufar todo esto
> ([06](./06-seams-integracion-repo.md)).

---

## 0. Resumen

1. **Autenticación Basic** con usuario y contraseña que entrega TBO, en cada request, sin token ni sesión
   (p. 7). La cabecera `Authorization: Basic …` es base64 **reversible**: equivale a la contraseña en claro y no
   puede aparecer nunca en logs, mensajes de error ni URLs.
2. **El host de test es `http://`** aunque el PDF dice que "All APIs should be secured with HTTPS protocol" (p. 7).
   Postura: `http` solo se acepta con credenciales de test contra el host de test conocido; en live se exige
   `https`.
3. **La URL live no se publica** (`{Live-URL}/HotelAPI`) y **cambia también el path** respecto de test
   (`/TBOHolidays_HotelAPI`) (p. 7). La base URL es configuración por cuenta, sin valor por defecto para live.
4. **El casing de los paths no es consistente** entre PDF y Postman (`/Search` frente a `/search`,
   `/HotelDetails` frente a `/Hoteldetails`, etc.). Postura: una sola tabla de operaciones con el casing del PDF,
   verificada por un smoke test en certificación. Un HTTP 404 nunca se interpreta como "sin disponibilidad".
5. **Timeouts recomendados solo para tres métodos**: Search 5-23 s, PreBook 23 s y Book 120 s (p. 8). Para
   BookingDetail, Cancel, BookingDetailsbasedondate y los estáticos proponemos valores y los preguntamos a TBO.
6. **Todo el flujo, de Search a Book, cabe en 30 minutos** (p. 8). Pasado ese plazo cabe esperar el código 315,
   "Session expired between search to book" (p. 9); que ese código sea el de la ventana de 30 minutos es
   **INFERIDO** (§6.1). Postura: la oferta vence a los 27 minutos del envío del Search, y a partir de ahí no se llama a TBO.
7. **Existe un límite de QPS (código 429), pero su valor no se publica** (p. 9). Postura: limitador por cuenta
   resuelta con un valor conservador configurable y capacidad reservada para las operaciones con dinero.
8. **El PDF expresa el estado con `Status.Code` en el cuerpo** ("Status code indicates the status of response",
   p. 8; objeto `Status`, p. 13). Son 12 códigos (pp. 8-10). El PDF no dice si el HTTP de transporte los refleja.
   Postura: gana el cuerpo cuando existe y es válido. Un cuerpo vacío, que no es JSON, sin `Status` o con un código
   desconocido es error, nunca éxito, salvo en `hotelcodelist`, cuyo ejemplo de respuesta no trae `Status` (p. 55,
   §8.1).
9. **Errores tipados:** una clase `TboApiError` con `failure.kind` cerrado (14 valores) para todo lo que pasó por
   el cable, más cinco clases: cuatro para fallos que no llegaron a TBO y una para la respuesta 200 que no se pudo
   leer (§9.1). La forma es
   compatible con el clasificador genérico de cancelaciones del repo
   (`apps/api/src/orders/cancel-retry-policy.ts:84`).
10. **Cero reintentos automáticos en `/Book` y `/Cancel`**. Si hay duda, se reconcilia con BookingDetail
    (p. 42, [03](./03-prebook-y-book.md), [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md)).
11. **Logging por lista blanca de campos.** No se registran cuerpos ni headers, y el texto libre `Status.Description`
    solo en las operaciones cuyo request no lleva datos personales, recortado (§11.1).
    Queda descartado el patrón de Despegar, que loguea 250 caracteres del body
    (`apps/api/src/hotels/despegar-hotels-exception.filter.ts:22`).
12. **El circuit breaker actual no sirve tal cual.** Cuenta cualquier excepción como fallo y lleva la cuenta por
    `providerCode` (`apps/api/src/search/circuit-breaker.service.ts:90-97`). Con eso, una credencial BYOC mala de
    una sola agencia abriría el circuito para todas. Además, el kill-switch `PROVIDERS_DISABLED` no llega al
    contenedor de producción.

---

## 1. Autenticación

### 1.1 Lo que dice el contrato

| Aspecto                     | Valor literal                                                                                                                                                                    | Fuente                                                    | Evidencia          |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------ |
| Protocolo                   | "The API uses the **Basic Auth** protocol for this authentication."                                                                                                              | p. 7                                                      | VERIFICADO-PDF     |
| Transporte                  | "All APIs should be secured with HTTPS protocol."                                                                                                                                | p. 7                                                      | VERIFICADO-PDF     |
| Credencial                  | "TBO provided Username and Password should be used in the authorization."                                                                                                        | p. 7                                                      | VERIFICADO-PDF     |
| URI / Method / Content-Type | `BaseURL` / `POST` / `application/json`                                                                                                                                          | p. 7                                                      | VERIFICADO-PDF     |
| Captura de ejemplo          | Postman "Type: Basic Auth", Username `TBOAPI`, Password enmascarada. Es ilustrativa, no una credencial                                                                           | p. 7                                                      | VERIFICADO-PDF     |
| Postman                     | `auth` de colección `type: "basic"` con `username`/`password` vacíos. `BookingDetailsBasedOnDate` y `Cancel` repiten su propio bloque `basic`, también vacío. El resto lo hereda | Postman: colección, `BookingDetailsBasedOnDate`, `Cancel` | VERIFICADO-POSTMAN |
| Credenciales de producción  | Se entregan al cerrar la certificación, mediante un "Production Process Form"                                                                                                    | Cert, "Sign Off / API Live Credentials!"                  | VERIFICADO-CERT    |

Lo que el contrato **no menciona** (búsqueda en todo el texto del PDF, sin resultados): tokens, sesión de login,
expiración o rotación de la contraseña, allowlist de IP de origen y cabeceras de correlación. **VERIFICADO-PDF
(por ausencia)**.

### 1.2 Cómo se construye la cabecera

- El PDF no escribe la cabecera literal. Suponemos la forma estándar de RFC 7617:
  `Authorization: Basic base64(utf8(username + ":" + password))`. **INFERIDO**, porque la captura de p. 7 es la del
  generador automático de Postman ("The authorization header will be automatically generated…").
- **Postura:**
  - La cabecera se calcula **una sola vez**, en el constructor del cliente, y se guarda en un campo privado de
    clase (`#authorization`). Así no aparece en `JSON.stringify` del cliente ni en la configuración que se pueda
    volcar a un log. Un test serializa el adapter y comprueba que no contiene la contraseña. Sabre no tiene ese
    test sobre el adapter serializado: su precedente comprueba logs y mensajes de error
    (`providers/sabre/src/sabre-flight-search.adapter.test.ts:337-346`,
    `apps/api/src/providers-sabre/sabre.factory.test.ts:106-122`).
  - El esquema Zod de la configuración rechaza un `username` que contenga `:`, porque RFC 7617 no lo permite en
    el user-id, y rechaza también usuario o contraseña vacíos. El mensaje de error lleva solo `ruta:código` del
    issue, nunca el valor, como `parseSabreConfig` (`providers/sabre/src/config.ts:122-131`).
  - Nada se recorta con `trim()` en la contraseña, porque un espacio puede ser parte de ella. Hoy el panel BYOC
    **sí** recorta todos los campos, secretos incluidos, antes del POST (`effectiveValue`,
    `apps/web-b2b/src/lib/provider-forms.ts:351-355`, usado en `:459`): la entrada de TBO en ese formulario tiene
    que exceptuar `password`. No se sabe cómo trata TBO los caracteres no ASCII → [Q-06](./10-preguntas-para-tbo.md#q-06).
- **No hay reautenticación.** Basic no tiene token que refrescar, así que un 401 no se reintenta nunca. Sabre sí
  reintenta una vez tras reautenticar (`providers/sabre/src/http/sabre-http.client.ts:194-201`), pero ese patrón
  no aplica aquí.

### 1.3 Credenciales por nodo (BYOC) — solo lo que afecta al cliente

- `username` y `password` van **cifrados** en `provider_accounts.credentials_enc`. `baseUrl` y `environment` van
  en `config`, que no se cifra. La herencia consolidador → agencia la resuelve `resolve_provider_account`, y la
  puerta de credenciales (`missingTboCredentials` → `ProviderAccountIncompleteError`) sigue el molde de LATAM y
  Sabre. El detalle está en [06](./06-seams-integracion-repo.md).
- El cliente HTTP es la **última puerta**. Si le llega una configuración sin credenciales usables, lanza
  `TboCredentialsMissingError` (con los nombres de los campos, nunca sus valores) antes de tocar la red. Es el
  mismo patrón que Sabre (`providers/sabre/src/http/sabre-http.client.ts:172-176`) y
  `LatamCredentialsMissingError` (`providers/latam-ndc/src/errors.ts:11-19`). **VERIFICADO-CODIGO** para los
  precedentes.
- Las credenciales de test y las de live son **distintas**: las de live se liberan después de la certificación
  (Cert, "Sign Off / API Live Credentials!"). **VERIFICADO-CERT** que las de live se entregan al certificar; **INFERIDO** que no coincidan con
  las de test (el documento no lo dice con esas palabras). Eso vuelve peligroso un valor por defecto de `baseUrl` (§2.3).

---

## 2. Entornos y URLs base

### 2.1 Tabla de entornos

| Entorno                          | Base URL literal                                                                                         | Fuente                                                      | Evidencia          |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------ |
| Test                             | `http://api.tbotechnology.in/TBOHolidays_HotelAPI`                                                       | p. 7                                                        | VERIFICADO-PDF     |
| Live                             | `{Live-URL}/HotelAPI`: marcador, **host no publicado**                                                   | p. 7                                                        | VERIFICADO-PDF     |
| Integración (certificación)      | `http://api.tbotechnology.in/TBOHolidays_HotelAPI` (el mismo que test)                                   | Cert, "TBO Hotel API Details"                               | VERIFICADO-CERT    |
| Staging (verificación de portal) | "Testing … must occur in our Staging environment". No se dice su URL                                     | Cert, "Certification Process (Website/Portal Verification)" | VERIFICADO-CERT    |
| Postman                          | Todas las requests contra `http://api.tbotechnology.in/TBOHolidays_HotelAPI/…`, sin variables ni entorno | Postman: las 10 requests                                    | VERIFICADO-POSTMAN |

Convención: "Please follow this convention for API endpoint: {BaseURL}/{Method Name}" (p. 7). **VERIFICADO-PDF.**

Aviso del documento de certificación: "the Certification environment is subject to frequent development updates;
therefore, brief system outages may need to occur on occasion without prior notification" (Cert, nota final).
**VERIFICADO-CERT.** Consecuencia: los cortes del entorno de test no deben generar alertas de guardia (§12.3).

### 2.2 HTTP frente a HTTPS — contradicción

- Contradicción: el PDF pide HTTPS ("should be secured with HTTPS protocol", p. 7), pero la base URL de test es
  `http://` en el PDF (p. 7), en Cert ("TBO Hotel API Details") y en Postman. Con Basic Auth sobre `http`, usuario y contraseña
  viajan en claro por internet. **VERIFICADO-PDF / VERIFICADO-CERT / VERIFICADO-POSTMAN.**
- No sabemos si `api.tbotechnology.in/TBOHolidays_HotelAPI` responde por HTTPS ni si la URL live es HTTPS →
  [Q-03](./10-preguntas-para-tbo.md#q-03), [Q-04](./10-preguntas-para-tbo.md#q-04). Único indicio: el ejemplo de respuesta de HotelDetails enlaza imágenes en
  `https://api.tbotechnology.in/imageresource.aspx?img=…` (p. 62), así que el host tiene TLS al menos para ese
  recurso. **VERIFICADO-PDF** (la URL del ejemplo); **INFERIDO** que valga para el path de la API.
- **Postura (defensiva):**
  1. El esquema Zod de la configuración acepta `http:` **solo** si `environment === 'test'` **y** el host es
     exactamente `api.tbotechnology.in`. Cualquier otra combinación con `http:` se rechaza al guardar la cuenta y
     también al construir el adapter.
  2. Antes de la certificación se prueba HTTPS contra el host de test. Si responde, la constante
     `TBO_BASE_URLS.test` pasa a `https://` y la excepción del punto 1 se elimina.
  3. `fetch` se llama con `redirect: 'manual'`. Una respuesta 3xx sin JSON válido se clasifica como `CLIENT_BUG`
     con alerta al operador. Así evitamos que un redirect (por ejemplo, de `http` a `https`, o a otro host) reenvíe
     la cabecera `Authorization` sin que nos enteremos, y el cambio de URL queda como una decisión explícita.
     **INFERIDO** (comportamiento de redirect de `fetch`) + Postura.
- Aceptar `http` en test es una decisión del founder: expone las credenciales de test, que son distintas de las de
  live (Cert, "Sign Off / API Live Credentials!"). Ver §14.

### 2.3 Host live desconocido y path distinto

- En live cambia el host **y** el path: `/HotelAPI` en lugar de `/TBOHolidays_HotelAPI` (p. 7). No se puede
  derivar una URL de la otra. **VERIFICADO-PDF.**
- **Postura:**
  - `TBO_BASE_URLS` solo contiene `test`. La URL live llega por `config.baseUrl` de la cuenta. Es la misma
    conclusión del dossier de credenciales: un `environment: 'test'|'live'` a secas no resuelve nada si el host
    no es conocido.
  - **No hay valor por defecto** cuando `environment === 'live'`: sin `baseUrl` la cuenta queda incompleta
    (`ProviderAccountIncompleteError`). Así una credencial live nunca termina enviándose al host de test por
    `http`. Despegar, en cambio, usa sandbox por defecto
    (`apps/api/src/providers-despegar/despegar-hotels.factory.ts:63`), y copiarlo aquí sería peligroso.
  - `baseUrl` se normaliza: sin barra final y sin query ni fragmento. El path de la operación se concatena con
    `/`.
- La URL exacta de live, y si staging usa otra URL distinta de la de integración → [Q-04](./10-preguntas-para-tbo.md#q-04), [Q-76](./10-preguntas-para-tbo.md#q-76).

---

## 3. Paths, verbos y casing

### 3.1 Tabla de operaciones

| Operación                         | Path en el PDF (p.)                  | Verbo PDF       | Path en Postman              | Verbo Postman | **Path que usamos**          |
| --------------------------------- | ------------------------------------ | --------------- | ---------------------------- | ------------- | ---------------------------- |
| Search                            | `/Search` (pp. 7, 10)                | POST (p. 10)    | `/search`                    | POST          | `/Search`                    |
| PreBook                           | `/PreBook` (pp. 7, 19)               | POST (p. 19)    | `/PreBook`                   | POST          | `/PreBook`                   |
| Book (etiqueta "HotelBook")       | `/Book` (pp. 7, 32)                  | POST (p. 32)    | `/Book`                      | POST          | `/Book`                      |
| BookingDetail                     | `/BookingDetail` (pp. 8, 42)         | POST (p. 42)    | `/BookingDetail`             | POST          | `/BookingDetail`             |
| Cancel                            | `/Cancel` (pp. 8, 41)                | POST (p. 41)    | `/Cancel`                    | POST          | `/Cancel`                    |
| BookingDetailsbasedondate         | `/BookingDetailsbasedondate` (p. 62) | POST (p. 62)    | `/BookingDetailsBasedOnDate` | POST          | `/BookingDetailsbasedondate` |
| CountryList                       | `/CountryList` (p. 51)               | **GET** (p. 51) | `/CountryList`               | **GET**       | `/CountryList`               |
| CityList                          | `/CityList` (p. 53)                  | POST (p. 53)    | `/CityList`                  | POST          | `/CityList`                  |
| HotelCodeList (todos los códigos) | `/hotelcodelist` (pp. 54-55)         | **GET** (p. 55) | — (no está en la colección)  | —             | `/hotelcodelist`             |
| TBOHotelCodeList                  | `/TBOHotelCodeList` (p. 65)          | POST (p. 65)    | `/TBOHotelCodeList`          | POST          | `/TBOHotelCodeList`          |
| HotelDetails                      | `/HotelDetails` (p. 56)              | POST (p. 56)    | `/Hoteldetails`              | POST          | `/HotelDetails`              |

**VERIFICADO-PDF** (en pp. 7-10 y 42 por lectura visual; en el resto por el texto por página) y
**VERIFICADO-POSTMAN**.

### 3.2 Contradicciones de path y verbo

- **Verbo:** la tabla general de p. 7 dice `Method POST`, pero `CountryList` (p. 51) y `hotelcodelist` (p. 55) son
  `GET`, y Postman también usa `GET` para `CountryList`. **Postura:** el verbo es un atributo de cada operación en
  la tabla (§10.2), no un valor global del cliente. Un GET no lleva body.
- **Casing:** hay cuatro discrepancias (`Search`/`search`, `HotelDetails`/`Hoteldetails`,
  `BookingDetailsbasedondate`/`BookingDetailsBasedOnDate`, y `hotelcodelist` en minúsculas frente al PascalCase del
  resto). Que Postman funcione con `/search` sugiere que el servidor no distingue mayúsculas. **INFERIDO.** El
  punto se pregunta a TBO ([Q-05](./10-preguntas-para-tbo.md#q-05)).
- **La tabla de endpoints de pp. 7-8 omite** los métodos estáticos y `BookingDetailsbasedondate`. Sus paths salen
  de la sección de cada método. **VERIFICADO-PDF.**
- **Postura:**
  1. Los paths viven en **una sola constante** (`TBO_OPERATIONS`, §10.2) con el casing del PDF, que es el
     contrato. No se escriben literales de path en ningún otro sitio.
  2. En certificación, un smoke test llama a cada operación con el casing de la constante y, si recibe 404, con
     el de Postman. El casing que funcione queda en la constante, con evidencia en
     [07](./07-certificacion.md).
  3. Una respuesta HTTP 404 o 405 **sin** envelope JSON válido se clasifica como `CLIENT_BUG` (path o verbo
     equivocado) con alerta al operador. **Nunca** como "sin disponibilidad" ni como resultado vacío.
  4. La comparación de paths para las reglas de dinero (§10.4) se hace sin distinguir mayúsculas.

---

## 4. Headers y cuerpo

| Header          | Valor                                        | Evidencia                                                                                                                                  |
| --------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `Authorization` | `Basic <base64(username:password)>`          | VERIFICADO-PDF (Basic, p. 7) + INFERIDO (forma RFC 7617)                                                                                   |
| `Content-Type`  | `application/json`, en toda request con body | VERIFICADO-PDF (p. 7). Postman no lo declara (`"header": []` en las 10 requests) y lo añade solo por usar body raw JSON: INFERIDO          |
| `Accept`        | `application/json`                           | INFERIDO (no lo pide el PDF, no hace daño)                                                                                                 |
| Cualquier otro  | **No se envía**                              | El PDF no documenta más cabeceras (p. 7, por ausencia). Mandar cabeceras no documentadas, como un `X-Request-Id`, tiene efecto desconocido |

- **Compresión:** el PDF no la menciona (p. 7, por ausencia). No forzamos `Accept-Encoding`. Si TBO soporta gzip,
  convendría para HotelDetails y las listas estáticas → [Q-12](./10-preguntas-para-tbo.md#q-12) (prioridad baja).
- **Cuerpo:** siempre `JSON.stringify` de un objeto que ya pasó por el esquema Zod de salida de la operación. La
  request `BookingDetail` de Postman trae un comentario `//` dentro del JSON, que es JSON inválido (Postman:
  `BookingDetail`, **VERIFICADO-POSTMAN**). Nuestro cliente no puede producir eso. Además, los ejemplos del PDF con
  comillas tipográficas (p. 12) no sirven como fixtures ([02](./02-search-y-oferta-canonica.md)).
- **Correlación:** TBO no documenta ningún identificador de request (pp. 7-10, por ausencia). **Postura:**
  generamos un `requestId` (UUID) por llamada solo para nuestros logs, sin enviarlo. Ante TBO, la correlación de
  reservas usa `BookingReferenceId`/`ClientReferenceId` (p. 33) y la de soporte usa los RQ/RS completos (§11.2).
  Si TBO acepta o devuelve algún identificador de correlación → [Q-12](./10-preguntas-para-tbo.md#q-12).

---

## 5. Timeouts

### 5.1 Lo que dice el contrato

"Please refer to the following table for recommended timeout settings for each API." (p. 8)

| API     | Recommended Timeout | Fuente |
| ------- | ------------------- | ------ |
| Search  | 5-23 Seconds        | p. 8   |
| PreBook | 23 Seconds          | p. 8   |
| Book    | 120 Seconds         | p. 8   |

- Nota en negrita: "To complete the entire booking process i.e., from search to book, the timeout is 30 minutes."
  (p. 8), desarrollada en §6.
- Nota de BookingDetail: "In case of timeout/failure/http/network related error in book response then it is
  mandatory to call the BookingDetail method by using BookingReferenceId after 120 seconds of book response."
  (p. 42).
- No hay timeout recomendado para BookingDetail, Cancel, BookingDetailsbasedondate ni los estáticos (p. 8, por
  ausencia).

Todo **VERIFICADO-PDF** (pp. 8 y 42, lectura visual).

### 5.2 Política por operación

| Operación                      | Contrato       | Timeout HTTP propuesto                                                                                                        | Quién espera                                        | Reintento automático (§10.4)                                                                                                                                             | Evidencia                                          |
| ------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| Search                         | 5-23 s (p. 8)  | `ResponseTime` + 3 s. Por defecto `ResponseTime` = 10 → **13 s**. Rango permitido de `ResponseTime`: 5-20 → timeout de 8-23 s | Vendedor, dentro del fan-out                        | 1, solo por 429, 500 o conexión rechazada, y nunca después de un timeout                                                                                                 | VERIFICADO-PDF + Postura                           |
| PreBook                        | 23 s (p. 8)    | **23 s**                                                                                                                      | Vendedor                                            | 1, solo si el primer fallo fue rápido (429, 500 o conexión rechazada) y el total no pasa de 23 s; nunca después de un timeout ([08](./08-requisitos-maestro.md) §9 C-24) | VERIFICADO-PDF + Postura                           |
| Book                           | 120 s (p. 8)   | **120 s**                                                                                                                     | Job de BullMQ (D9), no el request HTTP del vendedor | **0, nunca.** Recuperación con BookingDetail a +120 s (p. 42)                                                                                                            | VERIFICADO-PDF                                     |
| BookingDetail                  | no documentado | 30 s                                                                                                                          | Job de conciliación o vendedor en "ver detalle"     | Hasta 2 en job, 1 en interactivo                                                                                                                                         | INFERIDO → [Q-09](./10-preguntas-para-tbo.md#q-09) |
| Cancel                         | no documentado | 60 s                                                                                                                          | Job de BullMQ                                       | **0, nunca.** Reconciliación con BookingDetail                                                                                                                           | INFERIDO → [Q-09](./10-preguntas-para-tbo.md#q-09) |
| BookingDetailsbasedondate      | no documentado | 60 s                                                                                                                          | Job de conciliación                                 | Hasta 2                                                                                                                                                                  | INFERIDO → [Q-09](./10-preguntas-para-tbo.md#q-09) |
| CountryList, CityList          | no documentado | 30 s                                                                                                                          | Job de sincronización                               | Hasta 4, backoff exponencial                                                                                                                                             | INFERIDO → [Q-09](./10-preguntas-para-tbo.md#q-09) |
| TBOHotelCodeList, HotelDetails | no documentado | 60 s                                                                                                                          | Job de sincronización                               | Hasta 4, backoff exponencial                                                                                                                                             | INFERIDO → [Q-09](./10-preguntas-para-tbo.md#q-09) |
| hotelcodelist                  | no documentado | 180 s (devuelve la lista completa de códigos, p. 54)                                                                          | Job de sincronización                               | Hasta 2                                                                                                                                                                  | INFERIDO → [Q-09](./10-preguntas-para-tbo.md#q-09) |

Todos los valores viven en la tabla `TBO_OPERATIONS` (§10.2). La configuración por cuenta solo puede
**acortarlos**, salvo `ResponseTime`, que es un parámetro explícito.

### 5.3 Search: `ResponseTime` y el rango "5-23 Seconds"

- El request de Search incluye `ResponseTime`, de tipo `Integer`, "Expected response time (seconds)" (p. 11). Los
  ejemplos del PDF usan `23.0` (pp. 11-12) y Postman usa `20.0` (Postman: `Search`). **VERIFICADO-PDF /
  VERIFICADO-POSTMAN.**
- Suponemos que "5-23 Seconds" es el margen admisible de ese `ResponseTime` y que el timeout del cliente debe
  superarlo con holgura. **INFERIDO.** No se sabe si TBO corta al cumplirse `ResponseTime` y devuelve resultados
  parciales, ni si la duración depende del número de `HotelCodes` → [Q-16](./10-preguntas-para-tbo.md#q-16).
- **Postura:** se envía `ResponseTime` entero (el mismo número que `23.0` en JSON). El timeout HTTP es
  `ResponseTime + 3 s` con techo de 23 s, para que ninguna configuración salga del rango recomendado. El valor por
  defecto de 10 s equilibra completitud y velocidad (principio de venta en menos de 2 minutos, `CLAUDE.md`) y es
  una decisión del founder (§14). Cómo se reparte el fan-out por lotes de hasta 100 `HotelCodes` se explica en
  [02](./02-search-y-oferta-canonica.md).

### 5.4 Book: 120 s y la recuperación obligatoria

- Timeout de 120 s (p. 8). Si el Book falla por timeout, error HTTP, error de red u otra "failure", es
  obligatorio llamar a BookingDetail con `BookingReferenceId` **120 s después** (p. 42). **VERIFICADO-PDF.**
- **Postura:** el Book se ejecuta en un job de BullMQ (D9), nunca dentro del request HTTP del vendedor, así que un
  timeout de 120 s no bloquea a nadie. El Book **no** acepta una señal de cancelación del llamador. Si el vendedor
  cierra el navegador, abortar el Book no cancela nada en TBO y solo convierte un resultado conocido en uno
  incierto. La saga completa (intent idempotente, job diferido de +120 s, estados `FAILED` y `UNVERIFIED`) se
  describe en [03](./03-prebook-y-book.md).

### 5.5 Implementación del timeout: debe cubrir también el cuerpo

- Despegar crea un `AbortController`, arma un `setTimeout` de 15 s y lo **limpia en el `finally` de `fetch`**
  (`providers/despegar-hotels/src/http/despegar-http.client.ts:79-88`), antes de leer el cuerpo con `res.text()`
  (`:92`). Sabre hace lo mismo (`providers/sabre/src/http/sabre-http.client.ts:227-249` y `res.text()` en `:252`).
  **VERIFICADO-CODIGO.** Consecuencia: si un servidor manda las cabeceras y después entrega el cuerpo muy
  despacio, la lectura no tiene techo. **INFERIDO.**
- AgentCars pasa `AbortSignal.timeout(timeoutMs)` a `fetch` (`providers/agent-cars/src/http/agent-cars-http.client.ts:71`).
  Esa señal sigue viva mientras se lee el cuerpo. **VERIFICADO-CODIGO** (código); **INFERIDO** (que la señal
  aborta también la lectura del cuerpo, que es el comportamiento de `fetch`).
- **Postura:** el cliente de TBO usa `AbortSignal.timeout(op.timeoutMs)` y lee el cuerpo con la misma señal. En
  las lecturas interactivas (Search, PreBook y BookingDetail interactivo) se combina con la señal del request
  entrante mediante `AbortSignal.any`, disponible desde Node 20.3 (**INFERIDO**); el repo fija Node 20.18
  (`.nvmrc`, `apps/api/Dockerfile:1`, **VERIFICADO-CODIGO**). En Book y Cancel **no** se
  combina (§5.4). Los errores `TimeoutError` y `AbortError` se clasifican como `TRANSPORT` con `timedOut: true`.

---

## 6. La ventana de 30 minutos de Search a Book

### 6.1 Contrato

- "To complete the entire booking process i.e., from search to book, the timeout is 30 minutes." (p. 8)
- `BOOKINGCODE_EXPIRED` = 315, "Session Expired", "Session expired between search to book." (p. 9)

**VERIFICADO-PDF.** Que el `BookingCode` de Search es la "sesión" que vence es **INFERIDO** (pp. 8-9 juntas).

### 6.2 Huecos

- No se dice si los 30 minutos empiezan con el **request** de Search o con su respuesta, si PreBook **renueva** la
  ventana, ni si el Book tiene que **empezar** o **terminar** dentro de ella → [Q-29](./10-preguntas-para-tbo.md#q-29).

### 6.3 Postura (defensiva)

1. El reloj arranca en **`searchSentAt`**, el instante en que enviamos el Search, que es el más temprano posible.
   Se guarda en la oferta junto al `BookingCode` ([02](./02-search-y-oferta-canonica.md)).
2. `expiresAt = searchSentAt + 30 min − 120 s (duración máxima del Book) − 60 s de margen = searchSentAt + 27 min`.
   Suponemos que PreBook **no** renueva la ventana.
3. Antes de PreBook y antes de encolar el Book, si `now ≥ expiresAt` el adapter lanza `TboOfferExpiredError`
   **sin llamar a TBO**. Es la misma experiencia que un 315, pero sin gastar QPS y sin arriesgar un Book tardío.
4. Si hay caché de resultados de búsqueda, **no** reinicia el reloj: una oferta servida desde caché mantiene el
   `searchSentAt` original. Un acierto de caché con 25 minutos de antigüedad ofrece `BookingCode` casi muertos.
5. La UI muestra el tiempo restante y avisa a los 20 minutos (alrededor del 75 %), como RNF-12 de Sabre
   (`docs/sabre/10-requisitos-maestro.md` §4). En WhatsApp, un cliente que responde 40 minutos después obliga a
   buscar de nuevo y, si el precio cambió, a confirmarlo otra vez ([03](./03-prebook-y-book.md)).
6. El paso de cobro con hosted checkout, entre PreBook y Book, **consume** esta ventana. El link de pago tiene que
   vencer antes de `expiresAt` o, si se paga después, hay que volver a buscar y volver a hacer PreBook antes del
   Book ([03](./03-prebook-y-book.md)).

---

## 7. Límite de consultas (QPS, código 429)

### 7.1 Contrato

- `LIMIT_EXCEEDED` = 429, "QPS Exceeded", "Requests have exceeded allowed QPS." (p. 9). **VERIFICADO-PDF.**
- **El valor no se publica** (p. 9, por ausencia). Tampoco se dice si el límite va por usuario, por cuenta, por IP
  o por método, qué ventana usa, si admite ráfagas, si además hay límite de concurrencia, ni si el 429 llega como
  HTTP 429 o dentro de un 200 con `Retry-After` → [Q-10](./10-preguntas-para-tbo.md#q-10).

### 7.2 Postura

1. **Limitador por cuenta resuelta**, no por tenant. La clave es `ownerTenantId` más un digest truncado del
   `username`: las sub-agencias que heredan la cuenta del consolidador comparten el mismo cupo en TBO
   (**INFERIDO**), igual que razona Sabre para su semáforo (`docs/sabre/10-requisitos-maestro.md` RNF-04).
2. **Valores por defecto conservadores y configurables**: `maxQps` 5 y `maxConcurrent` 4 por cuenta
   (**INFERIDO**, sin evidencia de TBO), hasta que TBO publique el valor real. Es una decisión del founder (§14).
3. **Capacidad reservada para dinero:** Book, Cancel y el BookingDetail de recuperación tienen un cupo propio y no
   esperan detrás del tráfico de búsqueda. Una campaña de ventas no puede impedir la conciliación de una reserva.
   Los jobs no usan esa reserva (HARD-2, [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §9.5 punto 5):
   la verificación de un Book incierto sale por un cupo `verification`, que pasa antes que las búsquedas pero con
   techo propio (1 QPS y 1 en vuelo por cuenta), y el HCN, la verificación de una cancelación y la conciliación
   salen por el cupo de fondo, que cede ante las ventas. Una ráfaga de jobs no le quita al vendedor más que esos techos.
   Lo que espera una persona no va por el cupo de fondo: la lectura de cierre de un Book (el BookingDetail por
   localizador dentro de la venta) sale por el de dinero, y la consulta manual del panel y la lectura previa a un
   Cancel que pide una persona, por el de ventas (§9.3).
4. **Ante un 429:** se reduce a la mitad el ritmo de esa cuenta durante 60 s (**INFERIDO**) y se emite una
   métrica. Las lecturas se reintentan según §10.4. Book y Cancel, nunca.
5. **Saturación local en Search:** si el limitador no puede despachar un lote dentro del presupuesto de la
   búsqueda, ese lote se marca como degradado en el resultado (degradación visible, RNF-13 de Sabre) en lugar de
   encolarse más allá del timeout.
6. El estado vive en memoria mientras haya un solo contenedor de API, igual que el breaker
   (`apps/api/src/search/circuit-breaker.service.ts:25-26`). Cuando se escale, pasa a Redis **a través de un port**
   de `packages/core/src/ports/`, nunca importando `redis` directamente (`CLAUDE.md`). El `CachePort` actual solo
   tiene `get`/`set`/`delete`/`invalidatePattern` (`packages/core/src/ports/cache.port.ts:1-6`), sin operaciones
   atómicas: un limitador compartido necesita ampliar ese port o uno nuevo.

---

## 8. Modelo de respuesta y códigos `Status.Code`

### 8.1 Dónde viaja el código

- Todas las respuestas documentadas, salvo la de `hotelcodelist`, llevan un objeto `Status` con `Code` (Integer,
  "Internal code to denote response status") y `Description` (String, "Descriptive message.") (p. 13 en Search; p. 42 en Cancel). **VERIFICADO-PDF.**
- **Excepción: `hotelcodelist`.** Su tabla de respuesta solo lista `Hotel Codes` y su ejemplo es
  `{ "HotelCodes": [1000000, …] }`, sin `Status` (p. 55). **VERIFICADO-PDF.** Si la respuesta real es así, la regla
  "2xx sin `Status` → `MALFORMED_RESPONSE`" (§8.4, §10.3) rechazaría un éxito: esa operación necesita una excepción
  explícita en `TBO_OPERATIONS` (envelope opcional y validación solo por su esquema Zod). **Ambigüedad** → [Q-61](./10-preguntas-para-tbo.md#q-61) (H-22).
- Los identificadores `SUCCESS`, `NO_AVAILABILITY`, etc., son **etiquetas de la documentación**: no aparecen en
  ningún JSON de ejemplo (búsqueda en todo el texto del PDF; solo están en la tabla de pp. 8-10). **VERIFICADO-PDF.**
- **No se documenta si el HTTP status de transporte coincide con `Status.Code`.** Varios códigos (201, 207, 300,
  315, 479) no tienen sentido como HTTP de error, y otros coinciden con códigos HTTP de significado distinto (402
  "Payment Required", 405 "Method Not Allowed"). **VERIFICADO-PDF** (tabla) + **INFERIDO** (el choque) → [Q-07](./10-preguntas-para-tbo.md#q-07).

Ejemplo de error, el único del PDF, de Search (p. 18, JSON válido):

```json
{ "Status": { "Code": 201, "Description": "No Available rooms for given criteria" } }
```

Ejemplo de éxito de Cancel (p. 42, JSON válido):

```json
{ "Status": { "Code": 200, "Description": "Cancelled" }, "ConfirmationNumber": "FL1IMA" }
```

### 8.2 Tabla del contrato (literal, pp. 8-10)

| Response Status        | Status Code | Description                                          | Remarks                                                                                                                                                                                                                                                                                                                                              |
| ---------------------- | ----------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUCCESS`              | `200`       | Successful                                           | "This should be returned by all successful response, which indicates:" Availability Check: Hotel is valid, and rooms are available for the given search criteria. · Allotment check: The given room with rate plan that user wants to book is still available. · Booking Check: Booking is Confirmed or Voucher · Cancel Check: Booking is Cancelled |
| `NO_AVAILABILITY`      | `201`       | No Availability                                      | No available rooms for given criteria.                                                                                                                                                                                                                                                                                                               |
| `RATE_UNAVAILABLE`     | `207`       | Given rate is not Available for booking anymore.     | Given rate is not Available for booking anymore.                                                                                                                                                                                                                                                                                                     |
| `BOOKING_FAIL`         | `405`       | Booking Failed                                       | Cannot create booking                                                                                                                                                                                                                                                                                                                                |
| `CANCEL_FAIL`          | `479`       | Cancel Failed                                        | Cannot cancel booking                                                                                                                                                                                                                                                                                                                                |
| `UNAUTHORIZED`         | `401`       | Access Credentials is incorrect                      | Please check the credentials to access API feeds                                                                                                                                                                                                                                                                                                     |
| `INVALID_REQUEST`      | `400`       | Invalid Request                                      | When any parameter/value passed in the request is incorrect                                                                                                                                                                                                                                                                                          |
| `UNEXPECTED_ERROR`     | `500`       | Unexpected Error                                     | Any undefined error returned. Please send complete logs (JSON request and response) at apisupport@tboholidays.com for clarification.                                                                                                                                                                                                                 |
| `LIMIT_EXCEEDED`       | `429`       | QPS Exceeded                                         | Requests have exceeded allowed QPS.                                                                                                                                                                                                                                                                                                                  |
| `BOOKINGCODE_EXPIRED`  | `315`       | Session Expired                                      | Session expired between search to book.                                                                                                                                                                                                                                                                                                              |
| `INSUFFICIENT_BALANCE` | `300`       | Agency has Insufficient Funds for requested booking. | Agency does not have sufficient funds for the requested booking.                                                                                                                                                                                                                                                                                     |
| `AGENT_BLOCKED`        | `402`       | Agency blocked at TBO end.                           | _(vacío)_                                                                                                                                                                                                                                                                                                                                            |

**VERIFICADO-PDF**, con las tres páginas leídas visualmente. Son exactamente 12 códigos, en el orden del PDF.

### 8.3 Política por código

Notas sobre las columnas:

- **`kind`** es el valor de `failure.kind` en `TboApiError` (§9).
- **Breaker**: `COUNT` suma al circuito global de `tbo-hotels`; `IGNORE` no cuenta; `OPEN_ACCOUNT` abre solo el
  circuito de la cuenta resuelta (§12).
- **Reintento** es lo que hace el cliente sin intervención humana. En `/Book` y `/Cancel` es siempre "no",
  cualquiera que sea el código (§10.4).
- **HTTP al front** es el estado que devuelve nuestra API.
- Los mensajes al vendedor siguen la convención del repo (español con voseo, sin eco del proveedor, ruta del panel
  "Mi Red → Credenciales"), igual que `apps/api/src/hotels/despegar-hotels-errors.ts:26-53` (no `:56-58`, que sí
  hace eco del proveedor, §8.6) y
  `apps/api/src/providers-sabre/sabre-errors.ts:41-59`. Si la credencial es heredada, el mensaje apunta al
  consolidador (§9.4).

| `Status.Code` | Etiqueta               | ¿Error o resultado?                                                                                                            | `kind`                              | Breaker                                                 | Reintento                                                                                                                        | HTTP al front                                                       | Mensaje al vendedor                                                                                                                                                                                                                                                                                                                                 |
| ------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `200`         | `SUCCESS`              | Resultado: éxito. Todavía falta validar el cuerpo con Zod en el mapper de la operación                                         | —                                   | Cuenta como éxito y cierra el circuito                  | —                                                                                                                                | 200                                                                 | —                                                                                                                                                                                                                                                                                                                                                   |
| `201`         | `NO_AVAILABILITY`      | **Search:** resultado de negocio. Se devuelve una lista vacía y **no se lanza** error. **Otras operaciones:** error de negocio | `NO_AVAILABILITY` (fuera de Search) | Search: éxito. Resto: `IGNORE`                          | No                                                                                                                               | Search: 200 con lista vacía. Resto: 409                             | Search (estado vacío): "TBO no tiene habitaciones disponibles para estas fechas y ocupación." Resto: "La habitación elegida ya no tiene disponibilidad en TBO. Volvé a buscar para ver opciones actualizadas."                                                                                                                                      |
| `207`         | `RATE_UNAVAILABLE`     | Error de negocio                                                                                                               | `RATE_UNAVAILABLE`                  | `IGNORE`                                                | No (el vendedor vuelve a buscar)                                                                                                 | 409                                                                 | "Esta tarifa ya no está disponible en TBO. Volvé a buscar para ver precios actualizados."                                                                                                                                                                                                                                                           |
| `315`         | `BOOKINGCODE_EXPIRED`  | Error de negocio                                                                                                               | `OFFER_EXPIRED`                     | `IGNORE`                                                | No (el vendedor vuelve a buscar)                                                                                                 | 409                                                                 | "La cotización venció: TBO la mantiene 30 minutos desde la búsqueda. Volvé a buscar para reservar."                                                                                                                                                                                                                                                 |
| `300`         | `INSUFFICIENT_BALANCE` | Error de negocio **de la cuenta**, no una caída                                                                                | `INSUFFICIENT_BALANCE`              | `IGNORE`, con aviso al dueño de la credencial           | No                                                                                                                               | 409                                                                 | Propia: "La cuenta de TBO de tu agencia no tiene saldo o crédito suficiente para esta reserva. Cargá saldo en TBO o elegí otra tarifa." Heredada: "La cuenta de TBO del consolidador no tiene saldo suficiente para esta reserva. Avisale al consolidador."                                                                                         |
| `402`         | `AGENT_BLOCKED`        | Error **de la cuenta**                                                                                                         | `ACCOUNT_BLOCKED`                   | `OPEN_ACCOUNT`, con aviso al dueño y al operador        | No                                                                                                                               | 502                                                                 | Propia: "TBO tiene bloqueada la cuenta de tu agencia. No se pueden consultar ni reservar hoteles de TBO hasta que TBO la habilite; contactá a tu ejecutivo de TBO." Heredada: "TBO tiene bloqueada la cuenta del consolidador. Avisale al consolidador."                                                                                            |
| `401`         | `UNAUTHORIZED`         | Error de configuración de la cuenta                                                                                            | `CREDENTIALS_INVALID`               | `OPEN_ACCOUNT`, con aviso al dueño                      | No (Basic no tiene reautenticación)                                                                                              | 502                                                                 | Propia: "TBO rechazó el usuario o la contraseña de tu agencia. Verificalos en Mi Red → Credenciales → TBO Hoteles." Heredada: "TBO rechazó las credenciales que tu agencia hereda del consolidador. Avisale al consolidador para que las revise." Plataforma: "El acceso de la plataforma a TBO fue rechazado. Ya quedó registrado para el equipo." |
| `400`         | `INVALID_REQUEST`      | Error: bug nuestro o dato que no validamos                                                                                     | `CLIENT_BUG`                        | `IGNORE`, con alerta al operador                        | No                                                                                                                               | 502                                                                 | "No pudimos armar la consulta a TBO con estos datos. Ya quedó registrado; revisá fechas y ocupación y probá de nuevo."                                                                                                                                                                                                                              |
| `405`         | `BOOKING_FAIL`         | Error de negocio del Book                                                                                                      | `BOOKING_FAILED`                    | `IGNORE`                                                | **Nunca.** Se reconcilia con BookingDetail ([03](./03-prebook-y-book.md))                                                        | 502 (el Book es asíncrono y el front lo ve como estado de la orden) | "TBO no pudo crear la reserva. Estamos verificando que no haya quedado registrada; no la repitas hasta ver el resultado."                                                                                                                                                                                                                           |
| `479`         | `CANCEL_FAIL`          | Error de negocio del Cancel                                                                                                    | `CANCEL_FAILED`                     | `IGNORE`                                                | **Nunca.** Se consulta BookingDetail para registrar el estado real ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md)) | 502                                                                 | "TBO no pudo cancelar la reserva. Revisá su estado en el detalle antes de volver a intentar; si sigue activa, contactá a soporte."                                                                                                                                                                                                                  |
| `429`         | `LIMIT_EXCEEDED`       | Error de capacidad                                                                                                             | `THROTTLED`                         | `IGNORE`: se lo pasa al limitador (§7.2), no al breaker | Lecturas: sí (§10.4). Book y Cancel: nunca                                                                                       | 503                                                                 | "TBO está limitando la cantidad de consultas. Probá de nuevo en unos segundos."                                                                                                                                                                                                                                                                     |
| `500`         | `UNEXPECTED_ERROR`     | Error del proveedor                                                                                                            | `UPSTREAM`                          | `COUNT`                                                 | Lecturas: sí (§10.4). Book y Cancel: nunca, el estado queda `UNVERIFIED`                                                         | 502                                                                 | "TBO tuvo un problema interno. Probá de nuevo en unos minutos." Además, se guardan RQ y RS para soporte (§11.2), porque p. 9 exige "complete logs"                                                                                                                                                                                                  |

Toda la columna "¿Error o resultado?" y las siguientes son **Postura** apoyada en la tabla del contrato. El reparto
de códigos por método (405 en Book, 479 en Cancel, etc.) es **INFERIDO**: el PDF no dice qué códigos devuelve
cada método → [Q-08](./10-preguntas-para-tbo.md#q-08). La única excepción es el 201 en Search, que sí tiene ejemplo (p. 18,
**VERIFICADO-PDF**).

### 8.4 Resultados que no están en la tabla

| Situación                                                                                                                                    | `kind`                                                          | Breaker                                    | Reintento                                                                | HTTP al front                          | Mensaje al vendedor                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Sin respuesta: red, DNS, conexión rechazada o timeout local (`status = 0`)                                                                   | `TRANSPORT`                                                     | `COUNT`                                    | Lecturas según §10.4. Book y Cancel: nunca, el estado queda `UNVERIFIED` | 502                                    | "No pudimos conectar con TBO. Probá de nuevo en unos segundos." (en Book: ver fila `UNVERIFIED` más abajo)                        |
| HTTP no-2xx **con** envelope válido (`Status.Code` ≠ 200)                                                                                    | Según el código del cuerpo (§8.3)                               | Según el código                            | Según el código                                                          | Según el código                        | Según el código                                                                                                                   |
| HTTP no-2xx con `Status.Code` = 200 en el cuerpo                                                                                             | `MALFORMED_RESPONSE` (el transporte y el cuerpo se contradicen) | `COUNT`                                    | Como `UPSTREAM`                                                          | 502                                    | "TBO devolvió una respuesta que no pudimos interpretar. Ya quedó registrado para el equipo."                                      |
| HTTP 401 o 403 sin envelope                                                                                                                  | `CREDENTIALS_INVALID`                                           | `OPEN_ACCOUNT`                             | No                                                                       | 502                                    | Igual que 401 en §8.3                                                                                                             |
| HTTP 404 o 405 sin envelope                                                                                                                  | `CLIENT_BUG` (path o verbo, §3.2)                               | `IGNORE`, con alerta al operador           | No                                                                       | 502                                    | Igual que 400 en §8.3                                                                                                             |
| HTTP 429 sin envelope                                                                                                                        | `THROTTLED`                                                     | `IGNORE`                                   | Como 429                                                                 | 503                                    | Igual que 429 en §8.3                                                                                                             |
| HTTP 408, 5xx sin envelope                                                                                                                   | `UPSTREAM`                                                      | `COUNT`                                    | Como 500                                                                 | 502                                    | Igual que 500 en §8.3                                                                                                             |
| HTTP 3xx (con `redirect: 'manual'`) u otro 4xx sin envelope                                                                                  | `CLIENT_BUG`                                                    | `IGNORE`, con alerta al operador           | No                                                                       | 502                                    | Igual que 400 en §8.3                                                                                                             |
| HTTP 2xx con cuerpo vacío                                                                                                                    | `MALFORMED_RESPONSE`                                            | `COUNT`                                    | Como `UPSTREAM`                                                          | 502                                    | Igual que la fila de contradicción                                                                                                |
| HTTP 2xx con cuerpo que no es JSON (por ejemplo, la página HTML de un proxy)                                                                 | `MALFORMED_RESPONSE`                                            | `COUNT`                                    | Como `UPSTREAM`                                                          | 502                                    | Igual                                                                                                                             |
| HTTP 2xx con JSON sin `Status` (salvo en `hotelcodelist`, §8.1), o con `Code` que no es número ni string de 3 dígitos                        | `MALFORMED_RESPONSE`                                            | `COUNT`                                    | Como `UPSTREAM`                                                          | 502                                    | Igual                                                                                                                             |
| `Status.Code` fuera de la tabla de §8.2                                                                                                      | `UNKNOWN_CODE`                                                  | `IGNORE`, con alerta al operador y métrica | No                                                                       | 502                                    | "TBO devolvió un estado que no reconocemos. Ya quedó registrado para el equipo."                                                  |
| `Status.Code` = 200, pero el cuerpo no pasa el esquema Zod de la operación                                                                   | `TboResponseMappingError` (otra clase, §9.1)                    | `IGNORE`, con alerta al operador           | No                                                                       | 502                                    | "TBO devolvió una respuesta que no pudimos interpretar. Ya quedó registrado para el equipo."                                      |
| Book sin respuesta cierta: `TRANSPORT`, `UPSTREAM`, `THROTTLED`, `MALFORMED_RESPONSE`, `UNKNOWN_CODE`, `405`, o 200 sin `ConfirmationNumber` | El `kind` que corresponda; la saga marca `UNVERIFIED`           | Según el `kind`                            | **Nunca**                                                                | La orden queda en estado "verificando" | "No recibimos la confirmación de TBO. Estamos verificando si la reserva quedó hecha; no la repitas. Te avisamos en unos minutos." |

**Postura** en toda la tabla. La regla de fondo es la misma que Sabre aprendió en su integración: "`res.ok` no
significa éxito" (`docs/sabre/10-requisitos-maestro.md` RNF-03). En TBO, además, **un 200 de transporte no
significa nada** hasta leer `Status.Code`.

### 8.5 Particularidades por operación

- **Search, 201**: el único código que se trata como resultado vacío y no como error. Si un Search con N
  `HotelCodes` devuelve 201 cuando ninguno tiene disponibilidad, u omite los hoteles sin disponibilidad dentro de
  un 200, se trata en [02](./02-search-y-oferta-canonica.md).
- **Book**: dos desenlaces para todo Book que no termine en `200` con `ConfirmationNumber`
  ([08](./08-requisitos-maestro.md) RF-20 CA-2 y RF-21):

  - `FAILED` definitivo para los códigos de precondición `400`, `401`, `402`, `300`, `315`, `207` y `201`: la orden
    pasa a `failed`, se libera la clave y no hay `BookingDetail` obligatorio. La conciliación diaria por fecha
    ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §9) cubre el caso improbable de que TBO haya creado
    la reserva igual;
  - `UNVERIFIED` para todo lo demás, incluido el `405`, porque la nota de p. 42 habla de "failure" sin definirla: se
    aplica la recuperación con `BookingDetail` a +120 s.

  Qué códigos del Book garantizan que la reserva **no** se creó → [Q-36](./10-preguntas-para-tbo.md#q-36). Detalle en
  [03](./03-prebook-y-book.md) §3.9.

- **Cancel, 479**: "Cannot cancel booking" (p. 9) se toma como rechazo definitivo, pero igual se consulta
  BookingDetail, porque existen estados intermedios de cancelación (`CancellationInProgress`, p. 70;
  `CancelPending`, `CxlRequestSentToHotel` y `CancelledAndRefundAwaited`, p. 71; enum `Booking Status`) ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md)).
- **200 con semántica distinta según el método**: Availability, Allotment, Booking y Cancel check (pp. 8-9). El
  mapper de cada operación valida con Zod que el 200 traiga lo que esa operación promete. Por ejemplo, un Book 200
  sin `ConfirmationNumber` es incierto, no un éxito.

### 8.6 `Status.Description` no es parte del contrato

- Los textos de los ejemplos no siempre coinciden con los de la tabla: `"No Available rooms for given criteria"`
  (p. 18) frente a "No Availability" (p. 9); `"Cancelled"` en un Cancel 200 (p. 42); `"Success"` en CountryList,
  CityList y TBOHotelCodeList (pp. 52, 54, 67); `"HotelBookingDetailBasedOnDate Successful"` (p. 64). Search,
  PreBook, Book, BookingDetail y HotelDetails sí usan el `"Successful"` de la tabla (pp. 15, 24, 41, 49, 59).
  **VERIFICADO-PDF.**
- **Postura:** ninguna rama del código compara `Description`. No se muestra al vendedor, a diferencia de Despegar,
  que devuelve hasta 160 caracteres del proveedor (`apps/api/src/hotels/despegar-hotels-errors.ts:56-58`). Tampoco
  se loguea en las operaciones cuyo request lleva datos personales (§11.1).

---

## 9. Errores tipados del ACL

### 9.1 Una clase con `kind` y cuatro clases fuera del cable

| Clase                        | Cuándo se lanza                                                                                                                                                                                    | ¿Tocó a TBO?                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `TboApiError`                | Cualquier desenlace que no sea éxito tras intentar la llamada: transporte, envelope inválido o `Status.Code` distinto de éxito (§8.3, §8.4)                                                        | Sí, o se intentó             |
| `TboConfigError`             | Configuración inválida según Zod (URL, entorno, `http` no permitido, §2.2). El mensaje lleva `ruta:código`, nunca valores                                                                          | No                           |
| `TboCredentialsMissingError` | Faltan `username` o `password` en la última puerta del cliente (§1.3). Lleva nombres de campo                                                                                                      | No                           |
| `TboRequestBuildError`       | El body de salida no pasa el esquema Zod de la operación, o viola la guarda D1 (`PaymentMode` distinto de `Limit`, claves de tarjeta: §10.5)                                                       | No: se corta antes del cable |
| `TboOfferExpiredError`       | Vencimiento local de la ventana de 30 minutos (§6.3)                                                                                                                                               | No                           |
| `TboResponseMappingError`    | `Status.Code` 200, pero el cuerpo no cumple el esquema Zod de la operación. Lleva `ruta:código` de los issues, sin valores. En `/Cancel` tiene que ser una subclase `TboCancelMappingError` (§9.3) | Sí                           |

El paquete lanza además dos clases que esta tabla no nombra, y las dos importan por cómo las lee el clasificador de
§9.3 (VERIFICADO-CODIGO al 2026-09-27): `TboCancelOutcomeUnknownError` (HARD-1), un `TboApiError` para todo desenlace
de `/Cancel` distinto de `200` y `479` salvo los que no se pueden leer, que son `TboCancelMappingError`; y
`TboDispatchRejectedError`, la llamada que el limitador de la cuenta no despachó (§7.2 punto 5), que existe desde el
primer commit del paquete y lleva `sentToProvider: false` desde `34ef9f4`. La lista completa es `TBO_ERROR_CLASSES` en
`providers/tbo-hotels/src/errors.ts`.

Justificación del diseño:

- **`kind` en lugar de una subclase por código.** Sabre llegó a 21 clases lanzadas y tuvo que centralizarlas en
  `SABRE_THROWN_CLASSES` porque "una clase que faltara en el decorador no da un error de compilación, da un 500"
  (`apps/api/src/providers-sabre/sabre-exception.filter.ts:16-21`,
  `apps/api/src/providers-sabre/sabre-errors.ts:140-162`). Con un `kind` cerrado y un `Record<TboFailureKind, …>`
  completo, añadir un `kind` rompe la compilación del humanizador, que es la técnica de
  `apps/api/src/providers-sabre/sabre-errors.ts:65-68`. **VERIFICADO-CODIGO** (precedentes).
- **Clases aparte solo para lo que no vino de TBO**, o vino y no se pudo leer. El filtro y el humanizador las
  distinguen con `instanceof`, sin mirar strings.
- **`TboApiError` no lleva el cuerpo.** `DespegarApiError` guarda `body` y lo pone en `message` (300 caracteres,
  `providers/despegar-hotels/src/http/despegar-http.client.ts:3-12`). `SabreApiError` lo redacta en el constructor
  (`providers/sabre/src/errors.ts:542-548`). Para TBO no hace falta ninguna de las dos cosas: la clasificación sale
  de `Status.Code`, un entero, así que el cuerpo no tiene que viajar con la excepción. Si hay que investigar, el
  RQ/RS está en la bóveda de payloads (§11.2), localizable por `requestId`.

### 9.2 Forma propuesta

```ts
// providers/tbo-hotels/src/errors.ts — PROPUESTA
export type TboFailureKind =
  | 'TRANSPORT'
  | 'MALFORMED_RESPONSE'
  | 'UNKNOWN_CODE'
  | 'CLIENT_BUG'
  | 'CREDENTIALS_INVALID'
  | 'ACCOUNT_BLOCKED'
  | 'INSUFFICIENT_BALANCE'
  | 'THROTTLED'
  | 'UPSTREAM'
  | 'NO_AVAILABILITY'
  | 'RATE_UNAVAILABLE'
  | 'OFFER_EXPIRED'
  | 'BOOKING_FAILED'
  | 'CANCEL_FAILED';

export interface TboFailureClass {
  readonly kind: TboFailureKind;
  /** NATURALEZA del fallo. No es permiso para repetir una escritura: eso lo decide TBO_OPERATIONS. */
  readonly retry: 'NO_RETRY' | 'RETRY_BACKOFF';
  readonly circuit: 'COUNT' | 'IGNORE' | 'OPEN_ACCOUNT';
  readonly notifyAccountOwner: boolean; // 401, 402, 300
  readonly operatorAlert: boolean; // 400, 404/405, 3xx, UNKNOWN_CODE, MALFORMED_RESPONSE
}

export class TboApiError extends Error {
  constructor(
    readonly status: number, // HTTP de transporte; 0 = sin respuesta
    readonly tboCode: number | undefined, // Status.Code del cuerpo, si lo hubo
    readonly path: string, // constante de TBO_OPERATIONS, sin query
    readonly failure: TboFailureClass,
    readonly requestId: string,
    readonly timedOut: boolean = false,
  ) {
    super(`TBO ${path} http=${status} code=${tboCode ?? '-'} [${failure.kind}]`);
    this.name = 'TboApiError';
  }
  get retryable(): boolean {
    return this.failure.retry !== 'NO_RETRY';
  }
  /** Solo campos de la lista blanca de §11.1. Nunca body, headers ni Description. */
  toLogMeta(): Record<string, unknown> {
    /* … */
  }
}
```

- `message` solo contiene vocabulario nuestro: path constante, dos enteros y `kind`. Aunque un error llegue al
  `AllExceptionsFilter`, que loguea `exception.message` (`apps/api/src/all-exceptions.filter.ts:31-41`), no filtra
  nada. **VERIFICADO-CODIGO** (comportamiento del filtro global).
- `status` y `tboCode` van en campos separados. Si se mezclaran en un único `status`, un `200` con `Code: 405`
  sería indistinguible de un HTTP 405 por verbo equivocado (§8.1).

### 9.3 Compatibilidad con el clasificador genérico de cancelaciones

`classifyCancelThrownFailure` decide sin conocer al proveedor. Lee `name`, `path`, `status`, `retryable`,
`failure.kind`, `failure.retry` y `sentToProvider` (`apps/api/src/orders/cancel-retry-policy.ts:25-39`, `:95`), y la
usa `orders.service.ts` (`apps/api/src/orders/orders.service.ts:1117`, `:1248`, `:1464`, `:1592`, `:1689`). Las reglas
van en este orden y decide la primera que casa (**VERIFICADO-CODIGO** en la rama `feat/tbo-hotels` al 2026-09-27):

1. `sentToProvider: false` → `FAILED` reintentable, `pre-write-transient` (`:103-110`). Es la marca de lo que se
   cortó antes del cable y puede repetirse tal cual.
2. Nombre terminado en `Cancel(Booking)?(Mapping|OutcomeUnknown)Error` (`CANCEL_OUTCOME_UNKNOWN_ERROR`, `:48`) →
   `UNVERIFIED` con reconciliación (`:112-119`). Va antes que la regla 3 porque "no reintentar" no es "no se canceló".
3. Determinista → `FAILED` sin reintento (`:121-128`): nombre terminado en `BuildError`, `ConfigError`,
   `MappingError`, `RejectedError`… (`:49-50`), `retryable: false` o `failure.retry: 'NO_RETRY'` (`:77`), un
   `failure.kind` del conjunto de `:52-59`, o un HTTP 4xx que no sea 408, 425 ni 429 (`:85`).
4. `path` que casa con `CANCEL_WRITE_PATH` (`:41`, flag `i`) → `UNVERIFIED` (`:133-140`).
5. `path` conocido y fallo transitorio → `FAILED` reintentable (`:144-151`).
6. Todo lo demás → `UNVERIFIED` (`:153-158`).

La tabla dice qué lanza el ACL de TBO en cada caso y cómo lo clasifica la política, después del endurecimiento HARD-1
(2026-09-26) y del arreglo del limitador (commit `34ef9f4`), los dos descritos en
[04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §4.3 y §14. La clase la eligen el mapper de Cancel
(`providers/tbo-hotels/src/cancel/response.mapper.ts:81-106`) y el cliente HTTP (`#resolve` y `#finalError` en
`providers/tbo-hotels/src/http/tbo-http.client.ts`). Solo `200` y `479` son desenlaces que el contrato define para
Cancel (p. 9, 42):

| Caso en `/Cancel`                                                                           | Qué lanza el ACL                                                                                                                                                                                                                                     | Resultado del clasificador                                                                                                                                     | ¿Correcto?                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Timeout o red                                                                               | `TboCancelOutcomeUnknownError` con `status: 0` y `kind TRANSPORT` (`timedOut` si venció): el mapper envuelve el `TboApiError` del cliente con `TboCancelOutcomeUnknownError.from`, que conserva `kind`, `status`, `tboCode` y `failure`              | Regla 2 → `UNVERIFIED` con `verify-cancellation`                                                                                                               | Sí. Antes salía por la regla 4, que depende del `path`; el nombre no                                                                                                                                                                                                                                                                              |
| `500` o `429` en el cuerpo, HTTP de error sin envelope, o cuerpo sin `Status` legible       | `TboCancelOutcomeUnknownError` con el `kind` de lo que pasó (`UPSTREAM`, `THROTTLED`; `MALFORMED_RESPONSE` si no hay `Status` legible). El cliente no reintenta: `/Cancel` va con un intento (§10.4)                                                 | Regla 2 → `UNVERIFIED`                                                                                                                                         | Sí. Un `429` probablemente no se procesó, pero TBO no lo garantiza → [Q-51](./10-preguntas-para-tbo.md#q-51); la lectura lo cierra en minutos                                                                                                                                                                                                     |
| `401`, `402`, `400` y códigos de otras operaciones (`201`, `207`, `300`, `315`, `405`)      | `TboCancelOutcomeUnknownError` con el `kind` y el `failure` del código (`CREDENTIALS_INVALID`, `ACCOUNT_BLOCKED`, `CLIENT_BUG`…, todos `NO_RETRY`)                                                                                                   | Regla 2, antes que la 3: `UNVERIFIED` pese al `NO_RETRY`. El breaker sigue leyendo `failure.circuit`: un `401` o un `402` suspenden la cuenta (`OPEN_ACCOUNT`) | Sí desde HARD-1. Antes eran `TboApiError` `NO_RETRY` → `FAILED` determinista y sin lectura: si TBO sí había cancelado, la orden volvía a confirmada con la habitación liberada ([08](./08-requisitos-maestro.md) §9 C-04)                                                                                                                         |
| `479`                                                                                       | **No se lanza.** El adapter devuelve `{ success: false, error: 'TBO_CANCEL_FAIL' }` y la lectura posterior de BookingDetail decide ([04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §4.3-§4.4; [08](./08-requisitos-maestro.md) §9 C-05) | `CANCEL_REJECTED_POLICY`: `FAILED` sin reintento. Si la lectura muestra la reserva cancelada o en curso, éxito idempotente                                     | Sí                                                                                                                                                                                                                                                                                                                                                |
| `200` con cuerpo que no pasa Zod, o con un `ConfirmationNumber` sin forma o de otra reserva | `TboCancelMappingError`, del cliente HTTP (esquema) o del mapper (localizador)                                                                                                                                                                       | Regla 2 → `UNVERIFIED`                                                                                                                                         | Sí. Con la clase madre `TboResponseMappingError` habría caído en la regla 3 (sufijo `MappingError`) y cerrado `FAILED` una cancelación que TBO pudo aplicar                                                                                                                                                                                       |
| `Status.Code` desconocido                                                                   | `TboCancelMappingError` con el issue `Status.Code:unknown_code` (`#finalError`)                                                                                                                                                                      | Regla 2 → `UNVERIFIED`                                                                                                                                         | Sí. Como `TboApiError` `UNKNOWN_CODE` (`NO_RETRY`, §10.4) habría sido determinista, y un código que no reconocemos no prueba que la cancelación no se aplicó                                                                                                                                                                                      |
| Rechazo local antes del cable: circuito abierto, kill-switch o limitador sin cupo           | `BreakerRejectionError` (`apps/api/src/search/circuit-breaker.service.ts:106-117`) o `TboDispatchRejectedError` (`providers/tbo-hotels/src/errors.ts`), los dos con `sentToProvider: false`. Vale igual para la lectura previa                       | Regla 1 → `FAILED` reintentable (`pre-write-transient`): se encola en BullMQ, sin conciliar ni escalar                                                         | Sí. El breaker lleva la marca desde PR-0.6 de [09](./09-plan-implementacion.md) y el limitador desde `34ef9f4`. Antes, el rechazo del breaker caía en la regla 6 (`UNVERIFIED` sin que nada saliera) y el del limitador en la 3 por el sufijo `RejectedError`: `FAILED` sin reintento, con la reserva viva y sin camino de la API para cancelarla |

Lo que falla antes de `/Cancel` no llega al write, y por eso no es `UNVERIFIED`:

- **La lectura previa** (`BookingDetail`, `path: '/BookingDetail'`) lanza lo que lance la lectura. Un fallo
  transitorio (red, 5xx, `429`) cae en la regla 5: `FAILED` reintentable y encolado con `jobId`
  `cancel:<orderId>:<operationId>`. Un `401` o un `402` en esa lectura es determinista (regla 3): nada salió hacia
  `/Cancel` y el breaker suspende la cuenta. Un `201`, un `400` o un código desconocido no lanzan: la lectura los
  toma, provisoriamente hasta la sonda PR-05 ([07](./07-certificacion.md) §6.8), como "no encontrada", y el Cancel no
  sale (`TBO_BOOKING_NOT_FOUND`). La lectura previa sale por el cupo `sales` con dos intentos si una persona espera
  (`cancelOrder` y el reintento manual pasan `purpose: 'interactive'`) y por el de fondo con tres si es el reintento
  de BullMQ (§7.2 punto 3).
- **Un localizador sin forma** es `TboRequestBuildError` en `/Cancel` antes de enviar (regla 3, sufijo `BuildError`).

La lectura posterior a un `200` o un `479` hace un solo intento por el cupo de fondo y **nunca lanza**: si fallara con
`path: '/BookingDetail'`, la regla 5 la leería como previa al write y habilitaría un segundo Cancel. Si falla, el
resultado lleva el aviso `POST_CANCEL_READ_FAILED` y el `200` sigue siendo un `200`. Fuera del clasificador quedan
el presupuesto de 45 s de la petición ("Cancelación en curso") y el vencimiento de los claims huérfanos a los 15 min,
en [04](./04-post-venta-detalle-cancelacion-y-conciliacion.md) §14.1.

**Advertencia de diseño:** `retryable` tiene que reflejar la **naturaleza** del fallo, no el permiso para repetir la
escritura. Si se forzara `retryable = false` en los paths de dinero "por seguridad", el clasificador marcaría como
determinista (`:77`) todo lo que no lleve un nombre de la regla 2: un timeout de Cancel lanzado con otra clase saldría
`FAILED` y sin reconciliación, justo el error que existe para evitar. El nombre `TboCancelOutcomeUnknownError` protege
hoy a `/Cancel`, pero no reemplaza esta regla: `failure.retry` también decide los reintentos de las lecturas en el
cliente. La prohibición de repetir Book o Cancel se aplica en el cliente (§10.4) y en la saga, no en este campo.
Para Book, el clasificador equivalente (`FAILED` frente a `UNVERIFIED`) se define en [03](./03-prebook-y-book.md).

### 9.4 Humanizador y filtro en `apps/api`

- `humanizeTboError(err, ctx)` es un `Record<TboFailureKind, …>` completo, con variantes según
  `ctx.credentialSource` (`'own' | 'inherited' | 'env'`, `apps/api/src/providers/provider.types.ts:148`) para 401,
  402 y 300, y según la operación para 201 y para Book. **Nunca** cita `Status.Description` ni texto del proveedor,
  que es la regla de Sabre (`apps/api/src/providers-sabre/sabre-errors.ts:27-39`).
- `TenantProviderFactory.humanizeError(err)` solo recibe el error (`apps/api/src/providers/provider.types.ts:191`),
  así que no puede elegir el mensaje según la credencial sea propia o heredada. Ese ajuste de firma es un seam de
  [06](./06-seams-integracion-repo.md).
- El estado HTTP hacia el front no es siempre 502, igual que `sabreErrorStatus`
  (`apps/api/src/providers-sabre/sabre-errors.ts:179-190`): 409 para `NO_AVAILABILITY`, `RATE_UNAVAILABLE`,
  `OFFER_EXPIRED` e `INSUFFICIENT_BALANCE` (volver a buscar, o no se puede con esa cuenta); 503 para `THROTTLED`; 502
  para el resto. **Postura.**
- Se propone añadir al cuerpo de error un campo máquina (`reason: kind`) para que el front ofrezca "Volver a buscar"
  sin interpretar el texto. Hoy los filtros devuelven solo `statusCode`, `error` y `message`
  (`apps/api/src/hotels/despegar-hotels-exception.filter.ts:24-28`). Seam en [06](./06-seams-integracion-repo.md).
- El filtro loguea `toLogMeta()` y nada más, como Sabre con `SabreApiError` (`apps/api/src/providers-sabre/sabre-exception.filter.ts:58-59`)
  y LATAM, que solo loguea `status path` (`apps/api/src/providers-latam/latam-ndc-exception.filter.ts:22`).

---

## 10. Cliente HTTP `TboHttpClient`

### 10.1 Comparación con los clientes existentes

| Aspecto                | Despegar (`providers/despegar-hotels/src/http/despegar-http.client.ts`)                      | Sabre (`providers/sabre/src/http/sabre-http.client.ts`)                                              | **TBO (propuesta)**                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `fetch`                | Global (`:82`)                                                                               | Inyectable: `SabreHttpDeps.fetch` (`:123-130`, `:158`)                                               | Inyectable: `TboHttpDeps.fetch`                                                              |
| Logger                 | `console.warn` detrás de `DESPEGAR_DEBUG_HTTP` (`:30-36`, `:60`)                             | `LoggerPort` + `logRedacted` (`:2`, `:442-444`)                                                      | `LoggerPort` de `packages/core/src/ports/logger.port.ts:3-9`, con metadatos por lista blanca |
| Auth                   | `x-apikey` (`:39`, `:66`)                                                                    | `Bearer` del token service (`:386-392`)                                                              | `Authorization: Basic`, calculado una vez (§1.2)                                             |
| Timeout                | 15 s fijo; se limpia antes de leer el cuerpo (`:77-92`)                                      | Por request o config; se limpia antes de leer el cuerpo (`:227-252`)                                 | `AbortSignal.timeout` por operación, que cubre el cuerpo (§5.5)                              |
| Criterio de éxito      | `res.ok` (`:93`)                                                                             | `res.ok` + clasificación del sobre (`:260-284`)                                                      | `Status.Code` del cuerpo (§10.3)                                                             |
| 2xx vacío              | Devuelve `{}` (`:94`)                                                                        | Error: `JSON.parse` falla y el payload queda `null` (`:253-270`)                                     | `MALFORMED_RESPONSE`                                                                         |
| 2xx no JSON            | Error con 200 caracteres del cuerpo (`:98`)                                                  | Error sin cuerpo (`:264-270`)                                                                        | `MALFORMED_RESPONSE`, sin cuerpo                                                             |
| Error                  | `DespegarApiError(status, body, path)`, con 300 caracteres del cuerpo en `message` (`:3-12`) | `SabreApiError` con `failure` y cuerpo redactado (`providers/sabre/src/errors.ts:511-556`)           | `TboApiError` con `failure`, sin cuerpo (§9.2)                                               |
| Reintentos             | Ninguno                                                                                      | Solo con `idempotent: true` y fuera de `SABRE_NON_IDEMPOTENT_PATHS`, máximo 3 (`:35-42`, `:180-207`) | Por operación; `/Book` y `/Cancel` nunca (§10.4)                                             |
| Guarda de credenciales | No                                                                                           | `hasUsableSabreCredentials` antes del cable (`:172-176`)                                             | `hasUsableTboCredentials` antes del cable                                                    |
| Correlación            | No                                                                                           | `Conversation-ID` (`:178-179`, `:391`)                                                               | `requestId` propio, solo en logs (§4)                                                        |
| Redirects              | Por defecto de `fetch`                                                                       | Por defecto de `fetch`                                                                               | `redirect: 'manual'` (§2.2)                                                                  |

Todo **VERIFICADO-CODIGO**, salvo la columna TBO, que es propuesta.

### 10.2 Tabla de operaciones

```ts
// providers/tbo-hotels/src/http/operations.ts — PROPUESTA
export const TBO_OPERATIONS = {
  search: {
    path: '/Search',
    method: 'POST',
    timeoutMs: /* ResponseTime+3s */ 13_000,
    money: false,
    maxAttempts: 2,
  },
  prebook: { path: '/PreBook', method: 'POST', timeoutMs: 23_000, money: false, maxAttempts: 2 }, // segundo intento solo tras fallo rápido y dentro de 23 s en total
  book: { path: '/Book', method: 'POST', timeoutMs: 120_000, money: true, maxAttempts: 1 },
  bookingDetail: {
    path: '/BookingDetail',
    method: 'POST',
    timeoutMs: 30_000,
    money: false,
    maxAttempts: 3,
  },
  cancel: { path: '/Cancel', method: 'POST', timeoutMs: 60_000, money: true, maxAttempts: 1 },
  // BookingDetailsbasedondate, CountryList (GET), CityList, hotelcodelist (GET), TBOHotelCodeList, HotelDetails: §3.1 y §5.2
} as const;
```

- `money: true` fuerza `maxAttempts: 1` **aunque** alguien edite la tabla. El cliente comprueba, sin distinguir
  mayúsculas, que `/book` y `/cancel` nunca tengan más de un intento, como `isNonIdempotentSabrePath`
  (`providers/sabre/src/http/sabre-http.client.ts:58-61`). Un test de guarda lo fija.
- `maxAttempts` en BookingDetail es para los jobs. La llamada interactiva usa 2 (§5.2).

### 10.3 Algoritmo de `send(op, body)`, con parseo defensivo

1. **Puertas locales**, sin tocar la red: credenciales usables (§1.3), vencimiento (§6.3, lo aplica el adapter),
   esquema Zod de salida y guarda D1 (§10.5), y cupo del limitador (§7.2).
2. `fetch(baseUrl + op.path, { method, headers, body, signal: AbortSignal.timeout(op.timeoutMs), redirect: 'manual' })`.
   Si `fetch` lanza, se lanza `TRANSPORT` (`status 0`, con `timedOut` si fue `TimeoutError` o `AbortError`).
3. Se lee `await res.text()` con la misma señal. Si la lectura falla, `TRANSPORT`.
4. Si el texto no está vacío, se intenta `JSON.parse`. El envelope se localiza buscando `Status`/`Code` **sin
   distinguir mayúsculas**, porque el PDF tiene variantes de casing en nombres de campo (`Hotelcodes`, `fromdate`,
   pp. 56 y 63), y se emite la métrica `tbo.envelope.casing_variant` si hace falta. `Code` se acepta como entero o
   string de 3 dígitos. Cualquier otra forma es inválida.
5. **HTTP 2xx:**
   - cuerpo vacío, no JSON, sin `Status` o con `Code` inválido → `MALFORMED_RESPONSE` (la falta de `Status` no
     aplica a `hotelcodelist`, §8.1);
   - `Code 200` → éxito;
   - `Code 201` en `search` → éxito vacío;
   - código de la tabla → `TboApiError(kind)`;
   - otro código → `UNKNOWN_CODE`.
6. **HTTP no-2xx:**
   - con envelope válido y `Code` distinto de 200 → se clasifica **por el código del cuerpo** y se guarda el HTTP
     en `status`;
   - con envelope y `Code 200` → `MALFORMED_RESPONSE` (contradicción);
   - sin envelope → se clasifica por el HTTP según §8.4.
7. **Reintento:** solo si `failure.retry === 'RETRY_BACKOFF'`, `attempt < op.maxAttempts`, `!op.money`, el fallo
   no fue un timeout en `search` y queda presupuesto. El backoff es exponencial con jitter, con suelo de 500 ms y
   techo de 4 s, tomado del precedente de Sabre (`providers/sabre/src/errors.ts:474-487`). **INFERIDO** para TBO,
   que no publica cifra.
8. Se emiten el log (§11.1) y las métricas en los dos caminos.
9. **Éxito:** se devuelve `{ data: unknown, status, tboCode, durationMs, requestId }`. El cliente **no** tipa
   `data`: el mapper de la operación la valida con Zod (`CLAUDE.md`: Zod en todo borde, incluida la respuesta del
   proveedor). Un fallo ahí es `TboResponseMappingError`. Los tipos crudos no salen del paquete
   ([02](./02-search-y-oferta-canonica.md)).

La respuesta no se exige con `Content-Type` `application/json`: se juzga por el cuerpo. Sí se registran
`contentType` y `bodyBytes` en el log para diagnosticar páginas HTML de proxies.

### 10.4 Reintentos

| Operación                 | Reintentos automáticos     | Cuándo                                                                                                                                            | Nunca                                                                                                             |
| ------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Search                    | 1                          | `THROTTLED`, `UPSTREAM`, `TRANSPORT` sin timeout, siempre que quede presupuesto                                                                   | Tras un timeout; ante cualquier `NO_RETRY`                                                                        |
| PreBook                   | 1                          | `THROTTLED`, `UPSTREAM` o conexión rechazada, si el primer fallo fue rápido y el total no pasa de 23 s ([08](./08-requisitos-maestro.md) §9 C-24) | Tras un timeout: dos intentos de 23 s serían demasiada espera; ante cualquier `NO_RETRY`                          |
| **Book**                  | **0**                      | —                                                                                                                                                 | **Siempre.** La idempotencia por `BookingReferenceId` no está documentada (p. 33) → recuperación a +120 s (p. 42) |
| **Cancel**                | **0**                      | —                                                                                                                                                 | **Siempre.** Una segunda cancelación no se repite sin reconciliar                                                 |
| BookingDetail             | 2 en job, 1 en interactivo | `THROTTLED`, `UPSTREAM`, `TRANSPORT`, `MALFORMED_RESPONSE`                                                                                        | `NO_RETRY`                                                                                                        |
| BookingDetailsbasedondate | 2                          | Igual que BookingDetail                                                                                                                           | `NO_RETRY`                                                                                                        |
| Estáticos                 | 4 (2 en `hotelcodelist`)   | Igual que BookingDetail                                                                                                                           | `NO_RETRY`                                                                                                        |

No se reintenta nunca `CLIENT_BUG`, `CREDENTIALS_INVALID`, `ACCOUNT_BLOCKED`, `INSUFFICIENT_BALANCE`, los códigos de
negocio, `UNKNOWN_CODE` ni `TboResponseMappingError`. La decisión de repetir un **flujo** (buscar de nuevo, un
segundo Book tras conciliar) es de la saga o del vendedor, nunca del cliente HTTP.

### 10.5 Guarda de salida D1 (resumen)

D1, cerrada el 2026-08-26 (`docs/sabre/10-requisitos-maestro.md` §9), establece que nunca manejamos PAN ni CVV.
Para TBO eso significa solo `PaymentMode: "Limit"`. Como última barrera, el cliente rechaza con
`TboRequestBuildError`, **antes del cable**, cualquier body que:

- lleve `PaymentMode` distinto de `Limit`, o
- contenga en cualquier profundidad una clave que, normalizada, empiece por `card`, contenga `cvv`, o sea
  `paymentinfo`.

Motivo: la regla ESLint de D1 compara con claves camelCase exactas (`cardNumber`, `cvv`…) y solo en ficheros
`**/request.builder.ts`, `**/*.request.builder.ts` y `**/*.serializer.ts` (`eslint.config.mjs:50-75`), así que no
detectaría las PascalCase de TBO (`CardNumber`, `CvvNumber`, `PaymentInfo`, p. 33). **VERIFICADO-CODIGO** (regla) y
**VERIFICADO-PDF** (campos). El detalle y el ajuste de la regla están en [03](./03-prebook-y-book.md). Precedentes
de test para la guarda de TBO: `providers/sabre/src/pan-egress.guard.test.ts` (bytes de salida) y
`providers/sabre/src/pan-lint-rule.guard.test.ts`, que ejecuta ESLint real contra la regla y hay que ampliar si se
cambia su glob o su lista.

### 10.6 Dependencias inyectables y tests

- `TboHttpDeps { fetch?, logger?: LoggerPort, metrics?: MetricsPort, now?, sleep?, random?, uuid?, limiter?, payloadVault? }`.
  Las métricas de §11.1 salen por `MetricsPort` (`packages/core/src/ports/metrics.port.ts:1-5`, hoy sin
  implementación en el repo), no por un SDK importado desde el ACL. Con esto
  los tests no necesitan `vi.stubGlobal('fetch', …)`, que es lo que hoy usan los de Despegar
  (`apps/api/src/providers-despegar/despegar-hotels.adapter.test.ts:12`). El logger se adapta al `Logger` de Nest como hace Sabre
  (`apps/api/src/providers-sabre/sabre.factory.ts:527-540`). **VERIFICADO-CODIGO** (precedente).
- Tests mínimos en el paquete, con fixtures JSON colocalizados:
  - cada fila de §8.3 y §8.4, incluido HTTP 200 con `Code` de error y HTTP no-2xx con envelope;
  - el cuerpo que llega lento se corta por timeout;
  - `/Book` y `/Cancel` con un solo intento aunque el error sea `RETRY_BACKOFF`;
  - ni el adapter ni la configuración serializados contienen la contraseña;
  - ninguna línea de log contiene la cabecera `Authorization`, `FirstName`, `EmailId` ni `PhoneNumber` (logger
    espía);
  - la guarda D1;
  - el casing del envelope;
  - `redirect: 'manual'`.

---

## 11. Logging y redacción

### 11.1 Qué se loguea: lista blanca

| Se loguea                                                                                                                                                          | No se loguea nunca                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider: 'tbo-hotels'`, `op`, `path` (constante), `method`, `attempt`, `timeoutMs`, `durationMs`                                                                 | Headers, en particular `Authorization`                                                                                                                                                              |
| `status` (HTTP), `tboCode`, `kind`, `timedOut`, `contentType`, `bodyBytes`                                                                                         | Cuerpos de request y de response, ni siquiera recortados                                                                                                                                            |
| `requestId`, `accountRef` (digest truncado de `ownerTenantId` + `username`, como hace Sabre en RF-01 de `docs/sabre/10-requisitos-maestro.md`), `credentialSource` | `username`, porque es "la mitad de la credencial que acompaña a la contraseña" (el criterio que `apps/api/src/provider-credentials/provider-specs.ts:67-70` aplica al `epr` de Sabre), y `password` |
| En Book, BookingDetail y Cancel: `BookingReferenceId`, `ClientReferenceId`, `ConfirmationNumber` (identificadores operativos, no personales)                       | `FirstName`, `LastName`, `EmailId`, `PhoneNumber`, `CustomerNames`, cualquier `Card*`/`Cvv*`                                                                                                        |
| `Status.Description`, solo en operaciones cuyo request no lleva datos personales (Search, PreBook, estáticos), recortada a 120 caracteres                          | `Status.Description` en Book, BookingDetail, Cancel y BookingDetailsbasedondate: un 400 podría repetir un dato del huésped. **INFERIDO**                                                            |

- Niveles de log: `debug` para éxito; `warn` para errores; `error` para `UNKNOWN_CODE`, `MALFORMED_RESPONSE` y todo
  `UNVERIFIED` en un path de dinero.
- Métricas OpenTelemetry: `tbo.http.requests{op, kind, tbo_code}` y el histograma `tbo.http.duration{op}`. Nunca
  cuerpos (`CLAUDE.md`: logging estructurado con OpenTelemetry, "NUNCA loguear secrets, PAN, tokens, ni PII
  sensible").
- Lo que **no** se repite de Despegar:

  - el filtro que loguea 250 caracteres del cuerpo (`apps/api/src/hotels/despegar-hotels-exception.filter.ts:22`);
  - el `message` con 300 caracteres (`providers/despegar-hotels/src/http/despegar-http.client.ts:9`);
  - el `console.warn` de depuración (`:30-36`), que choca con "Nunca `console.log` en código de producción"
    (`CLAUDE.md`).

  **VERIFICADO-CODIGO.**

### 11.2 Cuerpos completos: la bóveda de payloads

- TBO pide, para `UNEXPECTED_ERROR`, "complete logs (JSON request and response)" (p. 9). La certificación exige
  entregar los RQ/RS de los 8 casos en un zip (Cert, "Integration on Test Account") y "all the JSON logs" en la verificación (Cert, "Certification Process (JSON Verification)").
  **VERIFICADO-PDF / VERIFICADO-CERT.**
- Eso choca con la regla de no loguear datos personales. **Postura:** los cuerpos **no** van al log. Van a un
  almacén separado de payloads del proveedor: cifrado, con retención corta, acceso auditado y consulta por
  `requestId`, escrito por `deps.payloadVault` solo si está configurado. En test/certificación los datos son
  ficticios y se exportan sin redactar. En live, la exportación para un ticket de soporte pasa por la redacción de
  §11.3, salvo que TBO pida el dato real. Es una decisión del founder (§14). El detalle operativo de la
  certificación está en [07](./07-certificacion.md).

### 11.3 Redacción de payloads, solo para exportar desde la bóveda

- Claves que se enmascaran, comparadas tras normalizar (minúsculas y solo alfanuméricos, porque TBO mezcla casing,
  por ejemplo `CardHolderlastName` en pp. 35 y 38): `firstname`, `lastname`, `emailid`, `email`, `phonenumber`,
  `phone`, `addressline1`, `addressline2`, `postalcode`, `cardholderaddress`, y todo lo que empiece por `card` o
  contenga `cvv`. También `tripname`: en la respuesta de BookingDetailsbasedondate su ejemplo es
  `"Sharma_02Dec_Dubai"` (p. 64), que parece llevar el apellido del huésped. **VERIFICADO-PDF** (el ejemplo);
  **INFERIDO** (que contenga datos personales).
- **No sirve importar la redacción de Sabre.** Un ACL no depende de otro, y además su lista no cubre algunas claves
  de TBO: `PII_KEYS` tiene `addressline` exacto (`providers/sabre/src/redaction.ts:147-170`) y los marcadores no
  incluyen `address` ni `postal` (`:194-208`). Así, `AddressLine1`, `PostalCode` y `CardExpirationMonth` quedarían
  sin redactar. **VERIFICADO-CODIGO** (por lectura de las listas). Otra opción es extraer un redactor común a
  `packages/core`. Se evalúa en [06](./06-seams-integracion-repo.md).

---

## 12. Circuit breaker y kill-switch

### 12.1 Estado actual

- `CircuitBreakerService`:
  - mantiene el estado **en memoria**, en una sola instancia (`apps/api/src/search/circuit-breaker.service.ts:25-26`, `:31`);
  - usa como clave un string, que hoy es el `providerCode`;
  - abre con 5 fallos consecutivos y se queda abierto 30 s (`:4`, `:6`);
  - al vencer la ventana pasa a half-open (`:78-79`) y un fallo ahí lo reabre (`:93`). Pese al comentario de `:78`,
    no limita la sonda a una llamada: solo rechaza con `state === 'open'` (`:72`), así que las llamadas concurrentes
    durante la sonda también salen al proveedor.
- Dentro del `catch` (`:90-97`) **cualquier excepción suma un fallo**.
- El kill-switch `PROVIDERS_DISABLED` se compara contra la **misma clave** del circuito (`:34-41`, `:64`).
- En hoteles, solo `searchAvailability` pasa por el breaker (`apps/api/src/hotels/hotels.service.ts:105`).
- `PROVIDERS_DISABLED` no aparece en `infrastructure/` ni en `.github/` (grep), así que **no llega al contenedor de
  producción**.

Todo **VERIFICADO-CODIGO**.

### 12.2 Problemas para TBO

1. **Los resultados de negocio abrirían el circuito.** Cinco 207 o 315 seguidos en PreBook, o cinco 400 por un bug
   nuestro, abrirían TBO para todos. Sabre ya clasificó el efecto de cada fallo (`SabreCircuitEffect`,
   `providers/sabre/src/errors.ts:25-32`), pero `CircuitBreakerService` no lo lee: `grep` de `failure.circuit` en
   `apps/api/src` no devuelve nada. **VERIFICADO-CODIGO.**
2. **La clave por `providerCode` castiga a toda la red.** Un 401 o 402 de la credencial BYOC de una sola agencia
   abriría el circuito de todas. Sabre ya había escrito que el breaker debe ir "por `provider_account` resuelta, no
   por `providerCode`" (`docs/sabre/10-requisitos-maestro.md` RNF-03; `providers/sabre/src/errors.ts:25`).
3. **El kill-switch apaga también la post-venta.** Con `PROVIDERS_DISABLED=tbo-hotels`, si todo pasa por el
   breaker, también se bloquean BookingDetail y Cancel de reservas ya vendidas y no se puede conciliar ni cancelar.
4. **El kill-switch no está cableado en producción** (§12.1).

### 12.3 Postura

1. **Efecto según `failure.circuit`.**
   - `COUNT` suma al circuito global `tbo-hotels`: `TRANSPORT`, `UPSTREAM` y `MALFORMED_RESPONSE`.
   - `IGNORE` no suma.
   - `OPEN_ACCOUNT` abre **solo** el circuito de la cuenta, `tbo-hotels@{accountRef}` (el mismo digest que usa el
     limitador, §7.2 y §11.1; así la clave no expone ids de tenant y una credencial rotada abre un circuito nuevo,
     [08](./08-requisitos-maestro.md) §9 C-16), con una ventana más larga
     (propuesta: 5 min para 401 y 15 min para 402, **INFERIDO**), además de avisar al dueño de la credencial y
     emitir un domain event (`CLAUDE.md`: eventos antes que estado).
   - Requiere que `execute` acepte un predicado o lea `err.failure.circuit`. Seam en
     [06](./06-seams-integracion-repo.md).
   - `GET /health` es `@Public()` y devuelve `breaker.snapshot()` con las claves de circuito tal cual
     (`apps/api/src/health/health.controller.ts:21-22`, `:50`; `circuit-breaker.service.ts:53-57`). Con claves por
     cuenta publicaría, sin autenticar, cuántas cuentas tienen la credencial rechazada o bloqueada, y con una clave
     por `ownerTenantId` publicaría además los ids de tenant. El snapshot público tiene que agregar o excluir los
     circuitos de cuenta.
     **VERIFICADO-CODIGO.**
2. **El kill-switch se evalúa por código de proveedor**, no por la clave del circuito, para que `tbo-hotels` apague
   también los circuitos de cuenta.
3. **Dos niveles de apagado:**

   - "ventas" apaga Search, PreBook y Book;
   - "todo" apaga además BookingDetail, Cancel y la conciliación.

   Con el breaker abierto, las lecturas de conciliación no fallan: el job de BullMQ se **reprograma** con demora.
   Es una decisión del founder (§14).

4. **Todas las llamadas a TBO pasan por el breaker**, no solo la búsqueda. Si el circuito está abierto, un Book falla
   **antes** de salir, y eso es un `FAILED` cierto: la reserva no se creó.
5. El vencimiento local, las puertas de credenciales y la construcción del request (`TboOfferExpiredError`,
   `TboCredentialsMissingError`, `TboRequestBuildError`) **no** pasan por el breaker: no son fallos del proveedor.
6. Cablear el kill-switch en producción (`infrastructure/hostinger/docker-compose.prod.yml` y
   `.github/workflows/deploy.yml`) o moverlo a `provider_catalog.status` o a Unleash. La migración ya reserva
   `'disabled'` como kill-switch (`db/migrations/0035_multi_flight_provider.sql:89-92`), pero ningún código de
   `apps/`, `packages/` ni `providers/` lee `provider_catalog` (grep), y `FeatureFlagsPort`
   (`packages/core/src/ports/feature-flags.port.ts`) no tiene implementación. El precedente más cercano es
   `ProviderFlagsPort` con `EnvProviderFlags` (`apps/api/src/providers/provider.types.ts:305`,
   `apps/api/src/providers/providers.module.ts:28-48`), solo para el `opt-in` de vuelos. Seam en
   [06](./06-seams-integracion-repo.md).
7. En test/certificación los cortes sin aviso son esperables (Cert, nota final): el breaker funciona igual, pero las
   alertas de guardia se silencian cuando `environment === 'test'`.
8. Estado en Redis, a través de un port, cuando haya más de una instancia de API
   (`apps/api/src/search/circuit-breaker.service.ts:25-26`).

---

## 13. Contradicciones y huecos del contrato

| #    | Hueco o contradicción                                                                                  | Evidencia                                              | Postura adoptada                                                                                                                        | ¿Solo TBO lo resuelve?                                                              |
| ---- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| H-01 | "should be secured with HTTPS" frente a una URL de test `http://`                                      | p. 7; Cert, "TBO Hotel API Details"; Postman           | `http` solo en test, con el host conocido y credenciales de test; `https` obligatorio en live; `redirect: 'manual'` (§2.2)              | → [Q-03](./10-preguntas-para-tbo.md#q-03)                                           |
| H-02 | Host live no publicado; path `/HotelAPI` frente a `/TBOHolidays_HotelAPI`                              | p. 7                                                   | `baseUrl` por cuenta, sin valor por defecto en live (§2.3)                                                                              | → [Q-04](./10-preguntas-para-tbo.md#q-04)                                           |
| H-03 | `Method POST` global frente a `GET` en CountryList y hotelcodelist                                     | pp. 7, 51, 55; Postman: `CountryList`                  | Verbo por operación en `TBO_OPERATIONS` (§3.2)                                                                                          | No                                                                                  |
| H-04 | Casing de paths inconsistente                                                                          | pp. 7, 10, 54, 56, 62; Postman                         | Casing del PDF en una sola constante, smoke test en certificación, 404 → `CLIENT_BUG` (§3.2)                                            | → [Q-05](./10-preguntas-para-tbo.md#q-05)                                           |
| H-05 | La tabla de endpoints omite los estáticos y BookingDetailsbasedondate                                  | pp. 7-8                                                | Paths tomados de cada sección (§3.1)                                                                                                    | No                                                                                  |
| H-06 | No se dice si el HTTP de transporte refleja `Status.Code`                                              | pp. 8-10, 13                                           | El cuerpo manda si existe y es válido; se aceptan ambos casos (§10.3)                                                                   | → [Q-07](./10-preguntas-para-tbo.md#q-07)                                           |
| H-07 | No se dice qué códigos devuelve cada método                                                            | pp. 8-10                                               | Cualquier código se acepta en cualquier operación; la política depende de la operación (§8.3, §8.5)                                     | → [Q-08](./10-preguntas-para-tbo.md#q-08)                                           |
| H-08 | `Description` distinta en la tabla y en los ejemplos                                                   | pp. 9, 18, 42, 52, 54, 64, 67                          | No se usa en la lógica ni se muestra al vendedor (§8.6)                                                                                 | No                                                                                  |
| H-09 | `AGENT_BLOCKED` sin "Remarks": alcance desconocido                                                     | p. 10                                                  | Circuito de la cuenta abierto y aviso; post-venta no bloqueada por nuestra parte (§12.3)                                                | → [Q-91](./10-preguntas-para-tbo.md#q-91)                                           |
| H-10 | El único ejemplo de error es el 201 de Search; Postman no trae respuestas                              | p. 18; Postman (`response: []`)                        | Fixtures de errores reales capturados en certificación ([07](./07-certificacion.md))                                                    | No                                                                                  |
| H-11 | Sin timeout para BookingDetail, Cancel, BookingDetailsbasedondate y estáticos                          | p. 8                                                   | Valores propuestos en §5.2                                                                                                              | → [Q-09](./10-preguntas-para-tbo.md#q-09)                                           |
| H-12 | "5-23 Seconds" es un rango, y la semántica de `ResponseTime` no se explica                             | pp. 8, 11                                              | Timeout = `ResponseTime` + 3 s con techo de 23 s; por defecto 10 s (§5.3)                                                               | → [Q-16](./10-preguntas-para-tbo.md#q-16)                                           |
| H-13 | Ventana de 30 min: punto de inicio, si PreBook la renueva, si el Book debe iniciarse o terminar dentro | pp. 8-9                                                | `expiresAt` = envío del Search + 27 min, sin renovación (§6.3)                                                                          | → [Q-29](./10-preguntas-para-tbo.md#q-29)                                           |
| H-14 | Valor del QPS no publicado                                                                             | p. 9                                                   | Limitador por cuenta, 5 QPS / 4 concurrentes configurables, cupo reservado para dinero (§7.2)                                           | → [Q-10](./10-preguntas-para-tbo.md#q-10)                                           |
| H-15 | `UNEXPECTED_ERROR` pide "complete logs" frente a nuestra regla de no loguear datos personales          | p. 9; `CLAUDE.md`                                      | Bóveda de payloads cifrada, separada del log (§11.2)                                                                                    | → [Q-11](./10-preguntas-para-tbo.md#q-11) (si aceptan RQ/RS con datos enmascarados) |
| H-16 | Email de soporte: `apisupport@tboholidays.com` frente a `apisupport@tbo.com`                           | p. 9; Cert, "Integration on Test Account" y nota final | Usar los dos hasta que se confirme                                                                                                      | → [Q-11](./10-preguntas-para-tbo.md#q-11)                                           |
| H-17 | Cortes sin aviso en el entorno de certificación                                                        | Cert, nota final                                       | Breaker normal, sin alertas de guardia en test (§12.3)                                                                                  | No                                                                                  |
| H-18 | Qué desenlaces del Book garantizan que no hubo reserva; qué abarca "failure" en la nota de p. 42       | pp. 9, 42                                              | BookingDetail después de cualquier Book no exitoso; `UNVERIFIED` salvo en códigos de precondición (§8.5)                                | → [Q-36](./10-preguntas-para-tbo.md#q-36)                                           |
| H-19 | Basic Auth: charset, rotación de contraseña, allowlist de IP de origen                                 | p. 7 (por ausencia)                                    | UTF-8, sin `trim`, sin `:` en el usuario (§1.2); IP fija de salida del VPS lista para declarar ([08](./08-requisitos-maestro.md) RC-11) | → [Q-06](./10-preguntas-para-tbo.md#q-06)                                           |
| H-20 | Compresión y cabeceras de correlación no documentadas                                                  | pp. 7-10 (por ausencia)                                | No se envían cabeceras no documentadas (§4)                                                                                             | → [Q-12](./10-preguntas-para-tbo.md#q-12)                                           |
| H-21 | Request de Postman con comentario `//` (JSON inválido)                                                 | Postman: `BookingDetail`                               | El cliente solo emite `JSON.stringify` de objetos validados (§4)                                                                        | No                                                                                  |
| H-22 | La respuesta de ejemplo de `hotelcodelist` no trae `Status` y su tabla tampoco lo lista                | p. 55                                                  | Envelope opcional solo en esa operación; validación por su esquema Zod (§8.1)                                                           | → [Q-61](./10-preguntas-para-tbo.md#q-61)                                           |

---

## 14. Decisiones abiertas para el founder

Se consolidan con opciones en [08](./08-requisitos-maestro.md). La línea base asumida aquí va entre paréntesis.

**Estado al 2026-09-25:** el founder firmó D-TBO-02 (B), D-TBO-03 (A), D-TBO-06 (A) y D-TBO-07 (A) y pidió aplicar
la opción recomendada en todas las demás hasta nuevo aviso; lo que manda es el
[Registro de decisiones](./08-requisitos-maestro.md#registro-de-decisiones) de 08.

1. **Credenciales de test por `http`** mientras TBO no confirme HTTPS (línea base: se aceptan solo en test, con el
   host conocido; en live se prohíbe).
2. **Entorno explícito en la cuenta** (`config.environment`, más `baseUrl` obligatorio en live, sin valor por
   defecto) frente a un valor por defecto al estilo Despegar (línea base: explícito).
3. **Bóveda de payloads** para soporte y certificación (línea base: cifrada, retención corta, acceso auditado)
   frente a no guardar cuerpos.
4. **Circuit breaker por cuenta**, además del global, y efecto según el `kind` (línea base: sí; requiere cambiar
   `CircuitBreakerService`).
5. **Kill-switch en dos niveles** ("ventas" y "todo") y su cableado en producción (línea base: dos niveles; hoy no
   llega al contenedor).
6. **Reacción ante 401 o 402 en una cuenta BYOC:** solo circuito de cuenta y aviso, o también cambiar
   `provider_accounts.status` automáticamente (línea base: no tocar el `status`).
7. **QPS y concurrencia por defecto** mientras TBO no publique el límite (línea base: 5 QPS / 4 concurrentes por
   cuenta, configurable).
8. **`ResponseTime` por defecto de Search** (línea base: 10 s, timeout de 13 s).
9. **Plazo de venta mostrado al vendedor** dentro de los 30 minutos de TBO (línea base: vence a los 27 minutos,
   aviso a los 20).

---

## 15. Preguntas para TBO surgidas en este documento

Las consolida [10-preguntas-para-tbo.md](./10-preguntas-para-tbo.md). En orden de aparición: HTTPS en test y en live
(§2.2); URL live exacta y URL de staging (§2.3); casing y sensibilidad a mayúsculas de los paths (§3.2); relación
entre el HTTP de transporte y `Status.Code` (§8.1); si `hotelcodelist` devuelve `Status` (§8.1, H-22); códigos
posibles por método (§8.3); desenlaces del Book que garantizan que no hubo reserva (§8.5); timeouts de los métodos sin recomendación (§5.2); semántica de
`ResponseTime` (§5.3); semántica de la ventana de 30 minutos (§6.2); valor y alcance del QPS y forma del 429 (§7.1);
alcance de `AGENT_BLOCKED` (H-09); formato de logs aceptado para `UNEXPECTED_ERROR` y email de soporte correcto
(H-15, H-16); charset de Basic, rotación de contraseña y allowlist de IP (§1.2, H-19); compresión y cabecera de
correlación (§4).

---

## Referencias cruzadas

- [00-fuentes.md](./00-fuentes.md): procedencia de PDF, Postman y certificación.
- [02-search-y-oferta-canonica.md](./02-search-y-oferta-canonica.md): `ResponseTime`, lotes de 100 `HotelCodes`,
  `searchSentAt` y `expiresAt` en la oferta.
- [03-prebook-y-book.md](./03-prebook-y-book.md): guarda `Limit`/D1, saga del Book, `FAILED`/`UNVERIFIED` y
  recuperación a +120 s.
- [04-post-venta-detalle-cancelacion-y-conciliacion.md](./04-post-venta-detalle-cancelacion-y-conciliacion.md):
  BookingDetail, Cancel y 479, conciliación.
- [05-contenido-estatico-e-inventario.md](./05-contenido-estatico-e-inventario.md): jobs de sincronización y sus
  timeouts.
- [06-seams-integracion-repo.md](./06-seams-integracion-repo.md): factory, puerta de credenciales, cambios en
  `CircuitBreakerService`, filtro y humanizador, kill-switch.
- [07-certificacion.md](./07-certificacion.md): smoke test de paths, captura de fixtures, zip de RQ/RS.
- [08-requisitos-maestro.md](./08-requisitos-maestro.md): decisiones con opciones.
- [09-plan-implementacion.md](./09-plan-implementacion.md): orden de construcción.
- [10-preguntas-para-tbo.md](./10-preguntas-para-tbo.md): preguntas consolidadas.
