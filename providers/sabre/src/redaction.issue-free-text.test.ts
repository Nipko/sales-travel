import type { LoggerPort } from '@sales-travel/core';
import { describe, expect, it } from 'vitest';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from './config';
import { SabreApiError, classifySabreEnvelope, type SabreIssue } from './errors';
import { SabreHttpClient } from './http/sabre-http.client';

/**
 * El `SabreIssue` se LOGUEA. Por eso sólo puede llevar VOCABULARIO, nunca prosa del proveedor.
 *
 * ## La regla, escrita en el propio `errors.ts`
 *
 * `SABRE_SAFE_CODE_SHAPE` dice literalmente: «Forma de un identificador de código: sin espacios y
 * corto. Sólo lo que la pasa viaja al issue (y por tanto al log). Cualquier otra cosa es texto
 * libre del proveedor y puede arrastrar PII del pasajero (RNF-07)». Y `issueFromEnvelopeRecord`
 * remata: «Nunca lleva `description`, `text`, `value` ni `fieldValue`».
 *
 * ## Lo que pasaba de verdad hasta la ronda 9 (MEDIDO por la puerta pública)
 *
 * La puerta existía pero **sólo se aplicaba en un sitio**: `scalarIssue`, que es el camino de
 * `errors: ["texto"]`. Los dos caminos de RECORD —`issueFromEnvelopeRecord` y `messageIssue`—
 * leían `code`, `category`, `type` y `fieldPath` con `sabreEnvelopeString` PELADO, sin pasar por
 * la forma. Resultado medido:
 *
 *     {"messages":[{"severity":"Error","code":"PNR XKCD12 not found for specified ticket
 *                                              SMITH/JOHNMR"}]}
 *
 *   → `SabreApiError.issues[0].code` con la frase entera, y de ahí a `toLogMeta()` y al
 *     `warn sabre.http.error`. Verificado en las CUATRO casillas: `code`, `category`, `type` y
 *     `fieldPath`, y en los dos portadores (`errors[]` y `messages[]`).
 *
 * `redaction.ts` no puede taparlo: `code`, `category` y `type` NO son claves de texto libre a
 * propósito —son el vocabulario cerrado sobre el que se diagnostica— y meterlas en
 * `FREE_TEXT_KEYS` dejaría los errores indiagnosticables, que es el otro fallo de producción. El
 * arreglo es cerrar la puerta donde ya está escrita: en `errors.ts`.
 *
 * ## Estado de este fichero — RONDA 9, CERRADO
 *
 * Los bloques (1) y (2) nacieron ROJOS y ya están en verde: `errors.ts` aplica la forma en las
 * CUATRO casillas y en los DOS caminos de record, por `safeIssueField`. Los bloques (3) —el
 * precio— y (4) —el mutante `code ?? text`— eran y siguen siendo verdes: el arreglo no podía
 * consistir en vaciar el issue, y no consiste.
 *
 * Lo que se decidió al cerrarlo, para que no haya que reconstruirlo leyendo el diff:
 *
 *   - **Se sustituye, no se borra.** Una casilla con prosa sale con `FREE_TEXT_REDACTED`, no
 *     ausente: «Sabre no mandó código» y «Sabre mandó una frase donde iba el código» son dos
 *     diagnósticos distintos y apuntan a sitios opuestos. El sentinel es vocabulario NUESTRO; del
 *     texto del proveedor no viaja un byte.
 *   - **La marca de entitlement sobrevive** (`FREE_TEXT_REDACTED_UNAUTHORIZED`), porque
 *     `partialUnauthorized` filtra `category`/`type` por `UNAUTHORIZED|RESOURCE_RESTRICTED` y sin
 *     eso una suscripción capada se vería como «no hay vuelos» (RNF-13). Lo que se conserva es el
 *     resultado de un booleano, nunca el texto.
 *   - **`fieldPath` tiene forma propia** (`SABRE_SAFE_FIELD_PATH_SHAPE`), la de código más
 *     corchetes: los contratos 2SG lo publican indexado (`travelers[0].passport`) y perderlo dejaba
 *     a soporte sin el «DÓNDE». La propiedad que protege —sin espacios y corta— es la misma.
 *   - **Lo que se pierde, escrito:** el texto exacto del error cuando el proveedor manda prosa
 *     donde el contrato promete un identificador. Se recupera por la traza de Sabre con el
 *     `conversationId`, que sí viaja y no lleva PII.
 *
 * ## Los otros cuatro hallazgos menores de la ronda, y por qué viven aquí
 *
 * Los bloques (5) a (8) no son de redacción: son los tres mutantes supervivientes de `errors.ts` y
 * la asimetría de los dos ejes del contexto de operación. Están en este fichero porque `errors.ts`
 * es el sujeto de los cuatro y porque cada uno se mide por la MISMA puerta pública que el resto —
 * un test que llama a la función interna demuestra que la función es correcta, jamás que sea la
 * que corre (ronda 2). Cada bloque nombra el mutante exacto que mata.
 */

const SHOP_PATH = '/v5/offers/shop';
const CREATE_BOOKING_PATH = '/v1/trip/orders/createBooking';
const HOTEL_AVAIL_PATH = '/v5/get/hotelavail';
const REMOVE_ANCILLARIES_PATH = '/v1/ancillaries/remove';

/**
 * Testigo con la forma REAL del texto libre de Sabre: una plantilla `%s` de la lista oficial de
 * errores de Booking Management, rellena con lo que interpola de verdad — un localizador y un
 * nombre de pasajero.
 */
const FREE_TEXT_WITNESS = 'PNR XKCD12 not found for specified ticket SMITH/JOHNMR';
const PII_INSIDE = 'SMITH/JOHNMR';

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

interface Observed {
  readonly rejected: boolean;
  readonly issues: readonly SabreIssue[];
  /** Todo lo que se le entregó al `LoggerPort`, ya redactado. */
  readonly logDump: string;
}

/** Puerta pública: el sobre entra por `postJson` y sale por `error.issues` y por el log. */
async function post(payload: unknown, path: string = SHOP_PATH): Promise<Observed> {
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
    Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
  const http = new SabreHttpClient(config(), tokens, {
    fetch: fetchImpl,
    logger,
    sleep: () => Promise.resolve(),
    jitter: () => 0,
    uuid: () => 'conv-fijo',
  });

  const outcome = await http.postJson(path, {}).then(
    () => null,
    (err: unknown) => err,
  );
  const rejected = outcome instanceof SabreApiError;
  return {
    rejected,
    issues: rejected ? outcome.issues : [],
    logDump: JSON.stringify(calls),
  };
}

/** Las cuatro casillas del `SabreIssue` que vienen del proveedor. */
const ISSUE_FIELDS = ['code', 'category', 'type', 'fieldPath'] as const;

/** Los dos portadores: la clave de problema y la de mensajes. Son caminos DISTINTOS del recorrido. */
const CARRIERS: ReadonlyArray<readonly [string, (item: Record<string, unknown>) => unknown]> = [
  ['errors[]', (item) => ({ errors: [item] })],
  ['messages[]', (item) => ({ messages: [item] })],
];

const LEAK_CASES = CARRIERS.flatMap(([carrier, wrap]) =>
  ISSUE_FIELDS.map((field) => [`${carrier} · ${field}`, field, wrap] as const),
);

/* ────────────────────────────────────────────────────────────────────────────
 * (1) El texto libre no entra en el issue
 * ──────────────────────────────────────────────────────────────────────────── */

describe('el issue no transporta prosa del proveedor — por la puerta pública', () => {
  it.each(LEAK_CASES)(
    '%s con texto libre: no llega al issue ni al log',
    async (name, field, wrap) => {
      const observed = await post(wrap({ severity: 'Error', [field]: FREE_TEXT_WITNESS }));

      // Primero lo que NO puede cambiar: el sobre sigue siendo un fallo. Vaciar el issue no puede
      // convertirse en «no había problema» — sería la inversión fail-open de siempre.
      expect(observed.rejected, `${name}: el sobre se aceptó como éxito`).toBe(true);
      expect(observed.issues.length, `${name}: se perdió el issue entero`).toBeGreaterThan(0);

      const dump = JSON.stringify(observed.issues);
      expect(dump, `${name}: el issue publicó la frase del proveedor`).not.toContain(
        FREE_TEXT_WITNESS,
      );
      expect(dump, `${name}: el issue publicó PII de pasajero`).not.toContain(PII_INSIDE);
      expect(observed.logDump, `${name}: la frase llegó al log`).not.toContain(FREE_TEXT_WITNESS);
      expect(observed.logDump, `${name}: la PII llegó al log`).not.toContain(PII_INSIDE);
    },
  );

  it.each(LEAK_CASES)(
    '%s: la propiedad general — ninguna casilla del issue lleva espacios',
    async (name, field, wrap) => {
      // La forma general de lo que se está fijando, y la que sobrevive a que el proveedor cambie
      // de plantilla: un identificador de contrato no tiene espacios; una frase sí. Es el mismo
      // criterio que `SABRE_SAFE_CODE_SHAPE` ya aplica en `scalarIssue`.
      const observed = await post(wrap({ severity: 'Error', [field]: FREE_TEXT_WITNESS }));

      for (const issue of observed.issues) {
        for (const [key, value] of Object.entries(issue)) {
          if (typeof value !== 'string') continue;
          expect(/\s/.test(value), `${name}: issue.${key} lleva prosa («${value}»)`).toBe(false);
        }
      }
    },
  );
});

/* ────────────────────────────────────────────────────────────────────────────
 * (2) Y tampoco cuando la prosa viaja sin severidad declarada
 * ──────────────────────────────────────────────────────────────────────────── */

describe('el issue no transporta prosa aunque el item no declare severidad', () => {
  it.each(ISSUE_FIELDS)('`errors[]` con sólo `%s` en prosa', async (field) => {
    const observed = await post({ errors: [{ [field]: FREE_TEXT_WITNESS }] });

    expect(observed.rejected, 'el sobre se aceptó como éxito').toBe(true);
    expect(JSON.stringify(observed.issues)).not.toContain(PII_INSIDE);
    expect(observed.logDump).not.toContain(PII_INSIDE);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * (3) El precio: el vocabulario del contrato SÍ tiene que seguir viajando
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Valores REALES de los contratos y de las listas de errores oficiales. Si el arreglo del bloque
 * (1) se los lleva por delante, el vendedor se queda sin nada delante del cliente y eso también es
 * un fallo de producción. Este bloque está VERDE hoy y tiene que seguir verde después.
 *
 * `fieldPath` va con el ejemplo literal del contrato —`passenger.givenName`
 * (`stateless-ancillaries-api-1.0.yml:1159`), `someObject.someFieldName`
 * (`booking-management-v1.yml:4290`)—, no con una ruta inventada con `/` inicial.
 */
const CONTRACT_ISSUE = {
  severity: 'Error',
  code: 'ERR.2SG.SEC.NOT_AUTHORIZED',
  category: 'APPLICATION_ERROR',
  type: 'BusinessLogic',
  fieldPath: 'passenger.givenName',
} as const;

describe('el precio — el vocabulario cerrado del contrato sigue llegando al log', () => {
  it.each(CARRIERS)('%s: las cuatro casillas estructuradas viajan enteras', async (name, wrap) => {
    const observed = await post(wrap({ ...CONTRACT_ISSUE }));

    expect(observed.rejected, name).toBe(true);
    const dump = JSON.stringify(observed.issues);
    for (const value of ['ERR.2SG.SEC.NOT_AUTHORIZED', 'APPLICATION_ERROR', 'BusinessLogic']) {
      expect(dump, `${name}: se perdió «${value}», el log queda ciego`).toContain(value);
    }
    // `fieldPath` sólo lo publica el camino de `errors[]`; `messageIssue` nunca lo ha llevado.
    if (name === 'errors[]') expect(dump).toContain('passenger.givenName');
    expect(observed.logDump, `${name}: el log perdió el código`).toContain(
      'ERR.2SG.SEC.NOT_AUTHORIZED',
    );
  });

  it('un código de hoteles con prefijo de severidad sigue clasificando y saliendo', async () => {
    // `ERR.0161` / `WARN.0788` (`help/get-hotel-avail-v4/v4-errors.txt:12,49`): aquí el `code` ES
    // la severidad, así que perderlo cambiaría el veredicto, no sólo el log.
    const observed = await post({ messages: [{ code: 'ERR.0161' }] });

    expect(observed.rejected).toBe(true);
    expect(JSON.stringify(observed.issues)).toContain('ERR.0161');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * (4) El mutante concreto: el `code` cayendo a `text`
 * ──────────────────────────────────────────────────────────────────────────── */

describe('el `code` no puede caer al `text` del proveedor', () => {
  it.each(CARRIERS)(
    '%s: con `text` y sin `code`, el issue sale SIN code y el texto no viaja',
    async (name, wrap) => {
      // El mutante superviviente: `sabreEnvelopeString(item['code']) ?? sabreEnvelopeString(item['text'])`
      // en `messageIssue`. Con ese `??` puesto, la frase entra en `issue.code` y de ahí al log.
      const observed = await post(
        wrap({ severity: 'Error', type: 'BusinessLogic', text: FREE_TEXT_WITNESS }),
      );

      expect(observed.rejected, name).toBe(true);
      expect(observed.issues.length, name).toBeGreaterThan(0);
      for (const issue of observed.issues) {
        expect(issue.code, `${name}: el \`text\` se coló como \`code\``).toBeUndefined();
      }
      expect(JSON.stringify(observed.issues), name).not.toContain(PII_INSIDE);
      expect(observed.logDump, name).not.toContain(PII_INSIDE);
      // Y el diagnóstico estructurado sigue ahí: el arreglo no es vaciar el issue.
      expect(JSON.stringify(observed.issues), name).toContain('BusinessLogic');
    },
  );

  it.each(['description', 'message', 'fieldValue', 'freeText', 'remark'])(
    'lo mismo para `%s`: ninguna clave de prosa puede alimentar una casilla del issue',
    async (proseKey) => {
      const observed = await post({
        errors: [
          { severity: 'Error', category: 'APPLICATION_ERROR', [proseKey]: FREE_TEXT_WITNESS },
        ],
      });

      expect(observed.rejected).toBe(true);
      expect(JSON.stringify(observed.issues)).not.toContain(PII_INSIDE);
      expect(observed.logDump).not.toContain(PII_INSIDE);
      expect(JSON.stringify(observed.issues)).toContain('APPLICATION_ERROR');
    },
  );
});

/* ────────────────────────────────────────────────────────────────────────────
 * (5) `worstSeverity` — en un conflicto gana la MÁS GRAVE, no la del item
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Mutante superviviente medido: sustituir el cuerpo de `worstSeverity` por `return b` —gana la
 * severidad declarada por el item— dejaba la suite entera en verde. No es equivalente: la política
 * escrita dice «degradar es fail-open», y degradar es exactamente lo que hace.
 *
 * Los dos sentidos hay que medirlos por separado porque cada uno mata un mutante distinto, y el
 * de `errors[]` además tiene un enmascarador: cuando la clave es de error y el subárbol no produce
 * ningún fallo salta el backstop opaco, así que el sobre se sigue rechazando y `rejected` no
 * distingue. Lo que distingue es CON QUÉ se rechaza — con el código real o con un opaco ciego.
 */

describe('la severidad de un conflicto es la más grave, en los dos sentidos', () => {
  it('`errors[]` con un item que se declara Warning sigue siendo un fallo CON su código', async () => {
    // Mata `return b`. Con el mutante el issue baja a warning, `failures` se queda vacío y salta el
    // backstop: el sobre se rechaza igual, pero con un opaco. El log pierde `WARN.0788` y soporte
    // se queda mirando un `UNSTRUCTURED` que no dice nada.
    const observed = await post({ errors: [{ severity: 'Warning', code: 'WARN.0788' }] });

    expect(observed.rejected, 'el sobre se aceptó como éxito').toBe(true);
    expect(
      observed.issues.some((issue) => issue.severity === 'error' && issue.code === 'WARN.0788'),
      `el fallo perdió su código: ${JSON.stringify(observed.issues)}`,
    ).toBe(true);
  });

  it('`warnings[]` con un item que se declara Error es un FALLO, no un aviso', async () => {
    // Mata `return a`. Con ese mutante gana la clave contenedora, `failures` queda vacío, el
    // backstop de una clave de warning se conforma con cualquier issue y el sobre se ENTREGA como
    // reserva buena. Es la inversión fail-open completa, no una pérdida de diagnóstico.
    const observed = await post({
      warnings: [{ severity: 'Error', code: 'ERR.0161' }],
      groupedItineraryResponse: { version: '5' },
    });

    expect(observed.rejected, 'un error dentro de `warnings[]` se entregó como éxito').toBe(true);
    expect(
      observed.issues.some((issue) => issue.severity === 'error' && issue.code === 'ERR.0161'),
      JSON.stringify(observed.issues),
    ).toBe(true);
  });

  it('el control: un warning que ES un warning se sigue entregando', async () => {
    // Sin esto, «rechazar siempre» pasaría los dos de arriba. El coste de un falso positivo es el
    // vendedor sin resultados delante del cliente, y ese lado también hay que medirlo.
    const observed = await post({
      warnings: [{ severity: 'Warning', code: 'WARN.0322' }],
      groupedItineraryResponse: { version: '5' },
    });

    expect(observed.rejected, 'un aviso se convirtió en fallo').toBe(false);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * (6) La caja de las HOJAS del item, simétrica con la de las claves del sobre
 * ────────────────────────────────────────────────────────────────────────────
 *
 * El recorrido decide qué es `errors`, `Warning` o `ERROR_DETAILS` normalizando la clave sin
 * distinguir caja ni puntuación. Un nivel más abajo se leía `item['severity']` con la clave exacta
 * en minúsculas. Era un descuido, no una decisión, y el agujero es fail-open.
 *
 * Sabre mezcla las dos convenciones en el MISMO sobre: contenedores en PascalCase
 * (`ApplicationResults`, `Success`, `SystemSpecificResults`, `Message`) y hojas en camelCase
 * (`code`, `value`, `type`). Asumir una sola caja para las hojas no tiene apoyo en ningún contrato.
 */

describe('las hojas del item se leen con el mismo criterio de caja que las claves del sobre', () => {
  it('`{"Severity":"Error"}` dentro de `warnings[]` escala a fallo', async () => {
    // El agujero medido: con lectura sensible a la caja el item no declaraba nada, heredaba
    // `warning` de la clave, `failures` quedaba vacío y el 200 se entregaba como reserva buena.
    // Una `S` mayúscula colando exactamente lo que `worstSeverity` existe para impedir.
    const observed = await post({
      warnings: [{ Severity: 'Error', Code: 'ERR.0161' }],
      groupedItineraryResponse: { version: '5' },
    });

    expect(observed.rejected, 'la caja de una letra convirtió un error en éxito').toBe(true);
  });

  it('y el vocabulario en PascalCase también llega entero al log', async () => {
    const observed = await post({
      errors: [
        {
          Category: 'APPLICATION_ERROR',
          Type: 'BusinessLogic',
          Code: 'ERR.2SG.SEC.NOT_AUTHORIZED',
        },
      ],
    });

    expect(observed.rejected).toBe(true);
    const dump = JSON.stringify(observed.issues);
    for (const value of ['APPLICATION_ERROR', 'BusinessLogic', 'ERR.2SG.SEC.NOT_AUTHORIZED']) {
      expect(dump, `se perdió «${value}» por venir en PascalCase`).toContain(value);
    }
  });

  it('la lectura exacta manda: con las dos cajas presentes gana la del contrato', async () => {
    // Determinismo. El barrido normalizado es sólo el plan B; si mandara él, el issue dependería
    // del orden de las claves del proveedor.
    const observed = await post({ errors: [{ code: 'ERR.EXACTO', Code: 'ERR.OTRO' }] });

    expect(observed.issues.some((issue) => issue.code === 'ERR.EXACTO')).toBe(true);
    expect(JSON.stringify(observed.issues)).not.toContain('ERR.OTRO');
  });

  it('la simetría NO abre una puerta a la PII: la prosa en PascalCase también se redacta', async () => {
    // Ampliar QUÉ se lee no puede ampliar QUÉ se publica: son dos puertas distintas y sólo una es
    // la de publicación.
    const observed = await post({ errors: [{ Severity: 'Error', Code: FREE_TEXT_WITNESS }] });

    expect(observed.rejected).toBe(true);
    expect(JSON.stringify(observed.issues)).not.toContain(PII_INSIDE);
    expect(observed.logDump).not.toContain(PII_INSIDE);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * (7) La comparación de rutas del contexto: `endsWith`, nunca `includes`
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Mutante superviviente medido: cambiar `endsWith` por `includes` en la comparación de rutas
 * dejaba la suite entera en verde para el eje de `ApplicationResults`. Con ese cambio, CUALQUIER
 * ruta que CONTUVIERA una de las ocho lecturas de inventario heredaría su permiso para conceder
 * benignidad — incluida una operación de dinero.
 *
 * Los dos ejes comparten ya una sola función (`declaresOperation`), así que un solo test cubre la
 * comparación de ambos; aun así se mide el lado del dinero explícitamente, que es donde el mutante
 * cuesta una reserva.
 */

/** `ApplicationResults.Success` con un mensaje sin severidad declarada dentro del portador. */
const SUCCESS_CARRYING_MESSAGE = {
  ApplicationResults: {
    status: 'Complete',
    Success: [{ SystemSpecificResults: [{ Message: [{ content: 'Booking failed' }] }] }],
  },
};

describe('la ruta concede el permiso del contrato sólo si ES la operación, no si la contiene', () => {
  it('una ruta de dinero que CONTIENE una lectura de hoteles no hereda su benignidad', async () => {
    // El testigo del mutante. `includes` da por buena esta ruta porque lleva `/v5/get/hotelavail`
    // dentro; `endsWith` no, porque las rutas de la lista empiezan por `/` y sólo casan en
    // frontera de segmento FINAL. Lo que está en juego es un `createBooking` apagando el recorrido
    // de su propio subárbol: la reserva fantasma de la ronda 5 entrando por la puerta del contexto.
    const observed = await post(
      SUCCESS_CARRYING_MESSAGE,
      `${HOTEL_AVAIL_PATH}${CREATE_BOOKING_PATH}`,
    );

    expect(observed.rejected, 'una ruta de dinero heredó el permiso de una lectura').toBe(true);
  });

  it('el control positivo: la lectura de hoteles de verdad SÍ lo concede', async () => {
    // Sin este contraste el test de arriba lo pasaría cualquier cosa que rechazara siempre, y no
    // estaría midiendo la comparación de rutas sino nada.
    const observed = await post(SUCCESS_CARRYING_MESSAGE, HOTEL_AVAIL_PATH);

    expect(observed.rejected, 'la lectura declarada por el contrato se rechazó').toBe(false);
  });

  it('el otro eje comparte la comparación: `/remove-all` no es `/remove`', async () => {
    // `{}` es éxito declarado SÓLO en `/v1/ancillaries/remove`. Con `includes`, `/remove-all`
    // —que es otra operación— se llevaría la excepción por delante.
    expect((await post({}, REMOVE_ANCILLARIES_PATH)).rejected).toBe(false);
    expect((await post({}, `${REMOVE_ANCILLARIES_PATH}-all`)).rejected).toBe(true);
    expect((await post({}, CREATE_BOOKING_PATH)).rejected).toBe(true);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * (8) Los dos ejes del contexto NO fallan al mismo lado — medido, no supuesto
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Circula por el paquete la frase «sin ruta el clasificador cae al modo estricto». Es cierta en un
 * eje y FALSA en el otro:
 *
 *   - `contractDeclaresEmptyBodySuccess`  sin ruta → `false` → falla CERRADO.
 *   - `contractDeclaresApplicationResults` sin ruta → `true`  → falla ABIERTO.
 *
 * El segundo no puede invertirse hoy sin cambiar un falso positivo medido de 3/252 por uno masivo
 * y no medido: los ocho contratos que declaran `ApplicationResults` meten los avisos del proveedor
 * de fondo dentro de `Success[]`. La forma de cerrarlo de verdad es hacer `path` obligatorio en
 * `SabreEnvelopeContext` —que el compilador impida el olvido en vez de un default— y eso es un
 * cambio de API pública que no entra en esta ronda.
 *
 * Lo que sí entra es que la asimetría quede MEDIDA aquí, con las dos afirmaciones enfrentadas en
 * el mismo test, para que quien invierta un default lo haga a sabiendas y no leyendo una frase que
 * sólo es cierta a medias. Y con ella, lo que la hace tolerable: por la puerta pública el default
 * permisivo NO se ejerce, porque el cliente pasa siempre la ruta.
 */

describe('la asimetría de los dos ejes está medida, no supuesta', () => {
  it('sin ruta, el eje del cuerpo vacío falla CERRADO y el de la benignidad falla ABIERTO', () => {
    // El único test de este fichero que no pasa por `postJson`, y a propósito: lo que mide es el
    // DEFAULT del clasificador, que por la puerta pública es inalcanzable. Medir el default por la
    // puerta pública sería medir el cableado, no el default.
    expect(classifySabreEnvelope({}).ok, 'el cuerpo vacío dejó de fallar cerrado').toBe(false);
    expect(
      classifySabreEnvelope(SUCCESS_CARRYING_MESSAGE).ok,
      'el eje de la benignidad cambió de default sin actualizar esta medición',
    ).toBe(true);
  });

  it('pero por la puerta pública el default permisivo no se ejerce: la ruta llega siempre', async () => {
    // Éste es el pin que hace tolerable la asimetría de arriba. El día que alguien vuelva a
    // descartar la ruta en el cliente —ya pasó una ronda entera— este test se pone rojo y el de
    // arriba sigue verde, que es justo la señal que faltó entonces.
    expect((await post(SUCCESS_CARRYING_MESSAGE, CREATE_BOOKING_PATH)).rejected).toBe(true);
    expect((await post(SUCCESS_CARRYING_MESSAGE, HOTEL_AVAIL_PATH)).rejected).toBe(false);
  });
});
