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
