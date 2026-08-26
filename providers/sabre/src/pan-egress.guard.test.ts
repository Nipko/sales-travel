import type { LoggerPort } from '@sales-travel/core';
import { describe, expect, it } from 'vitest';
import type { SabreTokenProvider } from './auth/token.service';
import {
  SABRE_CANCEL_BOOKING_PATH,
  buildSabreCancelBookingRequest,
  readSabreTicketCheck,
  type SabreCancelBookingOptions,
} from './booking/cancel.request.builder';
import {
  SABRE_CREATE_BOOKING_PATH,
  buildSabreCreateBookingRequest,
  type SabreCreateBookingInput,
} from './booking/create.request.builder';
import {
  SABRE_GET_BOOKING_PATH,
  buildSabreGetBookingForDisplay,
  buildSabreGetBookingForModification,
} from './booking/get.request.builder';
import { SABRE_HOSTS, type SabreConfig } from './config';
import { SabreHttpClient } from './http/sabre-http.client';
import {
  SABRE_PRICE_PATH,
  buildSabrePriceRequest,
  type SabrePriceInput,
} from './price/request.builder';

/**
 * El guard anti-PAN de salida (D1, decidida el 2026-08-26 — docs/sabre/10 §9).
 *
 * D1 dice que **nunca se manda PAN ni CVV**: se reserva y se emite con formas de pago sin tarjeta
 * y se cobra por hosted checkout del PSP, que es la postura PCI SAQ-A que fija `CLAUDE.md`. Los
 * builders ya la defienden por tipo —`SabreFormOfPayment` declara los siete campos de tarjeta como
 * `?: never`, así que `PAYMENTCARD` no se puede ni nombrar—. Este fichero es la otra mitad: mide
 * los **bytes que salen**, no el tipo que los produce.
 *
 * ## Por qué sobre los bytes y no sobre el objeto
 *
 * La cicatriz de este paquete se repitió cinco veces con la misma forma: código correcto que
 * producción no ejecutaba, o una defensa sin test que la fijara. Un `expect(body.payment)` mira el
 * objeto que devuelve el builder; lo que viaja es lo que `JSON.stringify` produce dentro de
 * `SabreHttpClient.postJson`. Aquí se entra por esa puerta —cliente real, `fetch` espiado— y se
 * lee `init.body`, que son literalmente los bytes del cable. Es la misma regla que ya aplican
 * `envelope-bypass.e2e.test.ts` y `redaction.log-gate.guard.test.ts`: la defensa se prueba por
 * fuera o no se prueba.
 *
 * ## Por qué corre en la suite y no sólo en CI
 *
 * Es la lección del guard de formato (`format.guard.test.ts`): lo que sólo vive en CI se descubre
 * tarde. Este fichero es un `.test.ts` normal, así que corre en cada `pnpm --filter
 * @sales-travel/sabre test`, que es el bucle que de verdad se ejecuta en cada ronda.
 *
 * ## Las dos mitades del guard
 *
 * 1. **El barrido de salida.** Los cuerpos de `offers/price`, `createBooking`, `cancelBooking` y
 *    los dos de `getBooking`, construidos desde entradas MÁXIMAS —cada campo opcional relleno—,
 *    no contienen ninguna clave de dato de tarjeta ni ninguna tirada con forma de PAN.
 * 2. **El barrido de mutación.** Se inyecta un PAN de prueba en CADA hoja de texto de cada
 *    entrada, se reconstruye y se clasifica el resultado en `rejected` (el builder lo rechazó) o
 *    `carried` (el PAN llegó al cable). La partición está **congelada**: si alguien afloja un
 *    esquema y un campo pasa de `rejected` a `carried`, o si aparece un campo nuevo, este test se
 *    pone rojo y hay que clasificarlo a mano. Es la sonda de comportamiento que exige la regla de
 *    la casa: si el guard no distingue las dos ramas, es hueco.
 *
 * ## Lo que este guard NO promete
 *
 * No promete que un PAN no pueda llegar a Sabre. **No puede**, y decir lo contrario sería un
 * comentario que promete una garantía que el código no da. Hay campos legítimos cuyo contenido es
 * indistinguible de un PAN por su forma —un teléfono (`^[0-9+-]+$`), un `unusedTicketNumber` de 13
 * dígitos, un `confirmationId` de `^[A-Z0-9]{6,}$`—, y rechazarlos por sospecha rompería ventas
 * legítimas. En esos campos la defensa NO es la forma: es la barrera de tipo de los builders, la
 * regla de lint acotada a `*request.builder.ts` / `*.serializer.ts` de `eslint.config.mjs`, y la
 * redacción de `redaction.ts` que impide que nada de eso llegue a un log. La lista `CARRIED` de
 * abajo es exactamente ese inventario, y por eso está escrita a mano y no derivada.
 */

// ---------------------------------------------------------------------------------------------
// El detector
// ---------------------------------------------------------------------------------------------

/**
 * Ventana de longitudes con forma de PAN. 13 es el mínimo real (Visa corto) y 19 el máximo del
 * estándar; el `pattern` de `cardNumber` del contrato de Sabre empieza en 12
 * (`booking-management-v1.yml:5314-5318`), pero por debajo de 13 la colisión con identificadores
 * legítimos deja de ser anecdótica.
 */
const PAN_MIN_DIGITS = 13;
const PAN_MAX_DIGITS = 19;

/** PAN de prueba público de la industria. No es de nadie: es el 4111… de los manuales. */
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

/** Una coincidencia. **Nunca lleva el valor**: sólo longitud y offset (`CLAUDE.md`: jamás PAN). */
interface PanHit {
  readonly length: number;
  readonly at: number;
}

interface DigitRun {
  readonly digits: string;
  readonly at: number;
}

/**
 * Tiradas de dígitos del texto.
 *
 * Con `collapseSeparators` se atraviesan los `-` y los espacios que separan dos dígitos, porque
 * `4111-1111-1111-1111` es un PAN igual que `4111111111111111` y un scanner que sólo mira dígitos
 * seguidos no lo ve. No se atraviesa ningún otro carácter: los separadores de JSON (`","`, `":`)
 * quedan intactos, así que dos números vecinos no se funden en uno falso.
 */
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
 * Tiradas COMPLETAS de 13 a 19 dígitos que pasan Luhn.
 *
 * ⚠️ Se mide la tirada entera, **no cada ventana dentro de ella**, y la diferencia no es un detalle
 * de implementación. Una de cada diez secuencias de 13 dígitos pasa Luhn por azar, así que un
 * escáner de ventanas encuentra un "PAN" dentro de casi cualquier tirada larga: la primera versión
 * de este detector marcaba `4111111111111112` —el PAN de prueba con el dígito de control roto—
 * porque una de sus ventanas de 13 sí cuadraba. Un detector que dispara con todo no distingue
 * nada, y un guard que no distingue es decorativo.
 *
 * El precio de medir la tirada entera está declarado y probado abajo: un PAN **concatenado** con
 * otros dígitos no se detecta. Es aceptable porque no es una vía de fuga realista —un PAN se cuela
 * como valor de un campo, no pegado a otro número— y porque el coste del camino contrario es un
 * guard inútil.
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
 * Claves que no pueden aparecer en NINGÚN cuerpo de salida.
 *
 * Son los siete campos de tarjeta que `SabreFormOfPaymentPanFree` declara `?: never` en
 * `create.request.builder.ts`, más el vocabulario habitual del CVV y el `unmaskPaymentCardNumbers`
 * de `getBooking` (`booking-management-v1.yml:290-293`), que desenmascara el PAN guardado en la
 * reserva y cuyo builder promete en su docstring que no se emite jamás.
 *
 * **`expiryDate` no está en la lista y no puede estarlo**: en `createBooking` es la caducidad del
 * PASAPORTE (`BookIdentityDocument.expiryDate`, `:5567`), un campo legítimo y frecuente. Prohibir
 * el nombre a secas rompería la reserva de cualquier vuelo internacional. Lo que se prohíbe es la
 * caducidad **de tarjeta**, y ésa sólo puede existir dentro de `payment`, donde no hay ninguna
 * variante que la declare.
 *
 * Tampoco están `cardType` ni `binNumber`: son el carril de BIN de `offers/price`, legítimo, y
 * cerrado tras `allowCardBinPricing` —apagado por defecto—. Que estén apagados por defecto se
 * comprueba abajo con su propio caso, no prohibiendo el nombre.
 */
const FORBIDDEN_KEYS: readonly string[] = Object.freeze([
  'cardNumber',
  'cardSecurityCode',
  'cardTypeCode',
  'cardHolder',
  'authentications',
  'virtualCard',
  'cvv',
  'cvc',
  'securityCode',
  'unmaskPaymentCardNumbers',
]);

function forbiddenKeysIn(wire: string): string[] {
  return FORBIDDEN_KEYS.filter((key) => wire.includes(`"${key}"`));
}

// ---------------------------------------------------------------------------------------------
// La puerta pública: los bytes que salen por `SabreHttpClient.postJson`
// ---------------------------------------------------------------------------------------------

function config(): SabreConfig {
  return {
    host: SABRE_HOSTS.cert.rest,
    epr: '500001',
    homePcc: 'ZZZZ',
    password: 'Pa55w0rd!',
    conversationIdPrefix: 'sales-travel',
    // `targetPcc` sólo es direccionable con grupo declarado: sin esto el builder de creación
    // rechaza la entrada máxima, que lo lleva.
    sabreGroup: 'GRP1',
  };
}

const silentLogger: LoggerPort = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

const fakeTokens: SabreTokenProvider = {
  getToken: () => Promise.resolve('ATK-SUPERSECRETO'),
  invalidate: () => Promise.resolve(),
};

/** Manda el cuerpo por el cliente real y devuelve la cadena EXACTA que recibió `fetch`. */
async function wireBytes(path: string, body: unknown): Promise<string> {
  let sent: string | undefined;
  const http = new SabreHttpClient(config(), fakeTokens, {
    fetch: (_url, init) => {
      // Fail-closed: un cuerpo que la guarda no puede leer es un cuerpo cuya ausencia de PAN
      // no puede verificar. Degradarlo con String() daria '[object Object]' y la guarda
      // pasaria inspeccionando texto vacio mientras cree que esta comprobando algo.
      if (typeof init?.body !== 'string') {
        throw new Error(
          `la guarda anti-PAN no puede inspeccionar un cuerpo de tipo ${typeof init?.body}`,
        );
      }
      sent = init.body;
      return Promise.resolve(
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    },
    logger: silentLogger,
    sleep: () => Promise.resolve(),
    jitter: () => 0,
    uuid: () => 'conv-fijo',
  });
  // El veredicto del clasificador de sobres se ignora **a propósito**. Lo que este guard mide es
  // lo que SALIÓ, y eso ya ocurrió cuando `fetch` recibió el `init`: los bytes viajan pase lo que
  // pase con la respuesta. Atar el guard a que la respuesta sea benigna lo acoplaría a las reglas
  // de `errors.ts` —otro subsistema, con sus propios tests— y lo dejaría rojo cada vez que aquéllas
  // se endurecen, que es exactamente el tipo de test frágil que acaba silenciado.
  await http.postJson(path, body).catch(() => undefined);
  if (sent === undefined) throw new Error(`el cliente no llegó a mandar cuerpo para ${path}`);
  return sent;
}

// ---------------------------------------------------------------------------------------------
// Entradas máximas: cada campo opcional relleno con un valor legítimo
// ---------------------------------------------------------------------------------------------

/**
 * 13 dígitos que **no** pasan Luhn, como los billetes reales: el dígito de control de un billete
 * IATA es mod-7, no Luhn. Ver la nota del detector sobre por qué eso importa.
 */
const UNUSED_TICKET = '0451234567890';

const MAXIMAL_PRICE_INPUT: SabrePriceInput = {
  query: [{ offerItemIds: ['OFFERITEM1-1-1'], passengerIds: ['PAX1'], formOfPaymentRef: 'FOP1' }],
  passengers: [
    {
      id: 'PAX1',
      type: 'ADT',
      frequentFlyer: [{ airline: 'AV', accountNumber: 'AV-998877' }],
      unusedTicketNumber: UNUSED_TICKET,
    },
  ],
  accountCode: 'CORP-2026',
  allowBundles: true,
  customQualifiers: { promo: 'INVIERNO26', canales: ['WEB', 'WHATSAPP'] },
  formOfPayment: { subCode: 'CA', id: 'FOP1' },
};

/**
 * Reserva ATPCO con todos los bloques que el builder sabe emitir. La aerolínea es `AV`: no tiene
 * requisitos propios en la tabla, así que ninguna fila bloqueante se dispara y el fixture mide el
 * cuerpo, no la tabla de requisitos.
 */
const MAXIMAL_CREATE_INPUT: SabreCreateBookingInput = {
  product: {
    kind: 'atpco',
    flights: [
      {
        flightNumber: 8020,
        airlineCode: 'AV',
        fromAirportCode: 'BOG',
        toAirportCode: 'LIM',
        departureDate: '2026-09-14',
        departureTime: '08:35',
        bookingClass: 'Y',
        flightStatusCode: 'NN',
        isMarriageGroup: true,
        confirmationId: 'ABC123',
        arrivalDate: '2026-09-14',
        arrivalTime: '11:20',
        source: 'ATPCO',
        // `seatOfferId` no cabe aquí: en ATPCO el asiento se pide por número. Es el carril NDC el
        // que lo lleva, y el builder lo rechaza — otro campo menos por el que colar texto libre.
        seats: [{ number: '12A', travelerPosition: 0 }],
      },
    ],
    pricing: [
      {
        flightPositions: [0],
        validatingAirlineCode: 'AV',
        // Excluyente con `commissionAmount` por contrato: se elige el porcentaje.
        commissionPercentage: '7.5',
        primaryFormOfPaymentPosition: 0,
        secondaryFormOfPaymentPosition: 1,
        amountOnSecondFormOfPayment: '30.000',
        priceComparisons: [
          { desiredAmount: '450.00', comparisonType: 'INCREASE_BY_PERCENT', percent: '5' },
        ],
      },
    ],
    haltOnFlightStatusCodes: ['NO', 'UC'],
    retryBookingUnconfirmedFlights: true,
  },
  travelers: [
    {
      providerTravelerId: 'PAX1',
      title: 'Mr',
      givenName: 'Nir',
      surname: 'Levin',
      birthDate: '1989-04-02',
      gender: 'MALE',
      passengerCode: 'ADT',
      nameReferenceCode: 'MAN1',
      identityDocuments: [
        {
          documentNumber: 'AB1234567',
          documentType: 'PASSPORT',
          expiryDate: '2031-01-31',
          issuingCountryCode: 'COL',
          residenceCountryCode: 'CO',
          placeOfBirth: 'BOGOTA',
          issueDate: '2021-02-01',
          givenName: 'Nir',
          middleName: 'Ben',
          surname: 'Levin',
          birthDate: '1989-04-02',
          gender: 'MALE',
          isPrimaryDocumentHolder: true,
          flightPositions: [0],
          citizenshipCountryCode: 'CO',
        },
      ],
      loyaltyPrograms: [
        {
          supplierCode: 'AV',
          programType: 'FREQUENT_FLYER',
          programNumber: 'LM998877',
          tierLevel: 3,
          receiverCode: 'AV',
        },
      ],
      useNotificationContactType: true,
      emails: ['vendedor@planetour.cloud'],
      phones: [{ number: '+57-3001234567', label: 'C' }],
      formOfPaymentPositions: [0],
    },
  ],
  contactInfo: {
    emails: ['agencia@planetour.cloud'],
    phones: ['+57-6015550000'],
  },
  agency: {
    address: {
      street: 'Calle 100 12-34',
      city: 'Bogota',
      stateProvince: 'Cundinamarca',
      postalCode: '110111',
      countryCode: 'CO',
    },
    contactInfo: {
      emails: ['ops@planetour.cloud'],
      phones: ['+57-6015550001'],
      includePhoneLabel: true,
    },
    ticketingPolicy: 'FUTURE_TICKETING',
    futureTicketingPolicy: {
      ticketingPcc: 'A1B2',
      queueNumber: '50',
      ticketingDate: '2026-09-01',
      ticketingTime: '18:00',
      comment: 'emision diferida por consolidador',
    },
    ticketingTimeLimitPolicy: {
      airlineCode: 'AV',
      ticketingDate: '2026-09-02',
      ticketingTime: '23:59',
    },
    agencyCustomerNumber: '123456',
  },
  formsOfPayment: [
    { type: 'CASH' },
    {
      type: 'INVOICE',
      invoiceDescription: 'factura consolidador',
      addInvoiceDescriptionPrefix: true,
    },
  ],
  targetPcc: 'A1B2',
  receivedFrom: 'sales-travel',
  retentionEndDate: '2026-12-31',
  retentionLabel: 'RETENIDA POR CONSOLIDADOR',
  corporateFare: false,
};

const TICKET_CHECK = readSabreTicketCheck(
  {
    timestamp: '2026-08-26T10:00:00Z',
    request: { confirmationId: 'ABCDEF' },
    tickets: [{ number: UNUSED_TICKET, isVoidable: true, isRefundable: false }],
    cancelOffers: [
      {
        offerItemId: 'CANCELOFFER1',
        offerType: 'CANCEL',
        offerExpirationDate: '2026-08-27',
        offerExpirationTime: '23:59',
      },
    ],
  },
  { confirmationId: 'ABCDEF' },
);

const MAXIMAL_CANCEL_OPTIONS: SabreCancelBookingOptions = {
  confirmationId: 'ABCDEF',
  bookingSource: 'SABRE_ORDER',
  scope: 'ALL',
  content: { items: [{ itemId: 'F1', kind: 'FLIGHT', lane: 'NDC' }], isTicketed: true },
  ticketCheck: TICKET_CHECK,
  offerItemId: 'CANCELOFFER1',
  errorHandlingPolicy: 'HALT_ON_ERROR',
  retrieveBooking: true,
  receivedFrom: 'sales-travel',
  targetPcc: 'A1B2',
  // `cancelAll` no admite notificación por correo (INVALID_FLAGS_COMBINATION): queda la cola.
  notification: { queueNumbers: [50] },
  retention: { endDate: '2026-12-31', label: 'RETENIDA' },
  now: '2026-08-26T10:00:00Z',
};

const MAXIMAL_GET_DISPLAY = {
  confirmationId: 'ABCDEF',
  bookingSource: 'SABRE_ORDER' as const,
  targetPcc: 'A1B2',
  surname: 'Levin',
  sections: ['FLIGHTS', 'TICKETS', 'FORMS_OF_PAYMENT'] as const,
};

const MAXIMAL_GET_MODIFICATION = {
  confirmationId: 'ABCDEF',
  bookingSource: 'SABRE_ORDER' as const,
  targetPcc: 'A1B2',
  surname: 'Levin',
};

// ---------------------------------------------------------------------------------------------
// Sondas del detector: si el detector no distingue, el guard entero es decorativo
// ---------------------------------------------------------------------------------------------

describe('el detector de PAN distingue de verdad', () => {
  it('un PAN de prueba se detecta', () => {
    expect(findPanLike(`{"x":"${TEST_PAN}"}`)).toHaveLength(1);
  });

  it('el mismo número con el dígito de control cambiado no se detecta: no es sólo la longitud', () => {
    // Mutación mínima de la propia defensa. Si borrar `luhnOk` no rompiera nada, esto pasaría.
    expect(luhnOk('4111111111111112')).toBe(false);
    expect(findPanLike('{"x":"4111111111111112"}')).toEqual([]);
  });

  it('12 dígitos válidos por Luhn quedan por debajo del suelo', () => {
    // 000000000000 pasa Luhn (suma 0) y tiene 12 dígitos: por debajo de PAN_MIN_DIGITS.
    expect(luhnOk('000000000000')).toBe(true);
    expect(findPanLike('{"x":"000000000000"}')).toEqual([]);
  });

  it('un PAN concatenado con otros dígitos NO se detecta, y está decidido así', () => {
    // Ver la nota de `findPanLike`. Buscar ventanas dentro de la tirada haría saltar el guard con
    // casi cualquier número largo —una de cada diez ventanas de 13 pasa Luhn por azar— y el
    // resultado sería un test que hay que silenciar. Quien venga a "mejorar" esto que lea antes el
    // caso del dígito de control de arriba: con ventanas, ese caso deja de distinguir.
    expect(findPanLike(`{"x":"999${TEST_PAN}99"}`)).toEqual([]);
  });

  it('un PAN con guiones se detecta: los separadores no son un escondite', () => {
    expect(findPanLike('{"x":"4111-1111-1111-1111"}')).toHaveLength(1);
  });

  it('dos números JSON vecinos no se funden en un falso positivo', () => {
    // 4111111 + 111111111 = el PAN, si el colapso atravesara `","`. No lo atraviesa.
    expect(findPanLike('{"a":"4111111","b":"111111111"}')).toEqual([]);
  });

  it('la coincidencia no lleva el valor: el mensaje de fallo no puede filtrar un PAN', () => {
    const [hit] = findPanLike(`{"x":"${TEST_PAN}"}`);
    expect(hit).toBeDefined();
    expect(JSON.stringify(hit)).not.toContain('4111');
    expect(Object.keys(hit ?? {}).sort()).toEqual(['at', 'length']);
  });

  it('es un detector de FORMA, no de semántica: un billete que colisione con Luhn lo dispara', () => {
    // Documentado a propósito y con su valor congelado. El dígito de control de un billete IATA es
    // mod-7, así que uno de cada diez billetes legítimos pasa Luhn por casualidad. Por eso el
    // detector NO se usa como rail de producción sobre `unusedTicketNumber` —eso rechazaría una de
    // cada diez reemisiones— y sí como guard sobre fixtures que elegimos nosotros. Quien lea esto
    // buscando "arreglar el falso positivo" está a punto de convertir un guard en una excepción.
    expect(luhnOk('0000000000000')).toBe(true);
    expect(findPanLike('{"unusedTicketNumber":"0000000000000"}')).toHaveLength(1);
    // El que usan los fixtures sí es realista y no colisiona.
    expect(luhnOk(UNUSED_TICKET)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Mitad 1: el barrido de salida
// ---------------------------------------------------------------------------------------------

interface Egress {
  readonly name: string;
  readonly path: string;
  readonly body: unknown;
}

function egressBodies(): readonly Egress[] {
  return [
    {
      name: 'offers/price',
      path: SABRE_PRICE_PATH,
      body: buildSabrePriceRequest(MAXIMAL_PRICE_INPUT),
    },
    {
      name: 'createBooking',
      path: SABRE_CREATE_BOOKING_PATH,
      body: buildSabreCreateBookingRequest(MAXIMAL_CREATE_INPUT, config()).body,
    },
    {
      name: 'cancelBooking',
      path: SABRE_CANCEL_BOOKING_PATH,
      body: buildSabreCancelBookingRequest(MAXIMAL_CANCEL_OPTIONS),
    },
    {
      name: 'getBooking (display)',
      path: SABRE_GET_BOOKING_PATH,
      body: buildSabreGetBookingForDisplay(MAXIMAL_GET_DISPLAY),
    },
    {
      name: 'getBooking (modificación)',
      path: SABRE_GET_BOOKING_PATH,
      body: buildSabreGetBookingForModification(MAXIMAL_GET_MODIFICATION),
    },
  ];
}

describe('ningún cuerpo de salida lleva dato de tarjeta', () => {
  it('el barrido cubre los cuerpos que se esperan: si uno desaparece, el guard no mide menos en silencio', () => {
    expect(egressBodies().map((egress) => egress.name)).toEqual([
      'offers/price',
      'createBooking',
      'cancelBooking',
      'getBooking (display)',
      'getBooking (modificación)',
    ]);
  });

  for (const { name, path, body } of egressBodies()) {
    it(`${name}: el cuerpo serializado no nombra ninguna clave de tarjeta`, async () => {
      const wire = await wireBytes(path, body);
      expect(
        forbiddenKeysIn(wire),
        `${name} nombra claves prohibidas por D1. Ninguna forma de pago de este ACL las declara: ` +
          'si han aparecido, alguien ha añadido un carril de tarjeta sin pasar por el flag SAQ-D.',
      ).toEqual([]);
    });

    it(`${name}: el cuerpo serializado no lleva ninguna tirada con forma de PAN`, async () => {
      const wire = await wireBytes(path, body);
      expect(
        findPanLike(wire),
        `${name} lleva ${String(findPanLike(wire).length)} tirada(s) de 13-19 dígitos que pasan ` +
          'Luhn. El valor NO se imprime a propósito; el offset localiza el campo en el cuerpo.',
      ).toEqual([]);
    });
  }

  it('las dos afirmaciones son capaces de fallar: cuerpo envenenado por la misma puerta', async () => {
    // La sonda de comportamiento. Los builders no pueden producir esto —`PAYMENTCARD` no está en
    // la unión y `cardNumber` es `?: never`—, así que se envenena el cuerpo a mano y se manda por
    // el MISMO `postJson`. Si algún día las dos afirmaciones de arriba dejaran de medir, este caso
    // se pondría verde-por-nada y con él se cae el guard entero.
    const poisoned = {
      payment: {
        formsOfPayment: [
          { type: 'PAYMENTCARD', cardNumber: TEST_PAN, cardSecurityCode: '123', cardHolder: 'X' },
        ],
      },
    };
    const wire = await wireBytes(SABRE_CREATE_BOOKING_PATH, poisoned);
    expect(forbiddenKeysIn(wire)).toEqual(['cardNumber', 'cardSecurityCode', 'cardHolder']);
    expect(findPanLike(wire)).toHaveLength(1);
  });

  it('el cuerpo de creación lleva un bloque de pago de verdad: el barrido no pasa por vacío', () => {
    // Sin esto, `omitPayment` o un fixture mal montado dejarían el guard verde midiendo un cuerpo
    // que ni siquiera tiene sección de pago. Verde por omisión no es verde.
    const body = buildSabreCreateBookingRequest(MAXIMAL_CREATE_INPUT, config()).body;
    expect(body.payment?.formsOfPayment.map((fop) => fop.type)).toEqual(['CASH', 'INVOICE']);
  });
});

describe('el carril de BIN de offers/price está apagado por defecto', () => {
  const withCard: SabrePriceInput = {
    ...MAXIMAL_PRICE_INPUT,
    formOfPayment: { subCode: 'VIS', cardType: 'VI', binNumber: '411111' },
  };

  it('sin allowCardBinPricing, tarificar con datos de tarjeta es un error duro', () => {
    expect(() => buildSabrePriceRequest(withCard)).toThrow(/allowCardBinPricing/);
  });

  it('con el interruptor puesto, el BIN sale y sigue sin caber un PAN', async () => {
    const wire = await wireBytes(
      SABRE_PRICE_PATH,
      buildSabrePriceRequest(withCard, { allowCardBinPricing: true }),
    );
    expect(wire).toContain('"binNumber":"411111"');
    // El BIN son 6-8 dígitos por contrato: nunca alcanza el suelo de 13 del detector.
    expect(findPanLike(wire)).toEqual([]);
    expect(forbiddenKeysIn(wire)).toEqual([]);
  });

  it('un PAN en binNumber no cabe ni con el interruptor puesto', () => {
    expect(() =>
      buildSabrePriceRequest(
        { ...MAXIMAL_PRICE_INPUT, formOfPayment: { subCode: 'VIS', binNumber: TEST_PAN } },
        { allowCardBinPricing: true },
      ),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// Mitad 2: el barrido de mutación
// ---------------------------------------------------------------------------------------------

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Rutas de todas las hojas de texto, en notación `a.0.b`. */
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
 * Inyecta el PAN en cada hoja de texto de `input` y clasifica el resultado.
 *
 * `rejected` = el builder lanzó (esquema, patrón o guardia explícito). `carried` = el PAN llegó al
 * cuerpo serializado. No hay tercera categoría a propósito: un builder que "lo limpia" callado
 * sería peor que cualquiera de las dos, y si apareciera, este barrido lo marcaría como `rejected`
 * sin lanzar —cosa imposible— y el `expect` de abajo se pondría rojo.
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
 * El inventario congelado de campos por los que un PAN inyectado LLEGA al cable.
 *
 * No es una lista de bugs: es la superficie de texto libre y numérico que el contrato de Sabre
 * exige y cuya forma es indistinguible de un PAN. Cada entrada está aquí porque rechazarla
 * rompería un caso legítimo —teléfonos, localizadores, identificadores de oferta, descripciones—.
 *
 * Su valor es el cambio: si un campo nuevo aparece aquí, alguien ha ampliado la superficie de
 * salida y tiene que decidirlo a la vista; si uno desaparece, alguien ha apretado un esquema y
 * conviene saberlo. **Añadir una línea a esta lista es una decisión, no un arreglo del test.**
 */

/**
 * `offers/price`. Los cinco son identificadores opacos que **emite Sabre** y nosotros devolvemos:
 * `^[\w-]{1,200}$` para los de pasajero, `^\S{1,64}$` para los de forma de pago. Un PAN encaja en
 * esos patrones porque encaja cualquier cosa; apretarlos rompería ids legítimos que ya vienen del
 * proveedor.
 *
 * Lo que **no** está aquí importa igual: `accountCode` y los valores de `customQualifiers` no
 * aparecen porque el builder los pasa por `assertNoPanLikeDigits`, y `unusedTicketNumber` tampoco
 * porque su patrón `^[0-9]{13,14}$` no admite los 16 dígitos del PAN de prueba. Las dos defensas
 * están vivas y se ven aquí por ausencia.
 */
const CARRIED_PRICE: readonly string[] = Object.freeze([
  'formOfPayment.id',
  'passengers.0.frequentFlyer.0.accountNumber',
  'passengers.0.id',
  'query.0.formOfPaymentRef',
  'query.0.passengerIds.0',
]);

/**
 * `createBooking`. Tres familias, ninguna sorprendente:
 *
 *  - **Texto libre de dirección y comentario** (`agency.address.*`, `futureTicketingPolicy.comment`
 *    e `invoiceDescription`): el contrato los declara `string` sin patrón. Un `street` que no
 *    admita dígitos no es una dirección.
 *  - **Campos numéricos legítimos** (`phones[]` con `^[0-9+-]+$`, `queueNumber`, `desiredAmount`,
 *    `amountOnSecondFormOfPayment`): un teléfono de 16 dígitos es indistinguible de un PAN por su
 *    forma, y ésa es justamente la razón por la que el detector de forma no puede ser el rail.
 *  - **Identificadores y nombres** (`confirmationId`, `providerTravelerId`, `programNumber`,
 *    `nameReferenceCode`, `documentNumber`, y los `givenName`/`middleName`/`surname` de dentro del
 *    documento): el `pattern` `:6165` del contrato admite dígitos en el nombre de pila a propósito.
 *    ⚠️ `travelers[].surname` NO está en la lista: su patrón `:6170` prohíbe dígitos y el PAN se
 *    rechaza. Que uno esté y el otro no es el contrato, no un descuido.
 */
const CARRIED_CREATE: readonly string[] = Object.freeze([
  'agency.address.city',
  'agency.address.postalCode',
  'agency.address.stateProvince',
  'agency.address.street',
  'agency.contactInfo.phones.0',
  'agency.futureTicketingPolicy.comment',
  'agency.futureTicketingPolicy.queueNumber',
  'contactInfo.phones.0',
  'formsOfPayment.1.invoiceDescription',
  'product.flights.0.confirmationId',
  'product.pricing.0.amountOnSecondFormOfPayment',
  'product.pricing.0.priceComparisons.0.desiredAmount',
  'receivedFrom',
  'retentionLabel',
  'travelers.0.givenName',
  'travelers.0.identityDocuments.0.documentNumber',
  'travelers.0.identityDocuments.0.givenName',
  'travelers.0.identityDocuments.0.middleName',
  'travelers.0.identityDocuments.0.placeOfBirth',
  'travelers.0.identityDocuments.0.surname',
  'travelers.0.loyaltyPrograms.0.programNumber',
  'travelers.0.nameReferenceCode',
  'travelers.0.phones.0.number',
  'travelers.0.providerTravelerId',
]);

/**
 * `cancelBooking`. `receivedFrom` y `retention.label` son texto libre acotado por patrón, igual
 * que en creación.
 *
 * ⚠️ `bookingSource` y `errorHandlingPolicy` son distintos y hay que leerlos con cuidado: son
 * **enums cerrados** y aparecen aquí sólo porque este barrido inyecta el PAN saltándose el
 * compilador. En TypeScript no se pueden construir con otro valor. La observación honesta es que
 * `buildSabreCancelBookingRequest` los copia SIN validación en tiempo de ejecución —a diferencia de
 * `confirmationId` o `receivedFrom`, que sí pasan por Zod—, así que un `unknown` que llegue por un
 * borde sin parsear los atravesaría. No es una fuga de PAN realista; es un borde sin Zod, y está
 * anotado para que quien conecte el adapter lo cierre allí o aquí.
 */
const CARRIED_CANCEL: readonly string[] = Object.freeze([
  'bookingSource',
  'errorHandlingPolicy',
  'receivedFrom',
  'retention.label',
]);

/** Lo que hay que hacer cuando este barrido se pone rojo. No es "actualizar el snapshot". */
const CARRIED_HELP =
  'La superficie de salida ha cambiado. Un campo NUEVO en la lista significa que un PAN inyectado ' +
  'ahora llega al cable por una vía que antes no existía: decide a la vista si el campo lo ' +
  'necesita —dirección, teléfono, identificador del proveedor— o si su esquema debe apretarse. Un ' +
  'campo que DESAPARECE significa que un esquema se ha endurecido: bórralo de la lista y ' +
  'enhorabuena. Copiar la lista recibida sin leerla convierte este guard en un snapshot, que es ' +
  'la forma que tiene un guard de morir sin ponerse rojo.';

describe('barrido de mutación: dónde llega un PAN inyectado y dónde no', () => {
  it('offers/price', () => {
    const verdicts = mutationVerdicts(MAXIMAL_PRICE_INPUT, (mutated) =>
      buildSabrePriceRequest(mutated as unknown as SabrePriceInput),
    );
    expect(Object.keys(verdicts).length).toBeGreaterThan(5);
    // Las dos defensas del builder, probadas por la rama que RECHAZA: sin esto, un builder que
    // aceptase todo pasaría igual con sólo alargar la lista congelada.
    expect(verdicts['accountCode']).toBe('rejected');
    expect(verdicts['customQualifiers.promo']).toBe('rejected');
    expect(verdicts['passengers.0.unusedTicketNumber']).toBe('rejected');
    expect(carriedPaths(verdicts), CARRIED_HELP).toEqual([...CARRIED_PRICE]);
  });

  it('createBooking', () => {
    const verdicts = mutationVerdicts(
      MAXIMAL_CREATE_INPUT,
      (mutated) =>
        buildSabreCreateBookingRequest(mutated as unknown as SabreCreateBookingInput, config())
          .body,
    );
    expect(Object.keys(verdicts).length).toBeGreaterThan(30);
    // El apellido sí prohíbe dígitos por contrato (`:6170`) y el nombre de pila no (`:6165`).
    // Fijar las dos ramas es lo que impide que este barrido se lea como "aquí no hay defensas".
    expect(verdicts['travelers.0.surname']).toBe('rejected');
    expect(verdicts['travelers.0.givenName']).toBe('carried');
    expect(verdicts['targetPcc']).toBe('rejected');
    expect(carriedPaths(verdicts), CARRIED_HELP).toEqual([...CARRIED_CREATE]);
  });

  it('cancelBooking', () => {
    const verdicts = mutationVerdicts(MAXIMAL_CANCEL_OPTIONS as unknown as Json, (mutated) =>
      buildSabreCancelBookingRequest({
        ...(mutated as unknown as SabreCancelBookingOptions),
        // La evidencia lleva una marca nominal que `JSON.parse` no reconstruye: se reinyecta la
        // real salvo cuando la mutación toca uno de SUS campos, que es lo que se quiere medir.
        ticketCheck: {
          ...TICKET_CHECK,
          ...((mutated as unknown as SabreCancelBookingOptions).ticketCheck ?? {}),
          __sabreTicketCheck: 'checkFlightTickets',
        },
      }),
    );
    expect(Object.keys(verdicts).length).toBeGreaterThan(10);
    expect(verdicts['confirmationId']).toBe('rejected');
    expect(carriedPaths(verdicts), CARRIED_HELP).toEqual([...CARRIED_CANCEL]);
  });
});
