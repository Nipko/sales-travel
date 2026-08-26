import { describe, expect, it } from 'vitest';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from './config';
import { SABRE_ISSUE_FREE_TEXT_UNAUTHORIZED, SabreApiError } from './errors';
import { SabreHttpClient } from './http/sabre-http.client';

/**
 * `normalizeCategory` — qué parte de esa función cambia el veredicto y qué parte no.
 *
 * ## Por qué existe este fichero
 *
 * El único test que la tocaba —`errors.test.ts`, «normaliza categorías compuestas y la errata
 * APPLICATION_EROR»— comprueba que `CANCELLATION_ERROR/WARNING` y `APPLICATION_EROR` dan
 * `BUSINESS`. `BUSINESS` es la rama **por defecto** del `switch`: los dos literales dan `BUSINESS`
 * también con la función vaciada entera, y también devolviendo la cadena tal cual. Se lee como si
 * fijara la normalización y no fija nada. Encima entra por `classifySabreFailure`, que es la
 * función y no la puerta por la que llega una categoría de verdad.
 *
 * Aquí se separa lo observable de lo inerte, y todo entra por `postJson`.
 *
 * ## Observable: el plegado de caja (bloque 1)
 *
 * `toUpperCase` sólo se nota cuando el resultado cae en un `case` del `switch`, y hay que elegir un
 * `case` cuya política se distinga de la de por defecto: `forbidden` → `ENTITLEMENT` con
 * `operatorAlert`, contra `BUSINESS` sin aviso. `application_eror` no sirve para medir nada porque
 * el destino es el mismo con y sin plegado.
 *
 * ## Inerte, medido, y escrito como inerte (bloques 2, 3 y 4)
 *
 * Las tres inercias se verificaron con mutantes sobre la suite ENTERA, no razonando sobre el
 * código: reducida `normalizeCategory` a `return category.toUpperCase()` —sin troceado, sin
 * `trim` y sin la corrección de la errata— los 1.244 tests del paquete siguen en VERDE. Con el
 * `toUpperCase` quitado se ponen rojos cinco, y los cinco son de este fichero. O sea: de las
 * cuatro operaciones de esa función, hoy sólo una tiene efecto observable.
 *
 *   - **`APPLICATION_EROR → APPLICATION_ERROR`**: `APPLICATION_ERROR` no es un `case`, así que la
 *     errata y su corrección caen las dos en `default`. Borrar esa línea no produce ninguna
 *     diferencia por ninguna puerta del paquete.
 *   - **`.trim()`**: inalcanzable. El único sitio que rellena `category` es el cliente HTTP con
 *     `verdict.failures[0].category`, y ese campo pasó antes por `safeIssueField`, que no publica
 *     nada con espacios. Una categoría con espacio alrededor no llega como categoría.
 *   - **el troceado por `/`**: inalcanzable **desde esta ronda**, y no por esta función. Ver el
 *     bloque 4: es un efecto colateral del endurecimiento de `safeIssueField` y está reportado.
 *
 * Los bloques 2, 3 y 4 **no matan ningún mutante y no dicen que lo hagan**. Fijan el
 * comportamiento de hoy y llevan el mensaje de qué decisión hay que tomar el día que se pongan
 * rojos, que es cuando la política correspondiente deje de ser inerte.
 */

const SHOP_PATH = '/v5/offers/shop';

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

/** Puerta pública: un 200 con `errors[]` entra por `postJson` y sale como `SabreApiError`. */
async function classifyThroughHttpClient(category: string): Promise<SabreApiError> {
  const fetchImpl: SabreFetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ errors: [{ severity: 'Error', category }] }), { status: 200 }),
    );
  const http = new SabreHttpClient(config(), tokens, {
    fetch: fetchImpl,
    sleep: () => Promise.resolve(),
    jitter: () => 0,
    uuid: () => 'conv-fijo',
  });
  const error = (await http.postJson(SHOP_PATH, {}).catch((e: unknown) => e)) as SabreApiError;
  expect(error).toBeInstanceOf(SabreApiError);
  return error;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 1. Observable: el plegado de caja decide la política
 * ──────────────────────────────────────────────────────────────────────────── */

describe('categorías en minúscula — el `toUpperCase` sí cambia el veredicto', () => {
  it.each(['forbidden', 'Forbidden', 'FoRbIdDeN'])(
    '`%s` clasifica como `FORBIDDEN`: ENTITLEMENT con aviso al operador',
    async (category) => {
      // Sin el plegado, la cadena no casa con ningún `case` y cae en `BUSINESS`: nadie recibe el
      // aviso de que a ese PCC le falta una suscripción, y el vendedor ve un «error de negocio»
      // que ningún reintento ni ninguna persona va a arreglar.
      const error = await classifyThroughHttpClient(category);

      expect(error.failure.kind).toBe('ENTITLEMENT');
      expect(error.failure.operatorAlert).toBe(true);
      expect(error.failure.retry).toBe('NO_RETRY');
    },
  );

  it.each(['resource_restricted', 'internal_server_error'])(
    '`%s` — el plegado vale para todo el `switch`, no sólo para un literal',
    async (category) => {
      const error = await classifyThroughHttpClient(category);

      expect(error.failure.kind).not.toBe('BUSINESS');
    },
  );

  it('CONTROL: un literal que NO es `case` sigue en BUSINESS, en mayúsculas o minúsculas', async () => {
    // El testigo del bloque: sin él, los casos de arriba podrían estar pasando por otra vía y
    // `ENTITLEMENT` podría no venir del `switch`.
    expect((await classifyThroughHttpClient('BAD_REQUEST')).failure.kind).toBe('BUSINESS');
    expect((await classifyThroughHttpClient('bad_request')).failure.kind).toBe('BUSINESS');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. Inerte: la corrección de la errata
 * ──────────────────────────────────────────────────────────────────────────── */

describe('la corrección de `APPLICATION_EROR` no tiene efecto observable', () => {
  it('la errata y el literal correcto son INDISTINGUIBLES por la puerta pública', async () => {
    // Pasa con la corrección y pasa sin ella: no hay mutante que matar. Lo que documenta es que
    // `APPLICATION_ERROR` no es un `case` del `switch`. Se pondrá rojo el día que alguien lo
    // añada, y ése es el día en que la corrección deja de ser inerte.
    const conErrata = await classifyThroughHttpClient('APPLICATION_EROR');
    const correcto = await classifyThroughHttpClient('APPLICATION_ERROR');

    expect(conErrata.failure.kind).toBe('BUSINESS');
    expect(correcto.failure.kind).toBe(conErrata.failure.kind);
    expect(correcto.failure.retry).toBe(conErrata.failure.retry);
    expect(correcto.failure.circuit).toBe(conErrata.failure.circuit);
    expect(correcto.failure.operatorAlert).toBe(conErrata.failure.operatorAlert);
  });

  it('la errata CRUDA sí viaja al issue, que es donde de verdad sirve', async () => {
    // Lo que hay que conservar de la errata no es la clasificación —es la misma— sino que el
    // literal llegue al log: es lo que le dice a soporte que el sobre venía del dialecto con la
    // errata y no de nuestro parser.
    const error = await classifyThroughHttpClient('APPLICATION_EROR');

    expect(error.issues[0]?.category).toBe('APPLICATION_EROR');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. Inerte: el `.trim()`
 * ──────────────────────────────────────────────────────────────────────────── */

describe('el `.trim()` de la normalización es inalcanzable por la puerta pública', () => {
  it.each([' FORBIDDEN', 'FORBIDDEN ', ' FORBIDDEN '])(
    '`%s` no llega como categoría: `safeIssueField` no publica nada con espacios',
    async (category) => {
      // Esa puerta corre ANTES que `normalizeCategory`, así que el `trim` no llega ni a ejecutarse
      // sobre este valor. El veredicto es `BUSINESS` y no `ENTITLEMENT` porque la categoría nunca
      // existió como tal — no porque el `trim` falle.
      const error = await classifyThroughHttpClient(category);

      expect(error.failure.kind).toBe('BUSINESS');
      expect(error.issues[0]?.category).not.toBe('FORBIDDEN');
    },
  );
});

/* ─────────────────────────────────────────────────────────────────────────────
 * 4. OBSERVABLE otra vez: el troceado por `/` y la marca de entitlement
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * La ronda 11 dejó este bloque exigiendo `BUSINESS` y escribió al lado la condición de su propia
 * caducidad: «SI ESTE BLOQUE SE PONE ROJO: se restauró el paso de las compuestas. Entonces el
 * troceado por `/` vuelve a ser observable y este bloque tiene que volver a exigir la política del
 * `case`». Es lo que ha pasado, y esto es esa reescritura.
 *
 * ## Qué se rompió y qué costaba de verdad
 *
 * El endurecimiento de `safeIssueField` trataba el `/` como marca de dato —`SMITH/JOHNMR`— y no
 * como separador, así que una categoría compuesta se publicaba como valor opaco y lo que llegaba
 * al clasificador ya no era el literal. Consecuencia de NEGOCIO, no técnica: a una agencia a la
 * que le falta contratado un producto con Sabre, el rechazo se registraba como fallo de negocio
 * corriente y `operatorAlert` se quedaba en `false`. El vendedor sigue viendo que hay algo capado
 * —eso lo sostiene `partialUnauthorized`, y por otra vía—, pero nadie del equipo se entera de que
 * hay una venta bloqueada por papeleo, que es justo el aviso que existe para gestionarlo
 * comercialmente.
 *
 * ## La regla nueva, y por qué ésa
 *
 * Verificado contra `docs/sabre/evidence/specs/` antes de decidirla: los valores compuestos del
 * expediente son 44 y **los 44 acaban en la misma cola** — `CANCELLATION_ERROR/WARNING` (×36),
 * `CHECK_ERROR/WARNING` (×6), `APPLICATION_ERROR/WARNING`, `RS/Warning`. No hay ninguna otra cola,
 * y el propio expediente explica qué significa: la categoría sale como error o como warning según
 * el `ErrorHandlingPolicy` de la request
 * (`help/booking-management-api-v1/help-documentation-cancel-booking.txt:151`). O sea que la cola
 * es severidad, no contenido — y la severidad ya viaja en su propio campo del `SabreIssue`.
 *
 * Medido también: **no hay una sola compuesta con cabeza de entitlement** en los `.yml` ni en las
 * listas (`FORBIDDEN` aparece 39 veces, `UNAUTHORIZED` 33, `RESOURCE_RESTRICTED` 2, y ninguna
 * seguida de `/`). Las tres de este bloque son forma HIPOTÉTICA y se dice aquí para no fingir
 * evidencia que no existe. Se tratan igual porque la cola es la misma y porque el coste de no
 * tratarlas es perder el aviso comercial.
 *
 * Así que la puerta admite la cola de severidad y juzga la CABEZA: `isPublishableIssueValue` mide
 * la estructura sobre la cabeza y los otros dos filtros sobre el valor entero. `SMITH/JOHNMR` no
 * tiene cola de severidad y sigue fuera; `AB1234567/WARNING` la tiene pero su cabeza no pasa.
 *
 * ## Los dos mutantes que mata
 *
 *   - quitar `SABRE_ISSUE_COMPOSITE_SEVERITY` de `isPublishableIssueValue` (vuelve el hallazgo);
 *   - quitar de `normalizeCategory` el troceado por `/` (la compuesta llega entera al `switch` y
 *     no casa con ningún `case`).
 */

describe('las categorías compuestas vuelven a decidir la política', () => {
  it.each(['FORBIDDEN/WARNING', 'UNAUTHORIZED/WARNING', 'RESOURCE_RESTRICTED/WARNING'])(
    '`%s`: ENTITLEMENT con aviso al operador, como su cabeza',
    async (category) => {
      const error = await classifyThroughHttpClient(category);

      expect(error.failure.kind, 'la compuesta no llegó al `switch`').toBe('ENTITLEMENT');
      expect(
        error.failure.operatorAlert,
        'sin aviso nadie gestiona el alta comercial de esa agencia',
      ).toBe(true);
      expect(error.failure.retry).toBe('NO_RETRY');
    },
  );

  it('la compuesta viaja ENTERA al issue: la cola es lo que soporte necesita para el diagnóstico', async () => {
    // Se publica el literal del proveedor, no la cabeza recortada: `CANCELLATION_ERROR/WARNING`
    // le dice a soporte con qué `ErrorHandlingPolicy` salió el sobre, y eso no se puede
    // reconstruir desde `CANCELLATION_ERROR`.
    const error = await classifyThroughHttpClient('CANCELLATION_ERROR/WARNING');

    expect(error.issues[0]?.category).toBe('CANCELLATION_ERROR/WARNING');
  });

  it('CONTROL: una compuesta que NO es de entitlement sigue en BUSINESS', async () => {
    // El testigo del bloque. Sin él, `ENTITLEMENT` podría venir de que cualquier compuesta cae en
    // el mismo sitio, y entonces los tres casos de arriba no medirían el `switch`.
    const error = await classifyThroughHttpClient('CANCELLATION_ERROR/WARNING');

    expect(error.failure.kind).toBe('BUSINESS');
    expect(error.failure.operatorAlert).toBe(false);
  });

  it.each(['AB1234567/WARNING', 'SMITH/JOHNMR/WARNING', 'XKCD12/ERROR'])(
    'el precio NO es un agujero: `%s` no se publica por tener cola de severidad',
    async (category) => {
      // La cola admite la COLA, no la cabeza: la cabeza sigue pasando los tres filtros enteros.
      const observed = await classifyThroughHttpClient(category);

      expect(JSON.stringify(observed.issues)).not.toContain(category.split('/')[0]);
      expect(observed.message).not.toContain(category.split('/')[0]);
      expect(observed.body).not.toContain(category.split('/')[0]);
    },
  );

  it('la marca de entitlement sobrevive aunque la categoría sea PROSA, y con ella el aviso', async () => {
    // El otro carril del mismo arreglo, y el que cubre lo que el contrato NO declara: los 21
    // `.yml` declaran `category` como `type: string` con un `example:` y cero `enum`, así que una
    // plantilla `%s` interpolada es forma posible. Esa prosa no se publica —y no debe—, pero lo
    // que llega al clasificador es el sentinel `FREE_TEXT_REDACTED_UNAUTHORIZED`, que sigue
    // diciendo «esto era entitlement».
    //
    // MUTANTE QUE MATA: quitar de `normalizeCategory` la línea del sentinel. Sin ella el veredicto
    // cae en `default` y `operatorAlert` se queda en `false`.
    const error = await classifyThroughHttpClient('UNAUTHORIZED: PCC not subscribed for ZZ1A');

    expect(error.failure.kind).toBe('ENTITLEMENT');
    expect(error.failure.operatorAlert).toBe(true);
    // Y la prosa no viaja: lo que se conserva es el resultado de un booleano, nunca el texto.
    expect(error.issues[0]?.category).toBe(SABRE_ISSUE_FREE_TEXT_UNAUTHORIZED);
    expect(error.message).not.toContain('ZZ1A');
    expect(error.body).not.toContain('ZZ1A');
  });
});
