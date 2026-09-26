import type { HotelRoomOccupancy } from '@sales-travel/canonical';
import type { HotelBookingContact, HotelBookingRoomGuests } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import { buildTboBookRequest, type TboBookInput } from './booking/book.request.builder';
import { parseTboConfig } from './config';
import {
  buildTboBookingDetailRequest,
  type TboBookingDetailInput,
} from './detail/booking-detail.request.builder';
import { TboRequestBuildError } from './errors';
import { TboInMemoryRateLimiter } from './http/limiter';
import { TboHttpClient, type TboFetch } from './http/tbo-http.client';
import { buildTboPrebookRequest, type TboPrebookInput } from './prebook/prebook.request.builder';
import { TboHotelsAdapter } from './tbo-hotels.adapter';

/**
 * El guard anti-PAN de salida de TBO (D1; docs/tbo/03 §7.2 barrera 4; 08 RNF-04 capa 5; 09 PR-4.2),
 * sobre el modelo de `providers/sabre/src/pan-egress.guard.test.ts`.
 *
 * D1 dice que nunca se manda PAN ni CVV: TBO se reserva sólo con `PaymentMode: "Limit"`, que no
 * lleva tarjeta (p. 33, 35-36). Los builders lo defienden por tipo (`PaymentInfo?: never`), por
 * esquema (`.strict()` con el literal) y el cliente barre las claves de tarjeta. Este archivo es la
 * otra mitad: mide los **bytes que salen**, no el tipo que los produce.
 *
 * ## Por la puerta pública
 *
 * Los builders no se publican: la salida del paquete es el adapter. Así que los cuerpos de PreBook,
 * Book y BookingDetail se mandan por `TboHotelsAdapter` con el cliente real y un `fetch` espiado, y
 * se lee `init.body`, que son literalmente los bytes del cable. La defensa se prueba por fuera o no
 * se prueba.
 *
 * ## Las dos mitades
 *
 * 1. **El barrido de salida.** Los cuerpos construidos desde entradas MÁXIMAS —cada campo opcional
 *    relleno— no nombran ninguna clave de tarjeta, no llevan ninguna tirada con forma de PAN y
 *    llevan `PaymentMode: "Limit"`.
 * 2. **El barrido de mutación.** Se inyecta un PAN de prueba en CADA hoja de texto de cada entrada y
 *    se clasifica el resultado en `rejected` (el builder lo rechazó o no lo mandó) o `carried` (llegó
 *    al cable). La partición está **congelada**: si alguien afloja un esquema y un campo pasa a
 *    `carried`, o aparece un campo nuevo, esto se pone rojo y hay que clasificarlo a mano.
 *
 * ## Lo que este guard NO promete
 *
 * No promete que un PAN no pueda llegar a TBO: hay campos opacos que emite TBO y nosotros devolvemos
 * (`BookingCode`, `ConfirmationNumber`) donde cualquier texto encaja. La lista `CARRIED` es ese
 * inventario, escrito a mano.
 */

// ---------------------------------------------------------------------------------------------
// El detector (independiente de la guarda del cliente: si compartieran código, un error común
// dejaría a los dos ciegos a la vez)
// ---------------------------------------------------------------------------------------------

const PAN_MIN_DIGITS = 13;
const PAN_MAX_DIGITS = 19;

/** PAN de prueba público de la industria: el 4111… de los manuales. */
const TEST_PAN = '4111111111111111';

function luhnOk(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Una coincidencia. Nunca lleva el valor: sólo longitud y offset. */
interface PanHit {
  readonly length: number;
  readonly at: number;
}

interface DigitRun {
  readonly digits: string;
  readonly at: number;
}

/** Tiradas de dígitos; con `collapseSeparators` se atraviesan `-` y espacios entre dígitos. */
function digitRuns(text: string, collapseSeparators: boolean): DigitRun[] {
  const runs: DigitRun[] = [];
  let buffer = '';
  let start = -1;
  const flush = (): void => {
    if (buffer.length > 0) runs.push({ digits: buffer, at: start });
    buffer = '';
    start = -1;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? '';
    if (char >= '0' && char <= '9') {
      if (buffer.length === 0) start = i;
      buffer += char;
      continue;
    }
    if (collapseSeparators && buffer.length > 0 && (char === '-' || char === ' ')) {
      const next = text[i + 1] ?? '';
      if (next >= '0' && next <= '9') continue;
    }
    flush();
  }
  flush();
  return runs;
}

/**
 * Tiradas COMPLETAS de 13 a 19 dígitos que pasan Luhn. Se mide la tirada entera y no cada ventana:
 * una de cada diez ventanas de 13 dígitos pasa Luhn por azar, y un detector que dispara con todo
 * no distingue nada (ver el caso del dígito de control abajo).
 */
function findPanLike(text: string): PanHit[] {
  const hits: PanHit[] = [];
  const seen = new Set<number>();
  for (const collapse of [false, true]) {
    for (const run of digitRuns(text, collapse)) {
      if (run.digits.length < PAN_MIN_DIGITS || run.digits.length > PAN_MAX_DIGITS) continue;
      if (!luhnOk(run.digits)) continue;
      if (seen.has(run.at)) continue;
      seen.add(run.at);
      hits.push({ length: run.digits.length, at: run.at });
    }
  }
  return hits;
}

/**
 * Las claves del carril de tarjeta de TBO, en el casing del PDF (p. 33-35 y 38): la tabla escribe
 * `CardHolderLastName` y los ejemplos `CardHolderlastName`. `BillingAmount` y `BillingCurrency`
 * sólo existen dentro de `PaymentInfo`. Se buscan sin distinguir mayúsculas y a cualquier
 * profundidad del JSON: un `cardnumber` en minúsculas sigue siendo un PAN con otro nombre.
 */
const FORBIDDEN_KEYS: readonly string[] = Object.freeze([
  'PaymentInfo',
  'CardNumber',
  'CvvNumber',
  'CardExpirationMonth',
  'CardExpirationYear',
  'CardHolderFirstName',
  'CardHolderLastName',
  'CardHolderlastName',
  'CardHolderAddress',
  'BillingAmount',
  'BillingCurrency',
]);

function keysOf(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) keysOf(item, into);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      into.push(key);
      keysOf(child, into);
    }
  }
  return into;
}

function forbiddenKeysIn(wire: string): string[] {
  const keys = keysOf(JSON.parse(wire) as unknown).map((key) => key.toLowerCase());
  return FORBIDDEN_KEYS.filter((key) => keys.includes(key.toLowerCase()));
}

// ---------------------------------------------------------------------------------------------
// Entradas máximas: cada campo opcional relleno con un valor legítimo
// ---------------------------------------------------------------------------------------------

const REFERENCE = 'STT7K2M9QX4D8R1VZ6AB';
const SEARCH_SENT_AT = Date.parse('2026-09-25T15:00:00.000Z');
const NOW = SEARCH_SENT_AT + 5 * 60_000;
const BOOKING_CODE = '1120548!TB!4!TB!8bd7a82e-439a-4b2d-869d-09de4456e482';

const OCCUPANCY: HotelRoomOccupancy[] = [
  { adults: 1, childrenAges: [7] },
  { adults: 1, childrenAges: [] },
];

/** Todos los campos del huésped neutral, también los que el Book de TBO no lleva (p. 32-34). */
const MAXIMAL_ROOMS: HotelBookingRoomGuests[] = [
  {
    guests: [
      {
        paxType: 'ADT',
        title: 'Mr',
        firstName: 'José',
        lastName: 'Muñoz',
        gender: 'M',
        birthDate: '1985-03-14',
        nationality: 'CO',
        document: { type: 'PASSPORT', number: 'AB1234567', issuingCountry: 'CO' },
      },
      {
        paxType: 'CHD',
        title: 'Ms',
        firstName: 'Sofía',
        lastName: 'Muñoz',
        gender: 'F',
        age: 7,
        birthDate: '2019-01-20',
        nationality: 'CO',
        document: { type: 'NATIONAL_ID', number: '1020304050', issuingCountry: 'CO' },
      },
    ],
  },
  { guests: [{ paxType: 'ADT', title: 'Mrs', firstName: 'Ana María', lastName: "O'Neill" }] },
];

const MAXIMAL_CONTACT: HotelBookingContact = {
  email: 'reservas@agencia.example',
  phone: { countryCode: '+57', areaCode: '601', number: '555 0100' },
};

const MAXIMAL_BOOK_INPUT: TboBookInput = {
  bookingCode: BOOKING_CODE,
  bookingReferenceId: REFERENCE,
  totalFare: '305.75',
  rooms: MAXIMAL_ROOMS,
  occupancy: OCCUPANCY,
  contact: MAXIMAL_CONTACT,
};

const MAXIMAL_PREBOOK_INPUT: TboPrebookInput = { bookingCode: BOOKING_CODE };

// ---------------------------------------------------------------------------------------------
// La puerta pública: los bytes que salen por el adapter
// ---------------------------------------------------------------------------------------------

function config() {
  return parseTboConfig({
    environment: 'test',
    username: 'agencia-demo',
    password: 'Pa55w0rd-pan',
  });
}

function limiter(): TboInMemoryRateLimiter {
  return new TboInMemoryRateLimiter({
    maxQps: 1_000,
    maxConcurrent: 100,
    background: { qps: 1_000, concurrent: 100 },
  });
}

/** Un adapter real cuyo `fetch` anota la cadena EXACTA que recibió y responde un envelope vacío. */
function spyingAdapter(): { adapter: TboHotelsAdapter; wires: string[] } {
  const wires: string[] = [];
  const fetch: TboFetch = (_url, init) => {
    // Fail-closed: un cuerpo que no es texto no se puede inspeccionar, y degradarlo con String()
    // dejaría al guard mirando '[object Object]'.
    if (typeof init.body !== 'string') {
      throw new Error(`el guard anti-PAN no puede inspeccionar un cuerpo ${typeof init.body}`);
    }
    wires.push(init.body);
    return Promise.resolve(
      new Response(JSON.stringify({ Status: { Code: 500 } }), { status: 200 }),
    );
  };
  const adapter = new TboHotelsAdapter(config(), {
    fetch,
    now: () => NOW,
    sleep: () => Promise.resolve(),
    random: () => 0,
    limiter: limiter(),
  });
  return { adapter, wires };
}

const CTX = { tenantId: '00000000-0000-4000-8000-00000000000a' };

interface Egress {
  readonly name: string;
  readonly send: (adapter: TboHotelsAdapter) => Promise<unknown>;
}

const EGRESS: readonly Egress[] = [
  {
    name: 'PreBook',
    send: (adapter) =>
      adapter.prebookReport(
        {
          hotelCode: '1120548',
          bookingCode: BOOKING_CODE,
          searchId: 'srch-1',
          searchSentAt: SEARCH_SENT_AT,
          rooms: OCCUPANCY,
        },
        CTX,
      ),
  },
  {
    name: 'Book',
    send: (adapter) =>
      adapter.bookReport(
        {
          bookingCode: MAXIMAL_BOOK_INPUT.bookingCode,
          totalFare: MAXIMAL_BOOK_INPUT.totalFare,
          bookingReferenceId: MAXIMAL_BOOK_INPUT.bookingReferenceId,
          searchSentAt: SEARCH_SENT_AT,
          occupancy: OCCUPANCY,
          rooms: MAXIMAL_ROOMS,
          contact: MAXIMAL_CONTACT,
        },
        CTX,
      ),
  },
  {
    name: 'BookingDetail (ConfirmationNumber)',
    send: (adapter) =>
      adapter.bookingDetailReport({ confirmationNumber: 'YOSUR8', purpose: 'interactive' }, CTX),
  },
  {
    name: 'BookingDetail (BookingReferenceId)',
    send: (adapter) =>
      adapter.bookingDetailReport({ bookingReferenceId: REFERENCE, purpose: 'interactive' }, CTX),
  },
];

/** Los bytes que salieron. El desenlace se ignora a propósito: lo que se mide ya ocurrió. */
async function wireOf(egress: Egress): Promise<string> {
  const { adapter, wires } = spyingAdapter();
  await egress.send(adapter).catch(() => undefined);
  const [first] = wires;
  if (first === undefined) throw new Error(`el adapter no llegó a mandar ${egress.name}`);
  return first;
}

// ---------------------------------------------------------------------------------------------
// Sondas del detector: si el detector no distingue, el guard entero es decorativo
// ---------------------------------------------------------------------------------------------

describe('el detector de PAN distingue de verdad', () => {
  it('un PAN de prueba se detecta', () => {
    expect(findPanLike(`{"x":"${TEST_PAN}"}`)).toHaveLength(1);
  });

  it('el mismo número con el dígito de control cambiado no: no es sólo la longitud', () => {
    expect(luhnOk('4111111111111112')).toBe(false);
    expect(findPanLike('{"x":"4111111111111112"}')).toEqual([]);
  });

  it('12 dígitos que pasan Luhn quedan por debajo del suelo', () => {
    expect(luhnOk('000000000000')).toBe(true);
    expect(findPanLike('{"x":"000000000000"}')).toEqual([]);
  });

  it('un PAN con guiones o espacios se detecta', () => {
    expect(findPanLike('{"x":"4111-1111-1111-1111"}')).toHaveLength(1);
    expect(findPanLike('{"x":"4111 1111 1111 1111"}')).toHaveLength(1);
  });

  it('un PAN escrito como número JSON también', () => {
    expect(findPanLike(`{"TotalFare":${TEST_PAN}}`)).toHaveLength(1);
  });

  it('dos números JSON vecinos no se funden en un falso positivo', () => {
    expect(findPanLike('{"a":"4111111","b":"111111111"}')).toEqual([]);
  });

  it('un decimal parte la tirada: un importe grande no es un PAN', () => {
    expect(findPanLike('{"TotalFare":411111111.1111111}')).toEqual([]);
  });

  it('la coincidencia no lleva el valor', () => {
    const [hit] = findPanLike(`{"x":"${TEST_PAN}"}`);
    expect(JSON.stringify(hit)).not.toContain('4111');
    expect(Object.keys(hit ?? {}).sort()).toEqual(['at', 'length']);
  });

  it('las claves prohibidas se encuentran a cualquier profundidad y con cualquier casing', () => {
    expect(forbiddenKeysIn('{"a":[{"b":{"cardnumber":"x"}}],"PaymentInfo":{}}')).toEqual([
      'PaymentInfo',
      'CardNumber',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Mitad 1: el barrido de salida
// ---------------------------------------------------------------------------------------------

describe('ningún cuerpo de salida lleva dato de tarjeta', () => {
  it('el barrido cubre los cuerpos que se esperan: si uno desaparece, no mide menos en silencio', () => {
    expect(EGRESS.map((egress) => egress.name)).toEqual([
      'PreBook',
      'Book',
      'BookingDetail (ConfirmationNumber)',
      'BookingDetail (BookingReferenceId)',
    ]);
  });

  for (const egress of EGRESS) {
    it(`${egress.name}: no nombra ninguna clave de tarjeta`, async () => {
      expect(forbiddenKeysIn(await wireOf(egress))).toEqual([]);
    });

    it(`${egress.name}: no lleva ninguna tirada con forma de PAN`, async () => {
      const wire = await wireOf(egress);
      expect(
        findPanLike(wire),
        `${egress.name} lleva tiradas de 13-19 dígitos que pasan Luhn. El valor NO se imprime.`,
      ).toEqual([]);
    });

    it(`${egress.name}: sale con PaymentMode "Limit" y ningún otro modo`, async () => {
      const wire = await wireOf(egress);
      expect(wire).toContain('"PaymentMode":"Limit"');
      expect(wire.match(/"PaymentMode"/g)).toHaveLength(1);
    });
  }

  it('el Book lleva de verdad lo que se barre: huéspedes, contacto e importe', async () => {
    // Verde por omisión no es verde: un cuerpo vacío pasaría todo lo de arriba.
    const wire = JSON.parse(await wireOf(EGRESS[1] as Egress)) as Record<string, unknown>;
    expect(wire).toMatchObject({
      BookingType: 'Voucher',
      TotalFare: 305.75,
      PhoneNumber: '576015550100',
      EmailId: 'reservas@agencia.example',
    });
    expect(JSON.stringify(wire['CustomerDetails'])).toContain('"LastName":"Munoz"');
  });
});

describe('el cliente corta en la puerta un cuerpo envenenado (01 §10.5)', () => {
  function countingClient(): { client: TboHttpClient; calls: string[] } {
    const calls: string[] = [];
    const client = new TboHttpClient(config(), {
      fetch: (url) => {
        calls.push(url);
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
      limiter: limiter(),
    });
    return { client, calls };
  }

  it('las dos afirmaciones del barrido son capaces de fallar sobre el mismo cuerpo', () => {
    const poisoned = JSON.stringify({
      BookingCode: BOOKING_CODE,
      PaymentMode: 'NewCard',
      PaymentInfo: { CardNumber: TEST_PAN, CvvNumber: '123', CardHolderlastName: 'X' },
    });
    expect(forbiddenKeysIn(poisoned)).toEqual([
      'PaymentInfo',
      'CardNumber',
      'CvvNumber',
      'CardHolderLastName',
      'CardHolderlastName',
    ]);
    expect(findPanLike(poisoned)).toHaveLength(1);
  });

  it('un PaymentInfo en un Book no llega a fetch', async () => {
    const { client, calls } = countingClient();
    const error = await client
      .send('book', { BookingCode: BOOKING_CODE, PaymentInfo: { CardNumber: TEST_PAN } })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(TboRequestBuildError);
    expect((error as TboRequestBuildError).reason).toBe('CARD_DATA');
    expect(JSON.stringify((error as TboRequestBuildError).toLogMeta())).not.toContain('4111');
    expect(calls).toHaveLength(0);
  });

  it.each(['prebook', 'book', 'bookingDetail'] as const)(
    '%s con un modo que no es Limit no llega a fetch',
    async (operation) => {
      const { client, calls } = countingClient();
      const error = await client
        .send(operation, { BookingCode: BOOKING_CODE, PaymentMode: 'SavedCard' })
        .catch((err: unknown) => err);
      expect((error as TboRequestBuildError).reason).toBe('PAYMENT_MODE');
      expect(calls).toHaveLength(0);
    },
  );
});

// ---------------------------------------------------------------------------------------------
// Mitad 2: el barrido de mutación
// ---------------------------------------------------------------------------------------------

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stringLeafPaths(value: Json, prefix = ''): string[] {
  if (typeof value === 'string') return [prefix];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => stringLeafPaths(item, `${prefix}.${String(index)}`));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) =>
      stringLeafPaths(item, prefix === '' ? key : `${prefix}.${key}`),
    );
  }
  return [];
}

function setAtPath(root: Json, path: string, next: string): void {
  const parts = path.split('.');
  let cursor: Json = root;
  for (const part of parts.slice(0, -1)) {
    cursor = (cursor as { [key: string]: Json })[part] as Json;
  }
  const last = parts[parts.length - 1] ?? '';
  (cursor as { [key: string]: Json })[last] = next;
}

type Verdict = 'rejected' | 'carried';

/**
 * Inyecta el PAN en cada hoja de texto y clasifica. `rejected` = el builder lanzó o el PAN no llegó
 * al cuerpo (un campo que el Book no manda, como el documento del huésped); `carried` = llegó.
 */
function mutationVerdicts(input: Json, build: (mutated: Json) => unknown): Record<string, Verdict> {
  const verdicts: Record<string, Verdict> = {};
  for (const path of stringLeafPaths(input)) {
    const mutated = clone(input);
    setAtPath(mutated, path, TEST_PAN);
    let wire: string;
    try {
      wire = JSON.stringify(build(mutated));
    } catch {
      verdicts[path] = 'rejected';
      continue;
    }
    verdicts[path] = findPanLike(wire).length > 0 ? 'carried' : 'rejected';
  }
  return verdicts;
}

function carriedPaths(verdicts: Record<string, Verdict>): string[] {
  return Object.entries(verdicts)
    .filter(([, verdict]) => verdict === 'carried')
    .map(([path]) => path)
    .sort();
}

/**
 * El inventario congelado de campos por los que un PAN inyectado LLEGA al cable. Son los
 * identificadores opacos que emite TBO y nosotros devolvemos: el `BookingCode` (06 §5.3: no se
 * parsea) y el `ConfirmationNumber`, cuyo formato el contrato no documenta (p. 40, 43). Apretarlos
 * rompería un código real de TBO.
 *
 * Lo que NO está importa igual: el nombre y el apellido no admiten dígitos (D-TBO-23 A), el
 * teléfono tiene el techo de E.164 (15 dígitos), el `TotalFare` no pasa de nueve dígitos enteros,
 * nuestra referencia tiene forma fija, y la edad, la nacionalidad y el documento del huésped no
 * viajan. **Añadir una línea aquí es una decisión, no un arreglo del test.**
 */
const CARRIED_PREBOOK: readonly string[] = Object.freeze(['bookingCode']);
const CARRIED_BOOK: readonly string[] = Object.freeze(['bookingCode']);
const CARRIED_DETAIL_BY_CONFIRMATION: readonly string[] = Object.freeze(['confirmationNumber']);
const CARRIED_DETAIL_BY_REFERENCE: readonly string[] = Object.freeze([]);

const CARRIED_HELP =
  'La superficie de salida cambió. Un campo NUEVO en la lista significa que un PAN inyectado ahora ' +
  'llega al cable por una vía que antes no existía: decidí a la vista si el campo lo necesita o si ' +
  'su esquema debe apretarse. Un campo que DESAPARECE significa que un esquema se endureció: borralo ' +
  'de la lista. Copiar la lista recibida sin leerla convierte este guard en un snapshot.';

describe('barrido de mutación: dónde llega un PAN inyectado y dónde no', () => {
  it('PreBook', () => {
    const verdicts = mutationVerdicts(MAXIMAL_PREBOOK_INPUT as unknown as Json, (mutated) =>
      buildTboPrebookRequest(mutated as unknown as TboPrebookInput),
    );
    expect(carriedPaths(verdicts), CARRIED_HELP).toEqual([...CARRIED_PREBOOK]);
  });

  it('Book', () => {
    const verdicts = mutationVerdicts(MAXIMAL_BOOK_INPUT as unknown as Json, (mutated) =>
      buildTboBookRequest(mutated as unknown as TboBookInput),
    );
    expect(Object.keys(verdicts).length).toBeGreaterThan(20);
    // Las defensas del builder, por la rama que RECHAZA: sin esto, un builder que aceptara todo
    // pasaría igual alargando la lista congelada.
    expect(verdicts['bookingReferenceId']).toBe('rejected');
    expect(verdicts['totalFare']).toBe('rejected');
    expect(verdicts['rooms.0.guests.0.firstName']).toBe('rejected');
    expect(verdicts['rooms.0.guests.0.lastName']).toBe('rejected');
    expect(verdicts['contact.phone.number']).toBe('rejected');
    expect(verdicts['contact.phone.areaCode']).toBe('rejected');
    expect(verdicts['contact.email']).toBe('rejected');
    // No viajan: el Book de TBO no los lleva (p. 32-34).
    expect(verdicts['rooms.0.guests.0.document.number']).toBe('rejected');
    expect(verdicts['rooms.0.guests.0.nationality']).toBe('rejected');
    expect(carriedPaths(verdicts), CARRIED_HELP).toEqual([...CARRIED_BOOK]);
  });

  it('BookingDetail por ConfirmationNumber', () => {
    const verdicts = mutationVerdicts({ confirmationNumber: 'YOSUR8' }, (mutated) =>
      buildTboBookingDetailRequest(mutated as unknown as TboBookingDetailInput),
    );
    expect(carriedPaths(verdicts), CARRIED_HELP).toEqual([...CARRIED_DETAIL_BY_CONFIRMATION]);
  });

  it('BookingDetail por BookingReferenceId', () => {
    const verdicts = mutationVerdicts({ bookingReferenceId: REFERENCE }, (mutated) =>
      buildTboBookingDetailRequest(mutated as unknown as TboBookingDetailInput),
    );
    expect(verdicts['bookingReferenceId']).toBe('rejected');
    expect(carriedPaths(verdicts), CARRIED_HELP).toEqual([...CARRIED_DETAIL_BY_REFERENCE]);
  });
});
