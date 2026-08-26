import { describe, expect, it } from 'vitest';
import {
  SABRE_ACL_ISSUE_CATEGORY,
  SABRE_CREATE_RETURNS_BOOKING_SIGNATURE,
  SabreCreateBookingMapError,
  classifyItemStatus,
  mapSabreCreateBookingResponse,
  resolveOutcome,
} from './create.response.mapper';

/**
 * La forma de las respuestas de este archivo sale del **ejemplo oficial** de `createBooking`
 * (`specs/help/booking-management-api-v1/help-documentation-create-booking-examples.txt:955`+) y
 * del contrato (`booking-management-v1.yml:804-829`, `Booking` en `:1053`, `Error` en `:4271`).
 */

/** Un pasaporte centinela: sirve para demostrar que el eco del request nunca sale del mapper. */
const PASSPORT = 'XZ9871PASAPORTE';

/** El eco íntegro del payload que Sabre devuelve en `request` (`:827`). Lleva PII. */
const REQUEST_ECHO = {
  travelers: [
    {
      givenName: 'JOHN',
      surname: 'KOWALSKI',
      birthDate: '1980-12-02',
      identityDocuments: [{ documentNumber: PASSPORT, documentType: 'PASSPORT' }],
    },
  ],
  contactInfo: { emails: ['TRAVEL@SABRE.COM'] },
};

function response(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: '2025-10-29T10:17:18',
    confirmationId: 'PYMUEZ',
    booking: { bookingId: 'PYMUEZ' },
    request: REQUEST_ECHO,
    ...overrides,
  };
}

function flight(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { itemId: 'ABC12', flightStatusCode: 'HK', ...over };
}

describe('desenlace de la creación', () => {
  it('con localizador, ítems confirmados y sin errores: CONFIRMED', () => {
    const mapped = mapSabreCreateBookingResponse(
      response({ booking: { bookingId: 'PYMUEZ', flights: [flight()] } }),
    );

    expect(mapped.order.outcome).toBe('CONFIRMED');
    expect(mapped.order.pnr).toBe('PYMUEZ');
    expect(mapped.order.orderId).toBe('PYMUEZ');
    expect(mapped.order.items).toEqual([
      { kind: 'flight', providerItemId: 'ABC12', status: 'CONFIRMED', statusCode: 'HK' },
    ]);
  });

  it('con localizador pero SIN ítems y sin errores: PENDING, no CONFIRMED', () => {
    // Es exactamente lo que produce un `asynchronousUpdateWaitTime` corto: la orden existe y la
    // respuesta llegó antes de que la redisplay se sincronizara. Se resuelve con getBooking, no
    // cancelando. El propio ejemplo oficial de respuesta viene sin `flights`.
    const mapped = mapSabreCreateBookingResponse(response());
    expect(mapped.order.outcome).toBe('PENDING');
    expect(mapped.order.items).toEqual([]);
  });

  it('un ítem rechazado por la aerolínea deja la orden en PARTIAL', () => {
    const mapped = mapSabreCreateBookingResponse(
      response({
        booking: {
          bookingId: 'PYMUEZ',
          flights: [flight(), flight({ itemId: 'DEF34', flightStatusCode: 'UC' })],
        },
      }),
    );

    expect(mapped.order.outcome).toBe('PARTIAL');
    expect(mapped.order.items[1]?.status).toBe('FAILED');
  });

  it('un ítem en NN (pedido y sin respuesta) deja la orden en PARTIAL, no en CONFIRMED', () => {
    const mapped = mapSabreCreateBookingResponse(
      response({ booking: { bookingId: 'PYMUEZ', flights: [flight({ flightStatusCode: 'NN' })] } }),
    );
    expect(mapped.order.outcome).toBe('PARTIAL');
    expect(mapped.order.items[0]?.status).toBe('UNCONFIRMED');
  });

  it('un error de negocio junto a la reserva creada es PARTIAL, nunca FAILED', () => {
    const mapped = mapSabreCreateBookingResponse(
      response({
        booking: { bookingId: 'PYMUEZ', flights: [flight()] },
        errors: [{ category: 'APPLICATION_ERROR', type: 'SEATS_OFFER_UNAVAILABLE' }],
      }),
    );
    expect(mapped.order.outcome).toBe('PARTIAL');
  });

  it('un WARNING no degrada una reserva por lo demás confirmada', () => {
    const mapped = mapSabreCreateBookingResponse(
      response({
        booking: { bookingId: 'PYMUEZ', flights: [flight()] },
        errors: [{ category: 'WARNING', type: 'EMAIL_NOT_FOUND' }],
      }),
    );
    expect(mapped.order.outcome).toBe('CONFIRMED');
    expect(mapped.order.issues[0]?.severity).toBe('WARNING');
  });

  it('sin localizador de ninguna clase: FAILED', () => {
    const mapped = mapSabreCreateBookingResponse({
      errors: [{ category: 'BAD_REQUEST', type: 'REQUIRED_FIELD_MISSING' }],
    });
    expect(mapped.order.outcome).toBe('FAILED');
    expect(mapped.order.pnr).toBeUndefined();
    expect(mapped.order.orderId).toBeUndefined();
  });

  it('un bookingId sin confirmationId sigue siendo un localizador: no es FAILED', () => {
    const mapped = mapSabreCreateBookingResponse({ booking: { bookingId: 'PYMUEZ' } });
    expect(mapped.order.outcome).toBe('PENDING');
    expect(mapped.order.orderId).toBe('PYMUEZ');
  });

  it('resolveOutcome es la única regla, y no depende del orden de los ítems', () => {
    const confirmed = { kind: 'flight', status: 'CONFIRMED' } as const;
    const failed = { kind: 'flight', status: 'FAILED' } as const;
    expect(resolveOutcome('PNR123', [confirmed, failed], [])).toBe('PARTIAL');
    expect(resolveOutcome('PNR123', [failed, confirmed], [])).toBe('PARTIAL');
    expect(resolveOutcome('', [confirmed], [])).toBe('FAILED');
  });
});

describe('estado por ítem', () => {
  it('el nombre del enum cerrado manda sobre el código', () => {
    expect(classifyItemStatus('XX', 'Confirmed')).toBe('CONFIRMED');
    expect(classifyItemStatus('HK', 'Cancelled')).toBe('FAILED');
  });

  it('los códigos confirmados están verificados en ejemplos oficiales del mismo objeto Booking', () => {
    for (const code of ['HK', 'GK', 'KK', 'YK']) {
      expect(classifyItemStatus(code, undefined)).toBe('CONFIRMED');
    }
  });

  it('los cuatro códigos de rechazo del contrato dan FAILED', () => {
    for (const code of ['NO', 'UC', 'US', 'UN']) {
      expect(classifyItemStatus(code, undefined)).toBe('FAILED');
    }
  });

  it('la lista de espera NO es un fallo: cancelarla sería tirar lo que aún podía confirmarse', () => {
    for (const code of ['UU', 'LL', 'HL']) {
      expect(classifyItemStatus(code, undefined)).toBe('UNCONFIRMED');
    }
  });

  it('un código desconocido no se asume confirmado ni fallido', () => {
    expect(classifyItemStatus('ZQ', undefined)).toBe('UNCONFIRMED');
    expect(classifyItemStatus(undefined, undefined)).toBe('UNCONFIRMED');
    expect(classifyItemStatus('  ', '  ')).toBe('UNCONFIRMED');
  });

  it('el código se normaliza a mayúsculas antes de clasificar', () => {
    expect(classifyItemStatus('hk', undefined)).toBe('CONFIRMED');
  });
});

describe('hotel, coche y claves ausentes', () => {
  it('cada producto se mapea con su propio código de estado y su kind', () => {
    const mapped = mapSabreCreateBookingResponse(
      response({
        booking: {
          bookingId: 'PYMUEZ',
          flights: [flight()],
          hotels: [{ itemId: 'H1', hotelStatusCode: 'HK' }],
          cars: [{ itemId: 'C1', carStatusCode: 'UC' }],
        },
      }),
    );

    expect(mapped.order.items.map((item) => item.kind)).toEqual(['flight', 'hotel', 'car']);
    expect(mapped.order.items[1]?.status).toBe('CONFIRMED');
    expect(mapped.order.items[2]?.status).toBe('FAILED');
  });

  it('las claves de producto pueden no existir y el mapper no revienta', () => {
    // Tras un reembolso, `flights` y `journeys` desaparecen del objeto mientras `allSegments`
    // sobrevive (docs/sabre/04 §6.2).
    const mapped = mapSabreCreateBookingResponse(
      response({ booking: { bookingId: 'PYMUEZ', allSegments: [{ itemId: 'S1' }] } }),
    );
    expect(mapped.order.items).toEqual([]);
    expect(mapped.order.outcome).toBe('PENDING');
  });

  it('un itemId numérico se normaliza a texto en vez de perder la unidad de cancelación', () => {
    const mapped = mapSabreCreateBookingResponse(
      response({
        booking: { bookingId: 'PYMUEZ', flights: [{ itemId: 12, flightStatusCode: 'HK' }] },
      }),
    );
    expect(mapped.order.items[0]?.providerItemId).toBe('12');
  });
});

describe('compensación', () => {
  it('sólo se puede cancelar lo que existe: los ítems fallidos quedan fuera', () => {
    const mapped = mapSabreCreateBookingResponse(
      response({
        booking: {
          bookingId: 'PYMUEZ',
          flights: [flight(), flight({ itemId: 'DEF34', flightStatusCode: 'UC' })],
        },
      }),
    );
    expect(mapped.order.compensation).toEqual({ cancellableItemIds: ['ABC12'] });
  });

  it('un ítem sin itemId no es cancelable y no aparece', () => {
    const mapped = mapSabreCreateBookingResponse(
      response({ booking: { bookingId: 'PYMUEZ', flights: [{ flightStatusCode: 'HK' }] } }),
    );
    expect(mapped.order.compensation).toBeUndefined();
  });

  it('sin nada cancelable el bloque se omite: un array vacío invita a un cancelAll ciego', () => {
    const mapped = mapSabreCreateBookingResponse(response());
    expect(mapped.order.compensation).toBeUndefined();
    expect('compensation' in mapped.order).toBe(false);
  });
});

describe('bookingSignature', () => {
  it('createBooking NO lo devuelve: revision sale vacío y hay que encadenar getBooking', () => {
    const mapped = mapSabreCreateBookingResponse(
      response({ booking: { bookingId: 'PYMUEZ', flights: [flight()] } }),
    );
    expect(mapped.hasBookingSignature).toBe(false);
    expect(SABRE_CREATE_RETURNS_BOOKING_SIGNATURE).toBe(false);
    expect(mapped.order.revision).toBeUndefined();
    expect('revision' in mapped.order).toBe(false);
  });

  it('ni siquiera se recoge si el proveedor lo mandara: el campo no está en el contrato', () => {
    const mapped = mapSabreCreateBookingResponse(
      response({ booking: { bookingId: 'PYMUEZ' }, bookingSignature: 'FIRMA-INVENTADA' }),
    );
    expect(JSON.stringify(mapped)).not.toContain('FIRMA-INVENTADA');
  });
});

describe('PII — el eco del request no sale de aquí', () => {
  it('nada de lo que Sabre devuelve en `request` aparece en el resultado', () => {
    const mapped = mapSabreCreateBookingResponse(
      response({ booking: { bookingId: 'PYMUEZ', flights: [flight()] } }),
    );
    const serialized = JSON.stringify(mapped);

    for (const value of [PASSPORT, 'KOWALSKI', '1980-12-02', 'TRAVEL@SABRE.COM']) {
      expect(serialized).not.toContain(value);
    }
  });

  it('el mensaje de una respuesta deforme nombra rutas y códigos, nunca valores', () => {
    const mapped = mapSabreCreateBookingResponse(
      response({ errors: [{ category: 'BAD_REQUEST' }] }),
    );
    const shape = mapped.order.issues.find((issue) => issue.category === SABRE_ACL_ISSUE_CATEGORY);
    expect(shape?.type).toBe('RESPONSE_SHAPE_UNEXPECTED');
    expect(JSON.stringify(mapped)).not.toContain(PASSPORT);
  });
});

describe('respuestas que no cumplen el contrato', () => {
  it('si la forma falla pero hay localizador, NO se pierde: PARTIAL con la incidencia dentro', () => {
    // Perder el confirmationId es perder la reserva: no hay idempotency key y getBooking se
    // direcciona por él (docs/sabre/04 §5.5).
    const mapped = mapSabreCreateBookingResponse({
      confirmationId: 'PYMUEZ',
      errors: 'esto debería ser un array',
    });

    expect(mapped.order.pnr).toBe('PYMUEZ');
    expect(mapped.order.outcome).toBe('PARTIAL');
    expect(mapped.order.issues[0]?.category).toBe(SABRE_ACL_ISSUE_CATEGORY);
    expect(mapped.order.issues[0]?.severity).toBe('ERROR');
  });

  it('la incidencia de forma NO se cuenta como categoría del proveedor', () => {
    const mapped = mapSabreCreateBookingResponse({ confirmationId: 'PYMUEZ', errors: 42 });
    const categories = mapped.order.issues.map((issue) => issue.category);
    expect(categories).not.toContain('BAD_REQUEST');
    expect(categories).not.toContain('APPLICATION_ERROR');
    expect(categories).not.toContain('EXTERNAL_SERVER_ERROR');
  });

  it('sin forma y sin localizador sí se lanza: no hay nada que perder', () => {
    expect(() => mapSabreCreateBookingResponse({ errors: 'roto' })).toThrow(
      SabreCreateBookingMapError,
    );
    expect(() => mapSabreCreateBookingResponse(null)).toThrow(SabreCreateBookingMapError);
    expect(() => mapSabreCreateBookingResponse('no soy un objeto')).toThrow(
      SabreCreateBookingMapError,
    );
  });

  it('un cuerpo vacío no es una reserva: FAILED, no excepción', () => {
    const mapped = mapSabreCreateBookingResponse({});
    expect(mapped.order.outcome).toBe('FAILED');
    expect(mapped.order.issues).toEqual([]);
  });
});

describe('errores del proveedor', () => {
  it('se mapean campo a campo, sin aplanar a texto', () => {
    const mapped = mapSabreCreateBookingResponse({
      errors: [
        {
          category: 'BAD_REQUEST',
          type: 'REQUIRED_FIELD_MISSING',
          description: 'may not be null',
          fieldPath: 'travelers[0].surname',
          fieldName: 'surname',
        },
      ],
    });

    expect(mapped.order.issues[0]).toEqual({
      severity: 'ERROR',
      category: 'BAD_REQUEST',
      type: 'REQUIRED_FIELD_MISSING',
      message: 'may not be null',
      fieldPath: 'travelers[0].surname',
      fieldName: 'surname',
    });
  });

  it('el ActionCode del servicio interno llega entero, sin recortar', () => {
    // `DOWNLINE_SERVICE_ERROR` incluye qué servicio interno reventó, y es lo único que permite
    // atribuir el fallo a un dominio de producto (docs/sabre/04 §6.4).
    const detail = 'The (OTA_AirBookLLSRQ) service returned an error: (code: [123] message: [x])';
    const mapped = mapSabreCreateBookingResponse({
      confirmationId: 'PYMUEZ',
      errors: [
        { category: 'APPLICATION_ERROR', type: 'DOWNLINE_SERVICE_ERROR', description: detail },
      ],
    });
    expect(mapped.order.issues[0]?.message).toBe(detail);
  });

  it('el timestamp del proveedor se pasa tal cual aunque venga sin Z', () => {
    const mapped = mapSabreCreateBookingResponse(response());
    expect(mapped.timestamp).toBe('2025-10-29T10:17:18');
  });
});

/**
 * El asiento — la mitad que se pedía y no se leía.
 *
 * Todo entra por {@link mapSabreCreateBookingResponse}, que es la puerta que usa el adapter con el
 * cuerpo crudo de `SabreHttpClient.postJson`. Ningún caso llama al clasificador de asiento por
 * dentro: una regla que sólo se puede probar desde dentro puede dejar de invocarse en producción
 * sin que ningún test se entere, que es el fallo que este paquete ya pagó seis veces.
 *
 * Forma tomada del contrato (`Seat` en `booking-management-v1.yml:2409-2444`, `flights[].seats[]`
 * en `:2027-2037`) y del ejemplo oficial `help-documentation-get-booking-examples.txt:336-349`.
 */
function seat(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { number: '13A', ...over };
}

/** Un vuelo confirmado con los asientos que se le pasen. El vuelo entra siempre; el asiento no. */
function withSeats(seats: readonly unknown[]): Record<string, unknown> {
  return response({
    booking: { bookingId: 'PYMUEZ', flights: [flight({ seats })] },
  });
}

describe('el asiento se pide y ahora también se lee', () => {
  it('el vuelo entra y el asiento no: PARTIAL, no CONFIRMED', () => {
    // `UC` = unable to confirm. Antes de leer `seats[]`, esta reserva salía CONFIRMED y el
    // pasajero descubría el asiento inexistente en el aeropuerto.
    const mapped = mapSabreCreateBookingResponse(
      withSeats([seat({ statusCode: 'UC', statusName: 'Unconfirmed' })]),
    );

    expect(mapped.order.outcome).toBe('PARTIAL');
    expect(mapped.order.items.map((item) => item.kind)).toEqual(['flight', 'seat']);
    expect(mapped.order.items[0]?.status).toBe('CONFIRMED');
    expect(mapped.order.items[1]?.status).toBe('FAILED');
  });

  it('el asiento denegado NO entra en la compensación: el contrato no le da itemId', () => {
    // `Seat` declara `number`, `characteristics`, `statusCode` y `statusName`, y nada más. Colar
    // aquí el `itemId` del vuelo sería cancelar el vuelo porque falló el asiento.
    const mapped = mapSabreCreateBookingResponse(withSeats([seat({ statusCode: 'UC' })]));

    expect(mapped.order.compensation).toEqual({ cancellableItemIds: ['ABC12'] });
    expect(mapped.order.items[1]?.providerItemId).toBeUndefined();
  });

  it('el número de asiento no sale del mapper: nadie lo confunde con una clave de cancelación', () => {
    const mapped = mapSabreCreateBookingResponse(
      withSeats([seat({ number: '13A', statusCode: 'UC' })]),
    );
    expect(JSON.stringify(mapped)).not.toContain('13A');
  });

  it('CONTRAPESO: un asiento asignado no degrada nada', () => {
    const mapped = mapSabreCreateBookingResponse(
      withSeats([seat({ statusCode: 'HK', statusName: 'Confirmed' })]),
    );

    expect(mapped.order.outcome).toBe('CONFIRMED');
    expect(mapped.order.items[1]).toEqual({
      kind: 'seat',
      status: 'CONFIRMED',
      statusCode: 'HK',
      message: 'Confirmed',
    });
  });

  it('CONTRAPESO: el asiento del ejemplo oficial (HD/Unknown) tampoco degrada', () => {
    // `help-documentation-get-booking-examples.txt:336-349` — un asiento efectivamente asignado
    // llega con un código que no está en ninguna de nuestras listas. Con el default de vuelo
    // saldría UNCONFIRMED, la orden caería a PARTIAL y el saga compensaría: el pasajero perdería
    // el vuelo por culpa de un asiento que sí tenía.
    const mapped = mapSabreCreateBookingResponse(
      withSeats([seat({ number: '2C', statusCode: 'HD', statusName: 'Unknown' })]),
    );

    expect(mapped.order.outcome).toBe('CONFIRMED');
    expect(mapped.order.items[1]?.status).toBe('CONFIRMED');
  });

  it('los nombres del enum cerrado que NIEGAN el asiento dan FAILED', () => {
    for (const statusName of ['Cancelled', 'No Seat']) {
      const mapped = mapSabreCreateBookingResponse(withSeats([seat({ statusName })]));
      expect(mapped.order.items[1]?.status, statusName).toBe('FAILED');
      expect(mapped.order.outcome, statusName).toBe('PARTIAL');
    }
  });

  it('los nombres que dicen «pedido pero no retenido» dan UNCONFIRMED, que no es un rechazo', () => {
    for (const statusName of [
      'Waitlisted',
      'Priority Waitlist',
      'Standby',
      'On Request',
      'Pending',
      'Unconfirmed',
    ]) {
      const mapped = mapSabreCreateBookingResponse(withSeats([seat({ statusName })]));
      expect(mapped.order.items[1]?.status, statusName).toBe('UNCONFIRMED');
      expect(mapped.order.outcome, statusName).toBe('PARTIAL');
    }
  });

  it('`Infant/No Seat` NO es un asiento denegado: es un infante en brazos', () => {
    const mapped = mapSabreCreateBookingResponse(
      withSeats([seat({ statusName: 'Infant/No Seat' })]),
    );
    expect(mapped.order.outcome).toBe('CONFIRMED');
  });

  it('un nombre que niega el asiento manda sobre un código que lo confirma', () => {
    const mapped = mapSabreCreateBookingResponse(
      withSeats([seat({ statusCode: 'HK', statusName: 'Cancelled' })]),
    );
    expect(mapped.order.items[1]?.status).toBe('FAILED');
  });

  it('un RECHAZO no se ablanda con el nombre genérico que Sabre deriva de él', () => {
    // Sabre describe `UC` como `'Unconfirmed'`. Si el nombre ganara, un asiento DENEGADO se
    // contaría como «todavía puede confirmarse» y nadie volvería a mirarlo.
    const mapped = mapSabreCreateBookingResponse(
      withSeats([seat({ statusCode: 'UC', statusName: 'Unconfirmed' })]),
    );
    expect(mapped.order.items[1]?.status).toBe('FAILED');
  });

  it('los códigos de rechazo del contrato degradan, y el código se normaliza a mayúsculas', () => {
    for (const statusCode of ['NO', 'uc', 'US', 'UN']) {
      const mapped = mapSabreCreateBookingResponse(withSeats([seat({ statusCode })]));
      expect(mapped.order.items[1]?.status, statusCode).toBe('FAILED');
    }
  });

  it('los huecos que declara el contrato no son ítems: `null` y el Seat vacío', () => {
    // `:2029-2032` — "an empty Seat object or a null value indicates that no seat is assigned to
    // the corresponding traveler". Contarlos degradaría toda reserva sin asiento pedido.
    const mapped = mapSabreCreateBookingResponse(withSeats([null, {}]));

    expect(mapped.order.items.map((item) => item.kind)).toEqual(['flight']);
    expect(mapped.order.outcome).toBe('CONFIRMED');
  });

  it('un asiento ilegible no tumba el sobre: el itinerario sobrevive', () => {
    // Sin la tolerancia del schema, esta respuesta caería en el rescate del localizador, que
    // descarta TODOS los ítems —el vuelo incluido— y devuelve una orden sin nada que compensar.
    const mapped = mapSabreCreateBookingResponse(withSeats(['13A']));

    expect(mapped.order.outcome).toBe('CONFIRMED');
    expect(mapped.order.items).toEqual([
      { kind: 'flight', providerItemId: 'ABC12', status: 'CONFIRMED', statusCode: 'HK' },
    ]);
  });

  it('cada asiento va pegado a SU vuelo: sin itemId, la posición es lo único que los ata', () => {
    const mapped = mapSabreCreateBookingResponse(
      response({
        booking: {
          bookingId: 'PYMUEZ',
          flights: [
            flight({ seats: [seat({ statusCode: 'UC' })] }),
            flight({ itemId: 'DEF34', seats: [seat({ statusCode: 'HK' })] }),
          ],
        },
      }),
    );

    expect(mapped.order.items.map((item) => item.kind)).toEqual([
      'flight',
      'seat',
      'flight',
      'seat',
    ]);
    expect(mapped.order.items[1]?.status).toBe('FAILED');
    expect(mapped.order.items[3]?.status).toBe('CONFIRMED');
  });

  it('`changeOfGaugeSeats` NO se lee, porque el builder tampoco lo pide', () => {
    // Las dos mitades se mueven juntas. Este caso existe para que quien añada el carril al
    // builder se encuentre el test rojo y añada también la lectura, en vez de repetir la
    // asimetría que este bloque acaba de cerrar.
    const mapped = mapSabreCreateBookingResponse(
      response({
        booking: {
          bookingId: 'PYMUEZ',
          flights: [flight({ changeOfGaugeSeats: [seat({ statusCode: 'UC' })] })],
        },
      }),
    );

    expect(mapped.order.items.map((item) => item.kind)).toEqual(['flight']);
    expect(mapped.order.outcome).toBe('CONFIRMED');
  });
});
