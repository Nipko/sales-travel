import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SABRE_EXTRA_FEATURES } from './get.request.builder';
import {
  SABRE_STATUS_NAMES,
  SabreGetBookingMappingError,
  mapOrdersViewAirlineLocators,
  mapSabreGetBookingForDisplay,
  mapSabreGetBookingForModification,
  notFoundOrderView,
  toOrderForModification,
} from './get.response.mapper';

function findRepoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('no se encontró la raíz del monorepo');
    dir = parent;
  }
}

/**
 * Las 4 respuestas guardadas de la colección llevan dos líneas de cabecera `//` con su
 * procedencia. Se leen **del expediente**, no de una copia dentro del paquete: copiarlas aquí
 * dejaría dos originales divergiendo en silencio, que es el mismo fallo contra el que existe
 * `spec-manifest.test.ts` para los `.yml`.
 */
function loadEvidenceResponse(file: string): unknown {
  const raw = readFileSync(
    join(findRepoRoot(), 'docs', 'sabre', 'evidence', 'responses', file),
    'utf8',
  );
  const body = raw
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('//'))
    .join('\n');
  return JSON.parse(body) as unknown;
}

/** Reserva emitida con dos vuelos de la misma aerolínea y un tercero interlínea. */
function ticketedBooking(): Record<string, unknown> {
  return {
    bookingId: 'GLEBNY',
    isCancelable: true,
    isTicketed: true,
    flights: [
      {
        itemId: '1',
        airlineCode: 'AA',
        confirmationId: 'NIEBNY',
        sourceType: 'ATPCO',
        flightStatusCode: 'HK',
        flightStatusName: 'Confirmed',
      },
      {
        itemId: '2',
        airlineCode: 'AA',
        confirmationId: 'NIEBNY',
        sourceType: 'ATPCO',
        flightStatusName: 'Confirmed',
      },
      {
        itemId: '3',
        airlineCode: 'LA',
        confirmationId: 'XKCD12',
        sourceType: 'NDC',
        flightStatusName: 'Confirmed',
      },
    ],
    flightTickets: [{ number: '0167489825830', travelerIndex: 1 }],
    travelers: [{ givenName: 'PAM' }],
  };
}

describe('getBooking — RF-23: el localizador de la AEROLÍNEA', () => {
  it('sale de flights[].confirmationId + airlineCode, deduplicado y por transportista', () => {
    const snapshot = mapSabreGetBookingForDisplay(ticketedBooking());
    expect(snapshot.view.airlineLocators).toEqual([
      { carrierCode: 'AA', locator: 'NIEBNY' },
      { carrierCode: 'LA', locator: 'XKCD12' },
    ]);
  });

  it('NO es el PNR de Sabre ni nuestro orderId (RF-23 CA-2)', () => {
    const snapshot = mapSabreGetBookingForDisplay(ticketedBooking());
    expect(snapshot.view.orderId).toBe('GLEBNY');
    // El localizador de la aerolínea vive en otro campo y con otro valor. Colapsarlos daría al
    // pasajero un código con el que no puede hacer check-in.
    expect(snapshot.view.airlineLocators.map((entry) => entry.locator)).not.toContain('GLEBNY');
  });

  it('acepta un localizador de 5 caracteres: el patrón de Flight.confirmationId es {5,}', () => {
    const snapshot = mapSabreGetBookingForDisplay({
      flights: [{ itemId: '1', airlineCode: 'AV', confirmationId: 'ABC12' }],
    });
    expect(snapshot.view.airlineLocators).toEqual([{ carrierCode: 'AV', locator: 'ABC12' }]);
  });

  it('un vuelo sin airlineCode no publica localizador a medias', () => {
    const snapshot = mapSabreGetBookingForDisplay({
      flights: [{ itemId: '1', confirmationId: 'NIEBNY' }],
    });
    expect(snapshot.view.airlineLocators).toEqual([]);
    expect(snapshot.warnings).toContain('flight-without-airline-code');
  });

  it('RF-23 CA-4: reserva emitida sin ningún localizador ⇒ dato ausente y VISIBLE', () => {
    const snapshot = mapSabreGetBookingForDisplay({
      isTicketed: true,
      flights: [{ itemId: '1', airlineCode: 'AA', flightStatusName: 'Confirmed' }],
    });
    expect(snapshot.view.airlineLocators).toEqual([]);
    // Callarlo convierte "no nos lo dieron" en "la aerolínea no da código" (RNF-13).
    expect(snapshot.view.warnings).toContain('airline-locator-absent');
  });

  it('sin emitir, la ausencia de localizador NO es un aviso', () => {
    const snapshot = mapSabreGetBookingForDisplay({
      isTicketed: false,
      flights: [{ itemId: '1', airlineCode: 'AA' }],
    });
    expect(snapshot.warnings).not.toContain('airline-locator-absent');
  });
});

describe('getBooking — RF-23 CA-5: el carril NDC con el fixture REAL de /v1/orders/view', () => {
  it('extrae los dos localizadores de externalOrders[].bookingReferences[]', () => {
    const locators = mapOrdersViewAirlineLocators(
      loadEvidenceResponse('01-Add_phone_Orders_View.json'),
    );
    expect(locators).toHaveLength(2);
    expect(locators[0]).toEqual({ carrierCode: 'F1', locator: 'L4D79U' });
    expect(locators[1]).toEqual({ carrierCode: 'UAD', locator: 'MFFPXC' });
  });

  it('las cuatro respuestas guardadas dan lo mismo', () => {
    for (const file of [
      '01-Add_phone_Orders_View.json',
      '02-Delete_phone_Orders_View.json',
      '03-Update_phone_Orders_View.json',
      '04-update_birthdate_Orders_View.json',
    ]) {
      const locators = mapOrdersViewAirlineLocators(loadEvidenceResponse(file));
      expect(locators.length, file).toBeGreaterThanOrEqual(1);
    }
  });

  it('acepta carrierCode de tres caracteres: UAD no es un código IATA', () => {
    // Aplicar `^[A-Z]{2}$` —el patrón de Booking.flights[].airlineCode— tiraría la mitad de los
    // localizadores del único fixture real. Son dos endpoints con vocabularios distintos.
    const locators = mapOrdersViewAirlineLocators({
      order: { externalOrders: [{ bookingReferences: [{ id: 'MFFPXC', carrierCode: 'UAD' }] }] },
    });
    expect(locators).toEqual([{ carrierCode: 'UAD', locator: 'MFFPXC' }]);
  });

  it('un documento sin externalOrders devuelve lista vacía, no lanza', () => {
    expect(mapOrdersViewAirlineLocators({ order: {} })).toEqual([]);
  });
});

describe('getBooking — el display NUNCA devuelve la firma (RF-09 CA-1)', () => {
  it('descarta bookingSignature aunque venga en el cuerpo, y lo avisa', () => {
    const signature = '76c2817b178cc264fa44cf85df1da5fb9e1b963006b2339aa5edc09129415bba5fcf5bf9';
    const snapshot = mapSabreGetBookingForDisplay({
      ...ticketedBooking(),
      bookingSignature: signature,
    });

    // Ni el valor ni el nombre del campo aparecen en NINGÚN sitio de la vista.
    expect(JSON.stringify(snapshot)).not.toContain(signature);
    expect(JSON.stringify(snapshot)).not.toContain('bookingSignature');
    // Que venga significa que se pagó la lectura cara creyendo pagar la barata: es un bug visible.
    expect(snapshot.warnings).toContain('booking-signature-in-display-response');
  });
});

describe('getBooking — la lectura para modificar', () => {
  it('sin firma es fallo DURO del paso, no un campo opcional', () => {
    const result = mapSabreGetBookingForModification(ticketedBooking());
    expect(result.retrieved).toBe(false);
    if (result.retrieved) expect.unreachable('no debería haber recuperado');
    expect(result.warnings).toContain('booking-signature-absent');
  });

  it('con firma trae el sello, y el perfil de flags es el único que hay', () => {
    const result = mapSabreGetBookingForModification({
      ...ticketedBooking(),
      bookingSignature: 'abc123',
      timestamp: '2026-08-26T10:00:00Z',
    });
    expect(result.retrieved).toBe(true);
    if (!result.retrieved) expect.unreachable('debería haber recuperado');
    expect(result.signature).toBe('abc123');
    // El `timestamp` del proveedor gana al reloj nuestro: es el instante al que se refiere la firma.
    expect(result.retrievedAt).toBe('2026-08-26T10:00:00Z');

    const port = toOrderForModification(result);
    expect(port.retrieved).toBe(true);
    if (!port.retrieved) expect.unreachable('debería haber recuperado');
    expect(port.versionStamp.featureProfile).toEqual(SABRE_EXTRA_FEATURES);
  });

  it('sin timestamp usa el reloj inyectado', () => {
    const result = mapSabreGetBookingForModification(
      { ...ticketedBooking(), bookingSignature: 'abc123' },
      { now: '2026-01-01T00:00:00Z' },
    );
    if (!result.retrieved) expect.unreachable('debería haber recuperado');
    expect(result.retrievedAt).toBe('2026-01-01T00:00:00Z');
  });

  it('una firma vacía cuenta como ausente', () => {
    const result = mapSabreGetBookingForModification({
      ...ticketedBooking(),
      bookingSignature: '',
    });
    expect(result.retrieved).toBe(false);
  });
});

describe('getBooking — RF-10 CA-4: el estado NO se lee de la ausencia de claves', () => {
  it('sin ítems el estado es NO_CONTENT, jamás CANCELLED', () => {
    // Es lo que devuelven TANTO una reserva vaciada COMO una lectura filtrada sin FLIGHTS.
    // Confundirlas fue el error histórico.
    const snapshot = mapSabreGetBookingForDisplay({ bookingId: 'GLEBNY' });
    expect(snapshot.status).toBe('NO_CONTENT');
  });

  it('todos los ítems en Cancelled ⇒ CANCELLED', () => {
    const snapshot = mapSabreGetBookingForDisplay({
      flights: [{ itemId: '1', airlineCode: 'AA', flightStatusName: 'Cancelled' }],
      hotels: [{ itemId: '42', hotelStatusName: 'Cancelled' }],
    });
    expect(snapshot.status).toBe('CANCELLED');
  });

  it('un solo ítem vivo ⇒ ACTIVE', () => {
    const snapshot = mapSabreGetBookingForDisplay({
      flights: [{ itemId: '1', airlineCode: 'AA', flightStatusName: 'Cancelled' }],
      hotels: [{ itemId: '42', hotelStatusName: 'Confirmed' }],
    });
    expect(snapshot.status).toBe('ACTIVE');
  });

  it('StatusNameEnum tiene los 14 valores del contrato, incluidos Standby y Unknown', () => {
    expect(SABRE_STATUS_NAMES).toHaveLength(14);
    expect(SABRE_STATUS_NAMES).toContain('Standby');
    expect(SABRE_STATUS_NAMES).toContain('Unknown');
  });
});

describe('getBooking — ítems y carriles de contenido', () => {
  it('recoge itemId como string, con su tipo y su carril', () => {
    const snapshot = mapSabreGetBookingForDisplay({
      ...ticketedBooking(),
      hotels: [{ itemId: '42', hotelStatusName: 'Confirmed' }],
      cars: [{ itemId: '22' }],
    });
    expect(snapshot.items.filter((item) => item.kind === 'FLIGHT')).toHaveLength(3);
    expect(snapshot.items.find((item) => item.itemId === '42')?.kind).toBe('HOTEL');
    expect(snapshot.items.find((item) => item.itemId === '22')?.kind).toBe('CAR');
    expect(snapshot.contentLanes).toEqual(['ATPCO', 'NDC']);
  });

  it('un vuelo sin itemId no desaparece en silencio: no se podrá cancelar por producto', () => {
    const snapshot = mapSabreGetBookingForDisplay({
      flights: [{ airlineCode: 'AA', confirmationId: 'NIEBNY' }],
    });
    expect(snapshot.items).toEqual([]);
    expect(snapshot.warnings).toContain('flight-without-item-id');
  });

  it('un itemId numérico en la RESPUESTA es respuesta fuera de contrato, no algo que adivinar', () => {
    // La laxitud de `{"itemId": 9}` está en los cuerpos de PETICIÓN de la colección; el contrato
    // declara `type: string` (`:1874-1880`) en las dos direcciones. Un itemId que no es string es
    // un identificador que no sabemos escribir de vuelta en un cancelBooking, y cancelar con el
    // identificador equivocado es peor que no cancelar. Se falla cerrado.
    expect(() =>
      mapSabreGetBookingForDisplay({ flights: [{ itemId: 9, airlineCode: 'AA' }] }),
    ).toThrow(SabreGetBookingMappingError);
  });
});

describe('getBooking — billetes e índices 1-based', () => {
  it('recoge los números de billete sin repetir', () => {
    const snapshot = mapSabreGetBookingForDisplay({
      flightTickets: [
        { number: '0167489825830', travelerIndex: 1 },
        { number: '0167489825830', travelerIndex: 1 },
        { number: '1609786952746/47', travelerIndex: 1 },
      ],
      travelers: [{}],
    });
    expect(snapshot.view.ticketNumbers).toEqual(['0167489825830', '1609786952746/47']);
  });

  it('travelerIndex 0 es imposible: el campo es 1-based (minimum: 1)', () => {
    const snapshot = mapSabreGetBookingForDisplay({
      flightTickets: [{ number: '0167489825830', travelerIndex: 0 }],
      travelers: [{}],
    });
    expect(snapshot.warnings).toContain('traveler-index-out-of-range');
  });

  it('travelerIndex que no apunta a nadie se avisa', () => {
    const snapshot = mapSabreGetBookingForDisplay({
      flightTickets: [{ number: '0167489825830', travelerIndex: 3 }],
      travelers: [{}, {}],
    });
    expect(snapshot.warnings).toContain('traveler-index-out-of-range');
  });

  it('travelerIndex válido no avisa', () => {
    const snapshot = mapSabreGetBookingForDisplay({
      flightTickets: [{ number: '0167489825830', travelerIndex: 2 }],
      travelers: [{}, {}],
    });
    expect(snapshot.warnings).not.toContain('traveler-index-out-of-range');
  });

  it('infiere reserva emitida si falta isTicketed pero existen flightTickets', () => {
    const snapshot = mapSabreGetBookingForDisplay({
      flights: [{ itemId: '1', airlineCode: 'AA', flightStatusName: 'Confirmed' }],
      flightTickets: [{ number: '0167489825830', travelerIndex: 1 }],
      travelers: [{}],
    });

    expect(snapshot.isTicketed).toBe(true);
    expect(snapshot.warnings).toContain('airline-locator-absent');
  });

  it('la evidencia documental gana incluso ante un flag false o un número ilegible', () => {
    const snapshot = mapSabreGetBookingForDisplay({
      isTicketed: false,
      flightTickets: [{ number: { raw: 'DOCUMENTO-ILEGIBLE' } }],
    });

    expect(snapshot.isTicketed).toBe(true);
    expect(snapshot.warnings).toContain('ticket-number-malformed');
  });

  it.each(['nonElectronicTickets', 'accountingItems'] as const)(
    '%s también prueba que ya existe un documento cumplido',
    (field) => {
      const snapshot = mapSabreGetBookingForDisplay({ [field]: [{}] });
      expect(snapshot.isTicketed).toBe(true);
    },
  );
});

describe('getBooking — la vista NO puede llevar PII', () => {
  it('ningún valor de persona del payload aparece en la salida serializada', () => {
    const pii = {
      givenName: 'PAM',
      surname: 'THOMPSON',
      birthDate: '1977-03-01',
      email: 'pam.thompson@ejemplo.com',
      phone: '6069871234',
      passport: 'X1234567',
      cardNumber: '411111XXXXXX1111',
    };

    const snapshot = mapSabreGetBookingForDisplay({
      ...ticketedBooking(),
      // El eco de la request: Sabre devuelve lo que le mandamos, apellido incluido.
      request: { confirmationId: 'GLEBNY', surname: pii.surname },
      travelers: [
        {
          givenName: pii.givenName,
          surname: pii.surname,
          birthDate: pii.birthDate,
          emails: [{ address: pii.email }],
          phones: [{ number: pii.phone }],
          identityDocuments: [{ documentNumber: pii.passport, documentType: 'PASSPORT' }],
        },
      ],
      accountingItems: [{ cardNumber: pii.cardNumber }],
    });

    const serialized = JSON.stringify(snapshot);
    for (const [field, value] of Object.entries(pii)) {
      expect(serialized, `se filtró ${field}`).not.toContain(value);
    }
  });
});

describe('getBooking — el borde rechaza lo que no encaja', () => {
  it('un escalar no es una respuesta', () => {
    expect(() => mapSabreGetBookingForDisplay('OK')).toThrow(SabreGetBookingMappingError);
  });

  it('el mensaje del error de mapeo lleva rutas de Zod, no valores', () => {
    try {
      mapSabreGetBookingForDisplay({ bookingId: 42 });
      expect.unreachable('debería haber lanzado');
    } catch (error) {
      expect((error as Error).message).toContain('bookingId');
      expect((error as Error).message).not.toContain('42');
    }
  });

  it('notFoundOrderView cumple la forma del puerto', () => {
    const view = notFoundOrderView(['sabre.BOOKING_NOT_FOUND']);
    expect(view.found).toBe(false);
    // El campo es array SIEMPRE, nunca se omite (RF-23 CA-1).
    expect(view.airlineLocators).toEqual([]);
  });
});

/**
 * Los ejemplos OFICIALES de la ayuda del producto, leídos del expediente. Cada bloque JSON se
 * extrae por la frase que lo precede en el texto (y, si la frase se repite, por la sección donde
 * está), con un recorrido de llaves que respeta las cadenas.
 */
function loadHelpExample(file: string, label: string, after?: string): Record<string, unknown> {
  const text = readFileSync(
    join(
      findRepoRoot(),
      'docs',
      'sabre',
      'evidence',
      'specs',
      'help',
      'booking-management-api-v1',
      file,
    ),
    'utf8',
  );
  const from = after === undefined ? 0 : text.indexOf(after);
  if (from < 0) throw new Error(`no está la sección «${after ?? ''}» en ${file}`);
  const at = text.indexOf(label, from);
  if (at < 0) throw new Error(`no está «${label}» en ${file}`);
  const start = text.indexOf('{', at);
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>;
    }
  }
  throw new Error(`bloque JSON sin cerrar tras «${label}» en ${file}`);
}

const GET_EXAMPLES = 'help-documentation-get-booking-examples.txt';
const FULFILL_EXAMPLES = 'help-documentation-fulfill-flight-tickets-examples.txt';
const CONJUNCTIVE = 'Example response with refunded conjunctive tickets:';

describe('getBooking — RF-15: documentos con su estado, con los ejemplos oficiales', () => {
  it('el conjuntivo devuelto (TR + TE del mismo tiquete) es UN documento, devuelto', () => {
    // El reembolso de un conjuntivo deja un ítem `TR` con el número principal, y getBooking trae
    // también el `TE` original con el número conjuntivo (nota final del mismo archivo).
    const snapshot = mapSabreGetBookingForDisplay(loadHelpExample(GET_EXAMPLES, CONJUNCTIVE));
    expect(snapshot.view.documents).toEqual([
      {
        number: '1609786952746',
        kind: 'TICKET',
        status: 'REFUNDED',
        travelerIndex: 0,
        providerStatusCode: 'TR',
      },
    ]);
    // La lista vieja no cambia: sigue con los dos números tal como vinieron.
    expect(snapshot.view.ticketNumbers).toEqual(['1609786952746', '1609786952746/47']);
  });

  it('el orden de las dos entradas no cambia el resultado', () => {
    const example = loadHelpExample(GET_EXAMPLES, CONJUNCTIVE);
    const tickets = example['flightTickets'] as unknown[];
    const snapshot = mapSabreGetBookingForDisplay({
      ...example,
      flightTickets: [...tickets].reverse(),
    });
    expect(snapshot.view.documents?.map((d) => [d.number, d.status, d.travelerIndex])).toEqual([
      ['1609786952746', 'REFUNDED', 0],
    ]);
  });

  it('una reserva NDC sin emitir: el localizador de la aerolínea, sin documentos ni plazo', () => {
    const snapshot = mapSabreGetBookingForDisplay(
      loadHelpExample(GET_EXAMPLES, 'Example response with NDC seats:'),
    );
    expect(snapshot.view.airlineLocators).toEqual([{ carrierCode: 'LO', locator: 'Z6XNH2' }]);
    expect(snapshot.view).not.toHaveProperty('documents');
    // `creationDetails` viene, pero sin `purchaseDeadlineDate`: no hay plazo que inventar.
    expect(snapshot.view).not.toHaveProperty('ticketingDeadline');
    expect(snapshot.warnings).not.toContain('ticketing-deadline-malformed');
  });

  it('TE y ME del ejemplo oficial de fulfill ATPCO: tiquetes y EMD emitidos', () => {
    // Los `tickets[]` de fulfill comparten con `flightTickets[]` número y ticketStatusCode.
    const fulfill = loadHelpExample(
      FULFILL_EXAMPLES,
      'containing the issued documents (tickets and EMDs)',
    );
    const snapshot = mapSabreGetBookingForDisplay({ flightTickets: fulfill['tickets'] });
    const documents = snapshot.view.documents ?? [];
    expect(documents.length).toBeGreaterThan(0);
    expect(new Set(documents.map((d) => d.status))).toEqual(new Set(['ISSUED']));
    expect(new Set(documents.map((d) => d.kind))).toEqual(new Set(['TICKET', 'EMD']));
    expect(documents.find((d) => d.number === '0801806412388')?.kind).toBe('EMD');
    expect(documents.find((d) => d.number === '0806802004064')?.kind).toBe('TICKET');
  });

  it('TO del ejemplo oficial de fulfill NDC cuenta como emitido', () => {
    const fulfill = loadHelpExample(
      FULFILL_EXAMPLES,
      'A successful operation results',
      'NDC booking fulfillment',
    );
    const snapshot = mapSabreGetBookingForDisplay({ flightTickets: fulfill['tickets'] });
    expect(snapshot.view.documents).toEqual([
      { number: '0015752129518', kind: 'TICKET', status: 'ISSUED', providerStatusCode: 'TO' },
      { number: '0015752129519', kind: 'TICKET', status: 'ISSUED', providerStatusCode: 'TO' },
    ]);
    // El ejemplo trae nombres de pasajero en cada tiquete: no pasan a la vista.
    expect(JSON.stringify(snapshot)).not.toContain('Drake');
  });
});

describe('getBooking — RF-15: documentos, casos borde', () => {
  it('un código fuera de la tabla sale UNKNOWN, con su código y un aviso', () => {
    const snapshot = mapSabreGetBookingForDisplay({
      flightTickets: [{ number: '0167489825830', travelerIndex: 1, ticketStatusCode: 'TV' }],
    });
    expect(snapshot.view.documents).toEqual([
      {
        number: '0167489825830',
        kind: 'TICKET',
        status: 'UNKNOWN',
        travelerIndex: 0,
        providerStatusCode: 'TV',
      },
    ]);
    expect(snapshot.warnings).toContain('ticket-status-unknown');
  });

  it('un EMD emitido es EMD, y el pasajero va por posición desde 0', () => {
    const snapshot = mapSabreGetBookingForDisplay({
      flightTickets: [{ number: '1251934576908', travelerIndex: 2, ticketStatusCode: 'ME' }],
      travelers: [{}, {}],
    });
    expect(snapshot.view.documents).toEqual([
      {
        number: '1251934576908',
        kind: 'EMD',
        status: 'ISSUED',
        travelerIndex: 1,
        providerStatusCode: 'ME',
      },
    ]);
  });

  it('un índice de pasajero fuera de rango no se publica', () => {
    const snapshot = mapSabreGetBookingForDisplay({
      flightTickets: [{ number: '0167489825830', travelerIndex: 3, ticketStatusCode: 'TE' }],
      travelers: [{}],
    });
    expect(snapshot.view.documents?.[0]).not.toHaveProperty('travelerIndex');
    expect(snapshot.warnings).toContain('traveler-index-out-of-range');
  });

  it.each([
    ['0', 'muy corto'],
    ['016-7489825830', 'con guion: no se sabe si es formato o rango'],
    ['ABC1234567890', 'con letras'],
    ['01674898258301234', 'más de 16 dígitos'],
  ])('%s no pasa a documento (%s), pero sigue en ticketNumbers', (number) => {
    const snapshot = mapSabreGetBookingForDisplay({
      flightTickets: [{ number, travelerIndex: 1, ticketStatusCode: 'TE' }],
    });
    expect(snapshot.view.documents).toEqual([]);
    expect(snapshot.view.ticketNumbers).toEqual([number]);
    expect(snapshot.warnings).toContain('ticket-number-malformed');
  });

  it('con la sección de tiquetes presente pero sin documentos legibles, la lista es vacía', () => {
    // Presente manda sobre `ticketNumbers`: quien guarda no cae a "número sin estado".
    const snapshot = mapSabreGetBookingForDisplay({ flightTickets: [{ number: 42 }] });
    expect(snapshot.view.documents).toEqual([]);
  });

  it('sin flightTickets no hay lista: la lectura no trajo la sección', () => {
    expect(mapSabreGetBookingForDisplay({ bookingId: 'GLEBNY' }).view).not.toHaveProperty(
      'documents',
    );
  });
});

describe('getBooking — plazo de emisión', () => {
  it('futureTicketingPolicy, con el ejemplo oficial de una reserva NDC leída al modificarla', () => {
    const response = loadHelpExample(
      'help-documentation-modify-booking-examples-0.txt',
      'The expected response:',
      'NDC booking – modify traveler information',
    );
    const snapshot = mapSabreGetBookingForDisplay(response['booking']);
    expect(snapshot.view.ticketingDeadline).toEqual({
      date: '2023-09-30',
      time: '00:59',
      zone: 'PROVIDER_LOCAL',
    });
    expect(snapshot.view.airlineLocators).toEqual([{ carrierCode: 'QF', locator: 'L9LR6Q' }]);
  });

  it('en NDC, sin futureTicketingPolicy, el plazo de garantía del precio', () => {
    const snapshot = mapSabreGetBookingForDisplay({
      creationDetails: { purchaseDeadlineDate: '2026-10-20', purchaseDeadlineTime: '15:00' },
    });
    expect(snapshot.view.ticketingDeadline).toEqual({
      date: '2026-10-20',
      time: '15:00',
      zone: 'PROVIDER_LOCAL',
    });
  });

  it('futureTicketingPolicy gana a purchaseDeadline', () => {
    const snapshot = mapSabreGetBookingForDisplay({
      futureTicketingPolicy: { ticketingDate: '2026-10-18' },
      creationDetails: { purchaseDeadlineDate: '2026-10-20', purchaseDeadlineTime: '15:00' },
    });
    expect(snapshot.view.ticketingDeadline).toEqual({ date: '2026-10-18', zone: 'PROVIDER_LOCAL' });
  });

  it('una política sin fecha (sólo el PCC de emisión) no es un plazo', () => {
    const snapshot = mapSabreGetBookingForDisplay({
      futureTicketingPolicy: { ticketingPcc: 'G7RE', comment: 'TICKET BEFORE TUES' },
    });
    expect(snapshot.view).not.toHaveProperty('ticketingDeadline');
    // Ni el comentario (texto libre) ni el PCC salen en la vista.
    expect(JSON.stringify(snapshot)).not.toContain('TICKET BEFORE TUES');
    expect(JSON.stringify(snapshot)).not.toContain('G7RE');
  });

  it.each([
    [{ ticketingDate: '2026-02-30' }, 'una fecha que no existe'],
    [{ ticketingDate: '30/10/2026' }, 'otro formato'],
    [{ ticketingDate: 20261030 }, 'un número'],
    ['2026-10-30', 'el bloque no es un objeto'],
  ])(
    '%j no es un plazo (%s) y se avisa, sin tumbar la lectura',
    (policy: unknown, motivo: string) => {
      const snapshot = mapSabreGetBookingForDisplay({
        bookingId: 'GLEBNY',
        futureTicketingPolicy: policy,
      });
      expect(snapshot.view, motivo).not.toHaveProperty('ticketingDeadline');
      expect(snapshot.warnings).toContain('ticketing-deadline-malformed');
      expect(snapshot.view.orderId).toBe('GLEBNY');
    },
  );

  it('una hora ilegible se pierde sola: el día sigue valiendo', () => {
    const snapshot = mapSabreGetBookingForDisplay({
      futureTicketingPolicy: { ticketingDate: '2026-10-30', ticketingTime: '24:00' },
    });
    expect(snapshot.view.ticketingDeadline).toEqual({ date: '2026-10-30', zone: 'PROVIDER_LOCAL' });
    expect(snapshot.warnings).toContain('ticketing-deadline-malformed');
  });
});
