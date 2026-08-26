import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from './config';
import { SabreApiError } from './errors';
import { SabreHttpClient } from './http/sabre-http.client';
import { FREE_TEXT, REDACTED, redactMeta } from './redaction';

/**
 * Las dos piezas de política de `redaction.ts` cuyo comentario prometía efecto sin que ningún test
 * lo comprobara: la PRECEDENCIA de `maskForKey` y la SEGUNDA PASADA de `clampAndRedact`.
 *
 * Se midieron por separado y el resultado es distinto para cada una, así que se tratan distinto:
 *
 *  - **`maskForKey` — la precedencia es INERTE hoy, y la unicidad es lo observable.** El comentario
 *    dice «un secreto se tapa como secreto aunque también fuese texto libre». Medido: no existe
 *    clave que sea las dos cosas. `isFreeTextKey` compara EXACTO contra un conjunto cerrado —14
 *    literales hoy— y ninguno cae en ninguna de las cuatro reglas de secreto ni en las tres de PII.
 *    La rama nunca se ejecuta, con el `if` en un orden o en el otro: verificado intercambiando los
 *    dos `if` de `maskForKey` y ejecutando la suite entera, que se queda VERDE. Es un mutante
 *    equivalente, no un hueco de test, y por eso el bloque 2 vigila la premisa en vez de fingir
 *    que fija la precedencia.
 *    Lo que sí decide todos los días —y lo que sujeta el bloque 1— es que `maskForKey` sea la
 *    ÚNICA decisión: los cuatro sitios que enmascaran por clave le preguntan a ella, así que la
 *    misma clave sale con la misma marca por los cuatro. Eso sí tiene mutantes y se matan.
 *    El bloque 2 vigila la inercia: si alguien mete en `FREE_TEXT_KEYS` un literal que también sea
 *    secreto, el test se pone rojo y la precedencia deja de ser inerte ese mismo día.
 *
 *  - **`clampAndRedact` — la segunda pasada es LOAD-BEARING y se mata su mutante.** Ver el bloque 3:
 *    hay un cuerpo real que publica un PAN entero en el mensaje del error si se quita.
 */

const SHOP_PATH = '/v5/offers/shop';
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

/** Puerta pública: el cuerpo entra por `postJson` y sale por el `body` del error. */
async function bodyThroughHttpClient(rawBody: string): Promise<string> {
  const fetchImpl: SabreFetch = () => Promise.resolve(new Response(rawBody, { status: 500 }));
  const http = new SabreHttpClient(config(), tokens, {
    fetch: fetchImpl,
    sleep: () => Promise.resolve(),
    jitter: () => 0,
    uuid: () => 'conv-fijo',
  });
  const error = (await http.postJson(SHOP_PATH, {}).catch((e: unknown) => e)) as SabreApiError;
  expect(error).toBeInstanceOf(SabreApiError);
  return `${error.message}|${error.body}`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 1. Lo observable de `maskForKey`: una sola decisión para los cuatro carriles
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Los cuatro sitios que enmascaran por clave, ejercidos con la MISMA clave. Un carril que se
 * pregunte la política por su cuenta se ve aquí y sólo aquí: con la marca cambiada, o sin marca.
 */
const RAILS: ReadonlyArray<readonly [string, (key: string, value: string) => string]> = [
  ['redactValue (meta de log)', (key, value) => JSON.stringify(redactMeta({ [key]: value }))],
  [
    'carril JSON del escáner',
    (key, value) => JSON.stringify(redactMeta({ d: `{"${key}":"${value}"}` })),
  ],
  [
    'carril form-urlencoded',
    (key, value) => JSON.stringify(redactMeta({ d: `${key}=${value}&x=1` })),
  ],
  [
    'carril XML/SOAP',
    (key, value) => JSON.stringify(redactMeta({ d: `<${key}>${value}</${key}>` })),
  ],
];

describe('`maskForKey` es la única decisión: los cuatro carriles dan la misma marca', () => {
  it.each(RAILS)('%s — una clave de texto libre sale como TEXTO-LIBRE', (_name, run) => {
    const out = run('message', 'el proveedor escribió esto');

    expect(out).toContain(FREE_TEXT);
    expect(out, 'un secreto y una prosa no pueden llevar la misma marca').not.toContain(REDACTED);
  });

  it.each(RAILS)('%s — una clave de secreto sale como REDACTADO', (_name, run) => {
    const out = run('password', 'S3CR3T0-DE-OFICINA');

    expect(out).toContain(REDACTED);
    expect(out).not.toContain(FREE_TEXT);
    expect(out).not.toContain('S3CR3T0-DE-OFICINA');
  });

  it.each(RAILS)('%s — una clave que no manda nada deja pasar el valor', (_name, run) => {
    // El tercer estado de `maskForKey` (`null`). Sin él, «los cuatro carriles coinciden» se podría
    // cumplir tapándolo todo, que es el otro fallo de producción de este módulo.
    const out = run('itineraryRef', WITNESS);

    expect(out).toContain(WITNESS);
    expect(out).not.toContain(REDACTED);
    expect(out).not.toContain(FREE_TEXT);
  });

  it('y por la puerta pública del cliente HTTP, que es lo que ve un llamador', async () => {
    const dump = await bodyThroughHttpClient(
      JSON.stringify({ message: 'prosa del proveedor', password: 'S3CR3T0-DE-OFICINA' }),
    );

    expect(dump).toContain(FREE_TEXT);
    expect(dump).toContain(REDACTED);
    expect(dump).not.toContain('S3CR3T0-DE-OFICINA');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. Lo inerte de `maskForKey`: la precedencia, con vigilancia
 * ──────────────────────────────────────────────────────────────────────────── */

/** Raíz del paquete: el mismo idiom que los guards de `dist-*`, por el cwd variable de vitest. */
function findPackageRoot(): string {
  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const name = (JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string }).name;
      if (name === '@sales-travel/sabre') return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const fromWorkspace = resolvePath(process.cwd(), 'providers', 'sabre');
  if (existsSync(join(fromWorkspace, 'package.json'))) return fromWorkspace;
  throw new Error('no se encontró la raíz de @sales-travel/sabre desde el cwd');
}

/**
 * Los literales de `FREE_TEXT_KEYS` leídos de la fuente, no copiados a mano.
 *
 * Copiarlos convertiría este bloque en un test que sólo vigila lo que ya se sabía: una entrada
 * NUEVA en el Set —la que podría solaparse con un secreto y encender la precedencia— no aparecería
 * aquí y nadie se enteraría. Leyendo la fuente, el dominio del bloque crece solo con el Set.
 */
function freeTextKeysFromSource(): readonly string[] {
  const source = readFileSync(join(findPackageRoot(), 'src', 'redaction.ts'), 'utf8');
  const block = /const FREE_TEXT_KEYS = new Set\(\[([\s\S]*?)\]\)/.exec(source);
  if (block?.[1] === undefined) {
    throw new Error('no se pudo leer FREE_TEXT_KEYS de src/redaction.ts: ¿cambió su forma?');
  }
  return [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1] as string);
}

const FREE_TEXT_VOCABULARY = freeTextKeysFromSource();

describe('la precedencia de `maskForKey` es inerte: ninguna clave es secreto Y texto libre', () => {
  it('el vocabulario de texto libre no está vacío ni se leyó a medias', () => {
    // Anti-vacuidad: sin esto, un cambio de forma en el Set dejaría el bloque de abajo pasando por
    // no tener casos, que es exactamente cómo se pierde un guard sin que nadie lo note.
    expect(FREE_TEXT_VOCABULARY.length).toBeGreaterThanOrEqual(10);
    expect(FREE_TEXT_VOCABULARY).toContain('description');
    expect(FREE_TEXT_VOCABULARY).toContain('fieldvalue');
  });

  it.each(FREE_TEXT_VOCABULARY)(
    '`%s` sale como TEXTO-LIBRE y nunca como REDACTADO — la rama de secreto no se ejecuta',
    (key) => {
      // Este bloque NO mata el mutante «cambia el orden de los dos `if`»: con el orden invertido
      // pasa igual, porque ninguna de estas claves entra por la rama de secreto. Lo que hace es
      // vigilar la premisa. Si un día entra una que sí, este test se pone rojo, y ahí hay que
      // decidir a mano cuál de las dos marcas quiere el módulo — que es justo la pregunta que la
      // precedencia contesta por escrito y que hoy nadie le hace.
      const out = JSON.stringify(redactMeta({ [key]: WITNESS }));

      expect(
        out,
        `«${key}» dejó de ser sólo texto libre: la precedencia acaba de encenderse`,
      ).toContain(FREE_TEXT);
      expect(out).not.toContain(REDACTED);
      expect(out).not.toContain(WITNESS);
    },
  );
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. `clampAndRedact`: la segunda pasada sí tiene mutante, y se mata
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * El PAN de prueba de los contratos. Con un dígito de secuencia pegado detrás
 * (`…11119`) la tirada es de 17 dígitos, Luhn no la confirma y la PRIMERA pasada la deja literal.
 */
const PAN = '4111111111111111';

/**
 * Cuerpo construido para que el corte de `DEFAULT_BODY_SUMMARY_CHARS` (300) caiga **justo tras el
 * dígito 16**: 274 caracteres de relleno, 10 espacios y el PAN en los índices 284…299.
 *
 * Los 10 espacios no son adorno: `collapse` aplasta las tiradas de blancos DESPUÉS de que el
 * escáner haya emitido, y sin ellos el resumen se pasa de 300 y se lleva por delante la última
 * media docena de caracteres — justo la que distingue los dos comportamientos. Con ellos, el
 * resultado cabe entero y la aserción puede mirar el valor final en vez de un trozo.
 */
function bodyWithPanAtTheCut(): string {
  return JSON.stringify({ d: `${'A'.repeat(274)}${' '.repeat(10)}${PAN}9${'B'.repeat(400)}` });
}

describe('`clampAndRedact` vuelve a redactar DESPUÉS de cortar', () => {
  it('el corte DELIMITA un PAN que la primera pasada no podía confirmar', async () => {
    // El mutante: `return safe`. Entonces el valor sin cortar llega a `collapse`, que trunca a 300
    // sin mirar lo que corta, y el resumen del error publica `41111111111111119` entero. Medido.
    const dump = await bodyThroughHttpClient(bodyWithPanAtTheCut());

    expect(dump, 'el PAN salió entero en el mensaje del error').not.toContain(PAN);
    expect(dump, 'no hay marca: el PAN se perdió por truncado, no por redacción').toContain(
      REDACTED,
    );
  });

  it('CONTROL: sin llegar al corte, esos mismos 17 dígitos SALEN literales', async () => {
    // Es lo que convierte el caso de arriba en una prueba de la segunda pasada y no de la primera:
    // demuestra que `redactText` sobre el valor entero NO ve este número. Si algún día lo viera,
    // el test de arriba pasaría por la razón equivocada y este control lo diría.
    const dump = await bodyThroughHttpClient(JSON.stringify({ d: `X${PAN}9` }));

    expect(dump).toContain(`${PAN}9`);
  });

  it('CONTROL: el mismo cuerpo SIN el dígito de cola lo tapa ya la primera pasada', async () => {
    // La otra mitad del contraste: aquí la tirada es de 16, Luhn la confirma sin ayuda del corte.
    const sinCola = JSON.stringify({
      d: `${'A'.repeat(274)}${' '.repeat(10)}${PAN}${'B'.repeat(400)}`,
    });
    const dump = await bodyThroughHttpClient(sinCola);

    expect(dump).not.toContain(PAN);
    expect(dump).toContain(REDACTED);
  });

  it('y el corte no puede APAGAR una detección: el importe largo sigue saliendo', async () => {
    // El precio del bloque, en la dirección contraria: redactar dos veces no puede convertirse en
    // una excusa para tapar cualquier tirada de dígitos. Un número que Luhn no confirma sobrevive
    // a las dos pasadas.
    const dump = await bodyThroughHttpClient(JSON.stringify({ totalFare: '123456789012345' }));

    expect(dump).toContain('123456789012345');
  });
});
