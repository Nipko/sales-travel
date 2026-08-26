import { describe, expect, it } from 'vitest';
import {
  SABRE_FORMS_OF_PAYMENT_MAX_ITEMS,
  SABRE_FORM_OF_PAYMENT_INDEX_DECLARED_MAX,
  SABRE_INDEX_MIN,
  SabreIndexError,
  SabreIndexSchema,
  arrayPosition,
  elementAtSabreIndex,
  findSabreIndex,
  indexValue,
  parseSabreIndex,
  requireSabreIndex,
  sabreIndexAtMost,
  sabreIndexIn,
  toArrayPosition,
  toSabreIndex,
} from './indices';
import type { SabreIndex } from './indices';

/**
 * Generador determinista. No hay `fast-check` en el workspace y no se añade una dependencia por
 * un test: `mulberry32` da la misma secuencia en cada máquina y en cada corrida, así que un fallo
 * es reproducible por el número de caso, que es lo único que se le pide a un generador aquí.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CASES = 500;

interface Passenger {
  readonly name: string;
}

const passengers = (count: number): Passenger[] =>
  Array.from({ length: count }, (_unused, position) => ({ name: `PAX-${String(position)}` }));

describe('indices — propiedad 0-based → 1-based (RF-08 CA-4, R-22)', () => {
  it('para cualquier lista de N elementos, el índice emitido es pos + 1 en TODAS las posiciones', () => {
    const random = mulberry32(0x5ab7e);
    for (let testCase = 0; testCase < CASES; testCase += 1) {
      // 1..40 pasajeros: cubre el caso de uno solo, que es donde un off-by-one se esconde mejor
      // porque `[0]` y `[1]` no se distinguen si sólo se mira que "hay un índice".
      const count = 1 + Math.floor(random() * 40);
      const list = passengers(count);

      // Escrito con el mismo idioma que usan los builders de producción
      // (`create.request.builder.ts:1343`): `map` sobre la lista + `sabreIndexIn` con la posición.
      // Si la sonda usara azúcar que sólo existe para el test, probaría un camino que nadie anda.
      const emitted = list.map((_passenger, position) => indexValue(sabreIndexIn(list, position)));

      expect(emitted, `caso ${String(testCase)} con ${String(count)} elementos`).toEqual(
        Array.from({ length: count }, (_unused, position) => position + 1),
      );
      expect(emitted[0]).toBe(SABRE_INDEX_MIN);
      expect(emitted).not.toContain(0);
    }
  });

  it('el round-trip índice → posición → índice es la identidad, y devuelve el MISMO elemento', () => {
    const random = mulberry32(0xc0ffee);
    for (let testCase = 0; testCase < CASES; testCase += 1) {
      const count = 1 + Math.floor(random() * 40);
      const list = passengers(count);
      const position = Math.floor(random() * count);

      const index = sabreIndexIn(list, position);
      const back = toArrayPosition(index);
      const again = toSabreIndex(back);

      // Se compara como `number` crudo a propósito: la marca `ArrayPosition` no sobrevive a la
      // serialización ni tiene por qué, y lo que se está probando es el valor, no el tipo.
      expect<number>(back, `caso ${String(testCase)}`).toBe(position);
      expect(indexValue(again)).toBe(indexValue(index));
      // La identidad que de verdad importa no es numérica: es que el índice siga apuntando al
      // mismo pasajero después de ir y volver.
      expect(elementAtSabreIndex(list, again)).toBe(list[position]);
    }
  });

  it('el índice de cada posición devuelve ESE elemento, nunca el del vecino', () => {
    const random = mulberry32(0x1ee7);
    for (let testCase = 0; testCase < CASES; testCase += 1) {
      const list = passengers(1 + Math.floor(random() * 25));
      list.forEach((passenger, position) => {
        // Ida y vuelta sobre la MISMA lista: es la propiedad que un `+ 0` o un `+ 2` rompen y
        // que «el número es un número» no ve.
        expect(
          elementAtSabreIndex(list, sabreIndexIn(list, position)),
          `caso ${String(testCase)}`,
        ).toBe(passenger);
      });
    }
  });
});

describe('indices — sonda de comportamiento: asignación de asientos', () => {
  /**
   * El builder de asientos que aún no existe, reducido a lo que importa y escrito SÓLO con la API
   * pública de este módulo. Es la sonda que mata al mutante: un `+ 1` que se convierta en `+ 0`
   * o en `+ 2` no se ve en «el número es un número», se ve aquí, en que el 13A acaba en otro
   * pasajero. `BookGenericSeat` exige `travelerIndex` (booking-management-v1.yml:5291-5303).
   */
  function buildSeatOffers(
    travelers: readonly Passenger[],
    seats: readonly { readonly passenger: Passenger; readonly number: string }[],
  ): { travelerIndex: number; number: string }[] {
    return seats.map((seat) => ({
      travelerIndex: indexValue(
        requireSabreIndex(travelers, (candidate) => candidate === seat.passenger, 'el pasajero'),
      ),
      number: seat.number,
    }));
  }

  it('el asiento viaja con el índice del pasajero al que se le asignó', () => {
    const travelers = passengers(4);
    const tercero = travelers[2];
    if (tercero === undefined) throw new Error('la lista de prueba tiene que traer 4 pasajeros');

    const offers = buildSeatOffers(travelers, [{ passenger: tercero, number: '13A' }]);

    expect(offers).toEqual([{ travelerIndex: 3, number: '13A' }]);
    // Y el índice, leído como lo leería Sabre, devuelve al mismo pasajero.
    expect(elementAtSabreIndex(travelers, parseSabreIndex(offers[0]?.travelerIndex))).toBe(tercero);
  });

  it('con todos los pasajeros sentados, ningún asiento comparte índice y ninguno vale 0', () => {
    const travelers = passengers(6);
    const offers = buildSeatOffers(
      travelers,
      travelers.map((passenger, position) => ({ passenger, number: `${String(position + 1)}A` })),
    );

    expect(offers.map((offer) => offer.travelerIndex)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(offers.map((offer) => offer.travelerIndex)).size).toBe(6);
  });
});

describe('indices — lo que NO se deja pasar', () => {
  it('rechaza el -1 de un findIndex sin resultado en vez de convertirlo en el índice 0', () => {
    expect(() => arrayPosition(-1)).toThrow(SabreIndexError);
    expect(() => arrayPosition(-1)).toThrow(/findIndex/);
  });

  it('rechaza posiciones que no existen en la lista', () => {
    const list = passengers(3);
    expect(() => sabreIndexIn(list, 3)).toThrow(SabreIndexError);
    expect(() => sabreIndexIn(list, 99)).toThrow(/no existe en una lista de 3/);
  });

  it('rechaza no-enteros, NaN e Infinity', () => {
    expect(() => arrayPosition(1.5)).toThrow(SabreIndexError);
    expect(() => arrayPosition(Number.NaN)).toThrow(SabreIndexError);
    expect(() => arrayPosition(Number.POSITIVE_INFINITY)).toThrow(SabreIndexError);
  });

  it('`findSabreIndex` devuelve undefined —nunca 0— cuando no hay coincidencia', () => {
    const list = passengers(3);
    expect(findSabreIndex(list, () => false)).toBeUndefined();
    expect(findSabreIndex(list, (passenger) => passenger.name === 'PAX-0')).toBe(1);
  });

  it('`requireSabreIndex` lanza cuando la ausencia sería un bug silencioso', () => {
    expect(() => requireSabreIndex(passengers(2), () => false, 'el pasajero')).toThrow(
      SabreIndexError,
    );
  });

  it('`elementAtSabreIndex` distingue «el índice se sale» de «el elemento es undefined»', () => {
    const list = passengers(2);
    expect(() => elementAtSabreIndex(list, parseSabreIndex(3))).toThrow(SabreIndexError);

    // La CLASE del error no basta como aserción, y está medido: la mutación que borra la cota
    // superior (`position >= items.length`) dejaba los 18 casos verdes, porque el fallo salía por
    // el guardia de `undefined` de más abajo — mismo `SabreIndexError`, otro diagnóstico. Y el
    // diagnóstico es justo lo que se lee a las dos de la mañana: «el índice 3 no cabe en 2» dice
    // que lo desalineado es el índice; «el elemento es undefined» acusa al contenido del array.
    // Fijar los dos mensajes es lo único que separa los dos fallos.
    expect(() => elementAtSabreIndex(list, parseSabreIndex(3))).toThrow(
      /el índice 3 no apunta a ningún elemento de una lista de 2/,
    );

    const conHueco: readonly (Passenger | undefined)[] = [passengers(1)[0], undefined];
    expect(() => elementAtSabreIndex(conHueco, parseSabreIndex(2))).toThrow(
      /el elemento en la posición 1 es undefined/,
    );
  });
});

describe('indices — borde de ENTRADA (índices que manda Sabre)', () => {
  it('rechaza el 0: el contrato declara minimum 1 en todos los campos indexados', () => {
    expect(() => parseSabreIndex(0)).toThrow(/1-based/);
    expect(() => SabreIndexSchema.parse(0)).toThrow();
  });

  it('rechaza lo que no es número, en vez de propagar un NaN a la aritmética', () => {
    expect(() => parseSabreIndex('2')).toThrow(SabreIndexError);
    expect(() => parseSabreIndex(null)).toThrow(SabreIndexError);
    expect(() => parseSabreIndex(undefined)).toThrow(SabreIndexError);
  });

  it('acepta un índice legal y lo devuelve tal cual, sin restar en la entrada', () => {
    expect(indexValue(parseSabreIndex(1))).toBe(1);
    expect(indexValue(SabreIndexSchema.parse(7))).toBe(7);
  });

  it('lo que entra por el borde vuelve a la posición correcta del array', () => {
    const random = mulberry32(0xbadc0de);
    for (let testCase = 0; testCase < CASES; testCase += 1) {
      const list = passengers(1 + Math.floor(random() * 20));
      const wireIndex = 1 + Math.floor(random() * list.length);
      expect(
        elementAtSabreIndex(list, parseSabreIndex(wireIndex)),
        `caso ${String(testCase)}`,
      ).toBe(list[wireIndex - 1]);
    }
  });
});

describe('indices — cotas del contrato', () => {
  it('`sabreIndexAtMost` deja pasar dentro de la cota y lanza fuera', () => {
    const forms = passengers(SABRE_FORMS_OF_PAYMENT_MAX_ITEMS);
    const last = sabreIndexIn(forms, forms.length - 1);
    expect(indexValue(sabreIndexAtMost(last, SABRE_FORMS_OF_PAYMENT_MAX_ITEMS, 'x'))).toBe(10);
    expect(() => sabreIndexAtMost(last, 9, 'primaryFormOfPayment')).toThrow(
      /primaryFormOfPayment admite como máximo el índice 9/,
    );
  });

  it('la cota real es la del array (10), no el maximum declarado e inconsistente (11)', () => {
    // `formsOfPayment` tiene maxItems 10 (:5708-5711) y `primaryFormOfPayment` maximum 11 (:5742).
    // El 11 no puede existir; fijar la relación aquí evita que alguien "corrija" la constante.
    expect(SABRE_FORM_OF_PAYMENT_INDEX_DECLARED_MAX).toBeGreaterThan(
      SABRE_FORMS_OF_PAYMENT_MAX_ITEMS,
    );
    const forms = passengers(SABRE_FORMS_OF_PAYMENT_MAX_ITEMS);
    expect(() => sabreIndexIn(forms, SABRE_FORMS_OF_PAYMENT_MAX_ITEMS)).toThrow(SabreIndexError);
  });
});

describe('indices — la marca nominal es lo que impide el error, no la disciplina', () => {
  it('un number crudo no es asignable donde se espera un SabreIndex', () => {
    // ⚠️ ESTE caso lo mata `pnpm typecheck`, NO `vitest`. Vitest transpila sin comprobar tipos, así
    // que las tres constantes de abajo se evalúan igual con marca y sin ella y el `expect` pasaría
    // en los dos mundos. La aserción de verdad son las tres ANOTACIONES: si alguien borra la marca
    // de `SabreIndex`, `EsAsignable<number, SabreIndex>` pasa a ser `true` y `tsc` da
    // `TS2322: Type 'false' is not assignable to type 'true'` en las dos anotaciones que esperan
    // `false`. Verificado plantando ese mutante. El `expect` está para que el bloque no sea código
    // muerto que el lint borre por no usarse, no para probar nada por su cuenta.
    //
    // Se escribe con un tipo y no con `@ts-expect-error` porque este último choca con las reglas
    // `no-unsafe-*` del lint y, si el día de mañana el error desapareciera por otra razón, se
    // pondría rojo por el motivo equivocado.
    type EsAsignable<From, To> = [From] extends [To] ? true : false;

    const numberNoEsIndice: EsAsignable<number, SabreIndex> = false;
    const indiceSiEsNumber: EsAsignable<SabreIndex, number> = true;
    const posicionNoEsIndice: EsAsignable<ReturnType<typeof arrayPosition>, SabreIndex> = false;

    expect([numberNoEsIndice, indiceSiEsNumber, posicionNoEsIndice]).toEqual([false, true, false]);
  });
});
