import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { describe, expect, it } from 'vitest';

import * as index from './index';

import * as airlineRequirements from './booking/airline-requirements';
import * as cancelRequest from './booking/cancel.request.builder';
import * as cancelResponse from './booking/cancel.response.mapper';
import * as createRequest from './booking/create.request.builder';
import * as createResponse from './booking/create.response.mapper';
import * as getRequest from './booking/get.request.builder';
import * as getResponse from './booking/get.response.mapper';
import * as indices from './indices';
import * as priceRequest from './price/request.builder';
import * as priceResponse from './price/response.mapper';
import * as flightCheckRequest from './flight-check/request.builder';
import * as flightCheckResponse from './flight-check/response.mapper';
import * as flightCheckAdapter from './sabre-flight-check.adapter';
import * as offerPriceAdapter from './sabre-offer-price.adapter';
import * as orderCreateAdapter from './sabre-order-create.adapter';
import * as orderManageAdapter from './sabre-order-manage.adapter';

/**
 * La SONDA del entry público: que lo que `src/index.ts` publica sea **el mismo objeto** que el
 * módulo define, y no una copia.
 *
 * Es el tercer guard de la familia y comprueba lo que los otros dos no pueden:
 *
 *  - `dist-surface.guard.test.ts` comprueba ALCANZABILIDAD: que ningún `.ts` de `src/` se
 *    compile y se publique sin que el entry lo importe.
 *  - `dist-artifact.guard.test.ts` comprueba FRESCURA SEMÁNTICA del artefacto.
 *  - éste comprueba IDENTIDAD: que `index.SABRE_PRICE_PATH` sea `===` al que declara
 *    `price/request.builder`, no un string con el mismo valor escrito otra vez.
 *
 * Sin él, el modo de fallo que este paquete ya pagó cinco veces vuelve por la puerta del entry:
 * un `export const SABRE_CANCEL_BOOKING_PATH = '/v1/…'` escrito a mano en `index.ts` compila,
 * pasa los otros dos guards, y a partir de ahí producción llama a una ruta y los tests miden
 * otra. La comprobación no es «los valores coinciden» —eso lo haría igual una copia recién
 * escrita— sino «es el mismo objeto», que una copia no puede fingir.
 *
 * Los `export type` no aparecen aquí: no existen en tiempo de ejecución. De ésos responde el
 * `typecheck`, que falla con `ts2305`/`ts2308` si el entry re-declara o pierde un tipo.
 *
 * ## Lo que la identidad NO puede ver, y qué lo tapa
 *
 * `Object.is` distingue dos objetos con el mismo contenido, pero **no** dos primitivos con el
 * mismo valor: una copia recién escrita de `SABRE_CANCEL_BOOKING_PATH` —el mismo string, otra
 * declaración— pasa la comprobación de identidad sin despeinarse. Está medido: la mutación que
 * re-declara esa constante en el entry deja los 181 casos verdes.
 *
 * Lo que sí ve la identidad es una copia de string YA DIVERGIDA, que es el estado en el que la
 * copia hace daño. Y el hueco de la copia todavía-idéntica lo cierra el último bloque de este
 * fichero, que es una regla sobre la FUENTE del entry: `src/index.ts` no declara nada, sólo
 * re-exporta. Sin declaración local no hay copia posible, ni primitiva ni de ninguna clase.
 */

interface ProbedModule {
  readonly name: string;
  readonly module: Record<string, unknown>;
  /**
   * Nombres que el entry NO publica de este módulo, con el motivo. La lista existe para que una
   * omisión sea una DECISIÓN escrita y no un olvido: cualquier export nuevo que no esté aquí
   * pone el test rojo.
   */
  readonly notPublished?: Readonly<Record<string, string>>;
}

const PROBED: readonly ProbedModule[] = [
  { name: 'indices', module: indices },
  { name: 'booking/airline-requirements', module: airlineRequirements },
  { name: 'booking/create.request.builder', module: createRequest },
  {
    name: 'booking/create.response.mapper',
    module: createResponse,
    notPublished: {
      SABRE_STATUS_NAMES:
        'declarado con el mismo valor en booking/get.response.mapper; se publica aquél para que ' +
        'el `export *` no sea ambiguo (ts2308). Ver la nota en src/index.ts.',
    },
  },
  { name: 'booking/get.request.builder', module: getRequest },
  { name: 'booking/get.response.mapper', module: getResponse },
  { name: 'booking/cancel.request.builder', module: cancelRequest },
  { name: 'booking/cancel.response.mapper', module: cancelResponse },
  { name: 'price/request.builder', module: priceRequest },
  { name: 'price/response.mapper', module: priceResponse },
  { name: 'flight-check/request.builder', module: flightCheckRequest },
  { name: 'flight-check/response.mapper', module: flightCheckResponse },
  { name: 'sabre-flight-check.adapter', module: flightCheckAdapter },
  { name: 'sabre-offer-price.adapter', module: offerPriceAdapter },
  { name: 'sabre-order-create.adapter', module: orderCreateAdapter },
  { name: 'sabre-order-manage.adapter', module: orderManageAdapter },
];

describe('el entry público republica los módulos, no copias de ellos', () => {
  const surface = index as unknown as Record<string, unknown>;

  for (const probed of PROBED) {
    describe(probed.name, () => {
      const exported = Object.keys(probed.module).filter((key) => key !== 'default');

      it('exporta algo (si no, el módulo cambió de forma y el test se volvió vacuo)', () => {
        expect(exported.length).toBeGreaterThan(0);
      });

      it.each(exported)('%s es el MISMO objeto en el entry', (name) => {
        const reason = probed.notPublished?.[name];
        if (reason !== undefined) {
          // La lista de omisiones se VERIFICA, no se cree: si el entry acabara publicando este
          // objeto, la entrada estaría caducada y el comentario que la justifica sería falso.
          expect(
            Object.is(surface[name], probed.module[name]),
            `'${name}' está en \`notPublished\` (${reason}) pero el entry SÍ publica el objeto ` +
              `de ${probed.name}: borrá la entrada en vez de dejar la nota mintiendo.`,
          ).toBe(false);
          return;
        }

        expect(
          Object.hasOwn(surface, name),
          `src/index.ts no publica '${name}' de ${probed.name}: el módulo no es alcanzable desde ` +
            `fuera del paquete y su código es código muerto. Añadilo al entry, o declaralo en ` +
            `\`notPublished\` con el motivo.`,
        ).toBe(true);

        expect(
          Object.is(surface[name], probed.module[name]),
          `src/index.ts publica un '${name}' que NO es el de ${probed.name}: es una copia. Una ` +
            `copia deriva del original en la siguiente edición y produce el modo de fallo que ` +
            `este paquete ya pagó: tests midiendo una regla y producción ejecutando otra.`,
        ).toBe(true);
      });
    });
  }
});

describe('la omisión deliberada de SABRE_STATUS_NAMES es segura', () => {
  it('los dos mappers de booking declaran el MISMO vocabulario de StatusNameEnum', () => {
    // El entry publica el de `get.response.mapper` y calla el de `create.response.mapper` porque
    // un `export *` con dos declaraciones del mismo nombre es ambiguo. Eso sólo es aceptable
    // mientras los dos digan lo mismo: el día que uno cambie, este test se pone rojo y hay que
    // renombrar uno de los dos en vez de dejar que el consumidor lea el vocabulario equivocado.
    expect(createResponse.SABRE_STATUS_NAMES).toEqual(getResponse.SABRE_STATUS_NAMES);
    expect(index.SABRE_STATUS_NAMES).toBe(getResponse.SABRE_STATUS_NAMES);
  });
});

describe('los adapters de pricing y orden son alcanzables desde el entry', () => {
  // Escrito nombre a nombre y no derivado del módulo: es la lista que `apps/api` importa, y su
  // ausencia es exactamente el cableado perdido que dejó un eje entero inalcanzable en producción.
  it.each([
    ['SabreOfferPriceAdapter', offerPriceAdapter.SabreOfferPriceAdapter],
    ['SabreFlightCheckAdapter', flightCheckAdapter.SabreFlightCheckAdapter],
    ['DENY_CARD_BIN_PRICING', offerPriceAdapter.DENY_CARD_BIN_PRICING],
    ['SabreOrderCreateAdapter', orderCreateAdapter.SabreOrderCreateAdapter],
    ['SabreOrderManageAdapter', orderManageAdapter.SabreOrderManageAdapter],
  ])('%s', (_label, value) => {
    const published = Object.values(index as unknown as Record<string, unknown>);
    expect(published).toContain(value);
  });
});

describe('el entry no declara nada: sólo re-exporta', () => {
  /**
   * El carril que tapa el hueco de los primitivos.
   *
   * La identidad no puede distinguir `'/v1/trip/orders/cancelBooking'` declarado aquí de
   * `'/v1/trip/orders/cancelBooking'` declarado en su módulo, así que la defensa se pone un paso
   * antes: si el entry no puede DECLARAR, no puede copiar. Se comprueba sobre el texto de
   * `src/index.ts` porque es donde la regla vive; en el módulo compilado la distinción ya se
   * perdió.
   */
  it('src/index.ts no tiene ninguna declaración exportada propia', () => {
    const entry = findEntry();
    const source = readFileSync(entry, 'utf8');

    // `export const|let|var|function|class|enum|interface|type X = …` en columna 0. Se exceptúa
    // `export type { … } from` / `export { … } from`, que son re-exportaciones y no declaraciones.
    const declarations = [
      ...source.matchAll(/^export\s+(?:declare\s+)?(const|let|var|function|class|enum)\s+(\w+)/gm),
    ].map((match) => `${String(match[1])} ${String(match[2])}`);

    expect(
      declarations,
      `src/index.ts declara símbolos propios (${declarations.join(', ')}). El entry re-exporta y ` +
        `nada más: una constante declarada aquí es una COPIA del módulo que la define, y una ` +
        `copia de string es invisible para la comprobación de identidad hasta que diverge — que ` +
        `es justo cuando ya ha hecho daño.`,
    ).toEqual([]);
  });
});

/** La raíz del paquete desde el cwd de vitest, igual que hace `dist-surface.guard.test.ts`. */
function findEntry(): string {
  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const name = (JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string }).name;
      if (name === '@sales-travel/sabre') return join(dir, 'src', 'index.ts');
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolvePath(process.cwd(), 'providers', 'sabre', 'src', 'index.ts');
}
