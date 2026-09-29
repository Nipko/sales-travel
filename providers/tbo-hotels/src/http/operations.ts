/**
 * La ÚNICA tabla de operaciones de TBO (docs/tbo/01 §3.1, §5.2, §10.2 y §10.4; 08 RF-02 y RNF-01).
 *
 * Todo lo que el cliente HTTP necesita saber de una operación vive en su fila: path, verbo,
 * timeout, intentos, si mueve dinero, a qué cupo del limitador va, si el envelope `Status` es
 * obligatorio y si su `Status.Description` se puede loguear. Ningún otro archivo del paquete
 * escribe un path de TBO (RF-02 CA-5, lo vigila `operations.test.ts`): el casing de los paths no
 * es consistente entre el PDF y Postman (01 §3.2) y la sonda PR-04 de certificación decide cuál
 * funciona; ese cambio tiene que ser de una línea y en un solo sitio.
 *
 * Los timeouts de Search, PreBook y Book son los del PDF (p. 8); el resto es INFERIDO y se
 * pregunta a TBO (Q-09). La configuración de una cuenta o del sync sólo puede ACORTAR un timeout o
 * un número de intentos (RNF-01), salvo el de Search, que sube con `ResponseTime` hasta su techo.
 */

export type TboHttpMethod = 'GET' | 'POST';

/**
 * Cupos del limitador de una cuenta (RNF-02 punto 3). El dinero —Book, Cancel y el BookingDetail
 * de recuperación— tiene capacidad reservada y nunca espera detrás de una campaña de búsquedas.
 * `verification` es el BookingDetail con que un job busca un Book que no respondió: pasa antes que
 * las búsquedas, pero con un techo propio, porque una ráfaga de jobs no puede quitarle al vendedor
 * más que eso (04 §9.5 punto 5, PV-41).
 */
export type TboLane = 'sales' | 'money' | 'verification' | 'background';

export interface TboOperationSpec {
  /** Casing del PDF, con `/` inicial y sin query. Se concatena a la `baseUrl` de la cuenta. */
  readonly path: string;
  /** CountryList y hotelcodelist son GET (p. 51, 55): el verbo es de la operación, no global. */
  readonly method: TboHttpMethod;
  /** Timeout de un intento. Cubre también la lectura del cuerpo (01 §5.5). */
  readonly timeoutMs: number;
  /**
   * Techo al que puede llegar un timeout pedido por el llamador. Igual a `timeoutMs` en todas las
   * operaciones menos Search, donde `ResponseTime` es un parámetro explícito (RNF-01).
   */
  readonly maxTimeoutMs: number;
  /** Intentos totales, el original incluido. */
  readonly maxAttempts: number;
  /**
   * Mueve dinero o estado en TBO. El cliente además lo deduce del path (`isTboMoneyPath`) y del
   * nombre de la fila: una edición de esta columna no puede habilitar reintentos en Book ni en
   * Cancel.
   */
  readonly money: boolean;
  /**
   * Todos los intentos comparten un plazo igual al timeout: son las esperas del vendedor (Search y
   * PreBook). Dos intentos de 23 s serían demasiada espera (08 §9 C-24), así que un timeout acaba
   * con la llamada y un reintento sólo cabe si el primer fallo fue rápido.
   */
  readonly sharedDeadline: boolean;
  /** Cupos admitidos; el primero es el de por defecto. */
  readonly lanes: readonly [TboLane, ...TboLane[]];
  /**
   * `optional` sólo en `hotelcodelist`, cuyo ejemplo de respuesta no trae `Status` (p. 55; Q-61).
   * En las demás, un 2xx sin envelope es `MALFORMED_RESPONSE` (01 §8.1).
   */
  readonly envelope: 'required' | 'optional';
  /** `201 NO_AVAILABILITY` es un resultado vacío y no un error. Sólo en Search (01 §8.3). */
  readonly emptyOnNoAvailability: boolean;
  /**
   * `Status.Code` 500 con `Description` "No Hotels Found" (sin distinguir mayúsculas ni espacios),
   * con HTTP 2xx, es una ciudad sin hoteles: resultado vacío, no error. Sólo TBOHotelCodeList, que
   * es donde se observó en producción el 2026-09-29 (01 §8.5); cualquier otro 500 sigue siendo
   * `UPSTREAM`. En Book y Cancel el cliente la ignora aunque alguien la encienda: allí un 500 es un
   * desenlace incierto, nunca un vacío.
   */
  readonly emptyOnNoHotelsFound: boolean;
  /**
   * `Status.Description` puede ir al log, recortada, porque el request no lleva datos personales.
   * En Book, BookingDetail, Cancel y BookingDetailsbasedondate un 400 podría repetir un dato del
   * huésped (01 §11.1).
   */
  readonly logDescription: boolean;
}

/** `ResponseTime` de Search, en segundos: rango 5-20 y 10 por defecto (08 §9 C-01; D-TBO-17 A). */
export const TBO_SEARCH_RESPONSE_TIME_S = Object.freeze({ min: 5, max: 20, default: 10 } as const);

/** Holgura del timeout HTTP de Search sobre `ResponseTime` (01 §5.3). */
export const TBO_SEARCH_TIMEOUT_MARGIN_MS = 3_000;

/** Techo de Search: el extremo de "5-23 Seconds" (p. 8). */
export const TBO_SEARCH_TIMEOUT_CEILING_MS = 23_000;

/**
 * Timeout HTTP de un Search con ese `ResponseTime`: `ResponseTime + 3 s`, dentro de 8-23 s.
 * `ResponseTime` es Integer (p. 11); un valor fuera de rango se lleva al borde en vez de lanzar,
 * porque quien valida el request es el builder y aquí sólo se deriva una espera.
 */
export function tboSearchTimeoutMs(responseTimeSeconds: number): number {
  const { min, max } = TBO_SEARCH_RESPONSE_TIME_S;
  const seconds = Number.isFinite(responseTimeSeconds)
    ? Math.min(max, Math.max(min, Math.round(responseTimeSeconds)))
    : TBO_SEARCH_RESPONSE_TIME_S.default;
  return Math.min(TBO_SEARCH_TIMEOUT_CEILING_MS, seconds * 1_000 + TBO_SEARCH_TIMEOUT_MARGIN_MS);
}

function spec(value: TboOperationSpec): TboOperationSpec {
  const [first, ...rest] = value.lanes;
  return Object.freeze({
    ...value,
    lanes: Object.freeze<[TboLane, ...TboLane[]]>([first, ...rest]),
  });
}

/**
 * Las 11 operaciones del contrato V2.1. Páginas del PDF en cada fila; "INFERIDO" marca los valores
 * que TBO no publica.
 */
export const TBO_OPERATIONS = Object.freeze({
  /** p. 10. Timeout = `ResponseTime` 10 s + 3 s (D-TBO-17 A); 2 intentos, nunca tras un timeout. */
  search: spec({
    path: '/Search',
    method: 'POST',
    timeoutMs: tboSearchTimeoutMs(TBO_SEARCH_RESPONSE_TIME_S.default),
    maxTimeoutMs: TBO_SEARCH_TIMEOUT_CEILING_MS,
    maxAttempts: 2,
    money: false,
    sharedDeadline: true,
    lanes: ['sales'],
    envelope: 'required',
    emptyOnNoAvailability: true,
    emptyOnNoHotelsFound: false,
    logDescription: true,
  }),
  /** p. 19. 23 s (p. 8); segundo intento sólo tras un fallo rápido y dentro de los 23 s (C-24). */
  prebook: spec({
    path: '/PreBook',
    method: 'POST',
    timeoutMs: 23_000,
    maxTimeoutMs: 23_000,
    maxAttempts: 2,
    money: false,
    sharedDeadline: true,
    lanes: ['sales'],
    envelope: 'required',
    emptyOnNoAvailability: false,
    emptyOnNoHotelsFound: false,
    logDescription: true,
  }),
  /** p. 32. 120 s (p. 8). UN intento, siempre: la recuperación es BookingDetail a +120 s (p. 42). */
  book: spec({
    path: '/Book',
    method: 'POST',
    timeoutMs: 120_000,
    maxTimeoutMs: 120_000,
    maxAttempts: 1,
    money: true,
    sharedDeadline: false,
    lanes: ['money'],
    envelope: 'required',
    emptyOnNoAvailability: false,
    emptyOnNoHotelsFound: false,
    logDescription: false,
  }),
  /**
   * p. 42. 30 s (INFERIDO, Q-09). 3 intentos en jobs; la lectura interactiva pide 2. El cupo por
   * defecto es el de fondo (HCN, conciliación); la lectura de cierre de un Book pide `money`, y la
   * verificación de un Book incierto desde un job, `verification`.
   */
  bookingDetail: spec({
    path: '/BookingDetail',
    method: 'POST',
    timeoutMs: 30_000,
    maxTimeoutMs: 30_000,
    maxAttempts: 3,
    money: false,
    sharedDeadline: false,
    lanes: ['background', 'money', 'verification', 'sales'],
    envelope: 'required',
    emptyOnNoAvailability: false,
    emptyOnNoHotelsFound: false,
    logDescription: false,
  }),
  /** p. 41. 60 s (INFERIDO, Q-09). UN intento, siempre: se concilia con BookingDetail. */
  cancel: spec({
    path: '/Cancel',
    method: 'POST',
    timeoutMs: 60_000,
    maxTimeoutMs: 60_000,
    maxAttempts: 1,
    money: true,
    sharedDeadline: false,
    lanes: ['money'],
    envelope: 'required',
    emptyOnNoAvailability: false,
    emptyOnNoHotelsFound: false,
    logDescription: false,
  }),
  /** p. 62, casing del PDF (Postman: `BookingDetailsBasedOnDate`). 60 s (INFERIDO). */
  bookingDetailsByDate: spec({
    path: '/BookingDetailsbasedondate',
    method: 'POST',
    timeoutMs: 60_000,
    maxTimeoutMs: 60_000,
    maxAttempts: 3,
    money: false,
    sharedDeadline: false,
    lanes: ['background'],
    envelope: 'required',
    emptyOnNoAvailability: false,
    emptyOnNoHotelsFound: false,
    logDescription: false,
  }),
  /** p. 51, GET. 30 s (INFERIDO). */
  countryList: spec({
    path: '/CountryList',
    method: 'GET',
    timeoutMs: 30_000,
    maxTimeoutMs: 30_000,
    maxAttempts: 5,
    money: false,
    sharedDeadline: false,
    lanes: ['background'],
    envelope: 'required',
    emptyOnNoAvailability: false,
    emptyOnNoHotelsFound: false,
    logDescription: true,
  }),
  /** p. 53. 30 s (INFERIDO). */
  cityList: spec({
    path: '/CityList',
    method: 'POST',
    timeoutMs: 30_000,
    maxTimeoutMs: 30_000,
    maxAttempts: 5,
    money: false,
    sharedDeadline: false,
    lanes: ['background'],
    envelope: 'required',
    emptyOnNoAvailability: false,
    emptyOnNoHotelsFound: false,
    logDescription: true,
  }),
  /** p. 54-55, GET y en minúsculas. Devuelve todos los códigos: 180 s (INFERIDO). Sin `Status`. */
  hotelCodeList: spec({
    path: '/hotelcodelist',
    method: 'GET',
    timeoutMs: 180_000,
    maxTimeoutMs: 180_000,
    maxAttempts: 3,
    money: false,
    sharedDeadline: false,
    lanes: ['background'],
    envelope: 'optional',
    emptyOnNoAvailability: false,
    emptyOnNoHotelsFound: false,
    logDescription: true,
  }),
  /**
   * p. 65. 60 s (INFERIDO). Una ciudad sin hoteles llega como HTTP 200 con `Status.Code` 500
   * "No Hotels Found" (producción, 2026-09-29): es la única fila con esa excepción (01 §8.5).
   */
  tboHotelCodeList: spec({
    path: '/TBOHotelCodeList',
    method: 'POST',
    timeoutMs: 60_000,
    maxTimeoutMs: 60_000,
    maxAttempts: 5,
    money: false,
    sharedDeadline: false,
    lanes: ['background'],
    envelope: 'required',
    emptyOnNoAvailability: false,
    emptyOnNoHotelsFound: true,
    logDescription: true,
  }),
  /**
   * p. 56, casing del PDF (Postman: `Hoteldetails`). 60 s de techo; el sync configura 45 s porque
   * la configuración sólo acorta (08 §9 C-14).
   */
  hotelDetails: spec({
    path: '/HotelDetails',
    method: 'POST',
    timeoutMs: 60_000,
    maxTimeoutMs: 60_000,
    maxAttempts: 5,
    money: false,
    sharedDeadline: false,
    lanes: ['background'],
    envelope: 'required',
    emptyOnNoAvailability: false,
    emptyOnNoHotelsFound: false,
    logDescription: true,
  }),
});

export type TboOperationName = keyof typeof TBO_OPERATIONS;

/** Las operaciones cuyo único intento no depende de ninguna columna de la tabla. */
const MONEY_SEGMENTS: ReadonlySet<string> = new Set(['book', 'cancel']);

/**
 * ¿Este path es Book o Cancel? Sin distinguir mayúsculas, sobre el último segmento y sin query ni
 * fragmento, como `isNonIdempotentSabrePath`: `/BookingDetail` no es `/Book`, y `/book`, `/BOOK/` o
 * `/Cancel?x` sí lo son. Es la guarda que el cliente aplica encima de la columna `money` (01 §10.2).
 */
export function isTboMoneyPath(path: string): boolean {
  const bare = path.split(/[?#]/, 1)[0] ?? '';
  const last = bare
    .split('/')
    .filter((segment) => segment.length > 0)
    .pop();
  return last !== undefined && MONEY_SEGMENTS.has(last.toLowerCase());
}
