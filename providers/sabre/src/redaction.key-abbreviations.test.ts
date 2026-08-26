import type { LoggerPort } from '@sales-travel/core';
import { describe, expect, it } from 'vitest';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from './config';
import { SabreApiError } from './errors';
import { SabreHttpClient } from './http/sabre-http.client';
import { REDACTED, redactMeta } from './redaction';

/**
 * Las CLAVES que deciden: abreviaturas de credencial, y las dos entradas de PII que ningún test
 * fijaba.
 *
 * ## (1) La fuga medida: la lista de claves sólo conocía la palabra entera
 *
 * `SECRET_KEYS` y `SECRET_KEY_MARKERS` cubrían `password`, `passwd`, `passwordRaw`. Lo que escribe
 * un backend de verdad —y lo que llega en el eco de un tercero— es `pwd`, `pw`, `psw`, `userpwd` o
 * `pwdHash`. Medido antes de esta ronda sobre 20 variantes: **17 publicaban el valor EN CLARO**,
 * por `redactMeta` y por `safeBodySummary` a la vez. No es un hueco teórico: es la misma clase de
 * fuga que el módulo entero existe para cerrar, con el nombre abreviado.
 *
 * ## (2) El precio, y por qué se mide en las DOS direcciones
 *
 * `pass` es prefijo de `passenger` y `passengerInfo`. Cubrirlo por FRAGMENTO del nombre aplastado
 * borraría medio diagnóstico de una búsqueda —y no sólo eso: `groupWarning` normalizado contiene
 * `pw`, `groupSwitch` contiene `psw`, `boardingPass` y `bypassCache` contienen `pass`—. Por eso la
 * regla tiene dos mitades y ninguna es un `includes()`:
 *
 *   - por PALABRA (fronteras reales: separadores y cambio de caja), y `pass` NO está en esa lista;
 *   - por FORMA DE LA CLAVE ENTERA, anclada, con calificador y sufijo de LISTA CERRADA.
 *
 * Los dos bloques de abajo son el mismo test con el signo cambiado. Uno solo no vale: cubrir de
 * más y cubrir de menos son los dos fallos de producción de este módulo, y la corrección de uno es
 * exactamente el vector del otro.
 *
 * ## (3) `email` / `phone`: mutante superviviente
 *
 * Quitando `'email'`, `'emailaddress'`, `'phone'` y `'phonenumber'` de `PII_KEYS`, la suite entera
 * seguía verde mientras `{email:'a@b.com', phone:'+573001112233'}` salía en claro. Los marcadores
 * NO las salvan: `emailaddress`/`phonenumber` son fragmentos que la clave corta no contiene. Y
 * ninguna pasada por forma las ve —un email no tiene forma verificable y un teléfono de 12 dígitos
 * no llega al mínimo de `PAN_CANDIDATE`—. Aquí quedan fijadas.
 */

const SHOP_PATH = '/v5/offers/shop';

/** Testigo sin FORMA: no lo tapa ninguna de las diez pasadas, sólo puede taparlo la CLAVE. */
const WITNESS = 'V4L0R-EN-CLARO-9137';

function config(): SabreConfig {
  return {
    host: SABRE_HOSTS.cert.rest,
    epr: '500001',
    homePcc: 'ZZZZ',
    password: 'Pa55w0rd!',
    conversationIdPrefix: 'sales-travel',
  };
}

const tokens: SabreTokenProvider = {
  getToken: () => Promise.resolve('ATK-SUPERSECRETO'),
  invalidate: () => Promise.resolve(),
};

/** Puerta pública: el cuerpo entra por `postJson` y sale por el mensaje y el body del error. */
async function bodyThroughHttpClient(payload: unknown): Promise<string> {
  const calls: unknown[] = [];
  const push =
    () =>
    (message: string, meta?: Record<string, unknown>): void => {
      calls.push({ message, meta });
    };
  const logger: LoggerPort = {
    debug: push(),
    info: push(),
    warn: push(),
    error: push(),
    child: () => logger,
  };
  const fetchImpl: SabreFetch = () =>
    Promise.resolve(new Response(JSON.stringify(payload), { status: 500 }));
  const http = new SabreHttpClient(config(), tokens, {
    fetch: fetchImpl,
    logger,
    sleep: () => Promise.resolve(),
    jitter: () => 0,
    uuid: () => 'conv-fijo',
  });
  const error = (await http.postJson(SHOP_PATH, {}).catch((e: unknown) => e)) as SabreApiError;
  expect(error).toBeInstanceOf(SabreApiError);
  return `${error.message}|${error.body}|${JSON.stringify(calls)}`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 1. Las abreviaturas se tapan — por la puerta pública y por la meta de log
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Las 20 variantes. Las tres últimas ya estaban cubiertas y siguen aquí como suelo: si alguien
 * reescribe la regla y se lleva por delante `password`, este mismo bloque lo dice.
 */
const CREDENTIAL_KEYS: readonly string[] = [
  'pwd',
  'pass',
  'passw',
  'pw',
  'psw',
  'pswd',
  'userpwd',
  'userPass',
  'pwdHash',
  'passHash',
  'passcode',
  'passphrase',
  'pword',
  'passwrd',
  'usrPwd',
  'accountPwd',
  'oldPwd',
  // Estas dos sólo las ve la mitad «por PALABRA»: la abreviatura va en medio del nombre, así que
  // la forma de la clave entera no casa. Están aquí para que quitar esa mitad se note — sin ellas
  // el mutante «borra el barrido por palabras» sobrevive, porque la otra mitad tapa el resto.
  'sabrePwdForTenant',
  'PWD_DE_LA_OFICINA',
  // Prefijo en MAYÚSCULAS pegado a la abreviatura, que es como escribe las claves media integración
  // de terceros. Sólo los ve la SEGUNDA regla de troceado de `KEY_WORD_BOUNDARIES`
  // (`([A-Z])([A-Z][a-z])` → `LDAP` + `Pwd`): la forma de la clave entera no casa —su calificador es
  // lista cerrada y `ldap`/`smtp`/`http` no están— y el nombre aplastado (`ldappwd`) no contiene
  // ninguna palabra del Set. Sin estas tres, borrar esa regla dejaba la suite entera en verde
  // (medido en la ronda 12); con ellas, el mutante muere aquí.
  'LDAPPwd',
  'SMTPPwd',
  'HTTPPwd',
  'newPassword',
  'passwd',
  'password',
];

describe('claves de credencial abreviadas — el valor no sale', () => {
  it.each(CREDENTIAL_KEYS)(
    '`%s` en el cuerpo de la respuesta no llega al error ni al log (postJson)',
    async (key) => {
      const dump = await bodyThroughHttpClient({ [key]: WITNESS });

      expect(dump, `«${key}» publicó el valor en claro`).not.toContain(WITNESS);
      expect(dump, `«${key}» no dejó marca de redacción`).toContain(REDACTED);
    },
  );

  it.each(CREDENTIAL_KEYS)('`%s` tampoco sale por la meta de log (`redactMeta`)', (key) => {
    const out = JSON.stringify(redactMeta({ [key]: WITNESS }));

    expect(out, `«${key}» publicó el valor en claro`).not.toContain(WITNESS);
    expect(out).toContain(REDACTED);
  });

  it('CONTROL: el testigo NO tiene forma — bajo una clave inocua sale entero', async () => {
    // Sin esto los 40 casos de arriba podrían estar pasando por una pasada por FORMA y no por la
    // regla de clave, y la regla de clave podría no existir.
    const dump = await bodyThroughHttpClient({ payload: WITNESS });

    expect(dump).toContain(WITNESS);
  });

  it('la abreviatura también manda cuando el valor es un objeto entero', async () => {
    const dump = await bodyThroughHttpClient({ pwd: { raw: WITNESS, again: [WITNESS] } });

    expect(dump).not.toContain(WITNESS);
  });

  it('y en el carril form-urlencoded, que no es JSON y cae al carril suelto', () => {
    const out = JSON.stringify(redactMeta({ detalle: `grant_type=password&pwd=${WITNESS}` }));

    expect(out).not.toContain(WITNESS);
  });

  it('y en el carril XML/SOAP', () => {
    const out = JSON.stringify(redactMeta({ detalle: `<Pwd>${WITNESS}</Pwd>` }));

    expect(out).not.toContain(WITNESS);
  });

  it('y en prosa suelta, donde el valor lleva dígito', () => {
    const out = JSON.stringify(redactMeta({ detalle: `invalid credentials for pwd ${WITNESS}` }));

    expect(out).not.toContain(WITNESS);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. El precio: las claves inocuas que empiezan igual siguen saliendo
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Claves REALES del vocabulario de viajes que comparten letras con las abreviaturas. Si alguna
 * empieza a salir `«REDACTADO»`, el diagnóstico de una búsqueda se queda sin la mitad y eso también
 * es un fallo de producción — el que este módulo lleva tres rondas negándose a pagar.
 */
const INNOCENT_KEYS: readonly string[] = [
  'passenger',
  'passengers',
  'passengerInfo',
  'passengerRefId',
  'PassengerTypeQuantity',
  'boardingPass',
  'bypassCache',
  'passType',
  'passStatus',
  'groupWarning',
  'stopWaiting',
  'compass',
  'surpass',
  'passiveSegment',
];

describe('claves de credencial abreviadas — el falso positivo se mide', () => {
  it.each(INNOCENT_KEYS)('`%s` NO se tapa: su valor sigue en el log', (key) => {
    const out = JSON.stringify(redactMeta({ [key]: WITNESS }));

    expect(out, `«${key}» borró diagnóstico útil`).toContain(WITNESS);
    expect(out).not.toContain(REDACTED);
  });

  it.each(INNOCENT_KEYS)('`%s` tampoco se tapa por la puerta pública', async (key) => {
    const dump = await bodyThroughHttpClient({ [key]: WITNESS });

    expect(dump, `«${key}» borró diagnóstico útil`).toContain(WITNESS);
  });

  it('CONTROL de la frontera: `passenger` sale y `pass` no, en el MISMO sobre', async () => {
    const dump = await bodyThroughHttpClient({ passenger: WITNESS, pass: 'S3CR3T0-DE-OFICINA' });

    expect(dump).toContain(WITNESS);
    expect(dump).not.toContain('S3CR3T0-DE-OFICINA');
  });

  it('la prosa de diagnóstico sobrevive: `pwd rejected by policy` no pierde la explicación', () => {
    // El gate de dígito-o-símbolo de `looksLikeProseCredential` sigue mandando también para las
    // abreviaturas nuevas. Sin él, cubrir `pwd` costaría la palabra que explica TODOS los fallos.
    const out = JSON.stringify(redactMeta({ detalle: 'pwd rejected by policy' }));

    expect(out).toContain('rejected by policy');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. `email` / `phone`: el mutante que sobrevivía
 * ──────────────────────────────────────────────────────────────────────────── */

const PII_CASES: ReadonlyArray<readonly [string, string]> = [
  ['email', 'agente.demo@planetour.cloud'],
  ['emailAddress', 'otro.agente@planetour.cloud'],
  ['phone', '+573001112233'],
  ['phoneNumber', '+5511987654321'],
  ['Email', 'tercero@planetour.cloud'],
  ['E-Mail', 'cuarto@planetour.cloud'],
  // Compuestos: ni el Set (exacto) ni los marcadores (`phonenumber`, `emailaddress`) los veían.
  // Fuga MEDIDA en esta ronda: `contact_phone` publicaba el número entero.
  ['contact_phone', '+51987654321'],
  ['emergencyEmail', 'emergencia@planetour.cloud'],
  ['travelerPhone', '+528112345678'],
];

/** El otro lado: vocabulario legítimo que comparte letras con las palabras de PII. */
const INNOCENT_CONTACT_KEYS: readonly string[] = [
  'phoneticName',
  'telAvivAirport',
  'mobileVersion',
];

describe('PII de contacto — `email` y `phone` quedan fijadas por la puerta pública', () => {
  it.each(PII_CASES)('`%s` no sale del proceso', async (key, value) => {
    const dump = await bodyThroughHttpClient({ [key]: value });

    expect(dump, `«${key}» publicó PII de contacto`).not.toContain(value);
    expect(dump).toContain(REDACTED);
  });

  it.each(PII_CASES)('`%s` tampoco por la meta de log (`redactMeta`)', (key, value) => {
    const out = JSON.stringify(redactMeta({ [key]: value }));

    expect(out, `«${key}» publicó PII de contacto`).not.toContain(value);
    expect(out).toContain(REDACTED);
  });

  it.each(INNOCENT_CONTACT_KEYS)('`%s` NO se tapa: no es un dato de contacto', (key) => {
    const out = JSON.stringify(redactMeta({ [key]: WITNESS }));

    expect(out, `«${key}» borró diagnóstico útil`).toContain(WITNESS);
    expect(out).not.toContain(REDACTED);
  });

  it('CONTROL: un email NO tiene forma verificable — bajo clave inocua sale entero', async () => {
    // Esto es lo que convierte el bloque de arriba en una prueba de la CLAVE. Y de paso deja
    // escrito el límite: sin clave que lo delate, un email en texto libre no se puede tapar sin
    // borrar cualquier identificador con arroba.
    const dump = await bodyThroughHttpClient({ payload: 'agente.demo@planetour.cloud' });

    expect(dump).toContain('agente.demo@planetour.cloud');
  });

  it('el teléfono no lo salva Luhn: 12 dígitos no llegan al mínimo de PAN', async () => {
    // Segundo control del mismo bloque: si `phone` desapareciera de `PII_KEYS`, ninguna pasada por
    // forma lo recogería. Lo demuestra el número desnudo, sin clave.
    const dump = await bodyThroughHttpClient({ payload: '+573001112233' });

    expect(dump).toContain('573001112233');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 4. Los cinco carriles siguen limpios después de tocar las reglas de clave
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Ampliar `isSecretKey`/`isPiiKey` toca la decisión que comparten los CINCO carriles —los tres
 * estructurados (`JSON_PAIR`, `FORM_PAIR`, `XML_ELEMENT`), el de prosa y el de forma/auth—. Esta
 * rejilla es el suelo: si una de las cinco se cae, se cae en un sitio distinto del que se tocó.
 */
const RAILS: ReadonlyArray<readonly [string, string, string]> = [
  ['JSON', '{"password":"S3CR3T0-JSON"}', 'S3CR3T0-JSON'],
  ['form-urlencoded', 'grant_type=password&password=S3CR3T0-FORM', 'S3CR3T0-FORM'],
  ['XML/SOAP', '<UsernameToken><Password>S3CR3T0-XML</Password></UsernameToken>', 'S3CR3T0-XML'],
  ['prosa suelta', 'invalid credentials for password S3CR3T0-PROSA', 'S3CR3T0-PROSA'],
  [
    'auth — Bearer',
    'Authorization: Bearer AbC123dEf456GhI789jKl012MnO345pQr',
    'AbC123dEf456GhI789jKl012MnO345pQr',
  ],
  [
    'auth — Basic',
    'Authorization: Basic VmpFNlpYQnlPbkJqWXpwQlFRPT06Y0dGemN3PT0=',
    'VmpFNlpYQnlPbkJqWXpwQlFRPT06Y0dGemN3PT0=',
  ],
  [
    'auth — secret desnudo',
    'error_description: VmpFNlpYQnlPbkJqWXpwQlFRPT06Y0dGemN3PT0=',
    'VmpFNlpYQnlPbkJqWXpwQlFRPT06Y0dGemN3PT0=',
  ],
  ['auth — clientId', 'invalid_client:V1:500001:ZZZZ:AA', 'V1:500001:ZZZZ:AA'],
];

describe('los cinco carriles de redacción siguen limpios', () => {
  it.each(RAILS)('%s', (name, payload, witness) => {
    const out = JSON.stringify(redactMeta({ detalle: payload }));

    expect(out, `${name}: el carril dejó pasar el secreto`).not.toContain(witness);
    expect(out, `${name}: no hay marca de redacción`).toContain(REDACTED);
  });

  it('y la RUTA sigue saliendo entera: la redacción no puede dejar el log ciego', () => {
    const out = JSON.stringify(
      redactMeta({ path: '/v1/trip/orders/fulfillFlightTickets?pnr=XKCD12' }),
    );

    expect(out, 'se perdió la ruta de una operación con dinero').toContain(
      '/v1/trip/orders/fulfillFlightTickets',
    );
    expect(out, 'la query no se tiró').not.toContain('XKCD12');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 5. El coste sigue atado al RESUMEN, no a la entrada
 * ──────────────────────────────────────────────────────────────────────────── */

describe('el análisis de la clave no puede volver a depender del tamaño de la entrada', () => {
  it('una clave hostil de 1 MB se resuelve en tiempo despreciable', () => {
    // Este bloque lleva reloj, y es la única parte del módulo que lo lleva, a propósito: el fallo
    // que vigila NO tiene salida observable — el resultado es correcto, sólo que tarda. La primera
    // versión del troceado en palabras de esta ronda usaba `([A-Z]+)([A-Z][a-z])`, y una tirada de
    // un millón de mayúsculas la hacía retroceder desde cada posición: el test de la clave gigante
    // de `redaction.stream-gaps.test.ts` pasó de milisegundos a **13 minutos** y aun así en VERDE.
    // Es la misma avería que el umbral de 20.000 caracteres que este archivo existe para no tener.
    //
    // El umbral es deliberadamente flojo (dos segundos para un trabajo de milisegundos): no mide
    // rendimiento, sólo separa «lineal» de «cuadrático», que es una diferencia de cinco órdenes de
    // magnitud y no se la come ninguna máquina lenta.
    //
    // **Lo que este reloj NO detecta, y por eso no está solo.** Quitar `MAX_KEY_ANALYSIS_CHARS`
    // deja este test en VERDE. Medido en esta ronda con el tope quitado y sobre esta misma
    // entrada: 4 ms → 7 ms la clave sola, 234 ms → 243 ms el `it` entero. Son dos órdenes de
    // magnitud por debajo del umbral, y el margen que quedaría para separarlos convertiría esto en
    // un test de reloj de pared apretado — de los que en este paquete ya dieron rojos falsos,
    // porque vitest corre los ficheros en paralelo y la máquina no es siempre la misma.
    // El tope se fija abajo POR COMPORTAMIENTO, sin reloj, y ése sí se ha visto ponerse rojo.
    const hostil = 'K'.repeat(1_000_000);
    const started = Date.now();

    JSON.stringify(redactMeta({ [hostil]: WITNESS, tambien: `{"${hostil}":1}` }));

    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 6. `MAX_KEY_ANALYSIS_CHARS` — la frontera, sin reloj
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * El tope de 512 caracteres tiene una salida observable, y **no es la que su comentario cuenta**.
 *
 * El comentario de `MAX_KEY_ANALYSIS_CHARS` lo justifica sólo por coste. Su otro efecto —el que se
 * mide aquí— es que el barrido por PALABRA no ve nada más allá del carácter 512, así que una clave
 * de credencial con más de 512 caracteres de relleno delante **publica su valor en claro**:
 * `'x'.repeat(511) + 'Pwd'` sale entero, mientras que con 400 de relleno se tapa.
 *
 * Ese es el precio, y se acepta con los ojos abiertos: el identificador más largo de los 21
 * contratos (`SystemSpecificResults`) no llega ni a la décima parte del tope, así que más allá de
 * 512 no hay nombre de campo sino relleno del proveedor, y la otra mitad de la defensa —la forma
 * anclada de la clave entera, `SECRET_KEY_ABBREVIATION_SHAPE`— sigue viendo las claves reales.
 * Lo que no se acepta es que el precio no estuviera escrito en ningún sitio.
 *
 * Este bloque es además el ÚNICO detector del mutante «borra el tope». Verificado ejecutando la
 * suite entera con `keyWords` analizando la clave completa: de los 1.244 tests, los dos únicos que
 * se ponen rojos son los dos de aquí. El reloj de arriba, con ese mismo mutante, sigue verde.
 *
 * SI ESTE BLOQUE SE PONE ROJO por el caso de 511, alguien quitó o subió el tope. No se arregla
 * cambiando el número de aquí: hay que volver a medir el coste de la clave hostil de 1 MB y
 * decidir a la vez las dos mitades, que es la decisión que el tope encapsula.
 */
describe('el tope de análisis de la clave: qué cubre y qué deja de cubrir', () => {
  const REAL_KEY_PADDING = 400;
  const AT_THE_CAP = 509; // 509 + 'Pwd' = 512, el último carácter que el troceado llega a ver
  const PAST_THE_CAP = 511; // 514 caracteres: el troceado sólo ve 'x'…'x' + 'P'

  it('las claves REALES, que son cortas, se siguen tapando enteras', () => {
    const out = JSON.stringify(redactMeta({ [`${'x'.repeat(REAL_KEY_PADDING)}Pwd`]: WITNESS }));

    expect(out).not.toContain(WITNESS);
    expect(out).toContain(REDACTED);
  });

  it('y justo EN el tope todavía se tapan: los 512 caracteres se analizan enteros', () => {
    const out = JSON.stringify(redactMeta({ [`${'x'.repeat(AT_THE_CAP)}Pwd`]: WITNESS }));

    expect(out).not.toContain(WITNESS);
  });

  it('PASADO el tope el valor sale EN CLARO: éste es el precio del tope, escrito', () => {
    // No es un descuido que haya que arreglar tapando también esto: taparlo significa quitar el
    // tope, y quitar el tope devuelve el coste al tamaño de la entrada, que es el invariante que
    // el módulo entero defiende. Se elige el coste acotado y se paga con esta clave imposible.
    const out = JSON.stringify(redactMeta({ [`${'x'.repeat(PAST_THE_CAP)}Pwd`]: WITNESS }));

    expect(
      out,
      'el tope de análisis desapareció o creció: releer el comentario de MAX_KEY_ANALYSIS_CHARS',
    ).toContain(WITNESS);
  });

  it('lo mismo por el lado de PII, para que la frontera no se lea como cosa de secretos', () => {
    const corta = JSON.stringify(redactMeta({ [`${'x'.repeat(400)}Email`]: 'a@planetour.cloud' }));
    const larga = JSON.stringify(redactMeta({ [`${'x'.repeat(600)}Email`]: 'a@planetour.cloud' }));

    expect(corta).not.toContain('a@planetour.cloud');
    expect(larga).toContain('a@planetour.cloud');
  });

  it('CONTRAPESO: la otra mitad de la defensa no depende del tope', () => {
    // La forma anclada de la clave entera no trocea nada, así que el tope no la toca. Es lo que
    // hace que el precio de arriba se quede en la clave con relleno y no se extienda a las reales.
    for (const key of ['userPwd', 'accountPassword', 'oldPwd', 'passHash']) {
      const out = JSON.stringify(redactMeta({ [key]: WITNESS }));
      expect(out, `«${key}» dejó de taparse`).not.toContain(WITNESS);
    }
  });
});
