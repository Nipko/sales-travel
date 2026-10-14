import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  OrderModifyRejectedError,
  type OrderModifyRef,
  type TravelerChange,
} from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import { SABRE_EXTRA_FEATURES } from './get.request.builder';
import {
  SABRE_MODIFY_BOOKING_PATH,
  SabreModifyBookingBuildError,
  buildSabreModifyBookingRequest,
  describeSabreModifyBookingRequest,
  parseSabreTravelerChanges,
  type SabreModifyBookingInput,
} from './modify.request.builder';

/**
 * El `before`/`after` de `modifyBooking` (SAB-25, RF-17 CA-3): un documento entero sacado de la
 * lectura fresca, nunca un PATCH. La reserva leída es la del ejemplo OFICIAL de pasaporte ATPCO
 * (`help-documentation-modify-booking-examples-0.txt`, «modify identity document details
 * (PASSPORT)»): su `booking` de respuesta con la firma de su request, que es la forma de un
 * `getBooking` sin `returnOnly`.
 */

type Json = Record<string, unknown>;
const BACKSLASH = String.fromCharCode(92);

function findRepoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('no se encontró la raíz del monorepo');
    dir = parent;
  }
}

/** El primer bloque JSON del texto oficial después de `section` y de `label`. */
function officialBlock(section: string, label: string): Json {
  const text = readFileSync(
    join(
      findRepoRoot(),
      'docs',
      'sabre',
      'evidence',
      'specs',
      'help',
      'booking-management-api-v1',
      'help-documentation-modify-booking-examples-0.txt',
    ),
    'utf8',
  );
  const from = text.indexOf(section);
  if (from < 0) throw new Error(`no está la sección «${section}»`);
  const start = text.indexOf('{', text.indexOf(label, from));
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === BACKSLASH) i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1)) as Json;
    }
  }
  throw new Error(`bloque JSON sin cerrar tras «${label}»`);
}

const PASSPORT_SECTION = 'modify identity document details (PASSPORT)';
const PASSPORT_RESPONSE = 'The expected response is presented by the following snippet:';

/** `getBooking` sin `returnOnly`: la reserva del ejemplo oficial con su firma. */
function officialRead(): Json {
  const response = officialBlock(PASSPORT_SECTION, PASSPORT_RESPONSE);
  const request = response['request'] as Json;
  return {
    ...(response['booking'] as Json),
    bookingSignature: request['bookingSignature'],
    timestamp: response['timestamp'],
  };
}

const SIGNATURE_OF_READ = (officialRead()['bookingSignature'] as string) ?? '';
const PASSENGERS: OrderModifyRef['passengers'] = [{ paxType: 'ADT', surname: 'Doe', gender: 'M' }];

const NEW_PASSPORT: NonNullable<TravelerChange['identityDocument']> = {
  type: 'PASSPORT',
  number: 'AB1234567',
  issuingCountry: 'CO',
  nationality: 'CO',
  expiryDate: '2034-05-31',
};

function input(
  changes: readonly TravelerChange[],
  extra: Partial<SabreModifyBookingInput> = {},
): SabreModifyBookingInput {
  return {
    confirmationId: 'OFGBRU',
    signature: SIGNATURE_OF_READ,
    booking: officialRead(),
    changes,
    passengers: PASSENGERS,
    receivedFrom: 'PLANETOUR',
    ...extra,
  };
}

function refusal(run: () => unknown): SabreModifyBookingBuildError {
  try {
    run();
  } catch (error) {
    if (error instanceof SabreModifyBookingBuildError) return error;
    throw error;
  }
  throw new Error('se esperaba SabreModifyBookingBuildError');
}

function travelerOf(booking: unknown, index = 0): Json {
  return ((booking as Json)['travelers'] as Json[])[index] as Json;
}

describe('before/after: un documento entero sobre la lectura fresca, nunca un PATCH', () => {
  it('before ES la lectura: todos los pasajeros y todos los SSR, con todos sus campos', () => {
    const read = officialRead();
    const plan = buildSabreModifyBookingRequest(
      input([{ index: 0, identityDocument: NEW_PASSPORT }]),
    );
    const request = plan.request;
    if (request === undefined) throw new Error('se esperaba un cuerpo');
    expect(request.before.travelers).toEqual(read['travelers']);
    expect(request.before.specialServices).toEqual(read['specialServices']);
  });

  it('after es la misma lectura con SÓLO el documento cambiado: nada se borra por omisión', () => {
    const read = officialRead();
    const plan = buildSabreModifyBookingRequest(
      input([{ index: 0, identityDocument: NEW_PASSPORT }]),
    );
    const request = plan.request;
    if (request === undefined) throw new Error('se esperaba un cuerpo');

    // Los SSR —el DOCS automático y el OTHS de la aerolínea— van idénticos.
    expect(request.after.specialServices).toEqual(read['specialServices']);

    // Todo el pasajero menos sus documentos, idéntico.
    const { identityDocuments: afterDocs, ...afterRest } = travelerOf(request.after);
    const { identityDocuments: readDocs, ...readRest } = travelerOf(read);
    expect(afterRest).toEqual(readRest);

    // El documento: lo pedido, más todo lo que la reserva sabía de él y el cambio no toca.
    const before = (readDocs as Json[])[0] as Json;
    const after = (afterDocs as Json[])[0] as Json;
    expect(after).toEqual({
      ...before,
      documentNumber: 'AB1234567',
      issuingCountryCode: 'CO',
      citizenshipCountryCode: 'CO',
      expiryDate: '2034-05-31',
      // El titular es el pasajero de la reserva, no lo que el vendedor teclee.
      givenName: 'JOHN',
      surname: 'DOE',
    });
    expect(after['itemId']).toBe(before['itemId']);
    expect(after['isPrimaryDocumentHolder']).toBe(false);
    expect(plan.changed).toEqual([{ index: 0, field: 'identityDocuments' }]);
  });

  it('sólo las dos secciones de BookingToModify que se cambian; nunca contactInfo ni travelersGroup', () => {
    const plan = buildSabreModifyBookingRequest(
      input([{ index: 0, identityDocument: NEW_PASSPORT }]),
    );
    const request = plan.request;
    if (request === undefined) throw new Error('se esperaba un cuerpo');
    expect(Object.keys(request.before).sort()).toEqual(['specialServices', 'travelers']);
    expect(Object.keys(request.after).sort()).toEqual(['specialServices', 'travelers']);
    expect(Object.keys(request).sort()).toEqual([
      'after',
      'before',
      'bookingSignature',
      'bookingSource',
      'confirmationId',
      'extraFeatures',
      'receivedFrom',
      'retrieveBooking',
    ]);
    const wire = JSON.stringify(request);
    expect(wire).not.toContain('contactInfo');
    expect(wire).not.toContain('travelersGroup');
    expect(wire).not.toContain('unmaskPaymentCardNumbers');
    expect(wire).not.toContain('returnOnly');
  });

  it('la firma y el perfil son los de la lectura: las tres banderas comunes, con sus valores', () => {
    const plan = buildSabreModifyBookingRequest(
      input([{ index: 0, identityDocument: NEW_PASSPORT }]),
    );
    const request = plan.request;
    if (request === undefined) throw new Error('se esperaba un cuerpo');
    expect(request.bookingSignature).toBe(SIGNATURE_OF_READ);
    expect(request.extraFeatures).toEqual({
      returnFrequentRenter: SABRE_EXTRA_FEATURES.returnFrequentRenter,
      returnWalletFormsOfPayment: SABRE_EXTRA_FEATURES.returnWalletFormsOfPayment,
      returnFiscalId: SABRE_EXTRA_FEATURES.returnFiscalId,
    });
    expect(request.retrieveBooking).toBe(true);
    expect(request.receivedFrom).toBe('PLANETOUR');
    expect(request.bookingSource).toBe('SABRE');
  });

  it('no toca la lectura: before y after no comparten objetos con ella', () => {
    const read = officialRead();
    const snapshot = JSON.stringify(read);
    const plan = buildSabreModifyBookingRequest(
      input([{ index: 0, identityDocument: NEW_PASSPORT, specialServices: ['WCHR'] }], {
        booking: read,
      }),
    );
    expect(JSON.stringify(read)).toBe(snapshot);
    expect(plan.request?.before.travelers[0]).not.toBe(plan.request?.after.travelers[0]);
  });

  it('una reserva que ya tiene lo pedido no manda nada (NO_CHANGES_FOUND quemaría la transacción)', () => {
    const plan = buildSabreModifyBookingRequest(
      input([
        {
          index: 0,
          identityDocument: {
            type: 'PASSPORT',
            number: '987765452',
            issuingCountry: 'US',
            nationality: 'US',
            expiryDate: '2024-07-09',
          },
        },
      ]),
    );
    // El ejemplo no trae `citizenshipCountryCode`: agregarlo SÍ es un cambio.
    expect(plan.request).toBeDefined();

    const already = officialRead();
    const doc = (travelerOf(already)['identityDocuments'] as Json[])[0] as Json;
    doc['citizenshipCountryCode'] = 'US';
    const again = buildSabreModifyBookingRequest(
      input(
        [
          {
            index: 0,
            identityDocument: {
              type: 'PASSPORT',
              number: '987765452',
              issuingCountry: 'US',
              nationality: 'US',
              expiryDate: '2024-07-09',
            },
          },
        ],
        { booking: already },
      ),
    );
    expect(again.request).toBeUndefined();
    expect(again.changed).toEqual([]);
    expect(again.requested).toEqual([{ index: 0, field: 'identityDocuments' }]);
  });

  it('un número nuevo no hereda la fecha de emisión del anterior; el mismo número sí', () => {
    const read = officialRead();
    const doc = (travelerOf(read)['identityDocuments'] as Json[])[0] as Json;
    doc['issueDate'] = '2014-07-09';
    const nuevo = buildSabreModifyBookingRequest(
      input([{ index: 0, identityDocument: NEW_PASSPORT }], { booking: read }),
    );
    const afterNew = (travelerOf(nuevo.request?.after)['identityDocuments'] as Json[])[0];
    expect(afterNew).not.toHaveProperty('issueDate');

    const mismo = buildSabreModifyBookingRequest(
      input([{ index: 0, identityDocument: { ...NEW_PASSPORT, number: '987765452' } }], {
        booking: read,
      }),
    );
    const afterSame = (travelerOf(mismo.request?.after)['identityDocuments'] as Json[])[0];
    expect(afterSame).toHaveProperty('issueDate', '2014-07-09');
  });

  it('una cédula se agrega junto al pasaporte, con la forma de la creación', () => {
    const plan = buildSabreModifyBookingRequest(
      input([
        {
          index: 0,
          identityDocument: {
            type: 'NATIONAL_ID',
            number: '1020304050',
            issuingCountry: 'CO',
            nationality: 'CO',
            expiryDate: '2040-01-01',
            birthDate: '1970-01-23',
          },
        },
      ]),
    );
    const docs = travelerOf(plan.request?.after)['identityDocuments'] as Json[];
    expect(docs).toHaveLength(2);
    expect(docs[0]).toEqual((travelerOf(officialRead())['identityDocuments'] as Json[])[0]);
    expect(docs[1]).toEqual({
      documentType: 'NATIONAL_ID_CARD',
      documentNumber: '1020304050',
      issuingCountryCode: 'CO',
      residenceCountryCode: 'CO',
      citizenshipCountryCode: 'CO',
      expiryDate: '2040-01-01',
      givenName: 'JOHN',
      surname: 'DOE',
      birthDate: '1970-01-23',
      gender: 'MALE',
    });
  });
});

describe('viajero frecuente', () => {
  it('se agrega el programa de esa aerolínea y los demás quedan', () => {
    const read = officialRead();
    travelerOf(read)['loyaltyPrograms'] = [
      {
        supplierCode: 'BA',
        programType: 'FREQUENT_FLYER',
        programNumber: '7654325643',
        tierLevel: 1,
      },
    ];
    const plan = buildSabreModifyBookingRequest(
      input([{ index: 0, loyalty: { carrierCode: 'AV', number: '12345678901' } }], {
        booking: read,
      }),
    );
    expect(travelerOf(plan.request?.after)['loyaltyPrograms']).toEqual([
      {
        supplierCode: 'BA',
        programType: 'FREQUENT_FLYER',
        programNumber: '7654325643',
        tierLevel: 1,
      },
      { supplierCode: 'AV', programNumber: '12345678901' },
    ]);
  });

  it('el número de la misma aerolínea se reemplaza y pierde el nivel del número viejo', () => {
    const read = officialRead();
    travelerOf(read)['loyaltyPrograms'] = [
      {
        supplierCode: 'BA',
        programType: 'FREQUENT_FLYER',
        programNumber: '7654325643',
        tierLevel: 3,
        receiverCode: 'BA',
      },
    ];
    const plan = buildSabreModifyBookingRequest(
      input([{ index: 0, loyalty: { carrierCode: 'BA', number: '99887766' } }], { booking: read }),
    );
    expect(travelerOf(plan.request?.after)['loyaltyPrograms']).toEqual([
      {
        supplierCode: 'BA',
        programType: 'FREQUENT_FLYER',
        programNumber: '99887766',
        receiverCode: 'BA',
      },
    ]);
    expect(travelerOf(plan.request?.before)['loyaltyPrograms']).toEqual(
      travelerOf(read)['loyaltyPrograms'],
    );
  });

  it('un infante no lleva viajero frecuente: se rechaza antes de salir', () => {
    const read = officialRead();
    travelerOf(read)['passengerCode'] = 'INF';
    const error = refusal(() =>
      buildSabreModifyBookingRequest(
        input([{ index: 0, loyalty: { carrierCode: 'AV', number: '12345678' } }], {
          booking: read,
          passengers: [{ paxType: 'INF', surname: 'Doe' }],
        }),
      ),
    );
    expect(error.rule).toBe('INFANT_LOYALTY');
    expect(error.code).toBe('INVALID_CHANGE');
  });
});

describe('servicios especiales: lista cerrada, por pasajero, sin tocar los demás SSR', () => {
  it('pedir una silla de ruedas la agrega para ese pasajero y deja el DOCS y el OTHS', () => {
    const read = officialRead();
    const plan = buildSabreModifyBookingRequest(input([{ index: 0, specialServices: ['WCHR'] }]));
    expect(plan.request?.after.specialServices).toEqual([
      ...(read['specialServices'] as Json[]),
      { code: 'WCHR', travelerIndices: [1] },
    ]);
    expect(plan.request?.after.travelers).toEqual(read['travelers']);
    expect(plan.changed).toEqual([{ index: 0, field: 'specialServices' }]);
  });

  it('el conjunto pedido reemplaza al de la lista: lo que no está se quita, lo demás queda', () => {
    const read = officialRead();
    read['specialServices'] = [
      ...(read['specialServices'] as Json[]),
      { code: 'VGML', travelerIndices: [1], statusCode: 'HK', statusName: 'Confirmed' },
      { code: 'WCHR', travelerIndices: [1], statusCode: 'NN' },
    ];
    const plan = buildSabreModifyBookingRequest(
      input([{ index: 0, specialServices: ['WCHR', 'DBML'] }], { booking: read }),
    );
    expect(plan.request?.after.specialServices).toEqual([
      ...(officialRead()['specialServices'] as Json[]),
      { code: 'WCHR', travelerIndices: [1], statusCode: 'NN' },
      { code: 'DBML', travelerIndices: [1] },
    ]);
  });

  it('[] quita los de la lista y nada más', () => {
    const read = officialRead();
    read['specialServices'] = [
      ...(read['specialServices'] as Json[]),
      { code: 'MOML', travelerIndices: [1] },
    ];
    const plan = buildSabreModifyBookingRequest(
      input([{ index: 0, specialServices: [] }], { booking: read }),
    );
    expect(plan.request?.after.specialServices).toEqual(officialRead()['specialServices']);
  });

  it('uno de la lista pedido para dos pasajeros a la vez no se quita sólo para uno', () => {
    const read = officialRead();
    const second = { ...travelerOf(read), givenName: 'JANE' };
    read['travelers'] = [travelerOf(read), second];
    read['specialServices'] = [{ code: 'VGML', travelerIndices: [1, 2] }];
    const error = refusal(() =>
      buildSabreModifyBookingRequest(
        input([{ index: 0, specialServices: [] }], {
          booking: read,
          passengers: [...PASSENGERS, { paxType: 'ADT', surname: 'Doe', gender: 'F' }],
        }),
      ),
    );
    expect(error.rule).toBe('SPECIAL_SERVICE_SHARED');
    expect(error.code).toBe('SHARED_SPECIAL_SERVICE');
  });

  it('una reserva NDC (o sin carril conocido) no cambia servicios especiales por aquí', () => {
    const ndc = officialRead();
    ((ndc['flights'] as Json[])[0] as Json)['sourceType'] = 'NDC';
    expect(
      refusal(() =>
        buildSabreModifyBookingRequest(
          input([{ index: 0, specialServices: ['WCHR'] }], { booking: ndc }),
        ),
      ).rule,
    ).toBe('SPECIAL_SERVICES_NOT_SUPPORTED');

    const unknown = officialRead();
    delete ((unknown['flights'] as Json[])[0] as Json)['sourceType'];
    expect(
      refusal(() =>
        buildSabreModifyBookingRequest(
          input([{ index: 0, specialServices: ['WCHR'] }], { booking: unknown }),
        ),
      ).code,
    ).toBe('NOT_SUPPORTED_FOR_CONTENT');
    // Con el carril que declaró la orden, sí.
    expect(
      buildSabreModifyBookingRequest(
        input([{ index: 0, specialServices: ['WCHR'] }], {
          booking: unknown,
          contentSource: 'ATPCO',
        }),
      ).request,
    ).toBeDefined();
    // El documento sí se cambia en NDC.
    expect(
      buildSabreModifyBookingRequest(
        input([{ index: 0, identityDocument: NEW_PASSPORT }], { booking: ndc }),
      ).request,
    ).toBeDefined();
  });
});

describe('lo que se rechaza antes del cable', () => {
  it('los pasajeros de la orden tienen que ser los de la reserva', () => {
    expect(
      refusal(() =>
        buildSabreModifyBookingRequest(
          input([{ index: 0, identityDocument: NEW_PASSPORT }], {
            passengers: [{ paxType: 'ADT', surname: 'Pérez' }],
          }),
        ),
      ).rule,
    ).toBe('TRAVELER_SURNAME_MISMATCH');
    expect(
      refusal(() =>
        buildSabreModifyBookingRequest(
          input([{ index: 0, identityDocument: NEW_PASSPORT }], {
            passengers: [...PASSENGERS, { paxType: 'ADT', surname: 'Doe' }],
          }),
        ),
      ).code,
    ).toBe('TRAVELER_MISMATCH');
    expect(
      refusal(() =>
        buildSabreModifyBookingRequest(
          input([{ index: 0, identityDocument: NEW_PASSPORT }], {
            passengers: [{ paxType: 'INF', surname: 'Doe' }],
          }),
        ),
      ).rule,
    ).toBe('TRAVELER_TYPE_MISMATCH');
    // Las tildes y las mayúsculas no hacen a otra persona.
    const read = officialRead();
    travelerOf(read)['surname'] = 'PEREZ';
    expect(
      buildSabreModifyBookingRequest(
        input([{ index: 0, identityDocument: NEW_PASSPORT }], {
          booking: read,
          passengers: [{ paxType: 'ADT', surname: 'Pérez' }],
        }),
      ).request,
    ).toBeDefined();
  });

  it.each([
    ['número con separadores', { ...NEW_PASSPORT, number: 'AB-123.456' }],
    ['número en minúsculas', { ...NEW_PASSPORT, number: 'ab1234567' }],
    ['número con espacios', { ...NEW_PASSPORT, number: 'AB 1234567' }],
    ['país de tres letras', { ...NEW_PASSPORT, issuingCountry: 'COL' }],
    ['vencimiento imposible', { ...NEW_PASSPORT, expiryDate: '2034-02-30' }],
    ['tipo que no se edita', { ...NEW_PASSPORT, type: 'VISA' }],
  ])('documento inválido: %s', (_label, identityDocument) => {
    const error = refusal(() =>
      buildSabreModifyBookingRequest(
        input([
          { index: 0, identityDocument: identityDocument as TravelerChange['identityDocument'] },
        ]),
      ),
    );
    expect(error.rule).toBe('CHANGES_INVALID');
    // El mensaje nombra la ruta, nunca el valor.
    expect(error.message).not.toContain('AB');
    expect(error.message).not.toContain('1234567');
  });

  it.each([
    ['un SSR fuera de la lista', ['XBAG']],
    ['texto libre como código', ['WCHR/OSI TEXT']],
    ['repetido', ['WCHR', 'WCHR']],
  ])('servicio especial inválido: %s', (_label, specialServices) => {
    expect(
      refusal(() =>
        buildSabreModifyBookingRequest(
          input([
            { index: 0, specialServices: specialServices as TravelerChange['specialServices'] },
          ]),
        ),
      ).rule,
    ).toBe('CHANGES_INVALID');
  });

  it('campos de más, pasajeros repetidos o fuera de la orden, y cambios vacíos', () => {
    const extra = {
      index: 0,
      identityDocument: NEW_PASSPORT,
      contactInfo: {},
    } as unknown as TravelerChange;
    expect(() => parseSabreTravelerChanges([extra], 1)).toThrow(SabreModifyBookingBuildError);
    expect(() =>
      parseSabreTravelerChanges(
        [
          { index: 0, specialServices: ['WCHR'] },
          { index: 0, specialServices: ['VGML'] },
        ],
        1,
      ),
    ).toThrow(/CHANGES_INVALID/);
    expect(() => parseSabreTravelerChanges([{ index: 1, specialServices: [] }], 1)).toThrow(
      /no está en la orden/,
    );
    expect(() => parseSabreTravelerChanges([{ index: 0 }], 1)).toThrow(/CHANGES_INVALID/);
    expect(() => parseSabreTravelerChanges([], 1)).toThrow(/CHANGES_INVALID/);
  });

  it('sin firma, sin pasajeros o con un localizador fuera de contrato no se arma nada', () => {
    expect(
      refusal(() =>
        buildSabreModifyBookingRequest(
          input([{ index: 0, specialServices: [] }], { signature: '' }),
        ),
      ).rule,
    ).toBe('SIGNATURE_ABSENT');
    const empty = officialRead();
    delete empty['travelers'];
    expect(
      refusal(() =>
        buildSabreModifyBookingRequest(
          input([{ index: 0, specialServices: [] }], { booking: empty }),
        ),
      ).rule,
    ).toBe('TRAVELERS_ABSENT');
    expect(
      refusal(() =>
        buildSabreModifyBookingRequest(
          input([{ index: 0, specialServices: [] }], { confirmationId: 'abc' }),
        ),
      ).rule,
    ).toBe('CONFIRMATION_ID_INVALID');
  });

  it('el error es un OrderModifyRejectedError del dominio: la API lo traduce sin conocer a Sabre', () => {
    const error = refusal(() =>
      buildSabreModifyBookingRequest(input([{ index: 0, specialServices: ['XBAG' as 'WCHR'] }])),
    );
    expect(error).toBeInstanceOf(OrderModifyRejectedError);
  });
});

describe('la línea de log', () => {
  it('nombra la forma del cambio, nunca valores: ni localizador, ni firma, ni nombres, ni números', () => {
    const plan = buildSabreModifyBookingRequest(
      input([
        {
          index: 0,
          identityDocument: NEW_PASSPORT,
          loyalty: { carrierCode: 'AV', number: '55667788' },
          specialServices: ['DBML'],
        },
      ]),
    );
    const request = plan.request;
    if (request === undefined) throw new Error('se esperaba un cuerpo');
    const line = JSON.stringify(describeSabreModifyBookingRequest(request, plan.changed));
    for (const secret of [
      'OFGBRU',
      SIGNATURE_OF_READ,
      'JOHN',
      'DOE',
      'AB1234567',
      '987765452',
      '55667788',
      'DBML',
    ]) {
      expect(line).not.toContain(secret);
    }
    expect(JSON.parse(line)).toMatchObject({
      operation: SABRE_MODIFY_BOOKING_PATH,
      travelers: 1,
      fields: ['identityDocuments', 'loyalty', 'specialServices'],
    });
  });
});
