---
titulo: 'Sabre — Autenticación y conectividad'
fecha: 2026-08-25
estado: reconciliado-contra-spec
Fuentes: ver 00-fuentes.md
---

# Sabre — Autenticación y conectividad

> **Cómo leer este documento.** Marcado según la convención de `00-fuentes.md` §4. Esta segunda pasada reconcilia
> el análisis original (hecho sólo sobre la colección Postman) contra los **21 contratos OpenAPI oficiales** y las
> **81 páginas de documentación oficial** de `developer.sabre.com`. Donde el contrato confirma algo que antes era
> `[INFERIDO]` o `DESCONOCIDO`, ahora dice **VERIFICADO-SPEC** con archivo y línea. Donde el contrato **contradice**
> lo que decía la primera pasada, está señalado explícitamente con «**Corrección**».
>
> | Marca                     | Significado                                                                                                                               |
> | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
> | **VERIFICADO**            | Se lee literalmente en un body, header, URL o script de la colección. Se cita la ruta del request.                                        |
> | **VERIFICADO-SPEC**       | Sale del contrato OpenAPI oficial o de la documentación oficial. Se cita archivo:línea.                                                   |
> | **VERIFICADO-POR-SCRIPT** | El script de test de Postman **lee** esa ruta del response. Evidencia fuerte de que el campo existe, pero el body real no está capturado. |
> | **[INFERIDO]**            | Viene de nombres de variables, convención NDC/OTA o conocimiento general. **Hay que verificarlo contra el sandbox.**                      |
> | **DESCONOCIDO**           | No hay forma de saberlo desde las fuentes disponibles. Va a `Preguntas abiertas`.                                                         |

> **Nota de procedencia — corrección a la primera pasada.** La colección trae **4 respuestas guardadas y NO están
> vacías**: pesan **16.479 bytes cada una** y están extraídas en `evidence/responses/*.json`. Las cuatro son de
> `/v1/orders/view` (los únicos 4 requests a ese endpoint en toda la colección — VERIFICADO), y **ninguna es de
> autenticación**, por lo que siguen sin decir nada sobre la forma del response de `/v2/auth/token`. Lo que sí
> aportan es la única evidencia dura de forma de respuesta salida de la colección; se explotan en los documentos de
> modelo de datos, no aquí.

---

## 1. Los dos modos de credencial

Sabre expone **dos mecanismos de credencial que conviven en la misma colección**, nombrados explícitamente en los
títulos de los requests. **VERIFICADO** (conteo por _request_, reproducible — ver Anexo):

| Sufijo en el nombre del request | Nº de requests | Endpoint sobre el que aparece                                          |
| ------------------------------- | -------------- | ---------------------------------------------------------------------- |
| `(Stateless ATK)`               | **89**         | **sólo** `{{rest_endpoint}}/v{3,4,5}/offers/shop` y `/v1/offers/price` |
| `(Stateful ATH)`                | **57**         | **sólo** `{{soap_endpoint}}`                                           |
| `REST Authorize ATK`            | **59**         | `{{rest_endpoint}}/v2/auth/token`                                      |

> **Corrección (hallazgo 1 de la crítica — ACEPTADO).** La primera pasada ponía **26** en la fila
> `REST Authorize ATK`, contradiciendo su propio §2, que decía 59. El conteo correcto es **59**, verificado por dos
> vías independientes: requests cuyo nombre contiene `REST Authorize` = 59, y requests cuya URL contiene
> `/v2/auth/token` = 59. Las otras dos filas (89 y 57) eran correctas. El comando que lo reproduce está en el Anexo.

- **ATK = Application Token**, sin estado. Se obtiene por REST/OAuth2 (`client_credentials`) y se manda como
  `Authorization: Bearer`.
- **ATH = Authenticated Token / sesión**, con estado. Se obtiene abriendo una sesión SOAP (`SessionCreateRQ`) y hay
  que cerrarla (`SessionCloseRQ`). La sesión es un recurso **finito y con cupo** por agencia.

Distribución de transporte en la colección — **VERIFICADO**: **808** requests a `{{rest_endpoint}}`, **243** a
`{{soap_endpoint}}`, **0** a `{{lls_endpoint}}`. Mensajes de sesión: **73** requests `SessionCreateRQ`, **61**
`SessionCloseRQ` (conteo por request, no por ocurrencia de string).

### 1.1 El hallazgo clave: el token es _el mismo campo_ para REST y para SOAP — y ahora está en el contrato

La colección define auth **a nivel colección** (no por request) — **VERIFICADO**, raíz del `.json`:

```json
"auth": { "type": "bearer", "bearer": [ { "key": "token", "value": "{{token}}", "type": "string" } ] }
```

Y el mismo `{{token}}` se inyecta en el sobre SOAP como `BinarySecurityToken` — **VERIFICADO**, script pre-request
de colección:

```js
const header = `<SOAP-ENV:Envelope ...><SOAP-ENV:Header>
  <MessageHeader xmlns="http://www.ebxml.org/namespaces/messageHeader">
    <From><PartyId>Agency</PartyId></From><To><PartyId>SWS</PartyId></To>
    <ConversationId>2021.01.DevStudio</ConversationId><Action>${action}</Action>
  </MessageHeader>
  <Security xmlns="http://schemas.xmlsoap.org/ws/2002/12/secext">
    <BinarySecurityToken EncodingType="Base64Binary" valueType="String">${token}</BinarySecurityToken>
  </Security>
</SOAP-ENV:Header><SOAP-ENV:Body>`;
```

La primera pasada lo dedujo de la estructura. **Ahora está escrito en la documentación oficial**, literalmente, en
las siete páginas de Booking Management — **VERIFICADO-SPEC**:

> «_This API is designed to operate in a stateless way, and accepts both sessionless (ATK) and session-based (ATH)
> tokens. When a call is made to this API via a session-based token, the session (AAA) is cleared before and after
> execution._»
> — `help/booking-management-api-v1/help-documentation-create-booking.txt:28`; idéntico en
> `help-documentation-get-booking.txt:14`, `help-documentation-cancel-booking.txt:11`,
> `help-documentation-modify-booking-0.txt:28`, `help-documentation-fulfill-flight-tickets.txt:16`,
> `help-documentation-void-flight-tickets.txt:11`, `help-documentation-refund-flight-tickets.txt:11`.

**Confirma** que ATK y ATH son intercambiables como material de credencial en el carril REST. Pero añade una
cláusula que la primera pasada no tenía y que es **crítica para el diseño del pool de sesiones**:

> **La sesión (AAA) se limpia antes Y después de cada llamada REST de Booking Management.**
> Es decir: **no se puede usar una sesión ATH para acumular estado a lo largo de varias llamadas REST**. Si mandas
> un ATH a `createBooking`, Sabre limpia el área AAA al entrar y al salir. El token sigue vivo, pero cualquier
> contexto que hubieras dejado en la sesión (un PNR en curso, un cambio de PCC previo) se pierde. Ver §6.3.

Además, el script normaliza el prefijo — **VERIFICADO**, con el comentario original de Sabre:

```js
// Analyze 'token' variable, if it starts with "ATH:" this text is removed
// as it's not accepted by Sabre's 2SG gateways
if (token) {
  pm.environment.set('token', token.replace(/^ATH:/, ''));
}
```

> **Implicación para nuestro ACL:** el token que devuelve `SessionCreateRQ` puede venir prefijado `ATH:`. Hay que
> **strippear el prefijo antes de usarlo en el gateway REST**, pero _conservar el valor tal cual lo devolvió Sabre_
> para el `BinarySecurityToken` SOAP. Nuestro `SabreTokenService` debe guardar ambas formas o normalizar siempre.

### 1.2 Qué flujo exige cuál — evidencia por workflow (**recontada**)

> **Corrección (hallazgo 2 de la crítica — ACEPTADO).** La tabla de la primera pasada contaba **ocurrencias del
> string** dentro del JSON del request (nombre + `<Action>` + tag de apertura + tag de cierre), no requests, y por
> eso estaba inflada 3–4×: hacía creer que WF-20 abría 4 sesiones y WF-28 abría 20. Tabla recontada **por request**,
> agrupando por la carpeta de segundo nivel bajo `Workflows/` (255 requests en total):

| Workflow                                     | n           | SOAP  | `/v2/auth/token` | `SessionCreateRQ` | `SessionCloseRQ` | Ancillaries | Modo                            |
| -------------------------------------------- | ----------- | ----- | ---------------- | ----------------- | ---------------- | ----------- | ------------------------------- |
| 1 — Air NDC Shop, Price, Book, Cancel        | 6           | 0     | 1                | 0                 | 0                | 0           | **REST puro (ATK)**             |
| 2 — **Profiles** + Air NDC                   | 9           | 4     | 1                | **1**             | 1                | 0           | sesión SOAP (perfiles EPS)      |
| 3 — Air Shop, Book, Cancel                   | 4           | 0     | 1                | 0                 | 0                | 0           | REST puro (ATK)                 |
| 4 — **Profiles** + Air Shop/Book             | 8           | 4     | 1                | **1**             | 1                | 0           | sesión SOAP (perfiles EPS)      |
| 5 — Air **LCC** Shop, Book, Cancel           | 6           | 0     | 1                | 0                 | 0                | 0           | REST puro (ATK)                 |
| 6 / 7 / 8 — Shop, Book, Fulfill, Void/Refund | 9 / 10 / 15 | 0     | 1                | 0                 | 0                | 0           | REST puro (ATK)                 |
| 9 / 10 — Hotel / Vehicle Shop, Book, Cancel  | 8 / 5       | 0     | 1                | 0                 | 0                | 0           | REST puro (ATK)                 |
| 11–14, 16–18 — variantes NDC / ATPCO         | 5–9         | 0     | 1                | 0                 | 0                | 0           | REST puro (ATK)                 |
| **15 — NDC All supported airlines**          | 25          | 0     | **5**            | 0                 | 0                | 0           | REST puro, **5 re-auth**        |
| **19 — ATPCO Air search, Ancillaries, Book** | 5           | **1** | 1                | **0**             | 0                | **1**       | **ATK + SOAP sin sesión**       |
| **20 — LCC Air Search, Ancillaries, Book**   | 6           | **3** | **0**            | **1**             | **1**            | **1**       | **SESIÓN SOAP obligatoria**     |
| **21 — LCC Check, Refund Booking**           | 10          | 2     | 1                | **1**             | **1**            | 0           | sesión SOAP                     |
| **22 — LCC + ATPCO Check, Refund**           | 10          | 1     | 1                | **0**             | **1**            | 0           | ⚠ cierra sin abrir             |
| 23–25 — variantes NDC                        | 6 / 4 / 4   | 0     | 1                | 0                 | 0                | 0           | REST puro (ATK)                 |
| **26 — ATPCO Refund ancillaries (tickets)**  | 11          | 3     | 1                | **1**             | **1**            | **1**       | sesión SOAP                     |
| **27 — ATPCO Refund ancillaries (confId)**   | 10          | 2     | 1                | **1**             | **0**            | **1**       | ⚠ abre sin cerrar              |
| **28–33 — NDC asignación de asientos**       | 41          | 5     | **6**            | **5**             | **0**            | 0           | ⚠ mixto, 5 sesiones sin cerrar |

Cambios respecto a la primera pasada, todos aceptando la crítica:

- **WF-20 abre UNA sesión, no 4.** Y la cierra. La regla que fijaba ("LCC exige sesión SOAP") **sigue en pie**: es
  el único workflow con `auth=0`, así que su único origen de token es el `SessionCreateRQ`.
- **WF-15 sale de la fila agrupada**: tiene **5** llamadas a `/v2/auth/token`, no 1. Es el workflow que barre todas
  las aerolíneas NDC soportadas y re-autentica por tanda.
- **WF-19 tiene `SessionCreateRQ = 0`.** Confirma lo que la primera pasada afirmaba: usa el ATK REST para hablar
  SOAP, sin sesión. El dato ahora es limpio.
- **Los desbalances de sesión son puntuales, no uniformes** (ver §6.4).

Los dos casos que fijan la regla, **VERIFICADO** leyendo la secuencia de pasos:

**Workflow 19 (ATPCO) — arranca con ATK y usa ese ATK para hablar SOAP:**

```
0. REST Authorize ATK           POST {{rest_endpoint}}/v2/auth/token
1. Shop (BFM)                   POST {{rest_endpoint}}/v4/offers/shop
   GetAncillaryOffersRQ 3.1.0   POST {{soap_endpoint}}          <-- SOAP con el token ATK, SIN sesion
3. CreateBooking with ancillaries  POST {{rest_endpoint}}/v1/trip/orders/createBooking
4. GetBooking                   POST {{rest_endpoint}}/v1/trip/orders/getBooking
```

**Workflow 20 (LCC) — NO hay `REST Authorize`; todo el flujo cuelga de la sesión SOAP:**

```
SessionCreateRQ 1.0.0           POST {{soap_endpoint}}          <-- unica fuente de token
1. Shop (BFM)                   POST {{rest_endpoint}}/v3/offers/shop      <-- REST con token ATH
   GetAncillaryOffersRQ 3.1.0   POST {{soap_endpoint}}
3. CreateBooking with ancillaries  POST {{rest_endpoint}}/v1/trip/orders/createBooking
4. GetBooking                   POST {{rest_endpoint}}/v1/trip/orders/getBooking
SessionCloseRQ                  POST {{soap_endpoint}}
```

**Reglas operativas que se derivan:**

| Necesito…                                                                             | Modo requerido                                               |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Shopping NDC / ATPCO, price, createBooking, getBooking, cancel, fulfill, void, refund | **ATK stateless**                                            |
| Ancillaries **ATPCO** vía SOAP (`GetAncillaryOffersRQ 3.1.0`, **6 requests**)         | ATK basta; el transporte es SOAP sin sesión                  |
| Ancillaries **NDC** vía REST (`/v2/offers/getAncillaries`, **3 requests**)            | ATK stateless                                                |
| Ancillaries **LCC**                                                                   | **Sesión ATH abierta** (WF-20 no tiene otra fuente de token) |
| Cualquier cosa **LCC** con modificación (refund, FOP)                                 | Sesión ATH                                                   |
| **Perfiles** (`Sabre_OTA_ProfileCreateRQ`, `EPS_EXT_ProfileCreateRQ`)                 | Sesión ATH                                                   |
| Modificación de **asientos**, **SSR/documentos de identidad**, **FOP de hotel**       | Sesión ATH                                                   |

> **Matiz sobre "ancillaries".** `GetAncillaryOffersRQ` existe en **los dos transportes**: 6 requests SOAP
> (`3.1.0`, ATPCO/LCC) y 3 requests REST (`{{rest_endpoint}}/v2/offers/getAncillaries`, NDC). La primera pasada
> los mezclaba. **No es el mismo servicio**; el spec REST de `getAncillaries` es uno de los dos que faltan
> (`00-fuentes.md` §2).

---

## 2. `POST {{rest_endpoint}}/v2/auth/token`

Los **59** requests a este endpoint son **byte-a-byte idénticos** (agrupando por `headers+body+scripts`: **1 sola
variante sobre 59**). **VERIFICADO** — request `Authentication / REST Authorize`:

```
POST {{rest_endpoint}}/v2/auth/token
AUTH: {"type":"noauth"}                       <-- desactiva el bearer de coleccion
Content-Type: application/x-www-form-urlencoded
Authorization: Basic {{secret}}
Conversation-ID: {{conv_id}}

grant_type=client_credentials
```

| Elemento                    | Valor                                                           | Marca                                                                                                                    |
| --------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Método / path               | `POST /v2/auth/token`                                           | VERIFICADO + **VERIFICADO-SPEC**: `booking-management-v1.yml:23` (`tokenUrl`)                                            |
| Flujo OAuth2                | `client_credentials` (Swagger 2.0 lo llama `flow: application`) | **VERIFICADO-SPEC**: `booking-management-v1.yml:26`; OAS3: `bargain-finder-max-v5.yml:10246` (`flows.clientCredentials`) |
| Credencial en Basic base64  | `x-base64-encode-client-credentials: true`                      | **VERIFICADO-SPEC**: `booking-management-v1.yml:27` — presente en **los 21 specs**                                       |
| `Content-Type`              | `application/x-www-form-urlencoded`                             | VERIFICADO                                                                                                               |
| Body                        | `grant_type=client_credentials` (29 bytes, sin más params)      | VERIFICADO                                                                                                               |
| `Authorization` (a la API)  | `Bearer TOKEN`                                                  | **VERIFICADO-SPEC**: `booking-management-v1.yml:53-55` — declarado `required: true` en las 8 operaciones                 |
| `Conversation-ID`           | `{{conv_id}}`, que el script fija a `"2021.01.DevStudio"`       | VERIFICADO (no aparece en ningún spec)                                                                                   |
| Auth de request             | `noauth` — hay que **desactivar** el bearer heredado            | VERIFICADO                                                                                                               |
| Campo del response          | `access_token`                                                  | **VERIFICADO-POR-SCRIPT**                                                                                                |
| `expires_in` / `token_type` | **no aparecen ni en la colección ni en ningún spec**            | **DESCONOCIDO**                                                                                                          |

Consumo del response — **VERIFICADO-POR-SCRIPT**, evento `test` de colección:

```js
case 'token':
    pm.environment.set('token', jsonData.access_token);
    break;
```

> El script guarda `access_token` y **nada más**. No lee `expires_in`, ni `token_type`, ni `refresh_token`. Un grep
> de `expires_in|token_type|refresh_token` sobre los 1.077 requests, sobre el `.json` crudo **y sobre los 15
> specs** devuelve **cero coincidencias**. Los specs declaran el `tokenUrl` pero **no modelan el response del
> token** (`securityDefinitions` de Swagger/OpenAPI nunca lo hace). La vida del token sigue siendo DESCONOCIDA.

### 2.1 Construcción del `secret` — **VERIFICADO, no inferido**

El algoritmo está escrito literalmente en el script pre-request de la colección. **VERIFICADO**:

```js
case 'token':
    const username = pm.variables.get('username');
    const pcc      = pm.variables.get('pcc');

    if ((request.url.split("/")[1]) == ('v2')) {
        // Construct raw client id (by appending V1:username:PCC:AA)
        const clientidRaw    = `V1:${username}:${pcc}:AA`;
        const clientidBase64 = CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse(clientidRaw));
        const passwordRaw    = pm.variables.get('password');
        const passwordBase64 = CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse(passwordRaw));
        // Combine the two previous strings with a : in the middle
        const secretRaw      = `${clientidBase64}:${passwordBase64}`;
        // Base64 encode this last string
        const secretBase64   = CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse(secretRaw));
        pm.environment.set('secret', secretBase64);
        pm.environment.set('token', "");
    }
```

Reescrito como algoritmo (esquema de **doble base64**):

```
1. clientId  = "V1:" + EPR + ":" + PCC + ":AA"      // el literal "AA" es el Domain
2. A         = base64utf8(clientId)
3. B         = base64utf8(password)
4. secretRaw = A + ":" + B
5. secret    = base64utf8(secretRaw)
6. header    = "Authorization: Basic " + secret
```

El flag `x-base64-encode-client-credentials: true` de los specs (**VERIFICADO-SPEC**,
`booking-management-v1.yml:27`) confirma que Sabre espera el par de credenciales **ya codificado en base64** en el
header `Authorization: Basic`, pero **no describe el esquema de doble base64 ni el prefijo `V1:`**: eso sólo está
en el script de la colección. Los dos se complementan, no se contradicen.

Ejemplo con valores ficticios. Los valores no salen de la colección, pero **el cálculo sí está verificado**:
es reproducible con `node tools/sabre/cert-probe.mjs` y con el bloque `node -e` de más abajo.

```
EPR=500001  PCC=U9PK  password=Pa55w0rd!
clientId  = "V1:500001:U9PK:AA"
A         = "VjE6NTAwMDAxOlU5UEs6QUE="
B         = "UGE1NXcwcmQh"
secretRaw = "VjE6NTAwMDAxOlU5UEs6QUE=:UGE1NXcwcmQh"
secret    = "VmpFNk5UQXdNREF4T2xVNVVFczZRVUU9OlVHRTFOWGN3Y21RaA=="
```

> **Corregido el 2026-08-25.** La versión anterior de este ejemplo publicaba
> `VmpFNk5UQXdNREF4T2xVNVVFczZRVUU5OlVHRXhOWGN3Y21RaA==`, que es **incorrecto** por dos erratas de
> transcripción: al decodificarlo, `A` daba `"V1:500001:U9PK:AA="` (se había tragado el relleno `=` dentro
> de la propia cadena) y `B` daba `"Pa15w0rd!"` (un `1` en vez del `5` del password). Las líneas `A`, `B` y
> `secretRaw` siempre estuvieron bien; sólo el resultado final estaba mal. Quien copiara ese valor para
> validar su implementación habría perseguido un `401` inexistente. Comprobación:
>
> ```bash
> node -e 'const b=s=>Buffer.from(s,"utf8").toString("base64");console.log(b(b("V1:500001:U9PK:AA")+":"+b("Pa55w0rd!")))'
> ```

**Observaciones críticas:**

1. **El `secret` es reversible.** Es base64, no un hash. Quien tenga el `secret` tiene el **password en claro** del
   EPR. Debe tratarse exactamente igual de sensible que el password. Nunca loguear, nunca devolver por API, nunca
   meter en un query string (`CLAUDE.md` §Seguridad).
2. **El `Domain` en el clientId REST es `AA`**, pero el `Domain` del `UsernameToken` SOAP es `DEFAULT` en 66 de los
   73 `SessionCreateRQ` y `AA` en 7. **Incoherencia real de la colección** — ver §4.3.
3. **La colección NO trae el `secret` en claro.** En el environment: `secret = ""`, `password = ""`, `pcc = ""`,
   `username = "{{epr}}"` y la variable `epr` **ni siquiera está definida** entre las 425 claves. El secret se
   calcula en runtime a partir de valores que **el cliente tiene que darnos**.
4. **Si el Basic está mal construido, Sabre lo dice con un error específico.** **VERIFICADO-SPEC**,
   `help/booking-management-api-v1/v1-errors.txt:60-67`: `401 Unauthorized / "Credentials are missing or the syntax
is not correct"` → «_Verify that your base64-encoded token credentials were constructed properly._» Es el error
   que veremos si nos equivocamos en el doble base64. Ver §5.

### 2.2 La rama `/v3/auth/token` — existe en el script, **cero requests la usan**

**VERIFICADO** (grep `v3/auth/token` sobre `requests.jsonl` → 0 resultados). El script contempla un camino
alternativo para versiones ≥ v3, con OAuth2 clásico:

```js
} else {
    // Assumption is that this is /v3/auth/token or higher version
    const client_id     = pm.variables.get('client_id');
    const client_secret = pm.variables.get('client_secret');
    const clientIDClientSecret = `${client_id}:${client_secret}`;   // base64 SIMPLE, una sola vez
    pm.environment.set('auth_secret',
        CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse(clientIDClientSecret)));
    pm.environment.set('token', "");
}
```

|                                      | `/v2/auth/token`                 | `/v3/auth/token`                        |
| ------------------------------------ | -------------------------------- | --------------------------------------- |
| Identidad                            | EPR + PCC + password             | `client_id` + `client_secret`           |
| Codificación                         | **doble base64** (`V1:` + `:AA`) | base64 simple `client_id:client_secret` |
| Variable Postman                     | `secret`                         | `auth_secret`                           |
| Requests que lo usan en la colección | **59**                           | **0**                                   |
| Declarado en los 21 specs oficiales  | **21 / 21**                      | **0 / 21**                              |

> **Refuerzo desde el spec.** Los **quince** contratos oficiales apuntan su `tokenUrl` a `/v2/auth/token`. Ninguno
> menciona `/v3`. **VERIFICADO-SPEC** (`booking-management-v1.yml:23`, `bargain-finder-max-v5.yml:10249`,
> `bargain-finder-max-v4.yml:8017`, `bargain-finder-max-v3.yml:5558`, `offer-price-ndc-v1.yml:4493`,
> `flight-reshop-api-1.0.yml:6898`, `flightcheck-api-v1.yml:2231`, `get-hotel-avail-v4.yml:2722`,
> `get-hotel-avail-v3.yml:2262`, `hotel-price-check-v5.yml:1680`, `hotel-price-check-v4.yml:1588`,
> `get-vehicle-availability-v2.yml:49`, `get-vehicle-availability-v1.yml:2414`, `get-seats-agency-3.0.yml:101`,
> `get-seats-airline-3.0.yml:78`).
>
> **Decisión de diseño:** implementamos **v2**. Es lo único ejercitado, lo único contratado, y es lo que
> corresponde a una credencial EPR+PCC (el modelo BYOC que necesitamos). Dejamos `clientId`/`clientSecret` como
> campos opcionales en `credentials` para poder migrar a v3 sin cambiar el schema.

---

## 3. Endpoints por entorno

### 3.1 Lo que trae el environment — **VERIFICADO**

De las **425** variables del environment `BM API TEST CERT - EPR`, **sólo 6 tienen valor**, y 3 de esas 6 son
punteros a otra variable que no existe:

| Variable        | Valor                                         | Uso real en la colección                                      |
| --------------- | --------------------------------------------- | ------------------------------------------------------------- |
| `rest_endpoint` | `https://api.cert.platform.sabre.com`         | **808 requests**                                              |
| `soap_endpoint` | `https://webservices.cert.platform.sabre.com` | **243 requests**                                              |
| `lls_endpoint`  | `https://webservices.cert.platform.sabre.com` | **0 requests — variable muerta**                              |
| `username`      | `{{epr}}`                                     | ← `epr` **no definida**                                       |
| `pcc_tkt`       | `{{your_target_pcc}}`                         | ← `your_target_pcc` **no definida**                           |
| `ptrta`         | `{{atpco_printer_address}}`                   | **0 requests — variable muerta**, y su destino tampoco existe |

`lls_endpoint` y `soap_endpoint` **apuntan al mismo host**. LLS (_Legacy Local Services_, las APIs `*LLSRQ` tipo
`OTA_AirAvailLLSRQ`, `ContextChangeLLSRQ`) comparte gateway con el resto de SOAP. **[INFERIDO]** que la separación
de variables es histórica; en la práctica sólo necesitamos dos hosts.

### 3.2 Producción — **RESUELTO por el spec para REST, sigue DESCONOCIDO para SOAP**

> **Corrección.** La primera pasada marcaba el host de producción como `[INFERIDO — verificar]`. **Ya no lo es.**

**VERIFICADO-SPEC — cert y prod declarados explícitamente en el mismo documento:**

```yaml
# offer-price-ndc-v1.yml:12-16
servers:
  - url: https://api.cert.platform.sabre.com/v1/offers
    description: Certification environment.
  - url: https://api.platform.sabre.com/v1/offers
    description: Production environment.
```

Y en los specs que parametrizan el host, el `enum` trae los dos con comentario oficial — **VERIFICADO-SPEC**,
`flight-reshop-api-1.0.yml:8-17` (idéntico en `flightcheck-api-v1.yml:7-16`, `get-seats-agency-3.0.yml:17-26`,
`get-seats-airline-3.0.yml:15-24`, `hotel-price-check-v5.yml:7-14`):

```yaml
servers:
  - url: https://{environment}.sabre.com{basePath}
    variables:
      environment:
        default: 'api.cert.platform'
        enum:
          - api.cert.platform # Public Certification Server
          - api.platform # Public Production Server
```

Remate: **dos specs apuntan su `tokenUrl` directamente a producción** — `get-seats-agency-3.0.yml:101` y
`get-seats-airline-3.0.yml:78` usan `https://api.platform.sabre.com/v2/auth/token`. Es la confirmación de que el
endpoint de token en prod es el mismo path sobre el host de prod.

| Entorno  | REST                                                                                                                 | SOAP                                                                           |
| -------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **CERT** | `https://api.cert.platform.sabre.com` — **VERIFICADO** + **VERIFICADO-SPEC** (`booking-management-v1.yml:12`)        | `https://webservices.cert.platform.sabre.com` — **VERIFICADO**                 |
| **PROD** | `https://api.platform.sabre.com` — **VERIFICADO-SPEC** (`offer-price-ndc-v1.yml:15`, `get-seats-agency-3.0.yml:101`) | `https://webservices.platform.sabre.com` — **[INFERIDO]**, sigue sin verificar |

**El host SOAP de producción sigue siendo inferencia**, porque no tenemos ningún contrato del carril SOAP: los 15
specs oficiales son todos REST. La analogía (`quitar .cert`) es fuerte porque el patrón se cumple exactamente en
REST, pero no está confirmada. Sigue en `Preguntas abiertas`.

### 3.3 ¿Difiere el host o el `basePath` por producto? — **VERIFICADO-SPEC: el host no, el `basePath` sí**

Todos los productos comparten host y `tokenUrl`. Lo que **sí cambia por producto** es el prefijo de path, y hay que
modelarlo bien o el cliente HTTP montará URLs rotas:

| Producto                         | `basePath` / path completo declarado                         | Ref                                                         |
| -------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------- |
| Booking Management v1.33         | `basePath: /v1/trip/orders` (host raíz)                      | `booking-management-v1.yml:12-15`                           |
| Bargain Finder Max v5 / v4 / v3  | host raíz, path `/v{5,4,3}/offers/shop`                      | `bargain-finder-max-v5.yml:11`, `-v4.yml:29`, `-v3.yml:7-8` |
| Offer Price NDC v1               | server **incluye** `/v1/offers`, path `/price`               | `offer-price-ndc-v1.yml:13`                                 |
| Flight Reshop 1.0                | server `basePath` default `/v1/offers`, path `/flightReshop` | `flight-reshop-api-1.0.yml:16-17`                           |
| FlightCheck v1                   | server `basePath` default `/v1/offers`, path `/flightCheck`  | `flightcheck-api-v1.yml:15-16`                              |
| Get Seats 3.0 (agency / airline) | server `basePath` default `/v3/offers`, path `/getseats/*`   | `get-seats-agency-3.0.yml:25-26`                            |
| Get Hotel Avail v4 / v3          | host raíz, path `/v4.0.0/get/hotelavail`                     | `get-hotel-avail-v4.yml:8,12`                               |
| Hotel Price Check v5 / v4        | host raíz, path `/v5/hotel/pricecheck`                       | `hotel-price-check-v5.yml:8,19`                             |
| Get Vehicle Availability v2 / v1 | host raíz, path `/v2.0.0/get/vehavail`                       | `get-vehicle-availability-v2.yml:13,16`                     |

> **Ojo con Get Seats.** El spec dice `basePath: /v3/offers` + `/getseats/byNdcOrderId`, pero los **32 requests** de
> la colección van a `{{rest_endpoint}}/v1/offers/getseats`. **El spec y la colección no coinciden en la versión
> del path.** Es una discrepancia real que hay que resolver contra el sandbox antes de implementar asientos; queda
> en `Preguntas abiertas`.

### 3.4 Parametrización propuesta

Los endpoints **no son secretos**: van en `config`, nunca en `credentials`. Se derivan de un único campo
`environment: 'cert' | 'prod'`, con override explícito por si Sabre asigna un host dedicado a la agencia:

```ts
const SABRE_HOSTS = {
  cert: {
    rest: 'https://api.cert.platform.sabre.com', // VERIFICADO-SPEC
    soap: 'https://webservices.cert.platform.sabre.com',
  }, // VERIFICADO (coleccion)
  prod: {
    rest: 'https://api.platform.sabre.com', // VERIFICADO-SPEC
    soap: 'https://webservices.platform.sabre.com',
  }, // [INFERIDO]
} as const;
```

### 3.5 Variables de endpoint rotas — **VERIFICADO**

**26 requests** apuntan a variables `*_endpoint` que **no existen** en el environment. Como shipping, no corren:

| Variable usada como URL      | Requests | ¿Definida? |
| ---------------------------- | -------- | ---------- |
| `{{getBooking_endpoint}}`    | 12       | **NO**     |
| `{{createBooking_endpoint}}` | 7        | **NO**     |
| `{{modifyBooking_endpoint}}` | 6        | **NO**     |
| `{{cancelBooking_endpoint}}` | 1        | **NO**     |

**[INFERIDO]** que son restos de un environment interno de Sabre con hosts por microservicio. Al portar los casos
de prueba hay que reescribirlas a `{{rest_endpoint}}/v1/trip/orders/<op>`, que es lo que el spec declara como
`basePath` canónico (**VERIFICADO-SPEC**, `booking-management-v1.yml:15`).

---

## 4. Identidad de agencia en Sabre

### 4.1 Glosario de los identificadores

| Identificador              | Variable Postman                      | Qué es                                                                                                                                                                                                                                                                     | Dónde aparece                                                            |
| -------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **EPR**                    | `username` = `{{epr}}`                | _Employee Profile Record_. El **usuario humano/técnico** dentro de la agencia. Es el `username` de Sabre.                                                                                                                                                                  | `clientId` REST (`V1:EPR:PCC:AA`); `<Username>` del `UsernameToken` SOAP |
| **PCC** / pseudo-city      | `pcc`                                 | Código de 3–4 chars de la **oficina** (pseudo-city). Define qué tarifas privadas se ven, en qué colas caen los PNR y bajo qué agencia queda la reserva. **VERIFICADO-SPEC**: «_Four-character pseudo city code (PCC) of authorized branch_» (`get-hotel-avail-v4.yml:94`). | `clientId` REST; `<Organization>`; `<POS><Source PseudoCityCode=…>`      |
| **password**               | `password`                            | Password del EPR.                                                                                                                                                                                                                                                          | Base64 en el `secret`; `<Password>` SOAP en claro                        |
| **Domain**                 | — (literal)                           | Dominio de autenticación. `AA` en REST, `DEFAULT`/`AA` en SOAP.                                                                                                                                                                                                            | §4.3                                                                     |
| **`pcc_tkt`**              | `pcc_tkt` = `{{your_target_pcc}}`     | **PCC de emisión dedicado**: la oficina que emite el billete, que puede ser ≠ la que reservó.                                                                                                                                                                              | `targetPcc` en `fulfillFlightTickets` y `cancelBooking`                  |
| **`ptrta`**                | `ptrta` = `{{atpco_printer_address}}` | _Printer address_ ATPCO. **0 usos** — variable muerta. Lo que sí se usa es `hardcopy` (16) y `country_code` (15).                                                                                                                                                          | —                                                                        |
| **`X-Sabre-Group`**        | `x_sabre_group` (vacía)               | Header REST. **Obligatorio con `targetPcc` cuando se usa ATK** (§4.2).                                                                                                                                                                                                     | 214 requests, hardcodeado                                                |
| **`X-Sabre-Current-City`** | `x_sabre_current_city` (vacía)        | Header REST. **Obligatorio con `targetPcc` cuando se usa ATH** (§4.2).                                                                                                                                                                                                     | 214 requests, hardcodeado                                                |
| **`Application-ID`**       | —                                     | Header opcional recomendado por Sabre en hotel/vehicle. **VERIFICADO-SPEC**: «_Specifies the customer application ID. It is recommended but not needed_» (`hotel-price-check-v5.yml:24-28`, `get-hotel-avail-v4.yml:18-22`). **0 usos en la colección.**                   | —                                                                        |
| **`AppId`**                | `AppId` (vacía)                       | `CustomerAppId` en el sobre SOAP. Sólo lo usa `header_appid`, que **nadie usa**.                                                                                                                                                                                           | 0 usos                                                                   |

### 4.2 `X-Sabre-Group` y `X-Sabre-Current-City` — **la documentación oficial los desambigua**

> **Corrección.** La primera pasada marcaba su semántica como `[INFERIDO]` y preguntaba «¿qué pasa si difieren?».
> **La documentación oficial lo responde.**

**VERIFICADO-SPEC**, `help/booking-management-api-v1/help-documentation-create-booking-error-list.txt:1166-1170`:

| Error type                       | Categoría     | Descripción oficial                                                                                                               |
| -------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `HEADER_DATA_MISSING_TARGET_PCC` | `BAD_REQUEST` | «_Target PCC was defined but header data is missing. Please complete **X-Sabre-Group (ATK)** or **X-Sabre-Current-City (ATH)**._» |

De ahí se derivan tres reglas duras que la primera pasada no tenía:

1. **No son intercambiables ni redundantes: se eligen según el tipo de token.** `X-Sabre-Group` es el header del
   carril **ATK**; `X-Sabre-Current-City` es el del carril **ATH**.
2. **Son obligatorios cuando el body lleva `targetPcc`.** Si mandas `targetPcc` sin el header correspondiente,
   Sabre devuelve `HEADER_DATA_MISSING_TARGET_PCC`. Esto convierte el pareo `targetPcc` + header en una
   **invariante del ACL**, no en un detalle opcional. Nuestro cliente debe rechazar en compile-time / runtime la
   combinación `targetPcc` sin header.
3. La colección los manda **siempre en pareja y siempre con el mismo valor** (0 discrepancias en 214) porque el
   autor no sabía cuál aplicaba a cada token y puso los dos. Es una práctica defensiva, no un requisito.

Uso en la colección — **VERIFICADO**, 214 requests:

| Endpoint                                                  | `X-Sabre-Group` = `X-Sabre-Current-City` | Requests |
| --------------------------------------------------------- | ---------------------------------------- | -------- |
| `/v1/trip/orders/getBooking`                              | `U9PK` / `G7RE`                          | 75 + 56  |
| `/v1/trip/orders/modifyBooking`                           | `U9PK`                                   | 41       |
| `/v1/trip/orders/createBooking`                           | `U9PK` / `G7RE`                          | 14 + 14  |
| `{{getBooking_endpoint}}` (roto)                          | `G7RE` / `U9PK`                          | 4 + 2    |
| `/v1/trip/orders/checkFlightTickets`                      | `U9PK`                                   | 4        |
| `{{modifyBooking_endpoint}}` (roto)                       | `U9PK`                                   | 2        |
| `/v1.0.0/veh/pricecheck`, `/v1/trip/orders/cancelBooking` | `G7RE`                                   | 1 + 1    |

**Detalle importante:** el environment define `x_sabre_group` y `x_sabre_current_city` **vacías**, y los requests
**no las usan** — llevan `U9PK` y `G7RE` **hardcodeados**. Son los PCC de certificación del autor de la colección,
no valores nuestros. Al portar hay que parametrizarlos contra el PCC del tenant.

> **Ninguno de los 21 specs declara estos headers** (grep `X-Sabre` sobre `specs/*.yml` → 0). Sólo aparecen en la
> lista de errores. Es un caso donde la documentación de errores es más completa que el contrato.

### 4.3 Incoherencia de `Domain`: `AA` vs `DEFAULT` — **VERIFICADO**

Los 73 requests `SessionCreateRQ` se agrupan en **exactamente 4 variantes de body** (verificado normalizando
espacios y agrupando):

| #   | Requests | `Domain`  | `ConversationId`    | `ClientId` / `ClientSecret`            | Cuerpo `SessionCreateRQ`                                                 |
| --- | -------- | --------- | ------------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| 1   | **39**   | `DEFAULT` | `2019.09.DevStudio` | —                                      | `<SessionCreateRQ returnContextID="true">` + `POS` `{{pcc}}`             |
| 2   | **23**   | `DEFAULT` | `STX_2019_Postman`  | `SBR-BMAPI` / `{{soap_client_secret}}` | `<sws:SessionCreateRQ … Version="1.0.0">` + `POS` **`U9PK` hardcodeado** |
| 3   | **7**    | **`AA`**  | `2019.09.DevStudio` | —                                      | `<SessionCreateRQ returnContextID="true">` + `POS` `{{pcc}}`             |
| 4   | **4**    | `DEFAULT` | `STX_2019_Postman`  | —                                      | `<SessionCreateRQ Version="1.0.0" xmlns="…/OTA/2002/11"/>` (sin `POS`)   |

> **Nota metodológica.** Un conteo que busque el tag literal `<SessionCreateRQ` devuelve **50**, no 73, porque la
> variante 2 usa el prefijo de namespace `<sws:SessionCreateRQ>`. 50 = 39 + 7 + 4. El conteo correcto por request
> es **73**. La variante 2 no es un falso positivo: es un `SessionCreateRQ` legítimo con otro binding XML.

Ejemplo de la variante 1 — **VERIFICADO**, request `Authentication / SessionCreateRQ (Stateful ATH) create session`:

```xml
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">
  <SOAP-ENV:Header>
    <MessageHeader xmlns="http://www.ebxml.org/namespaces/messageHeader">
      <From><PartyId>Agency</PartyId></From>
      <To><PartyId>Sabre_API</PartyId></To>
      <ConversationId>2019.09.DevStudio</ConversationId>
      <Action>SessionCreateRQ</Action>
    </MessageHeader>
    <Security xmlns="http://schemas.xmlsoap.org/ws/2002/12/secext">
      <UsernameToken>
        <Username>{{username}}</Username>
        <Password>{{password}}</Password>
        <Organization>{{pcc}}</Organization>
        <Domain>DEFAULT</Domain>
      </UsernameToken>
    </Security>
  </SOAP-ENV:Header>
  <SOAP-ENV:Body>
    <SessionCreateRQ returnContextID="true">
      <POS><Source PseudoCityCode="{{pcc}}"/></POS>
    </SessionCreateRQ>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>
```

Y la variante 2, que trae **un `ClientSecret` en claro dentro de una colección distribuida públicamente**:

```xml
      <UsernameToken>
        <Username>{{username}}</Username>
        <Password>{{password}}</Password>
        <Organization>{{pcc}}</Organization>
        <ClientId>SBR-BMAPI</ClientId>
        <ClientSecret>{{soap_client_secret}}</ClientSecret>
        <Domain>DEFAULT</Domain>
      </UsernameToken>
```

**[INFERIDO]** que `SBR-BMAPI`/el valor original saneado es un identificador de aplicación de Sabre, no una
credencial de agencia — pero la fuente lo traía en claro y hay que preguntar antes de replicarlo. Va a `Riesgos`.

`SessionCloseRQ` tiene **2 variantes** (61 requests):

```xml
{{header}}
<SessionCloseRQ><POS><Source PseudoCityCode="{{pcc}}"/></POS></SessionCloseRQ>
{{footer}}
```

```xml
{{header}}
<SessionCloseRQ Version="1.0.0" xmlns="http://www.opentravel.org/OTA/2002/11"/>
{{footer}}
```

### 4.4 "Change PCC" — es un campo del body, **no un header** — **VERIFICADO + VERIFICADO-SPEC**

La documentación oficial define `targetPcc` en términos que son literalmente el modelo consolidador —
**VERIFICADO-SPEC**, `help/booking-management-api-v1/help-documentation-create-booking.txt:118`:

> «_`targetPcc` changes the context to a desired pseudo city code. This is particularly useful **for agencies that
> separate their booking, fulfillment, and shopping across different pseudo city codes (PCCs)**._»

Y explica **cómo** lo implementa Sabre por debajo — **VERIFICADO-SPEC**,
`help-documentation-cancel-booking.txt:81` (idéntico en `help-documentation-check-flight-tickets.txt:64`):

> «_`targetPcc` is used to specify which city (PCC) should change context using **ContextChange (AAA)**. If empty,
> or equals the current city, the context does not change._»

Es decir: **el `targetPcc` de REST es azúcar sobre `ContextChangeLLSRQ`**, que la API orquesta internamente. La
lista de servicios orquestados lo confirma — `help-documentation-create-booking.txt:45-49` abre «_Internal
orchestration_» con `ContextChangeLLSRQ` como **primera** entrada. **Nosotros nunca llamamos a
`ContextChangeLLSRQ` desde el carril REST.**

Los **7 requests** con `targetPcc`, sobre 4 endpoints — **VERIFICADO** (lista completa):

| Endpoint                               | Valor                | Request                                                     |
| -------------------------------------- | -------------------- | ----------------------------------------------------------- |
| `/v1/trip/orders/cancelBooking`        | `{{pcc}}`            | `Cancel Booking /v1 Cancel All + Change PCC`                |
| `/v1/trip/orders/cancelBooking`        | `{{pcc_tkt}}`        | `Cancel Booking - cancelAll and void corresponding tickets` |
| `/v1/trip/orders/voidFlightTickets`    | `{{pcc}}`            | `Void Flight Tickets - Change PCC`                          |
| `/v1/trip/orders/createBooking`        | `7KFA` (hardcodeado) | `createBooking - Air with pricing Complex`                  |
| **`/v1/trip/orders/createBooking`**    | **`{{pcc}}`**        | **`createBooking - Air with Changed PCC`**                  |
| `/v1/trip/orders/fulfillFlightTickets` | `{{pcc_tkt}}`        | `FulfillFlightTickets - … dedicated ticketing PCC` (×2)     |

> **Corrección (hallazgo 3 de la crítica — ACEPTADO).** La primera pasada listaba un solo valor para
> `createBooking` (`7KFA` hardcodeado) y omitía `createBooking - Air with Changed PCC`, que usa `{{pcc}}` > **parametrizado**. El total de 7 requests sobre 4 endpoints sí era correcto, pero la omisión debilitaba
> justamente el argumento de §9.4: **Sabre soporta cambiar el PCC tanto al reservar como al emitir**, y la propia
> colección de Sabre lo trae parametrizado en ambos puntos. No es un hardcode de demo.

El caso bisagra del modelo consolidador es
`FulfillFlightTickets - Fulfill with switching to dedicated ticketing PCC` — **VERIFICADO**:

```json
{
  "confirmationId": "{{pnr}}",
  "fulfillments": [{ "payment": { "primaryFormOfPayment": 1 } }],
  "designatePrinters": [
    { "hardcopy": { "address": "{{hardcopy}}" } },
    { "ticket": { "countryCode": "{{country_code}}" } }
  ],
  "formsOfPayment": [{ "type": "PAYMENTCARD", "cardTypeCode": "VI", "cardNumber": "…" }],
  "targetPcc": "{{pcc_tkt}}"
}
```

Headers: `Content-Type: application/json`, `at-diagnostics: false`.

> **Esto es exactamente el patrón consolidador:** _reservo con un PCC, emito con otro._ Y la API lo soporta de
> forma nativa vía `targetPcc`, sin re-autenticar.

### 4.5 ¿Hace falta autoridad previa sobre el `targetPcc`? — **VERIFICADO-SPEC: SÍ, y falla en runtime**

> **Corrección.** La primera pasada lo dejaba como `[INFERIDO — verificar con Sabre]`. **El spec lo confirma** y
> además da los códigos exactos con los que falla.

**VERIFICADO-SPEC**, `help/booking-management-api-v1/help-documentation-create-booking-error-list.txt:634-666`
(idéntico en `help-documentation-get-booking-error-list.txt:338-372` y
`help-documentation-modify-booking-error-list-0.txt:53-88`):

| Error type                               | Categoría           | Descripción oficial                                             |
| ---------------------------------------- | ------------------- | --------------------------------------------------------------- |
| `UNABLE_TO_CHANGE_CONTEXT`               | `APPLICATION_ERROR` | General problem with `ContextChangeLLSRQ` service.              |
| `UNABLE_TO_CHANGE_CONTEXT_UNAUTHORIZED`  | `APPLICATION_ERROR` | **User is unauthorized to change context for the desired PCC.** |
| `UNABLE_TO_CHANGE_CONTEXT_NOT_ALLOWED`   | `APPLICATION_ERROR` | **User is unauthorized to change context for the desired PCC.** |
| `UNABLE_TO_CHANGE_CONTEXT_FINISH_IGNORE` | `APPLICATION_ERROR` | System could not revert context.                                |
| `UNABLE_TO_CHANGE_CONTEXT_PLEASE_WAIT`   | `APPLICATION_ERROR` | System is still processing the transaction.                     |

Y para NDC hay una comprobación adicional — `…create-booking-error-list.txt:1159-1163`:

| `NDC_PCC_MISMATCH` | `APPLICATION_ERROR` | El PCC de la oferta NDC no coincide con el PCC usado para crear el order. |

**Consecuencias de diseño:**

- El modelo híbrido de §9.4 **con una sola cuenta es viable**, pero depende de un permiso que se concede en el
  back-office de Sabre (_branch access_ / AAA), no desde la API. Nuestro onboarding BYOC debe **probarlo
  explícitamente** con un `getBooking` de humo contra el `ticketingPcc` antes de dar la cuenta por buena.
- `UNABLE_TO_CHANGE_CONTEXT_FINISH_IGNORE` («_System could not revert context_») es un error especialmente
  peligroso: significa que Sabre **no pudo volver al PCC original**. Debe escalar a alerta operativa, no a un
  reintento silencioso.
- Para NDC, `targetPcc` no basta: la oferta tiene que haberse **shoppeado con el mismo PCC**. El
  `homePcc`/`ticketingPcc` no se pueden desacoplar libremente en el carril NDC.

---

## 5. Modelo de error oficial y política de reintento

> Sección **nueva**. La primera pasada dejaba el shape del error como `DESCONOCIDO`. Ahora tenemos la tabla oficial
> completa. Esto alimenta directamente el `SabreExceptionFilter` y el `CircuitBreakerService`
> (`apps/api/src/search/circuit-breaker.service.ts`, umbral 5 fallos / 30 s abierto).

### 5.1 Dos capas de error, y la de arriba miente

**VERIFICADO-SPEC**: los contratos de Sabre declaran, casi siempre, **sólo la respuesta `200`**. Los errores de
negocio viajan **dentro** de un `200`, en un array `errors[]`:

- `booking-management-v1.yml` declara `'200'` como **única** respuesta en las 8 operaciones (líneas 59, 84, 109,
  135, 161, 186, 210, 234). El array de error va en el body: «_Lists detailed error information. **This array is
  not displayed in successful responses**._» (`booking-management-v1.yml:461-465`, y equivalentes en las 8
  respuestas).
- `flightcheck-api-v1.yml:43`: «\*Successful response, **unless the `errors` array is returned\***.»
- `get-seats-agency-3.0.yml:43`: «\*Contains response data for a successful operation **or error details if request
  processing failed\***.»
- `bargain-finder-max-v5.yml:31-43`: sólo `'200'`.
- Excepciones que sí declaran códigos HTTP: `offer-price-ndc-v1.yml:56,62` (`400`, `500`),
  `get-hotel-avail-v4.yml:36,42` (`400`, `404`), `get-vehicle-availability-v2.yml:36,39` (`400`, `404`).

> **Regla no negociable para el ACL:** `res.ok` **no** significa éxito en Sabre. Todo mapper debe inspeccionar
> `errors[]` antes de dar la respuesta por buena. Un adapter que sólo mire el status HTTP dará por confirmadas
> reservas que fallaron.

**Shape del error** — **VERIFICADO-SPEC**, `booking-management-v1.yml:4271-4298` (idéntico en
`flight-reshop-api-1.0.yml:4796-4822`):

```jsonc
{
  "errors": [
    {
      "category": "BAD_REQUEST", // requerido
      "type": "REQUIRED_FIELD_MISSING", // requerido
      "description": "may not be null",
      "fieldPath": "someObject.someFieldName",
      "fieldName": "someName",
      "fieldValue": "field value",
    },
  ],
  "warnings": [{ "category": "WARNING", "type": "EMAIL_NOT_FOUND", "description": "…" }],
}
```

Categorías observadas en las listas oficiales: `BAD_REQUEST`, `APPLICATION_ERROR`, `UNAUTHORIZED`,
`RESOURCE_RESTRICTED`, `INTERNAL_SERVER_ERROR`, `WARNING`, `MISSING_DATA`, `PROCESSING_WARNING`, `IGNORED_DETAILS`.

### 5.2 Capa de gateway (2SG) — tabla oficial y clasificación

**VERIFICADO-SPEC**, `help/booking-management-api-v1/v1-errors.txt` (tabla completa, «_Most common errors in REST
API_»). Clasificación nuestra para el circuit breaker y el retry:

| HTTP | Message             | Text / código                                          | Resolución oficial                                                                  | **Clasificación**                                                              |
| ---- | ------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 400  | Bad Request         | `Invalid format for request`                           | Verificar parámetros y el `grant_type` del payload                                  | **NO REINTENTABLE**                                                            |
| 400  | —                   | `ERR.2SG.CLIENT.INVALID_REQUEST`                       | Verificar parámetros. Ver documentación                                             | **NO REINTENTABLE**                                                            |
| 401  | Unauthorized        | `Not authorized to make this request…`                 | Verificar credenciales del token                                                    | **NO REINTENTABLE** (falta de habilitación, no expiración)                     |
| 401  | Unauthorized        | **`invalid_client`**                                   | 1) Verificar credenciales. 2) **Verificar TAM Pool — puede estar agotado**          | **REINTENTABLE con backoff** (ver §5.3)                                        |
| 401  | Unauthorized        | `Credentials are missing or the syntax is not correct` | Verificar que el base64 se construyó bien                                           | **NO REINTENTABLE** — bug nuestro en el doble base64 (§2.1)                    |
| 401  | Unauthorized        | `Wrong clientID or clientSecret`                       | Verificar password del client ID                                                    | **NO REINTENTABLE** — credencial mala. **Marcar la cuenta BYOC como inválida** |
| 401  | Unauthorized        | `ERR.2SG.SEC.MISSING_CREDENTIALS`                      | Verificar el tipo de dato                                                           | **NO REINTENTABLE**                                                            |
| 401  | Unauthorized        | `ERR.2SG.SEC.INVALID_CREDENTIALS`                      | Verificar credenciales del token                                                    | **REINTENTABLE 1 vez** tras invalidar cache de token                           |
| 403  | Forbidden           | `Request is for a resource that is forbidden`          | Verificar autorización; contactar account manager                                   | **NO REINTENTABLE**                                                            |
| 403  | —                   | `ERR.2SG.SEC.NOT_AUTHORIZED`                           | Ídem                                                                                | **NO REINTENTABLE** — falta activación del producto                            |
| 403  | —                   | `ERR.2SG.CLIENT.SERVICE_UNKNOWN`                       | Verificar URL y segmentos (versión)                                                 | **NO REINTENTABLE** — bug de path (§3.3)                                       |
| 404  | Not Found           | `Response does not contain any data`                   | Menos filtros, o URL/versión mal                                                    | **NO REINTENTABLE** — puede ser "sin resultados" legítimo                      |
| 405  | Method Not Allowed  | —                                                      | Método no válido para el endpoint                                                   | **NO REINTENTABLE**                                                            |
| 406  | Not Acceptable      | Accept headers incompatibles                           | —                                                                                   | **NO REINTENTABLE**                                                            |
| 413  | — / `FULL head`     | `ERR.2SG.CLIENT.INVALID_REQUEST`                       | URL demasiado larga; partir en varios requests                                      | **NO REINTENTABLE**                                                            |
| 429  | too many requests   | **`temporarily_unavailable`**                          | Límite interno excedido. **Esperar ≥ 500 ms y reenviar**                            | **REINTENTABLE con backoff**                                                   |
| 429  | Throttled           | **`Active token count is exceeded`**                   | Máx. de requests concurrentes excedido. Contactar account manager. Esperar ≥ 500 ms | **REINTENTABLE + limitar concurrencia**                                        |
| 429  | —                   | `ERR.2SG.GATEWAY.REQUEST_THROTTLED`                    | Ídem                                                                                | **REINTENTABLE con backoff**                                                   |
| 500  | Server Error        | —                                                      | Esperar ≥ 500 ms y reenviar                                                         | **REINTENTABLE (≤ 2) → ABRIR CIRCUITO si persiste**                            |
| 500  | —                   | `ERR.2SG.SEC.INTERNAL_PROCESSING_ERROR`                | Ídem                                                                                | **REINTENTABLE → ABRIR CIRCUITO**                                              |
| 500  | —                   | `ERR.2SG.GATEWAY.TIMEOUT`                              | Esperar ≥ 500 ms y reenviar                                                         | **REINTENTABLE → ABRIR CIRCUITO**                                              |
| 500  | —                   | `ERR.2SG.GATEWAY.INTERNAL_PROCESSING_ERROR`            | Ídem                                                                                | **REINTENTABLE → ABRIR CIRCUITO**                                              |
| 500  | —                   | `ERR.2SG.GATEWAY.INVALID_PROVIDER_RESPONSE`            | Formato de respuesta del proveedor inválido. Contactar soporte Sabre                | **ABRIR CIRCUITO** — reintentar no arregla un formato roto                     |
| 500  | —                   | `ERR.2SG.GATEWAY.PROVIDER_CONNECTION_ERROR`            | Error de transporte. Esperar ≥ 500 ms                                               | **REINTENTABLE → ABRIR CIRCUITO**                                              |
| 500  | Connection error    | `ERR.2SG.PROVIDER_CONNECTION_ERROR`                    | Ídem                                                                                | **REINTENTABLE → ABRIR CIRCUITO**                                              |
| 503  | Service Unavailable | Servidor no disponible                                 | Reintentar más tarde; reportar si persiste                                          | **ABRIR CIRCUITO inmediatamente**                                              |
| 504  | Gateway Timeout     | Timeout del servidor                                   | Ídem                                                                                | **ABRIR CIRCUITO inmediatamente**                                              |

**Nota sobre el "≥ 500 ms"**: es la única cifra de espera que Sabre publica, y la repite en **todos** los casos
reintentables. La tomamos como **suelo**, no como política: nuestro backoff será exponencial con jitter a partir de
500 ms, con tope de 3 intentos.

**Nota sobre `Active token count is exceeded` (429)**: no habla de tokens de auth sino de **requests concurrentes
por API**. Confirma que **existe un límite de concurrencia contratado por agencia** y que hay que dimensionar el
fan-out del `search.service.ts` con un semáforo por `provider_account`, no por proceso.

### 5.3 `invalid_client` (401) y el TAM Pool — el caso que rompe la intuición

**VERIFICADO-SPEC**, `v1-errors.txt:41-51`:

> `401 / Unauthorized / invalid_client` → «\*1. Verify your token credentials. **2. Verify TAM Pool details. The
> error may occur when TAM Pool is exhausted.\***»

Esto es importante y contraintuitivo: **un 401 `invalid_client` puede no significar "credencial mala" sino "no
quedan slots"**. Tratarlo como credencial revocada (deshabilitar la cuenta BYOC del tenant) sería un
falso positivo que tumba a una agencia entera por saturación temporal.

**Política que se deriva:**

```
401 invalid_client  → NO deshabilitar la cuenta. Backoff + reintento (max 2).
                      Si persiste tras N ventanas -> alerta operativa "TAM Pool / credencial", nunca auto-disable.
401 "Wrong clientID or clientSecret"     -> credencial mala. Marcar la cuenta como `invalid`, avisar al tenant.
401 "Credentials are missing or the syntax is not correct" -> bug nuestro. Alerta de ingenieria, no del tenant.
401 ERR.2SG.SEC.INVALID_CREDENTIALS      -> invalidar cache de token, re-autenticar, reintentar UNA vez.
403 ERR.2SG.SEC.NOT_AUTHORIZED           -> producto no activado. Alerta de onboarding, no reintento.
```

### 5.4 Errores de auth en la capa de aplicación (dentro del `200`)

**VERIFICADO-SPEC**, `help/booking-management-api-v1/help-documentation-get-booking-error-list.txt:16-70` — todos
con `type: UNAUTHORIZED_ACCESS`:

| Categoría                                                                  | Descripción oficial                                                                               | Clasificación                           |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `UNAUTHORIZED`                                                             | **«Expired or invalid security token»** (`:48`)                                                   | **REINTENTABLE 1 vez** tras re-auth     |
| `UNAUTHORIZED`                                                             | **«Invalid security token.»** (`:55`)                                                             | **REINTENTABLE 1 vez** tras re-auth     |
| `UNAUTHORIZED`                                                             | «Booking cannot be retrieved due to authorization issues in the security systems…» (`:62`)        | **NO REINTENTABLE**                     |
| `UNAUTHORIZED`                                                             | «The service `GetAncillaryOffersRQ` returned an authorization failure…» (`:20`)                   | **NO REINTENTABLE** — falta suscripción |
| `UNAUTHORIZED`                                                             | «`TKT_ElectronicDocumentServicesRQ` is available to Sabre travel agency subscribers only» (`:41`) | **NO REINTENTABLE** — falta suscripción |
| `RESOURCE_RESTRICTED`                                                      | «Access to selected booking is restricted. Verify… Travel Journal Record settings» (`:69`)        | **NO REINTENTABLE**                     |
| `UNAUTHORIZED` (createBooking, `…create-booking-error-list.txt:1299-1303`) | «When invalid/expired ATK token is used.»                                                         | **REINTENTABLE 1 vez** tras re-auth     |

> **Riesgo de clasificación.** Los siete comparten `type = UNAUTHORIZED_ACCESS`. **El `type` no basta para decidir
> si reintentar**: hay que mirar la `description`, que es texto libre en inglés y puede cambiar sin aviso. Es una
> dependencia frágil. Mitigación: por defecto **reintentar una sola vez** ante cualquier `UNAUTHORIZED_ACCESS`
> (barato y seguro para operaciones idempotentes) y **nunca** ante operaciones no idempotentes
> (`createBooking`, `fulfillFlightTickets`, `voidFlightTickets`, `refundFlightTickets`), donde un reintento puede
> duplicar una emisión. Ver `Riesgos`.

### 5.5 Errores propios del carril de sesión

**VERIFICADO-SPEC** — aparecen en `createBooking`, `modifyBooking`, `cancelBooking` y `flightReshop`:

| Error type                        | Categoría           | Descripción oficial                                                     | Ref                                                                                                                              | Clasificación                                                                            |
| --------------------------------- | ------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `ATH_TOKEN_FAILURE`               | `APPLICATION_ERROR` | «Unable to create ATH session token. **Please retry the transaction.**» | `…create-booking-error-list.txt:39-43`; `…modify-booking-error-list-0.txt:25-29`; `flight-reshop-api-1.0/…-error-list.txt:23-27` | **REINTENTABLE** (Sabre lo pide explícitamente)                                          |
| `UNABLE_TO_RETRIEVE_SESSION_DATA` | `APPLICATION_ERROR` | General problem with `GetReservationRQ` service                         | `…create-booking-error-list.txt:56-64`                                                                                           | **REINTENTABLE 1 vez**                                                                   |
| `CLOSE_SESSION_WARNING`           | `WARNING`           | Falló el `SessionCloseRQ` interno                                       | `…cancel-booking-error-list.txt:554-558`                                                                                         | **NO reintentar la operación**, pero **sí alertar**: es una sesión potencialmente fugada |
| `FAULT_RESPONSE`                  | `APPLICATION_ERROR` | «The underlying system cannot process request at this time.»            | `…create-booking-error-list.txt:45-49`                                                                                           | **REINTENTABLE → ABRIR CIRCUITO** si persiste                                            |

> **`ATH_TOKEN_FAILURE` es la prueba de que la API REST abre sesiones ATH por su cuenta**, incluso cuando le mandas
> un ATK. Sabre necesita un AAA para orquestar `ContextChangeLLSRQ`, `EPS_EXT_ProfileToPNRRQ`, `EPS_EXT_ProfileReadRQ`,
> `GetReservationRQ`, `UpdateReservationRQ`, `PassengerDetailsRQ` (**VERIFICADO-SPEC**, `help-documentation-create-booking.txt:45-61`).
> Consumimos cupo de sesiones **aunque nunca llamemos a `SessionCreateRQ`**. Esto cambia el dimensionado del §7.

---

## 6. El carril stateful SOAP/LLS

> Sección **nueva**. La primera pasada trató el carril SOAP casi de pasada. Son **243 de 1.077 requests (22,6 %)** y
> es **la mayor desviación arquitectónica** respecto al patrón `latam-ndc`, que es stateless puro.

### 6.1 Inventario — **VERIFICADO** (conteo por request, `slices/09-soap-lls-stateful.txt`)

| Mensaje SOAP                        | Requests | Para qué                                                                  |
| ----------------------------------- | -------- | ------------------------------------------------------------------------- |
| `SessionCreateRQ`                   | **73**   | abrir sesión ATH (4 variantes de body, §4.3)                              |
| `SessionCloseRQ`                    | **61**   | cerrar sesión                                                             |
| `OTA_AirAvailLLSRQ`                 | **30**   | disponibilidad de vuelo — _obtener el número de vuelo_ antes de modificar |
| `GetHotelAvailRQ` (v5.0.0, CSL)     | **26**   | disponibilidad hotelera CSL → devuelve `RateKey`                          |
| `HotelPriceCheckRQ` (v5.0.0)        | **25**   | revalidación hotel → devuelve `BookingKey`                                |
| `GetAncillaryOffersRQ 3.1.0`        | **6**    | ancillaries ATPCO/LCC                                                     |
| `OTA_AirBookLLSRQ`                  | **4**    | book de segmentos en grupo                                                |
| `PassengerDetailsRQ 3.4.0`          | **4**    | nombres / tipos de pasajero en group bookings                             |
| `EnhancedEndTransactionRQ 1.0.0`    | **4**    | **commit** del PNR (el `ET` del emulador)                                 |
| `Sabre_OTA_ProfileCreateRQ`         | **4**    | perfiles EPS                                                              |
| `UpdatePassengerNameRecordRQ 1.1.0` | **3**    | añadir segmento de hotel CSL / FOP                                        |
| `GetVehAvailRQ`                     | **2**    | disponibilidad de auto                                                    |
| `VehPriceCheckRQ`                   | **1**    | revalidación de auto                                                      |

Todos van a `{{soap_endpoint}}` con `Content-Type: text/xml`. **0 requests** usan `{{lls_endpoint}}`.

### 6.2 Cuándo el carril stateful es **obligatorio**

No es una preferencia de transporte: hay funcionalidad que **sólo existe** ahí.

| Capacidad                                            | ¿Hay alternativa REST? | Evidencia                                                                                                              |
| ---------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Ancillaries LCC**                                  | **No**                 | WF-20 tiene `auth=0`: su único origen de token es `SessionCreateRQ`                                                    |
| **Perfiles (EPS)**                                   | **No**                 | WF-2 y WF-4 abren sesión para `Sabre_OTA_ProfileCreateRQ`; la orquestación REST sólo hace `ProfileToPNR`/`ProfileRead` |
| **Preparación hotel CSL** (`RateKey` → `BookingKey`) | Parcial                | los 26 `GetHotelAvailRQ` + 25 `HotelPriceCheckRQ` SOAP alimentan el `bookingKey` que consume `createBooking` REST      |
| **Preparación vehículo** (`bookingKey`)              | Parcial                | 2 `GetVehAvailRQ` + 1 `VehPriceCheckRQ`                                                                                |
| **Group bookings** (add/update/delete de pasajeros)  | **No**                 | `PassengerDetailsRQ` + `OTA_AirBookLLSRQ` + `EnhancedEndTransactionRQ`, 4 de cada                                      |
| **Modificación de asientos / SSR / FOP**             | Parcial                | `UpdatePassengerNameRecordRQ`, y todas las carpetas de _Seat modifications_ abren sesión                               |

> **Consecuencia para el roadmap:** un adapter Sabre "sólo REST" **no puede** vender LCC con ancillaries, ni
> gestionar perfiles, ni hacer group bookings. Si el alcance de Ola 1 incluye alguno de esos, el cliente SOAP + el
> parser XML + el pool de sesiones **entran en el alcance**, y eso no es una tarde de trabajo. Ver `Riesgos`.

### 6.3 Por qué el pool de sesiones **no** es un cache de tokens

Hay dos hechos del spec que, combinados, definen la arquitectura:

1. **La sesión ATH sirve para hablar SOAP con estado** — se abre, se acumula contexto (área AAA con el PNR en
   curso), se hace `EnhancedEndTransactionRQ` para commitear, se cierra.
2. **Pero cualquier llamada REST de Booking Management la limpia**: «_the session (AAA) is cleared before and after
   execution_» (**VERIFICADO-SPEC**, ×7 páginas, §1.1).

Es decir: **no se puede intercalar libremente REST y SOAP sobre la misma sesión abierta.** Un flujo como

```
SessionCreateRQ  ->  OTA_AirBookLLSRQ  ->  createBooking (REST)  ->  EnhancedEndTransactionRQ
                                            ^^^ AQUI SABRE BORRA EL AAA
```

pierde el trabajo hecho en SOAP. El orden correcto es el de WF-20: la sesión da el **token**, y las llamadas REST
son autocontenidas; el estado SOAP sólo se acumula entre mensajes SOAP consecutivos.

**Requisitos del `SabreSessionPool`:**

| Requisito                                                             | Por qué                                                                                        |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `acquire()` / `release()` con `finally` garantizado                   | El cupo de sesiones es finito; una sesión huérfana no se recupera sola                         |
| Límite de concurrencia por `provider_account` (no por proceso)        | `429 Active token count is exceeded` es por contrato de agencia, no por instancia              |
| Keepalive por inactividad                                             | Las sesiones ATH expiran por _idle_, no por TTL fijo **[INFERIDO]**                            |
| `SessionCloseRQ` en compensación de **Temporal**                      | Las sagas LCC / group booking son largas; un crash del worker no puede dejar la sesión abierta |
| Marcar la sesión como _dirty_ tras cualquier llamada REST intercalada | El AAA quedó limpio; el contexto acumulado ya no vale                                          |
| Métrica `sabre_sessions_open` por tenant + alerta                     | Sin esto, la fuga se descubre cuando la agencia deja de poder vender                           |

### 6.4 La fuga de sesiones de la propia colección — **localizada, no uniforme**

> **Corrección (hallazgo 2 de la crítica — ACEPTADO en la parte de matiz).** La primera pasada decía «12 sesiones
> fugadas» sin más. El desbalance es **73 create − 61 close = 12**, pero está concentrado en carpetas concretas:

Carpetas con `SessionCreateRQ` sin `SessionCloseRQ` hermano (**13**, todas con create=1/close=0):

```
Authentication                                                        (el ejemplar suelto, esperable)
ModifyBooking / Flight / Traveler modifications / update name - not suported by the airline
ModifyBooking / Flight / Ancillary Modifications / Add ancillaries
ModifyBooking / Flight / Ancillary Modifications / Remove ancillaries
ModifyBooking / NDC / Modify ancillaries / Add ancillaries
ModifyBooking / NDC / Modify ancillaries / Remove ancillaries
FulfillFlightTickets / Basic flow NDC / … / AA
Workflows / 27 - ATPCO - Refund ancillaries and tickets with the confirmationId.
Workflows / 28-33 NDC - Assign seats … / Seats - 1 Adult | 2 Segments | QR
Workflows / 28-33 NDC - Assign seats … / Seats - 1 Adult | 1 Segment | LO
Workflows / 28-33 NDC - Assign seats … / Seats - 2 Adults | 1 Segment | LO
Workflows / 28-33 NDC - Assign seats … / Seats - 1 Adult 1 Infant with seat | 1 Segment | AY
Workflows / 28-33 NDC - Assign seats … / Seats - 2 Adults 1 Infant with Seats | 2 Segments | AY
```

Y **1** carpeta con `SessionCloseRQ` sin `SessionCreateRQ`: `Workflows / 22 - LCC + ATPCO - Check, Refund Booking`
(cierra una sesión que abrió otro workflow — es decir, la colección **también** tiene un cierre cruzado).

**Lectura:** el patrón fugado no es aleatorio, es **el de asignación de asientos NDC (WF-28–33)** y el de
**modificación de ancillaries**. Son exactamente los flujos que más nos interesan para el Package Studio y el
upsell. Si portamos esos ejemplos literalmente, fugamos sesiones justo en los flujos de mayor volumen.

---

## 7. Vida del token y estrategia de cache

### 7.1 Lo que sabemos y lo que no — **actualizado contra el spec**

| Pregunta                                            | Respuesta                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ¿El response de `/v2/auth/token` trae `expires_in`? | **DESCONOCIDO.** 0 coincidencias de `expires_in`/`token_type`/`refresh_token` en la colección **y en los 21 specs**. Los `securityDefinitions` sólo declaran el `tokenUrl`.                                                                                                                                                                             |
| ¿Cuánto dura un ATK v2?                             | **DESCONOCIDO.** **[INFERIDO]** vida larga (orden de días). **Verificar contra sandbox.**                                                                                                                                                                                                                                                               |
| ¿Existe un límite de tokens/concurrencia?           | **VERIFICADO-SPEC: SÍ.** `401 invalid_client` menciona el **TAM Pool agotado** (`v1-errors.txt:49`) y `429 Throttled` dice «_Active token count is exceeded… contact your Sabre account manager to determine or increase your allocated concurrent request limit_» (`v1-errors.txt:195-205`). **La cifra concreta es contractual y sigue DESCONOCIDA.** |
| ¿Cuánto dura una sesión ATH?                        | **DESCONOCIDO.** **[INFERIDO]** expira por inactividad (~15 min) con cupo concurrente por agencia. **Verificar.**                                                                                                                                                                                                                                       |
| ¿Se puede refrescar?                                | **DESCONOCIDO.** No hay `refresh_token` en ninguna fuente.                                                                                                                                                                                                                                                                                              |
| ¿Qué devuelve Sabre si el token expiró?             | **VERIFICADO-SPEC.** Gateway: `401 ERR.2SG.SEC.INVALID_CREDENTIALS`. Aplicación: `UNAUTHORIZED_ACCESS / UNAUTHORIZED / "Expired or invalid security token"` dentro de un `200`. Ver §5.4.                                                                                                                                                               |

> **El dato del TAM Pool cambia una decisión.** La primera pasada decía «_[INFERIDO] Sabre limita la tasa de
> creación de tokens_» como razón para llevar el cache a Redis. **Ya no es inferencia**: el pool existe y su
> agotamiento se manifiesta como `401 invalid_client`. **El cache distribuido pasa de "conveniente" a
> "obligatorio"**: N réplicas re-autenticando en cada deploy es exactamente la forma de agotar el pool.

### 7.2 Comparación con `providers/latam-ndc/src/auth/token.service.ts`

Nuestro patrón actual (`LatamTokenService`) — verificado contra el archivo:

- cachea en memoria **por instancia del adapter**, `{ value, expiresAt }` (`token.service.ts:12-15,26`);
- coalescing con `this.inflight` para no disparar N fetches en paralelo (`token.service.ts:36-41`);
- margen de seguridad: `expiresAt = now + max(60, expires_in - 60) * 1000` (`token.service.ts:99`);
- **exige** `expires_in` en el response y lanza `LatamApiError` si falta (`token.service.ts:91-97`);
- la instancia (y por tanto el cache) la mantiene viva `LatamNdcProviderFactory` con key
  `byoc:{ownerTenantId}:{updatedAt}` (`apps/api/src/providers-latam/latam-ndc.factory.ts:29`) + `evictStale`
  (`:47`).

Qué se reusa tal cual y qué cambia para Sabre:

| Aspecto               | `latam-ndc`               | Sabre ATK                                                        | Sabre ATH                             |
| --------------------- | ------------------------- | ---------------------------------------------------------------- | ------------------------------------- |
| Coalescing `inflight` | sí                        | **reusar igual**                                                 | **imprescindible** (una sesión, no N) |
| Fuente del TTL        | `expires_in` del response | **puede no venir** → TTL configurable con default conservador    | _idle timeout_, no TTL fijo           |
| Margen                | `expires_in - 60s`        | mismo criterio si viene; si no, TTL fijo                         | keepalive periódico                   |
| Dónde vive            | memoria del proceso       | **debe ser el cache port** (TAM Pool, §7.1)                      | memoria + lease                       |
| Ante `401`            | no contemplado            | **invalidar + reintentar 1 vez**, salvo op no idempotente (§5.4) | invalidar sesión + `SessionCreateRQ`  |
| Ante `429`            | no contemplado            | **backoff ≥ 500 ms + semáforo por cuenta**                       | ídem + reducir tamaño del pool        |
| Cierre                | n/a                       | n/a                                                              | **`SessionCloseRQ` obligatorio**      |

**Tres diferencias que obligan a desviarse del patrón LATAM:**

1. **El TTL puede no venir.** `LatamTokenService` **falla duro** si falta `expires_in` (`token.service.ts:91-97`).
   Para Sabre eso rompería todo. Hay que aceptar el token con un `tokenTtlSeconds` de `config` (default
   conservador, p.ej. 3.600 s aunque el real sea de días) y **tratar el `401` como señal de expiración**:
   invalidar cache, re-autenticar, reintentar una sola vez. Es `fail loud, recover gracefully` (`CLAUDE.md` §9)
   aplicado a auth.

2. **El cache en memoria no alcanza — ahora con evidencia.** El TAM Pool y el `429 Active token count` son límites
   **por contrato de agencia**, no por proceso. El token debe ir al **cache port**
   (`packages/core/ports/`, nunca `redis` directo — `CLAUDE.md` §Anti-patrones) con clave
   `sabre:atk:{ownerTenantId}:{pcc}` y TTL igual al del token menos el margen. La clave **debe incluir el PCC**:
   el ATK está atado al par `(EPR, PCC)` porque ambos entran en el `clientId`.

3. **ATH no es un token, es un recurso con cupo.** No se cachea, se **poolea** (§6.3). Y con el matiz nuevo del
   §5.5: **consumimos sesiones aunque sólo usemos REST**, porque la API las abre internamente
   (`ATH_TOKEN_FAILURE`). El dimensionado del pool tiene que dejar margen para eso.

---

## 8. Mapeo a nuestro BYOC (`provider_accounts`, `providerCode = 'sabre'`)

Recordatorio del contrato (`db/migrations/0012_provider_accounts.sql:12-18`): `credentials_enc BYTEA` cifrado
AES-256-GCM, nunca expuesto por API; `config JSONB` no-secreto; `UNIQUE (tenant_id, provider_code, label)`;
herencia por `resolve_provider_account()` subiendo el `ltree` `path` hasta el ancestro heredable más cercano
(`:55,:73`).

### 8.1 `credentials` — **cifrado**, sólo lo que compromete la cuenta si se filtra

```json
{
  "epr": "500001",
  "password": "********",
  "clientId": null,
  "clientSecret": null
}
```

| Campo                       | Obligatorio | Por qué es secreto                                              |
| --------------------------- | ----------- | --------------------------------------------------------------- |
| `epr`                       | sí          | Es el `username`. Con el password da acceso total a la oficina. |
| `password`                  | sí          | Password del EPR.                                               |
| `clientId` / `clientSecret` | no          | Reservados para migrar a `/v3/auth/token` (§2.2).               |

**No** guardamos el `secret` calculado: es derivable y almacenarlo duplicaría el material sensible. Se computa en
cada `fetchToken()`.

### 8.2 `config` — **no cifrado**, identidad operativa y de negocio

```json
{
  "environment": "cert",
  "restEndpoint": null,
  "soapEndpoint": null,
  "homePcc": "U9PK",
  "ticketingPcc": "7KFA",
  "agencyIata": "76512345",
  "domain": "AA",
  "soapDomain": "DEFAULT",
  "conversationIdPrefix": "sales-travel",
  "applicationId": null,
  "printerHardcopyLniata": "…",
  "printerCountryCode": "CO",
  "sabreGroup": null,
  "sabreCurrentCity": null,
  "tokenTtlSeconds": 3600,
  "maxConcurrentRequests": 4,
  "sessionIdleSeconds": 600,
  "maxConcurrentSessions": 2,
  "mock": false
}
```

| Campo                             | Origen                                              | Nota                                                                                                                                                                                     |
| --------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment`                     | —                                                   | `'cert' \| 'prod'`; resuelve los dos hosts (§3.4).                                                                                                                                       |
| `restEndpoint` / `soapEndpoint`   | `rest_endpoint`, `soap_endpoint`                    | Override opcional.                                                                                                                                                                       |
| `homePcc`                         | `pcc`                                               | PCC de autenticación. **Entra en el `clientId`**, por eso `SabreConfig` lo necesita junto a `credentials`.                                                                               |
| `ticketingPcc`                    | `pcc_tkt`                                           | PCC de emisión → `targetPcc`. **Campo bisagra del modelo consolidador** (§9).                                                                                                            |
| `agencyIata`                      | — **[INFERIDO]**, no hay variable en el environment | Necesario para facturación y para el FOP `TRAVEL_AGENCY_IATA` que aparece en ModifyBooking.                                                                                              |
| `domain` / `soapDomain`           | literales `AA` / `DEFAULT`                          | Configurables por la incoherencia de §4.3.                                                                                                                                               |
| `applicationId`                   | —                                                   | Header `Application-ID`, **recomendado por Sabre** en hotel/vehicle (**VERIFICADO-SPEC**, `hotel-price-check-v5.yml:24-28`). Se pide al account manager. **Campo nuevo en esta pasada.** |
| `printerHardcopyLniata`           | `hardcopy` (16 usos)                                | `designatePrinters[].hardcopy.address`.                                                                                                                                                  |
| `printerCountryCode`              | `country_code` (15 usos)                            | `designatePrinters[].ticket.countryCode`.                                                                                                                                                |
| `sabreGroup` / `sabreCurrentCity` | `x_sabre_group`, `x_sabre_current_city`             | Si son `null`, default a `homePcc`. **Obligatorios cuando se usa `targetPcc`** (§4.2): `sabreGroup` para ATK, `sabreCurrentCity` para ATH.                                               |
| `maxConcurrentRequests`           | —                                                   | **Campo nuevo.** Semáforo por cuenta contra el `429 Active token count is exceeded` (§5.2). El valor real lo fija el contrato con Sabre.                                                 |

> **`homePcc` va en `config`, no en `credentials`** — aunque forme parte del `clientId`. Razones: (a) un PCC no es
> secreto, se imprime en el billete y el propio spec lo describe como «_pseudo city code of authorized branch_»
> (`get-hotel-avail-v4.yml:94`); (b) el comentario de la migración 0012 ya lo asigna a `config`
> (`0012_provider_accounts.sql:26`); (c) la UI de agencia necesita mostrarlo, y `credentials` nunca sale por API.
> El factory combina ambos lados, igual que `latam-ndc.factory.ts`.

### 8.3 Interface y factory — espejo del patrón `latam-ndc`

```ts
// providers/sabre/src/config.ts
export interface SabreConfig {
  restEndpoint: string;
  soapEndpoint: string;
  epr?: string;
  password?: string;
  homePcc?: string;
  ticketingPcc?: string;
  agencyIata?: string;
  domain?: string; // default 'AA'
  soapDomain?: string; // default 'DEFAULT'
  conversationIdPrefix?: string;
  applicationId?: string;
  printerHardcopyLniata?: string;
  printerCountryCode?: string;
  sabreGroup?: string;
  sabreCurrentCity?: string;
  tokenTtlSeconds?: number;
  maxConcurrentRequests?: number;
  mock?: boolean;
}

export function isMockMode(cfg: SabreConfig): boolean {
  if (cfg.mock) return true;
  return !cfg.epr || !cfg.password || !cfg.homePcc; // las 3 que construyen el clientId
}
```

Diferencias respecto a `LatamNdcProviderFactory` que hay que respetar:

- **Key de cache de instancia:** `latam-ndc` usa `byoc:{ownerTenantId}:{updatedAt}`
  (`apps/api/src/providers-latam/latam-ndc.factory.ts:29`). Para Sabre debe ser
  `byoc:{ownerTenantId}:{homePcc}:{updatedAt}` — el mismo tenant puede tener **dos `provider_accounts` con distinto
  `label`** (`0012_provider_accounts.sql:18`), típicamente `default` para reservar y `ticketing` para emitir. Sin el
  PCC en la key se mezclarían tokens de PCC distintos.
- **Fallback a env:** replicar `envConfig()` con `SABRE_*` para dev/CI, igual que `latam-ndc`.
- **`evictStale`:** reusar tal cual, ampliando el prefijo de owner al par `owner+pcc`.

### 8.4 Qué NUNCA se loguea

`password`, `secret`, `access_token`, `BinarySecurityToken`, el sobre SOAP completo del `SessionCreateRQ` (lleva el
password **en claro** dentro del XML) y el header `Authorization`. El `secret` es base64 **reversible**: loguearlo
equivale a loguear el password. Aplica `CLAUDE.md` §Seguridad.

---

## 9. Herencia del consolidador vs PCC propio

`resolve_provider_account()` devuelve la cuenta propia del tenant o, si no tiene, la del ancestro heredable más
cercano. Para Sabre esa decisión **no es sólo técnica: cambia quién es el dueño legal del PNR y quién liquida ante
BSP/ARC.**

### 9.1 Los tres modelos

|                                           | **A. Hereda todo**        | **B. PCC propio**              | **C. Híbrido (reserva propia, emisión del consolidador)**                  |
| ----------------------------------------- | ------------------------- | ------------------------------ | -------------------------------------------------------------------------- |
| `provider_account`                        | ninguna propia; hereda    | propia, `is_inheritable=false` | propia con `ticketingPcc` = PCC del consolidador                           |
| `homePcc`                                 | del consolidador          | de la agencia                  | de la agencia                                                              |
| PNR creado bajo                           | PCC del consolidador      | PCC de la agencia              | PCC de la agencia                                                          |
| Billete emitido bajo                      | IATA/ARC del consolidador | IATA/ARC de la agencia         | **IATA/ARC del consolidador**                                              |
| Liquidación BSP/ARC                       | consolidador              | agencia                        | consolidador                                                               |
| Riesgo de ADM                             | consolidador              | agencia                        | consolidador                                                               |
| Tarifas privadas visibles                 | las del consolidador      | las de la agencia              | las de la agencia al reservar                                              |
| Colas Sabre (queues)                      | del consolidador          | de la agencia                  | reserva en la agencia, emisión en el consolidador                          |
| Requiere que la agencia tenga IATA propio | **no**                    | **sí**                         | no                                                                         |
| Mecanismo API                             | ninguno extra             | ninguno extra                  | **`targetPcc`** + header `X-Sabre-*` (**VERIFICADO-SPEC**, §4.2/§4.4)      |
| Prerrequisito no-API                      | —                         | —                              | **autoridad de contexto sobre el `targetPcc`** (**VERIFICADO-SPEC**, §4.5) |

### 9.2 Modelo A — hereda las credenciales del consolidador

Es el caso de la sub-agencia sin acreditación IATA. Ante Sabre **existe un solo actor**: el consolidador.

Hipótesis operativas **[INFERIDO]** desde el modelo GDS, pendientes de confirmación comercial escrita (los
contratos del API no asignan facturación, BSP ni ADM):

- El **PNR queda a nombre del consolidador**. El `POS.Source.PseudoCityCode` que va en el body lleva el PCC del
  consolidador, y ese es el que la aerolínea ve.
- Es probable que el **billete se emita contra el IATA/ARC asociado al PCC del consolidador** y que las obligaciones
  BSP/ADM sigan esa relación, pero esto se confirma con Sabre y el contrato antes de habilitar herencia.
- **Voids, refunds y colas caen en el consolidador.** La sub-agencia no puede tocar el PNR desde su propio Sabre
  porque no tiene relación con Sabre.
- **Sabre no distingue a la sub-agencia.** Desde el GDS todas las ventas de toda la red se ven idénticas. Por tanto
  **la atribución por tenant es responsabilidad exclusiva nuestra**: hay que estampar el `tenant_id` en el PNR
  (remark / accounting line / DK number) _y_ en nuestro `domain_events`. Sin eso la reconciliación "qué vendió cada
  agencia" es imposible de auditar contra Sabre.
- Las **tarifas privadas** que ve la sub-agencia son las negociadas por el consolidador — puede ser ventaja
  (mejores netas) o problema (la agencia no ve sus propios acuerdos).
- El **pricing waterfall** debe repartir hacia abajo: la comisión llega al consolidador y nosotros la
  redistribuimos. Es contable interno, no lo hace el GDS.
- `is_inheritable = true` en la cuenta del consolidador es lo que habilita esto. Es un **interruptor con
  consecuencias financieras**, no una preferencia técnica.

### 9.3 Modelo B — la agencia trae su propio PCC

- El PNR y el billete se operan con el PCC propio de la agencia; su IATA/ARC, liquidación y riesgo de ADM se
  verifican contractualmente y no se deducen sólo del request.
- El consolidador **pierde visibilidad** salvo que en el back-office de Sabre exista _branch access_ entre el PCC
  del consolidador y el de la agencia. **No se configura desde la API**: es un trámite con Sabre. Lo que sí sabemos
  ahora es **cómo se manifiesta si no existe**: `UNABLE_TO_CHANGE_CONTEXT_UNAUTHORIZED` (**VERIFICADO-SPEC**, §4.5).
- Nuestro rol pasa a ser tecnología pura: no hay markup del consolidador sobre el neto porque el neto no pasa por
  él. **El pricing waterfall tiene que saber esto**, o cobrará un override que nadie va a liquidar.
- `is_inheritable = false` para que un hijo de esa agencia no herede sin querer credenciales que la comprometan.

### 9.4 Modelo C — el híbrido, y es el que la API favorece

Reservar con el PCC de la agencia y **emitir con `targetPcc` = PCC del consolidador** está soportado nativamente y
**la documentación oficial lo nombra como el caso de uso** (**VERIFICADO-SPEC**,
`help-documentation-create-booking.txt:118`: «_particularly useful for agencies that separate their booking,
fulfillment, and shopping across different pseudo city codes_»). La colección lo ejercita en **ambos extremos**:
`createBooking - Air with Changed PCC` con `targetPcc = {{pcc}}` **parametrizado** y
`FulfillFlightTickets - … dedicated ticketing PCC` con `targetPcc = {{pcc_tkt}}` (§4.4).

Se mapea limpiamente a nuestro schema porque `provider_accounts` ya tiene `label` en la clave única:

| `label`     | `homePcc`            | Uso                                                          |
| ----------- | -------------------- | ------------------------------------------------------------ |
| `default`   | PCC de la agencia    | shop, price, createBooking, getBooking                       |
| `ticketing` | PCC del consolidador | `fulfillFlightTickets` / `voidFlightTickets` con `targetPcc` |

Alternativa más simple: **una sola cuenta**, con `config.ticketingPcc` apuntando al PCC del consolidador y el mismo
ATK para todo. **Ahora sabemos que es viable si y sólo si el EPR autenticado tiene autoridad de contexto sobre el
`targetPcc`** (§4.5), y sabemos exactamente cómo verificarlo: una llamada de humo que devuelva
`UNABLE_TO_CHANGE_CONTEXT_UNAUTHORIZED` significa que hay que ir al modelo de dos cuentas. **Esta verificación debe
ser un paso obligatorio del wizard de onboarding BYOC**, no un descubrimiento en producción.

Advertencia NDC: `NDC_PCC_MISMATCH` (**VERIFICADO-SPEC**, §4.5) impide desacoplar shopping y booking en el carril
NDC. El modelo híbrido aplica limpio a ATPCO; en NDC hay que shoppear con el mismo PCC con el que se crea el order.

### 9.5 Regla de producto que se desprende

> Antes de activar `is_inheritable = true` en la cuenta Sabre de un consolidador, debe existir confirmación
> comercial escrita de quién es el emisor de récord y quién responde por BSP/ADM. La API demuestra la herencia
> técnica, no esa asignación contractual. La UI de BYOC debe presentar el riesgo financiero potencial como un paso
> separado, no como una casilla de configuración.

---

## Anexo — comandos para reproducir los conteos

Todos sobre `scratchpad/sabre/requests.jsonl` (1 request JSON por línea).

```js
// node -e "…"  — conteos de §1
const L = require('fs').readFileSync('requests.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
const c = (f) => L.filter(f).length;
c((r) => /REST Authorize/i.test(r.path)); // 59
c((r) => /v2\/auth\/token/.test(r.url || '')); // 59   <-- coherente
c((r) => /v3\/auth\/token/.test(r.url || '')); //  0
c((r) => /\(Stateless ATK\)/.test(r.path)); // 89
c((r) => /\(Stateful ATH\)/.test(r.path)); // 57
c((r) => /soap_endpoint/.test(r.url || '')); // 243
c((r) => /lls_endpoint/.test(r.url || '')); //  0
c((r) => /rest_endpoint/.test(r.url || '')); // 808
```

```js
// §1.2 — por workflow, CONTANDO REQUESTS (no ocurrencias de string)
const wf = L.filter((r) => /^Workflows \//.test(r.path));
const by = {};
for (const r of wf) (by[r.path.split(' / ')[1]] ??= []).push(r);
for (const [k, rs] of Object.entries(by))
  console.log(
    k,
    'soap=' + rs.filter((r) => /soap_endpoint/.test(r.url || '')).length,
    'auth=' + rs.filter((r) => /v2\/auth\/token/.test(r.url || '')).length,
    'creat=' + rs.filter((r) => /SessionCreateRQ/.test(r.path)).length,
    'close=' + rs.filter((r) => /SessionCloseRQ/.test(r.path)).length,
  );
```

```js
// §4.3 — variantes de body de SessionCreateRQ  (73 requests -> 4 variantes: 39 / 23 / 7 / 4)
const sc = L.filter((r) => /SessionCreateRQ/.test(r.path)); // 73
const g = {};
for (const r of sc) {
  const k = (r.body || '').replace(/\s+/g, ' ').trim();
  g[k] = (g[k] || 0) + 1;
}
Object.values(g).sort((a, b) => b - a); // [39, 23, 7, 4]
// OJO: buscar el tag literal '<SessionCreateRQ' devuelve 50, no 73:
//      la variante de 23 usa el prefijo de namespace '<sws:SessionCreateRQ'.
```

```js
// §6.4 — balance de sesiones por carpeta padre  (13 create-sin-close + 1 close-sin-create = neto 12)
const par = (r) => r.path.split(' / ').slice(0, -1).join(' / ');
const m = {};
for (const r of L) {
  if (/SessionCreateRQ/.test(r.path)) (m[par(r)] ??= { c: 0, x: 0 }).c++;
  if (/SessionCloseRQ/.test(r.path)) (m[par(r)] ??= { c: 0, x: 0 }).x++;
}
Object.entries(m).filter(([, v]) => v.c !== v.x);
```

```bash
# §2.2 y §3 — comparación de seguridad y hosts entre los 21 contratos
grep -n "^host:\|^basePath:\|tokenUrl\|x-base64-encode-client-credentials\|^servers:\|url:" specs/*.yml
```

---

## Preguntas abiertas

_(Se han retirado las que el spec ya respondió: hostnames REST de producción, semántica de `X-Sabre-Group` /
`X-Sabre-Current-City`, necesidad de autoridad previa para `targetPcc`, shape del error de auth, y si
`ContextChangeLLSRQ` es la única vía de cambio de PCC en REST.)_

1. **¿El response de `/v2/auth/token` trae `expires_in`?** Ni la colección ni los 21 specs lo modelan. Sin esto no
   podemos dimensionar el cache. **Capturar del sandbox en la primera llamada real.**
2. **¿Cuánto dura realmente un ATK v2?** Se asume vida larga (días) por convención; sigue siendo inferencia pura.
3. **¿Cuál es el tamaño del TAM Pool y el `allocated concurrent request limit` de nuestra agencia?** El spec
   confirma que ambos límites existen (`v1-errors.txt:49`, `:195-205`) pero las cifras son **contractuales**: hay
   que pedirlas al account manager. Determinan `maxConcurrentRequests` y el tamaño del pool de sesiones.
4. **¿Cuál es el idle timeout de una sesión ATH y cuántas sesiones concurrentes permite el contrato?** Define el
   tamaño del pool y el intervalo de keepalive. **Y**: ¿las sesiones que la propia API REST abre internamente
   (`ATH_TOKEN_FAILURE`, §5.5) consumen del mismo cupo?
5. **¿Cuál es el hostname SOAP de producción?** El REST está verificado (`api.platform.sabre.com`); el SOAP sigue
   siendo `webservices.platform.sabre.com` **por analogía**, sin contrato que lo respalde (no hay specs SOAP).
6. **`Domain`: ¿`AA` o `DEFAULT`?** El REST usa `AA` en el `clientId`; el SOAP usa `DEFAULT` en 66/73 y `AA` en 7.
   ¿Es indistinto, depende del contrato, o una de las dos ramas está mal en la colección? Ningún spec menciona
   `Domain`.
7. **Get Seats: ¿`/v1/offers/getseats` o `/v3/offers/getseats`?** Los 32 requests de la colección usan `v1`; el
   spec `get-seats-agency-3.0.yml:25-26` declara `basePath: /v3/offers`. **Discrepancia real** entre colección y
   contrato; bloquea la implementación de asientos.
8. **¿Qué credencial entregó el cliente? — RESUELTA 2026-08-25.** EPR+PCC+password para v2, disponibles fuera
   de Git. Falta inyectarlas mediante `ProviderCredentialsService` y confirmar auth/entitlements contra CERT.
9. **¿Qué es `SBR-BMAPI` / el `ClientSecret` fijo original en el `UsernameToken`?** ¿Un app id de Sabre o una credencial que no
   deberíamos replicar? Y en paralelo: **¿nos asignan un `Application-ID`?** El spec lo recomienda en hotel y
   vehicle (`hotel-price-check-v5.yml:24-28`) y no lo tenemos.
10. **¿La agencia tiene IATA propio?** Determina si el modelo por defecto de la red es A, B o C (§9).
11. **¿Qué operaciones de Booking Management son idempotentes de verdad?** De esto depende cuáles pueden llevar
    retry automático ante `401 UNAUTHORIZED_ACCESS` (§5.4). Ningún spec declara idempotency keys ni
    `Idempotency-Key` header.
12. **¿`ptrta` / `atpco_printer_address` se usa en algún flujo real?** 0 usos en 1.077 requests; los flujos de
    emisión usan `hardcopy` + `country_code`.
13. **¿El alcance de Ola 1 incluye LCC, perfiles o group bookings?** Si sí, el carril SOAP + pool de sesiones entra
    en el alcance (§6.2) y hay que estimarlo antes de comprometer fecha. **Es una decisión de producto, no
    técnica.**

## Riesgos

1. **Las credenciales no están embebidas en el environment — por diseño.** EPR+PCC+password ya están disponibles
   fuera de Git. El riesgo pendiente es operativo: inyección cifrada y smoke test de auth/entitlements sin
   imprimir `secret`, password ni token.
2. **`res.ok` no significa éxito.** Los contratos declaran casi sólo `200` y meten los errores de negocio en
   `errors[]` dentro del cuerpo (**VERIFICADO-SPEC**, §5.1). Un adapter que sólo mire el status HTTP **dará por
   confirmadas reservas que fallaron**. Es el riesgo de correctitud más caro de esta integración.
3. **`401 invalid_client` no siempre es "credencial mala".** Puede ser el **TAM Pool agotado** (**VERIFICADO-SPEC**,
   `v1-errors.txt:49`). Si nuestro auto-disable de cuentas BYOC lo trata como revocación, **tumbamos a una agencia
   entera por una saturación temporal**. La política de §5.3 no es opcional.
4. **El `type` del error no basta para decidir el reintento.** Siete errores distintos comparten
   `type = UNAUTHORIZED_ACCESS` y sólo se distinguen por una `description` en inglés de texto libre (§5.4).
   Cualquier lógica que parsee esa descripción es **frágil ante cambios no versionados de Sabre**. Mitigación:
   reintento único sólo en operaciones idempotentes, nunca en `createBooking` / `fulfill*` / `void*` / `refund*`,
   donde un reintento puede **duplicar una emisión**.
5. **El `secret` es reversible.** Base64, no hash: quien lo lea tiene el password. Un log de debug, un mensaje de
   error que incluya el header, o una traza OTel mal filtrada **filtran la credencial completa de la oficina**. Hay
   que añadir `Authorization`, `secret`, `password` y `BinarySecurityToken` al redactor de logs _antes_ de la
   primera llamada real.
6. **El sobre `SessionCreateRQ` lleva el password en claro dentro del XML.** Cualquier log del request SOAP completo
   — que es lo natural al debuggear XML — filtra el password. Riesgo mayor que en REST, donde al menos está
   codificado.
7. **Fuga de sesiones ATH, y en los flujos que más nos importan.** La colección de Sabre abre 73 y cierra 61, y las
   13 carpetas desbalanceadas son **asignación de asientos NDC y modificación de ancillaries** (§6.4). Si portamos
   esos ejemplos literalmente, agotamos el cupo justo en los flujos de mayor volumen. `SessionCloseRQ` tiene que
   estar en un `finally` y, para sagas largas, en una compensación de Temporal.
8. **Consumimos sesiones aunque nunca abramos una.** `ATH_TOKEN_FAILURE` demuestra que la API REST crea tokens ATH
   internamente para orquestar `ContextChangeLLSRQ` / `GetReservationRQ` / `OTA_AirBookLLSRQ` (**VERIFICADO-SPEC**,
   §5.5). El dimensionado del pool que hagamos **subestimará el consumo real** si no lo tiene en cuenta.
9. **`UNABLE_TO_CHANGE_CONTEXT_FINISH_IGNORE` deja el contexto en un PCC que no es el nuestro.** «_System could not
   revert context_» (**VERIFICADO-SPEC**, §4.5). Si tras un `targetPcc` la reversión falla y seguimos operando,
   podemos ejecutar la siguiente operación **en la oficina equivocada**. Debe abortar la saga y alertar, nunca
   reintentar en silencio.
10. **PCC de terceros hardcodeados.** `U9PK`, `G7RE`, `7KFA`, `G7HE`, `N87F`, `GF1I` aparecen fijos en headers y
    bodies. Portar un ejemplo sin parametrizar significaría **operar contra la oficina de otra agencia**.
11. **La fuente distribuía un `ClientSecret` fijo en claro.** La copia versionada lo reemplaza por
    `{{soap_client_secret}}`. Si fuera una credencial real, Sabre debe rotarla; no replicarla.
12. **26 requests apuntan a variables de endpoint inexistentes** (`getBooking_endpoint`, etc.). Cualquier suite de
    pruebas portada literalmente fallará de forma confusa.
13. **Sin `expires_in`, un TTL mal elegido rompe en producción.** Demasiado largo → 401 intermitentes bajo carga;
    demasiado corto → agotamiento del TAM Pool. Mitigación obligatoria: **retry único ante 401 con invalidación de
    cache** + cache distribuido, no confiar sólo en el reloj.
14. **`429 Active token count is exceeded` es un límite de concurrencia por agencia, no por proceso.** Nuestro
    fan-out multi-proveedor (`search.service.ts`) escala la concurrencia con el número de vendedores buscando. Sin
    un semáforo por `provider_account`, **una campaña de ventas exitosa nos throttlea a nosotros mismos**.
15. **Dependencia SOAP+XML para LCC, perfiles, asientos y SSR.** No es opcional: sin `SessionCreateRQ` esos flujos
    no existen (§6.2). Obliga a meter un cliente SOAP y un parser XML en un stack que hoy es JSON puro, y a
    construir un pool de sesiones que `latam-ndc` no necesitó. **Es la mayor desviación arquitectónica del patrón
    existente — 243 de 1.077 requests — y hay que dimensionarla antes de comprometer fecha.**
16. **Discrepancia de versión de path en Get Seats** entre colección (`v1`) y contrato (`v3`). Implementar contra la
    fuente equivocada da `403 ERR.2SG.CLIENT.SERVICE_UNKNOWN`, que es un error confuso de diagnosticar.
17. **La herencia de credenciales puede tener consecuencias financieras, no sólo técnicas.** `is_inheritable = true`
    hace que la red opere con la cuenta del consolidador; quién queda como emisor de récord y responsable de ADM se
    confirma por contrato. Si la UI lo presenta como un toggle más, el founder puede asumir un riesgo que no vio.
18. **Sin atribución explícita por tenant en el PNR, la reconciliación es imposible.** En modelo heredado Sabre ve un
    único actor. Si no estampamos `tenant_id` en el PNR _y_ en `domain_events` desde la primera reserva, no habrá
    forma de auditar quién vendió qué contra los datos del GDS.
