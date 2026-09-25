import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { describe, expect, it } from 'vitest';

import * as index from './index';

import * as policyMapper from './cancellation/policy.mapper';
import * as config from './config';
import * as errors from './errors';
import * as limiter from './http/limiter';
import * as operations from './http/operations';
import * as statusEnvelope from './http/status-envelope';
import * as httpClient from './http/tbo-http.client';
import * as providerCode from './provider-code';
import * as redaction from './redaction';
import * as mealType from './search/meal-type';
import * as offerWindow from './search/offer-window';
import * as searchMapper from './search/response.mapper';
import * as searchSchema from './search/response.schema';
import * as searchBuilder from './search/search.request.builder';
import * as adapter from './tbo-hotels.adapter';

/**
 * La SONDA del entry público, sobre el modelo de `providers/sabre/src/index.surface.test.ts`.
 *
 * Comprueba tres cosas que el typecheck no ve:
 *
 *  1. IDENTIDAD: lo que `src/index.ts` publica es el MISMO objeto que define su módulo, no una copia
 *     escrita otra vez. Una copia deriva en la siguiente edición y deja a los tests midiendo una
 *     regla y a producción ejecutando otra.
 *  2. CIERRE: no se publica nada fuera de la lista. `src/internal/**` y los tipos crudos de TBO no
 *     salen del paquete (08 RF-07 CA-6); un `export *` que arrastrara un helper interno pondría
 *     esto rojo.
 *  3. FUENTE: el entry no declara nada ni usa `export *`. La identidad no distingue dos strings con
 *     el mismo valor, así que el hueco de la copia todavía idéntica se tapa prohibiendo declarar.
 *
 * Los `export type` no existen en tiempo de ejecución: de ésos responde el `typecheck`.
 */

interface ProbedModule {
  readonly name: string;
  readonly module: Record<string, unknown>;
  /** Exports del módulo que el entry NO publica, con el motivo. Una omisión es una decisión escrita. */
  readonly notPublished?: Readonly<Record<string, string>>;
}

const PROBED: readonly ProbedModule[] = [
  { name: 'config', module: config },
  { name: 'errors', module: errors },
  { name: 'http/operations', module: operations },
  { name: 'http/tbo-http.client', module: httpClient },
  { name: 'http/limiter', module: limiter },
  {
    name: 'http/status-envelope',
    module: statusEnvelope,
    notPublished: {
      classifyTboResponse:
        'la única regla que decide éxito o error; sólo la ejecuta el cliente, nunca un llamador',
      TBO_STATUS_CODES: 'tabla interna del clasificador; fuera se razona por `failure.kind`',
      TBO_DESCRIPTION_LOG_MAX: 'detalle del log del cliente',
    },
  },
  {
    name: 'redaction',
    module: redaction,
    notPublished: {
      normalizeTboKey: 'helper de la guarda D1 y de la exportación; sin uso fuera del paquete',
      isTboCardKey: 'la guarda D1 vive en el cliente; fuera no hay nada que decidir con esto',
      isTboSensitiveKey: 'lo aplica `redactTboPayload`, que es la superficie de exportación',
      TBO_LOG_FIELDS: 'la lista blanca la aplica el cliente al loguear; no es configurable',
      pickTboLogMeta: 'ídem: el cliente es el único que escribe logs con datos de TBO',
    },
  },
  { name: 'provider-code', module: providerCode },
  {
    name: 'search/search.request.builder',
    module: searchBuilder,
    notPublished: {
      buildTboSearchRequest:
        'arma el body crudo de TBO; lo usa el adapter del paquete y el arnés pasa por el adapter',
    },
  },
  { name: 'search/offer-window', module: offerWindow },
  {
    name: 'search/response.schema',
    module: searchSchema,
    notPublished: {
      TboDecimalSchema: 'esquema crudo de TBO (08 RF-07 CA-6)',
      TboSupplementSchema: 'esquema crudo de TBO (08 RF-07 CA-6)',
      TboCancelPolicySchema: 'esquema crudo de TBO (08 RF-07 CA-6)',
      TboSearchRoomSchema: 'esquema crudo de TBO (08 RF-07 CA-6)',
      TboSearchHotelSchema: 'esquema crudo de TBO (08 RF-07 CA-6)',
      TboSearchEnvelopeSchema: 'esquema crudo de TBO; lo pasa el adapter como responseSchema',
      TBO_SEARCH_ROOT_KEYS: 'detalle de la detección de claves desconocidas del mapper',
      TBO_SEARCH_HOTEL_KEYS: 'ídem',
      TBO_SEARCH_ROOM_KEYS: 'ídem',
      TBO_SUPPLEMENT_KEYS: 'ídem',
      TBO_CANCEL_POLICY_KEYS: 'ídem',
      TBO_DAY_RATE_KEYS: 'ídem',
    },
  },
  {
    name: 'search/response.mapper',
    module: searchMapper,
    notPublished: {
      mapTboSearchResponse:
        'recibe el sobre crudo de TBO; fuera del paquete la salida es el adapter (PR-1.5)',
    },
  },
  {
    name: 'search/meal-type',
    module: mealType,
    notPublished: {
      TBO_MEAL_PLANS: 'vocabulario del request de TBO; fuera se filtra por BoardType',
      mapTboMealType: 'lo aplica el mapper; fuera se lee board, boardLabel y mealTypeRaw',
    },
  },
  { name: 'tbo-hotels.adapter', module: adapter },
  {
    name: 'cancellation/policy.mapper',
    module: policyMapper,
    notPublished: {
      mapTboCancellation:
        'recibe tramos crudos de TBO; lo comparten los mappers de Search y PreBook',
    },
  },
];

const surface = index as unknown as Record<string, unknown>;

describe('el entry público republica los módulos, no copias de ellos', () => {
  for (const probed of PROBED) {
    describe(probed.name, () => {
      const exported = Object.keys(probed.module).filter((key) => key !== 'default');

      it('exporta algo (si no, el módulo cambió de forma y el test se volvió vacuo)', () => {
        expect(exported.length).toBeGreaterThan(0);
      });

      it.each(exported)('%s es el MISMO objeto en el entry', (name) => {
        const reason = probed.notPublished?.[name];
        if (reason !== undefined) {
          expect(
            Object.is(surface[name], probed.module[name]),
            `'${name}' está en \`notPublished\` (${reason}) pero el entry SÍ lo publica.`,
          ).toBe(false);
          return;
        }
        expect(
          Object.hasOwn(surface, name),
          `src/index.ts no publica '${name}' de ${probed.name}. Añadilo al entry o declaralo en ` +
            `\`notPublished\` con el motivo.`,
        ).toBe(true);
        expect(
          Object.is(surface[name], probed.module[name]),
          `src/index.ts publica un '${name}' que NO es el de ${probed.name}: es una copia.`,
        ).toBe(true);
      });
    });
  }
});

describe('el entry no publica nada fuera de los módulos sondeados', () => {
  it('cada nombre del entry sale de un módulo sondeado', () => {
    const allowed = new Set(
      PROBED.flatMap((probed) =>
        Object.keys(probed.module).filter((key) => probed.notPublished?.[key] === undefined),
      ),
    );
    const extra = Object.keys(surface).filter((key) => !allowed.has(key));
    expect(
      extra,
      `src/index.ts publica nombres que no vienen de un módulo sondeado (${extra.join(', ')}). ` +
        `Si es superficie nueva, sumá su módulo a PROBED; si es un helper interno, no se publica.`,
    ).toEqual([]);
  });

  it('los helpers de src/internal no son alcanzables desde fuera', () => {
    for (const name of [
      'decimalToMinor',
      'toMinorUnits',
      'minorUnitExponent',
      'optionalString',
      'optionalInteger',
      'toList',
      'parseTboCancelPolicyDate',
      'isTboIsoDate',
      'zodIssueRef',
      'zodIssueRefs',
    ]) {
      expect(Object.hasOwn(surface, name), `'${name}' es interno y no debe publicarse`).toBe(false);
    }
  });
});

describe('la fuente del entry', () => {
  const source = readFileSync(findEntry(), 'utf8');

  it('no declara nada: sólo re-exporta', () => {
    const declarations = [
      ...source.matchAll(/^export\s+(?:declare\s+)?(const|let|var|function|class|enum)\s+(\w+)/gm),
    ].map((match) => `${String(match[1])} ${String(match[2])}`);
    expect(declarations).toEqual([]);
  });

  it('no usa export *: la superficie se nombra entera', () => {
    expect(source).not.toMatch(/^export\s+\*/m);
    expect(source).not.toMatch(/^export\s+type\s+\*/m);
  });

  it('no re-exporta nada de src/internal', () => {
    expect(source).not.toMatch(/from\s+'\.\/internal\//);
  });

  it('no re-exporta los esquemas crudos de TBO ni los mappers que los reciben (08 RF-07 CA-6)', () => {
    expect(source).not.toMatch(/from\s+'\.\/search\/response\.(schema|mapper)'/);
    expect(source).not.toMatch(/from\s+'\.\/search\/meal-type'/);
    expect(source).not.toMatch(/from\s+'\.\/cancellation\//);
    expect(source).not.toMatch(/\bbuildTboSearchRequest\b|\bTboSearchRequest\b/);
  });
});

/** La raíz del paquete desde el cwd de vitest, igual que en Sabre. */
function findEntry(): string {
  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const name = (JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string }).name;
      if (name === '@sales-travel/tbo-hotels') return join(dir, 'src', 'index.ts');
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolvePath(process.cwd(), 'providers', 'tbo-hotels', 'src', 'index.ts');
}
