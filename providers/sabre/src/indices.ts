import { z } from 'zod';

/**
 * ÚNICO punto de conversión 0-based → 1-based de todo el ACL de Sabre (RF-08 CA-4, riesgo R-22).
 *
 * ## Por qué existe un módulo entero para sumar uno
 *
 * Sabre numera pasajeros, vuelos, formas de pago y servicios especiales **desde 1**; nuestros
 * arrays, desde 0. Todos los campos afectados llevan `minimum: 1` en el contrato, verificado uno
 * a uno sobre `docs/sabre/evidence/specs/booking-management-v1.yml`:
 *
 *   - `travelerIndex` — `:5298` (asiento), `:7187` (coche), `:6068` (perfil), `:3864` (billete)
 *   - `flightIndices[]` — `:4921` (branded fare), `:5646` (documento de identidad), `:6126` (equipaje)
 *   - `flightIndex` — `:7238` (coche asociado a un vuelo)
 *   - `primaryFormOfPayment` / `secondaryFormOfPayment` — `:5736-5750`
 *   - `specialServiceIndex` — `:7143`
 *   - `emailIndex` — `:7187+` (email del viajero compartido con el proveedor de coche)
 *
 * Un off-by-one aquí **no lanza y no aparece en ningún test feliz**: la reserva se crea, el 200
 * llega, y el asiento queda asignado al pasajero equivocado o el cargo cae en la forma de pago
 * equivocada. Se descubre en el aeropuerto. Por eso la aritmética vive en dos funciones
 * —`toSabreIndex` y `toArrayPosition`, el único `+ 1` y el único `- 1` del paquete— y todo lo
 * demás se construye sobre ellas.
 *
 * ## Por qué tipos nominales y no `number`
 *
 * Con `number` a ambos lados, `travelerIndex: pos` compila igual de bien que `travelerIndex:
 * pos + 1`, y el compilador no tiene nada que decir. `SabreIndex` y `ArrayPosition` son marcas
 * distintas y **ninguna es asignable a la otra ni a un `number` literal**: un builder que declare
 * `travelerIndex: SabreIndex` no puede recibir una posición de array ni un `0` escrito a mano,
 * y sólo puede obtener el valor pasando por este módulo. La defensa la da el tipo, no la
 * disciplina de quien escribe el builder.
 *
 * Ambas marcas son `number` en tiempo de ejecución: `JSON.stringify` las serializa como el entero
 * que son, sin envoltorio ni conversión adicional en el borde.
 */

/**
 * Índice tal como lo entiende Sabre: 1-based. La marca sólo se pone dentro de este módulo, así
 * que un `SabreIndex` no existe sin haber pasado por alguna de sus funciones.
 */
export type SabreIndex = number & { readonly __sabreOneBasedIndex: 'sabre-1-based' };

/**
 * Posición dentro de uno de nuestros arrays: 0-based. Igual que `SabreIndex`, la marca sólo se
 * pone aquí dentro (`arrayPosition` la valida desde un `number`, `toArrayPosition` la deriva de
 * un índice del proveedor).
 */
export type ArrayPosition = number & { readonly __sabreZeroBasedPosition: 'array-0-based' };

/** Menor índice legal del API: todos los campos indexados declaran `minimum: 1`. */
export const SABRE_INDEX_MIN = 1;

/**
 * `Payment.formsOfPayment` admite como máximo **10** elementos (`booking-management-v1.yml:5708-5711`).
 *
 * ⚠️ El propio contrato se contradice: `PaymentMethod.primaryFormOfPayment` declara `maximum: 11`
 * (`:5738-5744`), un índice que **no puede existir** en un array de 10. Se adopta el límite del
 * array, que es el que el backend puede satisfacer; el 11 queda documentado abajo para que nadie
 * vuelva a "corregir" esta constante leyendo sólo la mitad del spec.
 */
export const SABRE_FORMS_OF_PAYMENT_MAX_ITEMS = 10;

/** El `maximum` declarado —e inconsistente— de `primaryFormOfPayment` (`:5742`). No usar como cota. */
export const SABRE_FORM_OF_PAYMENT_INDEX_DECLARED_MAX = 11;

/**
 * Índice o posición fuera de contrato. No es un fallo del proveedor: es un bug nuestro detectado
 * antes de salir al cable, así que no cuenta para el circuit breaker ni se reintenta.
 */
export class SabreIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SabreIndexError';
  }
}

/** `Number.isSafeInteger` rechaza `NaN`, `Infinity`, decimales y enteros fuera de 2^53. */
function assertSafeInteger(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new SabreIndexError(`${what} tiene que ser un entero seguro, y llegó ${String(value)}`);
  }
}

/**
 * Marca una posición cruda de array. Valida que sea un entero ≥ 0 **antes** de convertirla: un
 * `-1` de un `findIndex` que no encontró nada se convertiría en el índice `0`, que Sabre rechaza
 * pero que en otros contextos sería un índice válido apuntando al pasajero equivocado.
 */
export function arrayPosition(position: number): ArrayPosition {
  assertSafeInteger(position, 'la posición de array');
  if (position < 0) {
    throw new SabreIndexError(
      `la posición de array no puede ser negativa, y llegó ${String(position)} ` +
        `(¿un findIndex sin resultado?)`,
    );
  }
  return position as ArrayPosition;
}

/** El ÚNICO `+ 1` del paquete. */
export function toSabreIndex(position: ArrayPosition): SabreIndex {
  return (position + 1) as SabreIndex;
}

/** El ÚNICO `- 1` del paquete. Inverso exacto de `toSabreIndex`. */
export function toArrayPosition(index: SabreIndex): ArrayPosition {
  return (index - 1) as ArrayPosition;
}

/**
 * Desenvuelve para serializar. Identidad en runtime; existe para que el borde sea explícito.
 *
 * No hay simétrico para `ArrayPosition` a propósito: una posición 0-based **nunca** se serializa
 * —Sabre sólo ve índices 1-based— y para leer el array no hace falta desenvolverla, porque la
 * marca ya es un `number`. Publicar un `positionValue` sería publicar el desenvoltorio del único
 * valor que no debe salir al cable.
 */
export function indexValue(index: SabreIndex): number {
  return index;
}

/**
 * Convierte una posición **comprobada contra el array real**. Es la vía preferente en un builder:
 * un índice que no apunta a ningún elemento es un bug, y aquí muere en vez de viajar a Sabre.
 */
export function sabreIndexIn<T>(items: readonly T[], position: number): SabreIndex {
  const checked = arrayPosition(position);
  if (checked >= items.length) {
    throw new SabreIndexError(
      `la posición ${String(checked)} no existe en una lista de ${String(items.length)} elementos`,
    );
  }
  return toSabreIndex(checked);
}

/**
 * Vuelta atrás: el elemento al que apunta un índice de Sabre. Cierra el round-trip.
 *
 * ## Por qué se conserva sin llamador de producción
 *
 * Es el lado LECTURA de `sabreIndexIn`, y hoy ningún mapper necesita el elemento: el único sitio
 * que recibe un índice del proveedor (`booking/get.response.mapper.ts`, `flightTickets[]
 * .travelerIndex`) sólo quiere saber si apunta a alguien, tiene la longitud y no la lista, y
 * emite un aviso en vez de lanzar. Por eso no puede usar esta función, y por eso hace su
 * comprobación con `toArrayPosition` — la aritmética sigue viviendo aquí.
 *
 * El primer mapper que necesite el elemento y no lo encuentre publicado escribirá
 * `items[index - 1]`, que es exactamente el `- 1` suelto que este módulo existe para que no
 * haya. Es la única vuelta COMPROBADA de índice a elemento: `toArrayPosition` da la posición,
 * pero no dice si esa posición existe.
 */
export function elementAtSabreIndex<T>(items: readonly T[], index: SabreIndex): T {
  const position = toArrayPosition(index);
  if (position < 0 || position >= items.length) {
    throw new SabreIndexError(
      `el índice ${String(index)} no apunta a ningún elemento de una lista de ` +
        `${String(items.length)} elementos`,
    );
  }
  const element = items[position];
  if (element === undefined) {
    throw new SabreIndexError(`el elemento en la posición ${String(position)} es undefined`);
  }
  return element;
}

/**
 * Busca y devuelve el índice de Sabre, o `undefined` si no hay coincidencia. Nunca devuelve 0.
 *
 * ## Por qué se conservan `findSabreIndex` y `requireSabreIndex` sin llamador de producción
 *
 * Los builders de hoy reciben la posición ya resuelta desde arriba (`seat.travelerPosition`,
 * `document.flightPositions`) y les basta `sabreIndexIn`. El día que un builder tenga que
 * *emparejar* —el asiento con el pasajero al que se lo vendieron, el documento con su viajero—
 * lo natural sin esto publicado es `items.findIndex(match) + 1`.
 *
 * Y ese `+ 1` es el peor de todos: `findIndex` devuelve `-1` cuando no encuentra nada, y
 * `-1 + 1` es **0**. No es un valor absurdo que salte a la vista, es un índice con pinta de
 * índice. Hoy todos los campos indexados declaran `minimum: 1` (ver la cabecera), así que el 0
 * acaba rechazado —pero por Sabre, en el cable, con un error de contrato genérico que no dice
 * qué lista ni qué búsqueda falló, en vez de morir aquí nombrando las dos cosas.
 * `arrayPosition` mata ese `-1` antes de sumarle nada; estas dos son la puerta que lleva a él.
 *
 * La sonda de `indices.test.ts` («asignación de asientos») es ese builder futuro escrito sólo con
 * la API pública: existe para que la conversión esté probada el día que alguien la escriba de
 * verdad, no para justificar el export.
 */
export function findSabreIndex<T>(
  items: readonly T[],
  match: (value: T) => boolean,
): SabreIndex | undefined {
  const position = items.findIndex(match);
  return position < 0 ? undefined : toSabreIndex(arrayPosition(position));
}

/** Igual que `findSabreIndex` pero exige coincidencia: la ausencia es un bug, no un caso. */
export function requireSabreIndex<T>(
  items: readonly T[],
  match: (value: T) => boolean,
  what: string,
): SabreIndex {
  const index = findSabreIndex(items, match);
  if (index === undefined) {
    throw new SabreIndexError(`no se encontró ${what} en una lista de ${String(items.length)}`);
  }
  return index;
}

/**
 * Cota superior explícita para los campos que la declaran (`primaryFormOfPayment`,
 * `secondaryFormOfPayment`). Se aplica sobre el índice ya convertido, que es como lo declara
 * el contrato.
 */
export function sabreIndexAtMost(index: SabreIndex, max: number, field: string): SabreIndex {
  assertSafeInteger(max, `la cota de ${field}`);
  if (index > max) {
    throw new SabreIndexError(
      `${field} admite como máximo el índice ${String(max)}, y llegó ${String(index)}`,
    );
  }
  return index;
}

/**
 * Borde de ENTRADA: un índice que nos manda Sabre en una respuesta (`travelerIndex` de un
 * billete, `flightIndices` de un documento). Llega ya 1-based y hay que validarlo antes de
 * usarlo para volver a nuestros arrays; un `0` del proveedor convertido a `-1` leería el array
 * por el final o daría `undefined` silencioso.
 */
export function parseSabreIndex(value: unknown, what = 'el índice'): SabreIndex {
  if (typeof value !== 'number') {
    throw new SabreIndexError(`${what} tiene que ser un número, y llegó ${typeof value}`);
  }
  assertSafeInteger(value, what);
  if (value < SABRE_INDEX_MIN) {
    throw new SabreIndexError(
      `${what} es 1-based: el mínimo es ${String(SABRE_INDEX_MIN)}, y llegó ${String(value)}`,
    );
  }
  return value as SabreIndex;
}

/**
 * El mismo borde de entrada en forma de schema, para componer dentro de los mappers de respuesta
 * sin repetir la validación (CLAUDE.md: Zod en cada borde).
 */
export const SabreIndexSchema = z
  .number()
  .int()
  .min(SABRE_INDEX_MIN)
  .transform((value): SabreIndex => value as SabreIndex);
