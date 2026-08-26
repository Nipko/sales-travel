/**
 * Redacción de secretos y PII antes de que nada llegue a un transporte de logs (RNF-07, R-13).
 *
 * Por qué existe este módulo y por qué se escribió ANTES que el cliente HTTP: el `secret` de
 * Sabre es `base64(base64("V1:epr:pcc:AA") + ":" + base64(password))`. Es **reversible**, no un
 * hash. Un `console.debug` del header `Authorization` publica el password de la oficina en claro
 * (docs/sabre/01 §2.1 obs. 1, §8.4).
 *
 * Invariante que ordena todo el archivo, y que una auditoría adversarial rompió en la versión
 * anterior: **la protección no puede depender del tamaño del body**. La versión anterior apagaba
 * la redacción por clave por encima de 20.000 caracteres y dejaba sólo regex — y dos de los tres
 * fixtures oficiales de BFM pesan 24.980 y 29.216 bytes, así que el camino "degradado" era el
 * camino normal de una búsqueda. Aquí no hay umbral: el resumen se produce con un escáner JSON
 * incremental que redacta **mientras** avanza y se para cuando ha llenado el presupuesto de
 * salida, no cuando la entrada es grande.
 *
 * ---
 *
 * ## Límite conocido y ACEPTADO (re-auditoría)
 *
 * Un dato de PII **sin clave que lo identifique y sin forma verificable** no se redacta. Los dos
 * casos concretos: un número de pasaporte suelto en texto libre (`"el pasajero AB1234567 no
 * embarcó"`) y ese mismo número como elemento pelado de un array (`"docs":["AB1234567"]`).
 *
 * No es un descuido pendiente de arreglar: **no se puede cerrar sin falsos positivos**. `AB1234567`
 * es tipográficamente indistinguible de un localizador (PNR), de un código de tarifa o de un
 * `OfferItemID`, y ninguno de los tres puede desaparecer del resumen sin dejar el log inútil para
 * diagnosticar. Un pasaporte no tiene checksum publicado con el que confirmarlo, que es justo lo
 * que sí permite tapar un PAN suelto (Luhn) o un `secret` suelto (el prefijo `VmpF`/`VjE6`).
 *
 * Queda escrito aquí para que nadie lo lea como "cubierto": lo que protege ese caso es que la PII
 * de pasajero viaja SIEMPRE bajo clave en los contratos de Sabre (`passportNumber`,
 * `documentNumber`), y esa vía sí está cerrada por clave, por fragmento de clave y en las dos
 * posiciones —clave y valor— desde la re-auditoría.
 *
 * ## Segundo límite ACEPTADO: la credencial en prosa sin forma
 *
 * Una credencial escrita en prosa —clave y valor separados por espacio o por dos puntos, sin
 * comillas, sin `=` y sin etiqueta XML— no la ve ninguno de los tres carriles estructurados
 * (`JSON_PAIR`, `FORM_PAIR`, `XML_ELEMENT`). Es la forma de `"invalid credentials for password
 * Pa55w0rd!"`. Desde esta ronda la cubre {@link redactProseCredentials}, pero **sólo cuando el
 * valor no es una palabra**: se exige un dígito o un símbolo (ver `looksLikeProseCredential`).
 *
 * Lo que queda fuera, y se acepta: un password de sólo letras (`password correcthorse`). Cerrarlo
 * significaría borrar la palabra que sigue a `password` en cualquier frase de ayuda o de
 * diagnóstico —`"password rejected by policy"`— y el resumen existe justamente para diagnosticar.
 * El falso negativo cuesta una credencial que además hay que adivinar; el falso positivo cuesta
 * media línea de log en TODOS los errores. Se elige el gate de dígito-o-símbolo.
 *
 * El otro lado del mismo trato, también aceptado: lo que siga a una clave sensible y lleve dígitos
 * se tapa aunque sea un código de diagnóstico (`"token ERR.2SG.SEC.NOT_AUTHORIZED"`). Es
 * fail-closed deliberado y NO afecta a la clasificación, que `errors.ts` decide sobre el cuerpo
 * crudo; un código suelto o bajo clave inocua sigue saliendo entero.
 *
 * ## Tercer carril: el TEXTO LIBRE del proveedor (ver {@link FREE_TEXT_KEYS})
 *
 * Los diez carriles de arriba buscan una CLAVE sensible o una FORMA verificable. La prosa del
 * proveedor no tiene ninguna de las dos: `description`, `message` o `text` son claves inocuas cuyo
 * valor es una frase en inglés, y una frase no tiene forma. Ahí es donde Sabre —que es agregador—
 * mete lo que le devuelve el sistema de detrás. No es una hipótesis: la lista oficial de errores de
 * Booking Management publica las plantillas
 * (`docs/sabre/evidence/specs/help/booking-management-api-v1/help-documentation-*-error-list.txt`)
 * y son interpolaciones — `PNR %s not found for specified ticket`, `%s booking has already been
 * canceled by the airline`, `The (service ActionCode) service returned an error: (code: [%s]
 * message: [%s])`— rematadas por la nota del propio proveedor: «Variable %s contains information
 * returned dynamically by the downline service». BFM v3 lo dice todavía más claro del campo `text`:
 * «Free text dependent on the issuing party» (`bargain-finder-max-v3.yml:2594`).
 *
 * Se decide **no dejar viajar el texto libre**, con el mismo criterio que ya se aplicó a
 * `SabreIssue` en la ronda 5: el diagnóstico se apoya en los campos ESTRUCTURADOS —`category`,
 * `type`, `code`/`errorCode`, `fieldPath`, `severity`, `status`— que son vocabulario cerrado del
 * contrato y siguen saliendo enteros. La marca {@link FREE_TEXT} es distinta de {@link REDACTED} a
 * propósito: dice «aquí había prosa del proveedor y se omitió», no «aquí había un secreto», y quien
 * necesite la frase exacta la pide con el `Conversation-ID`, que sí va en el log.
 *
 * El coste está repartido y por eso la lista es CORTA y de coincidencia EXACTA, nunca por
 * fragmento: tapar de más deja los errores indiagnosticables, que es el otro fallo de producción.
 * Se excluyen a propósito `fieldPath`/`fieldName` (nombran la estructura, no el dato), `reason` y
 * `content` (el contrato los documenta como códigos: `ABC1`, `IATA`), y `details` (array
 * estructurado). Cada entrada está justificada contra los 21 contratos y el precio se paga en
 * `redaction.free-text.test.ts`, que mide el falso positivo contra los ejemplos oficiales.
 */

import type { LoggerPort } from '@sales-travel/core';

/** Marca visible en el log: si aparece, la redacción funcionó. */
export const REDACTED = '«REDACTADO»';

/**
 * Marca del texto libre omitido. Deliberadamente distinta de {@link REDACTED}: quien lee el log
 * tiene que poder distinguir «había un secreto» de «había prosa del proveedor que no se transporta».
 */
export const FREE_TEXT = '«TEXTO-LIBRE»';

/**
 * Claves cuyo valor jamás sale de este proceso. Se comparan en minúsculas y sin separadores,
 * para que `access_token`, `accessToken` y `Access-Token` caigan todas en la misma regla.
 *
 * `epr`, `homePcc`, `clientId` y la familia de PCCs están aquí aunque un PCC se imprima en el
 * billete: los tres son los factores del `clientId` `V1:{EPR}:{PCC}:{Domain}`, o sea la mitad
 * de identidad del `secret`. Quien junta esa mitad con un password filtrado tiene la oficina.
 */
const SECRET_KEYS = new Set([
  'authorization',
  'proxyauthorization',
  'secret',
  'clientsecret',
  'authsecret',
  'password',
  'passwordraw',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'token',
  'bearer',
  'binarysecuritytoken',
  'conversationtoken',
  'apikey',
  'xapikey',
  'usernametoken',
  // Identidad de la cuenta BYOC: componen el clientId, o derivan de él.
  'epr',
  'eprid',
  'epruserid',
  'agentepr',
  'clientid',
  'homepcc',
  'pcc',
  'targetpcc',
  'ticketingpcc',
  'sourcepcc',
  'agencypcc',
  'pseudocity',
  'pseudocitycode',
  'sabrecurrentcity',
  'sabregroup',
  'agencyiata',
  'iatanumber',
  /** `sabre:atk:{tenant}:{pcc}` — la clave de caché lleva el PCC dentro. */
  'cachekey',
]);

/**
 * PII de pasajero. `getBooking` y `createBooking` hacen **eco de la request entera**: pasaportes,
 * fechas de nacimiento y tarjetas enmascaradas incluidas (docs/sabre/10 RNF-07).
 */
const PII_KEYS = new Set([
  'givenname',
  'surname',
  'middlename',
  'firstname',
  'lastname',
  'birthdate',
  'dateofbirth',
  'email',
  'emailaddress',
  'phone',
  'phonenumber',
  'documentnumber',
  'passportnumber',
  'nationalid',
  'cardnumber',
  'creditcardnumber',
  'cardsecuritycode',
  'securitycode',
  'cvv',
  'namenumber',
  'address',
  'addressline',
]);

/**
 * Fragmentos que bastan para condenar una clave. Existen porque la lista exacta siempre va por
 * detrás del proveedor: `accessTokenExpiresIn`, `targetPccOverride` o `passportExpiryDate` son
 * claves que nadie escribió en el Set y que igualmente no pueden salir.
 *
 * Se aplican sobre la clave normalizada. Se eligen fragmentos que no aparecen en vocabulario
 * inocuo de viajes (`pcc` sí, `name` o `code` jamás).
 */
const SECRET_KEY_MARKERS: readonly string[] = [
  'password',
  'passwd',
  'secret',
  'apikey',
  'token',
  'authorization',
  'clientid',
  'privatekey',
  'credential',
  'pseudocity',
  'pcc',
];

const PII_KEY_MARKERS: readonly string[] = [
  'passport',
  'cardnumber',
  'creditcard',
  'cardholder',
  'securitycode',
  'nationalid',
  'documentnumber',
  'dateofbirth',
  'birthdate',
  'emailaddress',
  'phonenumber',
  'cvv',
  'cvc',
];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Tope de análisis de una CLAVE. Ningún identificador de los 21 contratos se acerca: el más largo
 * es `SystemSpecificResults`. Más allá de esto no hay nombre de campo, hay relleno del proveedor.
 *
 * No es cosmético, es el invariante del módulo: **el coste no puede depender del tamaño de la
 * entrada**. `redaction.stream-gaps.test.ts` manda una clave de 1 MB a propósito, y sin este tope
 * el troceado en palabras corre sobre el megabyte entero — en la primera versión de esta ronda ese
 * test pasó de milisegundos a 13 minutos, que es la misma avería que el umbral de 20.000 caracteres
 * que este archivo existe para no volver a tener, sólo que por el otro lado.
 */
const MAX_KEY_ANALYSIS_CHARS = 512;

/**
 * `PascalCase`/`camelCase` → frontera. `[A-Z]` suelto y **no** `[A-Z]+`: con el cuantificador, una
 * tirada larga de mayúsculas hace que el motor consuma hasta el final y retroceda desde cada
 * posición —backtracking cuadrático—, y la clave hostil de 1 MB es exactamente una tirada de
 * mayúsculas. `HTTPPwd` sigue partiéndose igual (`HTT` + `Pwd`), que es lo único que este troceado
 * necesita.
 *
 * **Redundante con {@link MAX_KEY_ANALYSIS_CHARS}, y así queda escrito.** Medido con las cuatro
 * combinaciones: con el tope puesto, volver al cuantificador `+` no tiene efecto observable —el
 * troceado nunca ve más de 512 caracteres—; sin el tope, el cuantificador `+` dispara el test del
 * reloj (300 s) y el de un solo carácter no (2 s). O sea: cada mitad basta por separado para la
 * entrada medida. Se dejan las dos, pero el que se puede MEDIR es el tope, y por eso es el que
 * lleva el test; esta línea es endurecimiento, no la defensa. Decir lo contrario sería exactamente
 * el comentario que promete de más contra el que se escribió media auditoría de este paquete.
 *
 * Lo anterior habla del CUANTIFICADOR. Las dos reglas en sí no son redundantes y cada una tapa
 * claves distintas: la segunda —`([A-Z])([A-Z][a-z])`— es la única que parte un prefijo en
 * mayúsculas pegado a la abreviatura (`LDAPPwd` → `LDAP` + `Pwd`), forma que ni el Set aplastado ni
 * {@link SECRET_KEY_ABBREVIATION_SHAPE} ven. Borrarla dejaba la suite verde hasta la ronda 12; hoy
 * la fijan `LDAPPwd`/`SMTPPwd`/`HTTPPwd` en `redaction.key-abbreviations.test.ts`.
 */
const KEY_WORD_BOUNDARIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/([a-z0-9])([A-Z])/g, '$1 $2'],
  [/([A-Z])([A-Z][a-z])/g, '$1 $2'],
];

/**
 * Palabras de la clave, con las fronteras REALES: separadores (`_`, `-`, `.`, espacio) y cambios
 * de caja (`pwdHash` → `pwd`,`hash`; `sabrePwdForTenant` → `sabre`,`pwd`,`for`,`tenant`).
 *
 * Existe porque {@link normalizeKey} borra justamente la información que distingue una abreviatura
 * de una coincidencia accidental: `groupWarning` normalizado contiene `pw`, y `groupSwitch`
 * contiene `psw`. Buscar esas abreviaturas como FRAGMENTO del nombre aplastado tapa media búsqueda;
 * buscarlas como PALABRA no puede, porque en `groupWarning` las palabras son `group` y `warning`.
 */
function keyWords(key: string): readonly string[] {
  let spaced = key.length > MAX_KEY_ANALYSIS_CHARS ? key.slice(0, MAX_KEY_ANALYSIS_CHARS) : key;
  for (const [pattern, replacement] of KEY_WORD_BOUNDARIES)
    spaced = spaced.replace(pattern, replacement);
  return spaced
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

/**
 * Abreviaturas de credencial que condenan la clave con sólo aparecer como PALABRA suya.
 *
 * Fuga MEDIDA antes de esta ronda: de 20 variantes de «password» que aparecen en payloads reales y
 * en logs de terceros, 17 publicaban el valor EN CLARO por `redactMeta` y por `safeBodySummary`.
 * `SECRET_KEY_MARKERS` sólo conocía la palabra entera (`password`, `passwd`), y la mitad de lo que
 * escribe un backend de verdad es `pwd`, `pw`, `psw`, `userpwd` o `pwdHash`.
 *
 * `pass` **no está aquí a propósito**: como palabra suelta es ambigua —`boardingPass` es un
 * concepto del contrato, no una credencial— y taparla borraría diagnóstico. `pass` sólo se condena
 * por la forma de la clave ENTERA, ver {@link SECRET_KEY_ABBREVIATION_SHAPE}.
 */
const SECRET_ABBREVIATION_WORDS = new Set([
  'pw',
  'pwd',
  'pwds',
  'pword',
  'psw',
  'pswd',
  'pwrd',
  'passw',
  'passwrd',
  'passcode',
  'passphrase',
  'passkey',
]);

/**
 * La clave ENTERA es una credencial: un calificador de propiedad opcional, el núcleo de la
 * abreviatura, y un sufijo opcional de representación.
 *
 * Se ancla a los dos extremos (`^…$`) y el calificador es una LISTA CERRADA, no `[a-z]*`, y las dos
 * cosas son load-bearing — es lo que hace que `pass` se pueda cubrir sin falso positivo:
 *
 *   - `pass`, `userPass`, `oldPwd`, `accountPwd`, `passHash` → credencial, se tapa.
 *   - `passenger`, `passengerInfo`, `passengers`, `passengerName` → el sufijo `enger…` no está en
 *     la lista, así que no casa y el diagnóstico de una búsqueda sale entero.
 *   - `boardingPass`, `bypassCache`, `compass`, `passType` → el calificador `boarding`/`by`/`com`
 *     no está en la lista, o el sufijo `type` no lo está. Siguen saliendo.
 *
 * Un `[a-z]*` de calificador convertiría `boardingPass` y `bypass` en `«REDACTADO»`, que es
 * exactamente el falso positivo que este módulo se niega a pagar.
 */
const SECRET_KEY_ABBREVIATION_SHAPE = new RegExp(
  '^' +
    '(?:user|usr|users|my|own|admin|agent|account|acct|client|login|logon|db|app|sabre|epr|' +
    'old|new|current|temp|tmp|initial|default|master|basic|proxy|auth|secure)?' +
    '(?:pass|passw|passwd|passwrd|passcode|passphrase|passkey|pw|pwd|pword|psw|pswd|pwrd)' +
    '(?:hash|hashed|raw|plain|plaintext|clear|cleartext|value|val|enc|encrypted|encoded|digest|' +
    'salt|salted|b64|base64|confirm|confirmation|repeat|\\d{1,2})?' +
    '$',
);

export function isSecretKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return (
    SECRET_KEYS.has(normalized) ||
    SECRET_KEY_MARKERS.some((mark) => normalized.includes(mark)) ||
    SECRET_KEY_ABBREVIATION_SHAPE.test(normalized) ||
    keyWords(key).some((word) => SECRET_ABBREVIATION_WORDS.has(word))
  );
}

/**
 * PII de contacto que condena la clave con aparecer como PALABRA suya.
 *
 * Cierra la familia de compuestos que ni el Set ni los marcadores veían: `contact_phone` no es
 * `phone` (el Set compara exacto) y no contiene `phonenumber` (el marcador compara fragmento), así
 * que salía EN CLARO — medido. `emergencyEmail`, `travelerPhone` o `agentEMail` son la misma forma.
 *
 * Por PALABRA y no por fragmento, por la razón de siempre: `phoneticName` contiene `phone` y no es
 * un teléfono. Con fronteras reales sus palabras son `phonetic` y `name`, y sigue saliendo.
 *
 * `tel` y `mobile` se dejan FUERA a propósito: `telAvivAirport` y `mobileVersion` son vocabulario
 * legítimo y taparlos cuesta diagnóstico. La forma larga (`telephone`) sí está.
 */
const PII_ABBREVIATION_WORDS = new Set([
  'email',
  'mail',
  'phone',
  'telephone',
  'msisdn',
  'dob',
  'ssn',
]);

export function isPiiKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return (
    PII_KEYS.has(normalized) ||
    PII_KEY_MARKERS.some((mark) => normalized.includes(mark)) ||
    keyWords(key).some((word) => PII_ABBREVIATION_WORDS.has(word))
  );
}

/** Única puerta de decisión por clave: la usan el escáner, `redactValue` y `redactText`. */
export function isSensitiveKey(key: string): boolean {
  return isSecretKey(key) || isPiiKey(key);
}

/**
 * Claves cuyo valor es PROSA DEL PROVEEDOR o ECO DE LA REQUEST. No son secretos ni PII por sí
 * mismas: son el hueco por el que puede salir cualquiera de las dos sin clave que lo delate y sin
 * forma que lo confirme (ver el bloque «Tercer carril» de la cabecera).
 *
 * **Coincidencia EXACTA, jamás por fragmento.** Los fragmentos existen para `SECRET_KEY_MARKERS`
 * porque allí el falso positivo cuesta media línea de log; aquí costaría campos estructurados
 * enteros: `messageId`, `textFormat` o `descriptionCode` no son prosa y tienen que seguir saliendo.
 *
 * Justificación por entrada contra los 21 contratos de `docs/sabre/evidence/specs/`:
 *
 * - `description` — `Error.description` de Booking Management (`booking-management-v1.yml:4286`),
 *   el campo cuyas plantillas oficiales interpolan PNR y respuestas del sistema de detrás.
 * - `errordescription` — `error_description` de OAuth2. Es donde Sabre hace eco del `clientId` y
 *   del `secret` cuando el Basic va mal armado (docs/sabre/01 §5.3). Ya lo tapaban las pasadas por
 *   forma; aquí deja de depender de que el eco tenga una forma reconocible.
 * - `message`, `errormessage`, `statusmessage` — el `message` de la capa de transporte
 *   (`{status, type, errorCode, timeStamp, message}`, docs/sabre/09 §2.1). Es la entrada más cara
 *   de la lista y se acepta: el `errorCode` `ERR.2SG.*`, el `status` y el `kind` que sale de
 *   clasificar sobre el cuerpo CRUDO siguen en el log y son lo que decide la política.
 * - `text` — `MessageType.text` de BFM: «Free text dependent on the issuing party».
 * - `freetext` — el nombre lo dice.
 * - `fieldvalue` — `Error.fieldValue`, «The field value of the request». Es el eco LITERAL de un
 *   valor que nosotros mandamos: si el error fue en `passportNumber`, el pasaporte está aquí. Es
 *   exactamente el campo que `SabreIssue` deja fuera desde la ronda 5.
 * - `remark`/`remarks`, `comment`/`comments`, `note`/`notes` — prosa escrita por un agente humano
 *   dentro del PNR, que `getBooking` devuelve y que puede contener cualquier cosa.
 */
const FREE_TEXT_KEYS = new Set([
  'description',
  'errordescription',
  'message',
  'errormessage',
  'statusmessage',
  'text',
  'freetext',
  'fieldvalue',
  'remark',
  'remarks',
  'comment',
  'comments',
  'note',
  'notes',
]);

export function isFreeTextKey(key: string): boolean {
  return FREE_TEXT_KEYS.has(normalizeKey(key));
}

/**
 * **Única** decisión de «qué marca le toca a esta clave», y por eso la única que fija la
 * PRECEDENCIA: un secreto se tapa como secreto aunque también fuese texto libre. Los cuatro sitios
 * que enmascaran por clave —`redactValue`, los tres carriles de `redactByKeyRails` y el escáner—
 * la llaman a ella; ninguno vuelve a preguntar por su cuenta. Escribir la precedencia dos veces es
 * cómo se llega a que un carril tape con una marca y el otro con la contraria.
 *
 * `null` = la clave no manda nada; el valor sigue su camino normal (recursión o pasadas por forma).
 */
function maskForKey(key: string): string | null {
  if (isSensitiveKey(key)) return REDACTED;
  if (isFreeTextKey(key)) return FREE_TEXT;
  return null;
}

/**
 * Claves cuyo valor es una RUTA. No son sensibles —la ruta dice qué se rompió y es lo único que
 * queda para diagnosticar— pero su **query string** sí lo es siempre.
 *
 * Los seis alias de `path` no son adorno y tampoco son alcanzables desde este paquete: el cliente
 * HTTP sólo emite `path`, y quien loguea `url`/`endpoint` es el consumidor que importa
 * {@link redactMeta}. Que la lista siga completa lo fija `redaction.path-key-rails.test.ts` §3 por
 * esa misma puerta, con el control que enseña qué cuesta cada alias que falte: bajo una clave que
 * no esté aquí, la ruta no recibe esta política sino {@link redactText}, y `LONG_BASE64_RUN` se la
 * come entera. O sea, el precio de olvidar un alias no es una fuga, es un log ciego.
 */
const PATH_KEYS = new Set(['path', 'url', 'uri', 'href', 'endpoint', 'requesturi', 'requesturl']);

function isPathKey(key: string): boolean {
  return PATH_KEYS.has(normalizeKey(key));
}

/**
 * Tira la query string (y el fragmento) de una ruta, conservando la ruta.
 *
 * Por qué no basta con redactar por clave: la redacción por clave sólo tapa los parámetros que
 * alguien enumeró. `passportNumber=…` cae en la lista; `pnr=XKCD12` o `recordLocator=…` no, y un
 * localizador en el log de una búsqueda es exactamente lo que RNF-07 prohíbe. La query es
 * estructuralmente insegura —no la construimos nosotros, y por ahí es por donde entra lo que el
 * llamador pegue— así que se tira ENTERA en vez de enumerar lo que se salva.
 *
 * Interna a propósito: la puerta única de la política de rutas es {@link redactPath}. Dos símbolos
 * exportados para la misma regla es cómo empieza la divergencia que se está cerrando aquí.
 */
function stripUrlQuery(value: string): string {
  const cut = value.search(/[?#]/);
  return cut < 0 ? value : `${value.slice(0, cut)}?${REDACTED}`;
}

/**
 * **La regla canónica de RUTA.** Única implementación de «conservar la ruta, tirar la query y el
 * fragmento, y no dejar que la redacción por forma se coma la ruta».
 *
 * ## Por qué existe como función propia y no como `redactText(stripUrlQuery(x))`
 *
 * Porque `redactText` **borraría la ruta entera**. `LONG_BASE64_RUN` es la única de las pasadas por
 * forma cuyo alfabeto incluye `/`, y una ruta real de Sabre cumple sus tres condiciones a la vez:
 * `/v1/trip/orders/getBookingSummary` son 33 caracteres de `[A-Za-z0-9+/]` con mayúscula, minúscula
 * y dígito, así que `looksHighEntropy` la condena. Medido antes de esta ronda: `redactMeta` publicaba
 * `«REDACTADO»` en lugar de la ruta en `sabre.http.ok`, o sea que la traza de
 * `/v1/trip/orders/fulfillFlightTickets` —una operación con dinero— salía ciega. No era fuga, era
 * ceguera; y las dos rompen el log por motivos opuestos.
 *
 * La respuesta NO es saltarse toda la redacción, que es lo que hacía la copia que vivía en
 * `errors.ts`: es aplicar las nueve pasadas que no pueden comerse una ruta y apagar sólo la décima.
 * Un `Bearer …`,
 * un JWT (`eyJ…`), el `secret` de Sabre (`VmpF…`/`VjE6…`), el `clientId` (`V1:…`) o un PAN metidos
 * en un segmento de ruta siguen tapados aquí.
 *
 * ## Límite ACEPTADO
 *
 * Un blob opaco de alta entropía en un SEGMENTO de ruta que no sea ninguna de esas cinco formas no
 * se tapa. Se acepta porque el vector real —lo que no construimos nosotros— es la query, y la query
 * se tira entera; las rutas las escribe este paquete como constantes. Cerrarlo exigiría el rail que
 * acabamos de apagar, y su falso positivo es borrar la ruta de TODOS los logs.
 *
 * ## Un solo sitio
 *
 * Se aplica en {@link redactMeta}, no en cada llamador: el cliente HTTP mete el `path` crudo en la
 * meta de `sabre.http.ok` y de `sabre.http.entitlement_parcial`, y en los dos `warn` sólo se salva
 * porque un spread posterior pisa el campo. Una protección que depende del orden de dos líneas en
 * el llamador no es una protección.
 *
 * ## Una sola implementación, y ahora de verdad
 *
 * `errors.ts` tenía una segunda copia, `safeErrorPath`, que sólo tiraba la query y no aplicaba
 * NINGUNA pasada por forma: un `Bearer`, un JWT o el `secret` de Sabre metidos en un segmento de
 * ruta llegaban enteros a `error.message` y a `error.path`. El informe de la ronda 5 dio los
 * duplicados por consolidados y para éste no era cierto —lo que se hizo fue extraer esta función y
 * DEJAR la copia—, así que durante una ronda entera hubo un comentario afirmando en pasado algo que
 * no había ocurrido. Es la forma exacta del incidente de la ronda 2.
 *
 * Desde esta ronda `errors.ts` hace `import { redactPath }` y `safeErrorPath` ya no existe. Que
 * siga siendo así no depende de que alguien lea esto: `redaction.single-path-rule.test.ts` se pone
 * rojo si el símbolo reaparece, si `errors.ts` deja de importar la regla canónica, o si las dos
 * observaciones de la misma ruta —`error.path` y el `path` del log— dejan de coincidir.
 */
/**
 * ## Qué fija cada una de las tres llamadas
 *
 * `stripUrlQuery` y las pasadas por forma llevaban red desde la ronda 5
 * (`redaction.single-path-rule.test.ts`). `redactByKeyRails` —la del medio— no llevaba ninguna:
 * borrarla dejaba los 1.298 tests en verde. El portador que la ejercita no es la query, que ya se
 * ha tirado antes de llegar aquí, sino el parámetro de MATRIZ (`;access_token=…`, RFC 3986 §3.3);
 * desde la ronda 12 lo fija `redaction.path-key-rails.test.ts` §1.
 */
export function redactPath(value: string): string {
  // Primero se tira lo que no controlamos; las pasadas por forma sólo corren sobre lo que queda.
  return redactShapeRails(redactByKeyRails(stripUrlQuery(value)), { collapseBase64Runs: false });
}

const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 20;

/**
 * Redacta recursivamente un valor cualquiera. Corta en profundidad y en longitud de array: el
 * objetivo es un log legible, no un volcado.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_DEPTH) return '«PROFUNDIDAD-MAX»';

  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactValue(item, depth + 1));
    return value.length > MAX_ARRAY_ITEMS
      ? [...head, `«+${value.length - MAX_ARRAY_ITEMS} más»`]
      : head;
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const mask = maskForKey(key);
      if (mask !== null) {
        out[key] = mask;
        continue;
      }
      // Una RUTA no pasa por `redactText`: su rail de tirada base64 se comería la ruta entera.
      // Toda la política de rutas —query fuera, ruta dentro, formas tapadas— vive en `redactPath`.
      out[key] =
        isPathKey(key) && typeof item === 'string'
          ? redactPath(item)
          : redactValue(item, depth + 1);
    }
    return out;
  }

  return '«NO-SERIALIZABLE»';
}

/**
 * Par `"clave": valor` dentro de una cadena. Se captura **cualquier** clave y se decide en el
 * replacer con {@link isSensitiveKey}: así una clave nueva en los Sets queda cubierta también en
 * el carril textual, sin tener que mantener dos listas que se desincronizan.
 */
const JSON_PAIR =
  /"([A-Za-z0-9_.\- ]{1,64})"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d[\d.eE+-]*|true|false|null)/g;

/** Par `clave=valor` de un `application/x-www-form-urlencoded` (el body de `/v2/auth/token`). */
const FORM_PAIR = /([A-Za-z0-9_.-]{1,64})=([^&\s"'<>]+)/g;

/** `<Password>…</Password>` y compañía: el carril SOAP manda `UsernameToken` en XML. */
const XML_ELEMENT = /<([A-Za-z0-9_.:-]{1,64})((?:\s[^>]*)?)>([^<]*)<\/\1>/g;

const BEARER_OR_BASIC = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/**
 * El `clientId` en claro. Es la mitad de identidad del `secret` y viaja tal cual en los
 * `error_description` de Sabre cuando el Basic va mal armado (docs/sabre/01 §5.3).
 */
const SABRE_CLIENT_ID = /\bV1:[A-Za-z0-9._-]{1,32}:[A-Za-z0-9._-]{1,16}:[A-Za-z0-9._-]{1,16}/g;

/**
 * El `secret` por FORMA, sin depender de que venga precedido de `Basic` ni de una clave.
 *
 * Como el `clientId` empieza SIEMPRE por `"V1:"`, `base64(clientId)` empieza siempre por `VjE6`
 * y `base64(base64(clientId) + ":" + …)` —el `secret` completo— empieza siempre por `VmpF`.
 * Verificado derivando el secret con `deriveSabreSecret`.
 */
const SABRE_SECRET_SHAPE = /\b(?:VmpF|VjE6)[A-Za-z0-9+/=]{8,}/g;

const JWT_SHAPE = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]+)?/g;

/**
 * Cualquier tirada larga del alfabeto base64. El filtro de entropía (mayúscula + minúscula +
 * dígito) es lo que separa un ATK de una palabra larga, de un código en mayúsculas o de un id
 * numérico: ninguno de esos tres mezcla los tres tipos de carácter.
 */
const LONG_BASE64_RUN = /[A-Za-z0-9+/]{32,}={0,2}/g;

/**
 * Candidato a PAN: 13-19 dígitos con separadores opcionales. Se confirma con Luhn.
 *
 * Los bordes son `(?<![0-9])`/`(?![0-9])` y NO `\b`, que es lo que había: `\b` exige que el
 * vecino no sea alfanumérico, así que un PAN pegado a una letra —`"pago 4111111111111111x"`, o el
 * mismo PAN dentro de un identificador que el proveedor concatena— no casaba en ninguna posición
 * y salía entero. Medido: con `\b` ese cuerpo sale en claro. Con el lookaround sólo se exige que
 * el vecino no sea otro dígito, que es lo que de verdad delimita el número, y Luhn sigue siendo
 * quien decide: un tramo de 13-19 dígitos que no valide sigue saliendo literal.
 */
const PAN_CANDIDATE = /(?<![0-9])(?:\d[ -]?){12,18}\d(?![0-9])/g;

function looksHighEntropy(token: string): boolean {
  return /[a-z]/.test(token) && /[A-Z]/.test(token) && /\d/.test(token);
}

/** Luhn: sin él, `PAN_CANDIDATE` taparía cualquier importe largo o timestamp en microsegundos. */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let value = digits.charCodeAt(i) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Par `clave valor` o `clave: valor` EN PROSA: sin comillas, sin `=` y sin etiqueta XML. Es el
 * cuarto carril por clave, y el único que los otros tres no pueden ver.
 *
 * El separador admite sólo `:` o espacios, nunca `"`, `=` ni `>`. Eso lo mantiene ortogonal a
 * {@link JSON_PAIR}, {@link FORM_PAIR} y {@link XML_ELEMENT}: donde manda uno de los tres, aquí no
 * hay match, así que este carril no puede alterar lo que aquéllos ya decidieron.
 */
const PROSE_PAIR = /([A-Za-z][A-Za-z0-9_.-]{1,40})(:[ \t]*|[ \t]+)([^\s"'<>&=:,;]{6,80})/g;

/**
 * El gate que separa una credencial de una palabra de diagnóstico. Se exige un dígito o un
 * símbolo: `Pa55w0rd!` pasa, `rejected`, `expired`, `missing` o `characters` no. Sin este gate,
 * `"password must be rotated"` perdería la palabra `must` y el log dejaría de explicar el fallo.
 */
function looksLikeProseCredential(value: string): boolean {
  return /\d/.test(value) || /[^A-Za-z0-9._-]/.test(value);
}

function redactProseCredentials(text: string): string {
  PROSE_PAIR.lastIndex = 0;
  const out: string[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = PROSE_PAIR.exec(text)) !== null) {
    const key = match[1] ?? '';
    const separator = match[2] ?? '';
    const value = match[3] ?? '';

    if (isSensitiveKey(key) && looksLikeProseCredential(value)) {
      out.push(text.slice(cursor, match.index), key, separator, REDACTED);
      cursor = match.index + match[0].length;
      continue;
    }

    // El VALOR no se consume cuando no se redacta: puede ser él mismo la clave del par siguiente.
    // `"error: password: Pa55w0rd!"` casa primero como (clave `error`, valor `password`), y si se
    // avanzara más allá de `password` la credencial real quedaría sin clave que la delate.
    // `key.length + separator.length >= 3`, así que `lastIndex` siempre avanza y el bucle termina.
    PROSE_PAIR.lastIndex = match.index + key.length + separator.length;
  }

  return cursor === 0 ? text : `${out.join('')}${text.slice(cursor)}`;
}

/**
 * La regla de PAN, aislada del resto de `redactText` para poder aplicarla a un literal numérico
 * sin pagar las otras nueve pasadas. Ver {@link redactJsonLiteral}.
 */
function redactPanShape(text: string): string {
  return text.replace(PAN_CANDIDATE, (match: string) => {
    const digits = match.replace(/[^\d]/g, '');
    return digits.length >= 13 && digits.length <= 19 && passesLuhn(digits) ? REDACTED : match;
  });
}

/**
 * Redacta una cadena suelta: headers pegados, cuerpos sin parsear, mensajes de error de terceros.
 *
 * Dos pasadas y en este orden. Primero **por clave** —`"passportNumber": "…"`, `password=…`,
 * `<Password>…</Password>`, `password Pa55w0rd!`— porque saber a qué campo pertenece un valor es
 * la señal más fiable. Después **por forma**, que es la que salva el caso que rompió la auditoría:
 * un `secret` DESNUDO, sin prefijo `Basic` y sin clave que lo acompañe, dentro del
 * `error_description` que Sabre devuelve haciendo eco de la request.
 *
 * El orden es LOAD-BEARING y hay test que lo fija (`redaction.order.test.ts`): la pasada por forma
 * puede REESCRIBIR el nombre de un campo —una clave larga de alfabeto base64 cae entera en
 * `LONG_BASE64_RUN`— y una clave ya convertida en `«REDACTADO»` no casa con `JSON_PAIR` ni la
 * reconoce {@link isSensitiveKey}. Invertir los dos grupos deja el VALOR de esa clave en claro.
 */
export function redactText(text: string): string {
  return redactShapeRails(redactByKeyRails(text), { collapseBase64Runs: true });
}

/**
 * Grupo 1: las tres formas estructuradas de «clave = valor» (`JSON_PAIR`, `FORM_PAIR`,
 * `XML_ELEMENT`). Extraído de {@link redactText} para que {@link redactPath} corra exactamente
 * estas mismas reglas en vez de escribir su propia versión — que es el duplicado que se está
 * cerrando. Si esto se vuelve a copiar en otro sitio, el bug de la ronda 2 vuelve.
 */
function redactByKeyRails(text: string): string {
  return text
    .replace(JSON_PAIR, (match, key: string) => {
      const mask = maskForKey(key);
      return mask === null ? match : `"${key}":"${mask}"`;
    })
    .replace(FORM_PAIR, (match, key: string) => {
      const mask = maskForKey(key);
      return mask === null ? match : `${key}=${mask}`;
    })
    .replace(XML_ELEMENT, (match, tag: string, attrs: string) => {
      const mask = maskForKey(String(tag).split(':').pop() ?? tag);
      return mask === null ? match : `<${tag}${attrs}>${mask}</${tag}>`;
    });
}

/**
 * Grupo 2: las pasadas por FORMA, en su orden.
 *
 * `collapseBase64Runs` existe por un solo llamador, {@link redactPath}, y sólo puede apagar ESA
 * pasada: es la única cuyo alfabeto incluye `/` y por tanto la única que puede confundir una ruta
 * con un secreto. Las demás quedan siempre encendidas, para las dos llamadas, y no hay ningún
 * parámetro con el que apagarlas. El interruptor es deliberadamente estrecho: un booleano genérico
 * de «redacta menos» es la clase de puerta por la que se cuela la próxima ronda.
 */
function redactShapeRails(text: string, options: { collapseBase64Runs: boolean }): string {
  const byShape = redactProseCredentials(text)
    .replace(BEARER_OR_BASIC, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(JWT_SHAPE, REDACTED)
    .replace(SABRE_SECRET_SHAPE, REDACTED)
    .replace(SABRE_CLIENT_ID, REDACTED);
  const withRuns = options.collapseBase64Runs
    ? byShape.replace(LONG_BASE64_RUN, (match: string) =>
        looksHighEntropy(match) ? REDACTED : match,
      )
    : byShape;
  return redactPanShape(withRuns);
}

/**
 * Detección por forma sobre un literal JSON —`4111111111111111`, `true`, `null`—, que el escáner
 * emite sin comillas y que por eso se saltaba entero el carril de cadenas.
 *
 * Aplica **sólo** la regla de PAN, y eso basta: de las diez pasadas de {@link redactText}, ocho
 * exigen un carácter que un literal no puede contener —`"`, `<`, `=`, `:`— o letras fuera de
 * `[eE]` (`Bearer`, `eyJ`, `VmpF`, `V1:`). La novena, la tirada base64 larga, pide mayúscula Y
 * minúscula Y dígito a la vez, que ningún número reúne. La décima, el par en prosa, exige una
 * clave que empiece por letra Y un separador de espacio o dos puntos: un literal no tiene ninguno
 * de los dos, porque el escáner corta precisamente en ` `, `:`, `,`, `}` y `]`.
 *
 * El argumento se cierra por arriba: cualquier cosa que NO case con `JSON_LITERAL` aborta el
 * escáner (`return null`) y se resume por el carril textual, donde sí corren las nueve. Aquí sólo
 * llega lo que ya se verificó que es un literal.
 *
 * Devuelve el literal tal cual si no cambió; si cambió, deja de ser un número y quien llama tiene
 * que entrecomillarlo para que el resumen siga siendo JSON legible.
 */
function redactJsonLiteral(literal: string): string {
  return redactPanShape(literal);
}

const DEFAULT_BODY_SUMMARY_CHARS = 300;

const JSON_WHITESPACE = new Set([' ', '\t', '\n', '\r']);
const JSON_LITERAL_END = new Set([',', '}', ']', ':', '"', ' ', '\t', '\n', '\r']);
const JSON_LITERAL = /^(?:-?\d[\d.eE+-]*|true|false|null)$/;

/** Fin exclusivo de la cadena JSON que abre en `start`. `-1` si el body viene cortado. */
function endOfJsonString(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '"') return i + 1;
  }
  return -1;
}

/** Fin exclusivo de la estructura `{…}`/`[…]` que abre en `start`. `-1` si no cierra. */
function endOfJsonStructure(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      const end = endOfJsonString(text, i);
      if (end < 0) return -1;
      i = end - 1;
      continue;
    }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Un valor de cadena largo no puede comerse el presupuesto ni esquivar la redacción por forma.
 *
 * **La ventana es un tope de COSTE y no lleva test, a propósito.** Medido en la ronda 12: quitarla
 * —`window = Infinity`— deja la suite entera en verde, porque lo que sale por delante lo recorta
 * igual el `maxChars` de la línea siguiente. Lo único que cambia es cuánto texto recorren las diez
 * pasadas, o sea la mitad de la invariante del módulo que sólo se puede afirmar con reloj. Ponerle
 * red significaría un test de tiempo, y el molde está en {@link MAX_KEY_ANALYSIS_CHARS}: hizo falta
 * una entrada de 1 MB para separar 2 s de 300 s. Aquí no hay una entrada así medida, así que se
 * deja escrito que es endurecimiento sin red en vez de fingir que lo fija algo.
 */
function clampAndRedact(value: string, maxChars: number): string {
  const window = Math.max(maxChars * 4, 1_024);
  const safe = redactText(value.length > window ? value.slice(0, window) : value);
  // La segunda pasada es por el corte, y es LOAD-BEARING con un caso medido: cortar puede
  // DELIMITAR un número que antes no lo estaba. Un PAN seguido de otro dígito —`"…41111111111111119"`,
  // el PAN con un dígito de secuencia pegado— es una tirada de 17 que Luhn no confirma, así que la
  // primera pasada la deja literal; al cortar en `maxChars` justo tras el dígito 16 queda el PAN
  // exacto y Luhn sí lo confirma. Es el único sentido en que cortar HABILITA una detección: las
  // otras nueve pasadas piden longitudes mínimas o un carácter de cierre, y acortar sólo las apaga.
  return safe.length > maxChars ? redactText(safe.slice(0, maxChars)) : safe;
}

/**
 * Escáner JSON incremental con presupuesto de SALIDA.
 *
 * No construye el árbol: avanza por el texto, decide clave por clave y emite hasta llenar
 * `maxChars`. El coste está atado al tamaño del resumen, no al del body, que es justo lo que
 * permite quitar el antiguo umbral de 20.000 caracteres sin volver a pagar el parseo completo de
 * una respuesta de BFM con 200 itinerarios.
 *
 * Devuelve `null` cuando el body no es un sobre JSON, o cuando viene cortado **y lo que quedó a
 * medias no era el valor de una clave que mande tapar**; quien llama cae entonces al carril
 * textual, que también redacta por clave. Si lo que quedó a medias SÍ era el valor de una clave
 * sensible o de texto libre, no se aborta: se emite la marca y se cierra el resumen ahí, porque el
 * carril textual no sabe ver un par sin cerrar y lo publicaría en claro (ver el bloque de
 * `endOfJsonString(...) < 0` más abajo, y `redaction.stream-gaps.test.ts`).
 */
function redactJsonStream(body: string, maxChars: number): string | null {
  let i = 0;
  while (i < body.length && JSON_WHITESPACE.has(body[i] ?? '')) i++;
  const opener = body[i];
  if (opener !== '{' && opener !== '[') return null;

  const out: string[] = [];
  let len = 0;
  const emit = (chunk: string): void => {
    out.push(chunk);
    len += chunk.length;
  };

  const stack: string[] = [];
  let expectKey = false;
  // La marca que le toca al PRÓXIMO valor, o `null` si no le toca ninguna. Era un booleano; deja
  // de serlo porque ahora hay dos marcas distintas (`REDACTED` y `FREE_TEXT`) y cuál se emite lo
  // decide `maskForKey` sobre la clave, no este bucle. Guardar la marca en vez de un «sí/no» es lo
  // que impide que el escáner tenga que volver a preguntar por la clave —que ya no tiene— y acabe
  // con su propia copia de la precedencia.
  let pendingMask: string | null = null;

  while (i < body.length && len < maxChars) {
    const ch = body[i] ?? '';

    if (JSON_WHITESPACE.has(ch)) {
      i++;
      continue;
    }

    if (ch === '{' || ch === '[') {
      if (pendingMask !== null) {
        // El valor de una clave sensible puede ser un objeto entero (`credentials`, `payment`), y
        // el de una clave de texto libre también (`description` no siempre es una cadena).
        const end = endOfJsonStructure(body, i);
        // Si la estructura viene CORTADA no se puede abortar al carril textual: ver el bloque
        // gemelo de la cadena, unas líneas más abajo. Se emite la marca y se cierra aquí.
        emit(`"${pendingMask}"`);
        pendingMask = null;
        if (end < 0) return out.join('');
        i = end;
        continue;
      }
      stack.push(ch);
      expectKey = ch === '{';
      emit(ch);
      i++;
      continue;
    }

    if (ch === '}' || ch === ']') {
      stack.pop();
      expectKey = false;
      emit(ch);
      i++;
      continue;
    }

    if (ch === ',') {
      expectKey = stack[stack.length - 1] === '{';
      emit(ch);
      i++;
      continue;
    }

    if (ch === ':') {
      expectKey = false;
      emit(ch);
      i++;
      continue;
    }

    if (ch === '"') {
      const end = endOfJsonString(body, i);
      if (end < 0) {
        // El cuerpo llegó CORTADO en mitad de una cadena (conexión caída, 502 con cuerpo parcial).
        //
        // Abortar aquí al carril textual publicaba el valor EN CLARO, y era una fuga medida por la
        // puerta pública: `{"password":"Pa55w0rd!` salía literal en `error.body` y en
        // `error.message`. La razón es que NINGUNA pasada por clave puede ver un par sin cerrar
        // —`JSON_PAIR` exige la comilla de cierre, `XML_ELEMENT` la etiqueta de cierre— así que el
        // fallback no tapaba nada. El escáner, en cambio, ya sabe a qué clave pertenece esta cadena.
        //
        // Sin clave sensible delante se mantiene el fallback: ahí el carril textual sí aporta
        // (`FORM_PAIR` y las pasadas por forma siguen viendo el trozo suelto).
        if (pendingMask === null) return null;
        emit(`"${pendingMask}"`);
        return out.join('');
      }
      let value: unknown;
      try {
        value = JSON.parse(body.slice(i, end));
      } catch {
        return null;
      }
      if (typeof value !== 'string') return null;
      i = end;

      if (expectKey) {
        // La decisión se toma sobre la clave ORIGINAL y la clave EMITIDA va redactada. Son dos
        // cosas distintas y el orden importa: un secreto puede estar en posición de clave
        // (`{"V1:EPR:PCC:AA":1}`, un mapa indexado por clientId), y ahí lo que hay que tapar es
        // el nombre del campo, no su valor. Redactar antes de decidir rompería `isSensitiveKey`.
        //
        // Fijado por test (`redaction.order.test.ts`): con una clave que es sensible por NOMBRE y
        // que además cae entera en `LONG_BASE64_RUN` —`accessTokenAbc123Def456Ghi789Jkl`—, la
        // clave redactada es `«REDACTADO»`, que ya no es sensible para nadie. Decidir sobre ella
        // pone `pendingMask = null` y el VALOR sale en claro.
        pendingMask = maskForKey(value);
        // Se redacta con `clampAndRedact`, no con `redactText` pelado, por la misma razón que un
        // valor: una clave de 1 MB fabricada por el proveedor haría que el coste volviera a
        // depender del tamaño de la ENTRADA, que es la propiedad que este módulo defiende.
        emit(JSON.stringify(clampAndRedact(value, maxChars)));
        expectKey = false;
      } else if (pendingMask !== null) {
        emit(`"${pendingMask}"`);
        pendingMask = null;
      } else {
        emit(JSON.stringify(clampAndRedact(value, maxChars)));
      }
      continue;
    }

    const start = i;
    while (i < body.length && !JSON_LITERAL_END.has(body[i] ?? '')) i++;
    const literal = body.slice(start, i);
    if (!JSON_LITERAL.test(literal)) return null;
    if (pendingMask !== null) {
      emit(`"${pendingMask}"`);
      pendingMask = null;
    } else {
      // Un literal numérico también pasa por la detección por FORMA: un PAN serializado como
      // número JSON (`{"acct":4111111111111111}`) no lleva comillas y se saltaba entero el
      // carril de cadenas. Luhn es quien decide, y por eso un importe o un número de vuelo
      // largo sigue saliendo literal.
      const safe = redactJsonLiteral(literal);
      // Si cambió, dejó de ser un número: hay que entrecomillarlo o el resumen deja de ser JSON.
      emit(safe === literal ? literal : `"${safe}"`);
    }
  }

  return out.join('');
}

function collapse(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars)}…` : collapsed;
}

/**
 * Carril para lo que no es JSON: HTML de un balanceador, form-urlencoded, XML del carril SOAP,
 * texto suelto. Se redacta ANTES de truncar y se vuelve a redactar DESPUÉS, porque el corte puede
 * partir en dos un secreto que la primera pasada veía entero.
 *
 * La doble pasada SÍ lleva red (`redaction.order.test.ts`; quitar la segunda pone la suite roja).
 * La `window` de aquí abajo NO, y por lo mismo que la de {@link clampAndRedact}: es un tope de
 * coste, quitarlo no cambia ninguna salida observada y su red tendría que ser un test de reloj.
 */
function redactLooseText(body: string, maxChars: number): string {
  const window = Math.max(maxChars * 16, 8_192);
  const truncated = body.length > window;
  const collapsed = redactText(body.slice(0, window)).replace(/\s+/g, ' ').trim();
  if (!truncated && collapsed.length <= maxChars) return collapsed;
  return `${redactText(collapsed.slice(0, maxChars))}…`;
}

/**
 * Resumen seguro de un cuerpo de respuesta para meter en el mensaje de un error.
 *
 * **No hay ningún tamaño de body para el que la protección se apague**: por debajo y por encima
 * de cualquier umbral se aplica la misma redacción por clave. Lo único que depende del tamaño es
 * cuánto se ve, nunca cuánto se tapa.
 */
export function safeBodySummary(body: string, maxChars = DEFAULT_BODY_SUMMARY_CHARS): string {
  const streamed = redactJsonStream(body, maxChars);
  return streamed === null ? redactLooseText(body, maxChars) : collapse(streamed, maxChars);
}

/** Metadatos de log: siempre pasan por aquí antes de tocar el `LoggerPort`. */
export function redactMeta(meta: Record<string, unknown>): Record<string, unknown> {
  return redactValue(meta) as Record<string, unknown>;
}

/** Los dos niveles que el ACL usa. `info`/`error` no se abren hasta que haya un caso que los pida. */
export type SabreLogLevel = 'debug' | 'warn';

/**
 * **El ÚNICO sitio del paquete donde se llama a un método de `LoggerPort`.**
 *
 * ## Qué hace, exactamente
 *
 * Etiqueta la meta con `provider: 'sabre'` y la pasa por {@link redactMeta}. Nada más. No decide
 * qué se loguea ni con qué nivel: eso sigue siendo de cada clase.
 *
 * ## Por qué es una función y no una línea copiada en cada clase
 *
 * La línea `logger?.[level](message, redactMeta({ provider: 'sabre', ...meta }))` estaba escrita
 * BYTE A BYTE en tres clases distintas —`SabreTokenService`, `SabreFlightSearchAdapter` y
 * `SabreHttpClient`— y **sólo la del cliente HTTP tenía test**. Medido: quitando `redactMeta` de
 * las otras dos, la suite entera seguía verde. Y la del token service es load-bearing —sin ella,
 * `sabre.token.cache_corrupta` publica `cacheKey`, o sea el PCC de la oficina, en el log—.
 *
 * Tres copias de una política de seguridad con un solo test es exactamente la forma del incidente
 * de la ronda 2 de este paquete (dos implementaciones de la regla dura, y la que corría en
 * producción era la débil). Aquí hay una.
 *
 * ## Qué impide que vuelvan a ser tres
 *
 * `redaction.log-gate.guard.test.ts`, y **no este comentario**. La guarda construye el programa de
 * TypeScript del paquete y pregunta al checker por el TIPO de cada expresión llamada: toda llamada
 * a un método de `LoggerPort` desde código de producción tiene que estar dentro de esta función.
 * Es por ALCANZABILIDAD de tipo, no por una lista de nombres prohibidos —una lista de nombres es
 * lo que ya falló en la guarda de superficie del artefacto—: un campo con otro nombre, un alias
 * local, un logger pasado a una función auxiliar o una cuarta clase caen igual.
 *
 * La misma guarda comprueba que la llamada de aquí abajo sigue pasando la meta por `redactMeta`
 * (por SÍMBOLO, no por texto), y tres tests de comportamiento —uno por clase, todos por la puerta
 * pública— comprueban que un testigo sensible no llega al `LoggerPort`.
 *
 * ## Lo que este helper NO garantiza
 *
 * No garantiza que la meta que le pasa cada clase sea la correcta: `redactMeta` tapa por CLAVE y
 * por FORMA, así que un dato sensible bajo una clave inocua y sin forma verificable sigue saliendo
 * (ver los tres límites aceptados de la cabecera de este archivo). Lo que garantiza es que no hay
 * ningún camino al `LoggerPort` que se salte esa pasada.
 */
export function logRedacted(
  logger: LoggerPort | undefined,
  level: SabreLogLevel,
  message: string,
  meta: Record<string, unknown>,
): void {
  logger?.[level](message, redactMeta({ provider: 'sabre', ...meta }));
}
