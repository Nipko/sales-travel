import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HotelRoomOccupancy } from '@sales-travel/canonical';
import type { HotelBookingContact, HotelBookingRoomGuests, HotelGuest } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import { TboRequestBuildError } from '../errors';
import {
  TBO_BOOK_LIMITS,
  TboBookRequestSchema,
  buildTboBookRequest,
  checkTboBookGuests,
  normalizeTboGuestName,
  type TboBookInput,
} from './book.request.builder';

/**
 * El builder del Book (docs/tbo/03 §3; 08 RF-18 CA 2 a 4, RF-19, RF-20 CA-6; BK-01 a BK-05).
 */

const FIXTURES = join(__dirname, '..', '__fixtures__');
const BOOK_812 = JSON.parse(
  readFileSync(join(FIXTURES, 'pdf', 'book-request-limit-multi-room.p35.json'), 'utf8'),
) as Record<string, unknown>;

const REFERENCE = 'STT7K2M9QX4D8R1VZ6AB';
const CONTACT: HotelBookingContact = {
  email: 'reservas@agencia.example',
  phone: { countryCode: '+57', number: '300 123 4567' },
};

function adult(firstName: string, lastName: string, title: HotelGuest['title'] = 'Mr'): HotelGuest {
  return { paxType: 'ADT', title, firstName, lastName };
}

function child(firstName: string, lastName: string, age = 7): HotelGuest {
  return { paxType: 'CHD', title: 'Ms', firstName, lastName, age };
}

const TWO_ADULT_ROOMS: HotelRoomOccupancy[] = [
  { adults: 1, childrenAges: [] },
  { adults: 1, childrenAges: [] },
];

function input(overrides: Partial<TboBookInput> = {}): TboBookInput {
  return {
    bookingCode: '1120548!TB!4!TB!8bd7a82e-439a-4b2d-869d-09de4456e482',
    bookingReferenceId: REFERENCE,
    totalFare: '360.13',
    rooms: [{ guests: [adult('TestGuest', 'One')] }, { guests: [adult('TestGuest', 'second')] }],
    occupancy: TWO_ADULT_ROOMS,
    contact: {
      email: 'reservas@agencia.example',
      phone: { countryCode: '57', number: '3001234567' },
    },
    ...overrides,
  };
}

function issuesOf(run: () => unknown): readonly string[] {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(TboRequestBuildError);
    const error = err as TboRequestBuildError;
    expect(error.path).toBe('/Book');
    expect(error.reason).toBe('SCHEMA');
    return error.issues;
  }
  throw new Error('el builder no lanzó');
}

describe('8.1.2 (p. 35-36): varias habitaciones con Limit', () => {
  it('reproduce el ejemplo con nuestras referencias y el PaymentMode explícito', () => {
    const body = buildTboBookRequest(input());
    expect(body.CustomerDetails).toEqual(BOOK_812['CustomerDetails']);
    expect(body.BookingCode).toBe(BOOK_812['BookingCode']);
    expect(body.TotalFare).toBe(BOOK_812['TotalFare']);
    expect(body.BookingType).toBe(BOOK_812['BookingType']);
    // 8.1.2 omite PaymentMode (Limit por defecto, p. 33); lo mandamos siempre (03 §3.6).
    expect(Object.keys(body)).toEqual([...Object.keys(BOOK_812), 'PaymentMode']);
    expect(body.PaymentMode).toBe('Limit');
  });

  it('el JSON que sale es exactamente éste, con las claves en el orden del PDF', () => {
    expect(JSON.stringify(buildTboBookRequest(input()))).toBe(
      '{"BookingCode":"1120548!TB!4!TB!8bd7a82e-439a-4b2d-869d-09de4456e482",' +
        '"CustomerDetails":[{"CustomerNames":[{"Title":"Mr","FirstName":"TestGuest","LastName":"One","Type":"Adult"}]},' +
        '{"CustomerNames":[{"Title":"Mr","FirstName":"TestGuest","LastName":"second","Type":"Adult"}]}],' +
        `"ClientReferenceId":"${REFERENCE}","BookingReferenceId":"${REFERENCE}",` +
        '"TotalFare":360.13,"EmailId":"reservas@agencia.example","PhoneNumber":"573001234567",' +
        '"BookingType":"Voucher","PaymentMode":"Limit"}',
    );
  });

  it('ClientReferenceId lleva el mismo valor que BookingReferenceId (RF-19)', () => {
    const body = buildTboBookRequest(input());
    expect(body.ClientReferenceId).toBe(REFERENCE);
    expect(body.BookingReferenceId).toBe(REFERENCE);
  });

  it('el esquema de salida no acepta dos referencias distintas', () => {
    const body = { ...buildTboBookRequest(input()), ClientReferenceId: 'STT0000000000000000A' };
    const parsed = TboBookRequestSchema.safeParse(body);
    expect(parsed.success).toBe(false);
  });
});

describe('huéspedes contra PaxRooms (RF-18; BK-01)', () => {
  it('un CustomerDetails por habitación, en el orden del Search, con niños nombrados', () => {
    const body = buildTboBookRequest(
      input({
        occupancy: [
          { adults: 1, childrenAges: [7] },
          { adults: 2, childrenAges: [] },
        ],
        rooms: [
          { guests: [adult('Juan', 'Perez'), child('Sofia', 'Perez')] },
          { guests: [adult('Ana', 'Munoz', 'Mrs'), adult('Luis', 'Munoz')] },
        ],
      }),
    );
    expect(body.CustomerDetails).toEqual([
      {
        CustomerNames: [
          { Title: 'Mr', FirstName: 'Juan', LastName: 'Perez', Type: 'Adult' },
          { Title: 'Ms', FirstName: 'Sofia', LastName: 'Perez', Type: 'Child' },
        ],
      },
      {
        CustomerNames: [
          { Title: 'Mrs', FirstName: 'Ana', LastName: 'Munoz', Type: 'Adult' },
          { Title: 'Mr', FirstName: 'Luis', LastName: 'Munoz', Type: 'Adult' },
        ],
      },
    ]);
  });

  it('la edad, la nacionalidad y los documentos no viajan: el Book no los lleva (p. 32-34)', () => {
    const rich: HotelGuest = {
      ...adult('Juan', 'Perez'),
      nationality: 'CO',
      birthDate: '1990-01-01',
      document: { type: 'PASSPORT', number: 'AB1234567', issuingCountry: 'CO' },
      gender: 'M',
    };
    const body = buildTboBookRequest(
      input({ rooms: [{ guests: [rich] }, { guests: [adult('Ana', 'Munoz')] }] }),
    );
    expect(JSON.stringify(body)).not.toMatch(/AB1234567|1990|"CO"|nationality|document/i);
  });

  it('otra cantidad de habitaciones que el Search', () => {
    expect(
      issuesOf(() => buildTboBookRequest(input({ rooms: [{ guests: [adult('Ana', 'Munoz')] }] }))),
    ).toContain('rooms:count_mismatch');
  });

  it('otra cantidad de adultos o de niños en una habitación', () => {
    const issues = issuesOf(() =>
      buildTboBookRequest(
        input({
          occupancy: [
            { adults: 2, childrenAges: [] },
            { adults: 1, childrenAges: [5] },
          ],
          rooms: [
            { guests: [adult('Juan', 'Perez')] },
            { guests: [adult('Ana', 'Munoz'), adult('Luis', 'Munoz')] },
          ],
        }),
      ),
    );
    expect(issues).toEqual(
      expect.arrayContaining(['rooms.0:adults_mismatch', 'rooms.1:adults_mismatch']),
    );
    expect(issues).toContain('rooms.1:children_mismatch');
  });

  it('el primer huésped de cada habitación es adulto', () => {
    const issues = issuesOf(() =>
      buildTboBookRequest(
        input({
          occupancy: [
            { adults: 1, childrenAges: [5] },
            { adults: 1, childrenAges: [] },
          ],
          rooms: [
            { guests: [child('Sofia', 'Perez'), adult('Juan', 'Perez')] },
            { guests: [adult('Ana', 'Munoz')] },
          ],
        }),
      ),
    );
    expect(issues).toEqual(['rooms.0.guests.0:lead_not_adult']);
  });

  it('una habitación sin huéspedes', () => {
    expect(
      issuesOf(() =>
        buildTboBookRequest(
          input({ rooms: [{ guests: [] }, { guests: [adult('Ana', 'Munoz')] }] }),
        ),
      ),
    ).toContain('rooms.0.guests:empty');
  });

  it('un tipo de pasajero que TBO no tiene (p. 33: Adult o Child)', () => {
    const infant = { ...adult('Leo', 'Perez'), paxType: 'INF' } as unknown as HotelGuest;
    expect(
      issuesOf(() =>
        buildTboBookRequest(
          input({
            rooms: [
              { guests: [adult('Juan', 'Perez'), infant] },
              { guests: [adult('Ana', 'Munoz')] },
            ],
          }),
        ),
      ),
    ).toContain('rooms.0.guests.1.paxType:not_allowed');
  });
});

describe('Title (RF-18 CA-2; Q-41)', () => {
  it.each(['Mr', 'Mrs', 'Ms'] as const)('%s pasa', (title) => {
    const body = buildTboBookRequest(
      input({
        rooms: [{ guests: [adult('Ana', 'Munoz', title)] }, { guests: [adult('Luis', 'Munoz')] }],
      }),
    );
    expect(body.CustomerDetails[0]?.CustomerNames[0]?.Title).toBe(title);
  });

  it('Dr (Postman: HotelBook) se rechaza hasta que TBO lo confirme', () => {
    const doctor = { ...adult('Ana', 'Munoz'), title: 'Dr' } as unknown as HotelGuest;
    expect(
      issuesOf(() =>
        buildTboBookRequest(
          input({ rooms: [{ guests: [doctor] }, { guests: [adult('Luis', 'Munoz')] }] }),
        ),
      ),
    ).toEqual(['rooms.0.guests.0.title:not_allowed']);
  });

  it('sin título no se deriva del género: se pide', () => {
    const untitled: HotelGuest = {
      paxType: 'ADT',
      firstName: 'Ana',
      lastName: 'Munoz',
      gender: 'F',
    };
    expect(
      issuesOf(() =>
        buildTboBookRequest(
          input({ rooms: [{ guests: [untitled] }, { guests: [adult('Luis', 'Munoz')] }] }),
        ),
      ),
    ).toEqual(['rooms.0.guests.0.title:required']);
  });
});

describe('nombres en ASCII (D-TBO-23 A; RF-18 CA-3)', () => {
  it('José Muñoz sale como Jose Munoz', () => {
    const body = buildTboBookRequest(
      input({
        rooms: [{ guests: [adult('José', 'Muñoz')] }, { guests: [adult('Ana', 'Pérez')] }],
      }),
    );
    expect(body.CustomerDetails[0]?.CustomerNames[0]).toMatchObject({
      FirstName: 'Jose',
      LastName: 'Munoz',
    });
    expect(body.CustomerDetails[1]?.CustomerNames[0]?.LastName).toBe('Perez');
  });

  it.each([
    ['  María   José  ', 'Maria Jose'],
    ['Ñandú', 'Nandu'],
    ['Gonçalves', 'Goncalves'],
    ['João', 'Joao'],
    ['Straße', 'Strasse'],
    ['Ærø', 'AEro'],
    ['Łódź', 'Lodz'],
    ['O’Brien', "O'Brien"],
    ['D´Alessandro', "D'Alessandro"],
    ['Ana‐María', 'Ana-Maria'],
    ['Øystein', 'Oystein'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeTboGuestName(raw)).toEqual({ ok: true, value: expected });
  });

  it.each([
    ['', 'required'],
    ['   ', 'required'],
    ['Juan2', 'contains_digits'],
    ['٣Ana', 'contains_digits'],
    ['李', 'invalid_characters'],
    ['Иван', 'invalid_characters'],
    ['Jr.', 'invalid_characters'],
    ['Ana 😀', 'invalid_characters'],
    ['A', 'too_short'],
    ["A'-", 'too_short'],
    ['A'.repeat(TBO_BOOK_LIMITS.maxNameLength + 1), 'too_long'],
  ])('%j se rechaza con %s', (raw, reason) => {
    expect(normalizeTboGuestName(raw)).toEqual({ ok: false, reason });
  });

  it('40 caracteres pasan: el techo es inclusivo', () => {
    expect(normalizeTboGuestName('A'.repeat(40))).toEqual({ ok: true, value: 'A'.repeat(40) });
  });

  it('los issues nombran el campo, nunca el valor: son nombres de personas', () => {
    const issues = issuesOf(() =>
      buildTboBookRequest(
        input({
          rooms: [{ guests: [adult('Juan2', 'Perez')] }, { guests: [adult('Ana', '李')] }],
        }),
      ),
    );
    expect(issues).toEqual([
      'rooms.0.guests.0.firstName:contains_digits',
      'rooms.1.guests.0.lastName:invalid_characters',
    ]);
    expect(JSON.stringify(issues)).not.toMatch(/Juan|Perez|Ana|李/);
  });
});

describe('duplicados en la misma reserva (RF-18 CA-4)', () => {
  it('dos huéspedes idénticos se rechazan, aunque estén en habitaciones distintas', () => {
    const issues = issuesOf(() =>
      buildTboBookRequest(
        input({
          rooms: [{ guests: [adult('Ana', 'Munoz')] }, { guests: [adult('ana', 'MUNOZ')] }],
        }),
      ),
    );
    expect(issues).toEqual(['rooms.1.guests.0:duplicate_guest']);
  });

  it('se compara lo que SALE: José Muñoz y Jose Munoz son el mismo huésped para TBO', () => {
    expect(
      issuesOf(() =>
        buildTboBookRequest(
          input({
            rooms: [{ guests: [adult('José', 'Muñoz')] }, { guests: [adult('Jose', 'Munoz')] }],
          }),
        ),
      ),
    ).toEqual(['rooms.1.guests.0:duplicate_guest']);
  });

  it('distinguirlos con un segundo nombre alcanza', () => {
    expect(() =>
      buildTboBookRequest(
        input({
          rooms: [{ guests: [adult('Ana', 'Munoz')] }, { guests: [adult('Ana Maria', 'Munoz')] }],
        }),
      ),
    ).not.toThrow();
  });
});

describe('checkTboBookGuests: la misma regla, antes del intent', () => {
  it('devuelve los nombres tal como van a salir, en vocabulario neutral', () => {
    const check = checkTboBookGuests(
      [{ guests: [adult('José', 'Muñoz'), child('Sofía', 'Muñoz')] }],
      [{ adults: 1, childrenAges: [7] }],
    );
    expect(check).toEqual({
      ok: true,
      rooms: [
        [
          { title: 'Mr', firstName: 'Jose', lastName: 'Munoz', paxType: 'ADT' },
          { title: 'Ms', firstName: 'Sofia', lastName: 'Munoz', paxType: 'CHD' },
        ],
      ],
    });
  });

  it('informa todo junto y con techo', () => {
    const guests: HotelBookingRoomGuests[] = Array.from({ length: 8 }, () => ({
      guests: [adult('1', '2'), adult('3', '4')],
    }));
    const check = checkTboBookGuests(
      guests,
      guests.map(() => ({ adults: 2, childrenAges: [] })),
    );
    expect(check.ok).toBe(false);
    expect(check.ok ? [] : check.issues).toHaveLength(20);
  });

  it('más habitaciones que las que TBO busca', () => {
    const nine = Array.from({ length: 9 }, (_, index) => ({
      guests: [adult('Ana', `Munoz${'x'.repeat(index)}`.replace(/\d/g, ''))],
    }));
    const check = checkTboBookGuests(
      nine,
      nine.map(() => ({ adults: 1, childrenAges: [] })),
    );
    expect(check.ok ? [] : check.issues).toContain('rooms:too_many');
  });
});

describe('TotalFare: el literal del PreBook, exacto o nada (03 §3.4; RF-20 CA-6)', () => {
  it.each([
    ['360.13', 360.13],
    ['85.822', 85.822],
    // p. 49: el mismo decimal con ceros de relleno.
    ['107.14000000000000', 107.14],
    ['0.1', 0.1],
    ['164.65', 164.65],
    ['999999999.99', 999999999.99],
  ])('%s sale como el número %d', (literal, expected) => {
    const body = buildTboBookRequest(input({ totalFare: literal }));
    expect(body.TotalFare).toBe(expected);
    expect(JSON.stringify(body)).toContain(`"TotalFare":${String(expected)},`);
  });

  it.each([
    ['12345678.123456789', 'not_exact'],
    ['0.1000000000000000055511151231257827', 'not_exact'],
    ['1e3', 'not_a_decimal'],
    ['-5.00', 'not_a_decimal'],
    ['85,82', 'not_a_decimal'],
    [' 85.82', 'not_a_decimal'],
    ['85.', 'not_a_decimal'],
    ['0', 'not_positive'],
    ['0.000', 'not_positive'],
    ['1000000000.00', 'out_of_range'],
    ['4111111111111111', 'out_of_range'],
  ])('%s se rechaza con %s sin llamar a TBO', (literal, reason) => {
    expect(issuesOf(() => buildTboBookRequest(input({ totalFare: literal })))).toEqual([
      `totalFare:${reason}`,
    ]);
  });

  it('un número en lugar del literal se rechaza: el literal es texto por diseño', () => {
    expect(
      issuesOf(() => buildTboBookRequest(input({ totalFare: 360.13 as unknown as string }))),
    ).toEqual(['totalFare:required']);
  });
});

describe('referencia, contacto y constantes', () => {
  it('una referencia que no es nuestra no sale (Postman, PDF, un Idempotency-Key)', () => {
    for (const reference of [
      '742955723103628',
      'AVw12118',
      '9d3b1a52-4c1f-4d8e-8b1a-0f2e5c7d9a10',
    ]) {
      expect(issuesOf(() => buildTboBookRequest(input({ bookingReferenceId: reference })))).toEqual(
        ['bookingReferenceId:invalid_format'],
      );
    }
  });

  it('el teléfono sale con dígitos y prefijo de país, sin + (p. 35-36)', () => {
    expect(buildTboBookRequest(input({ contact: CONTACT })).PhoneNumber).toBe('573001234567');
    expect(
      buildTboBookRequest(
        input({
          contact: {
            email: 'reservas@agencia.example',
            phone: { countryCode: '51', areaCode: '(1)', number: '555-0100' },
          },
        }),
      ).PhoneNumber,
    ).toBe('5115550100');
  });

  it.each([
    [{ countryCode: '57', number: '300 ABC 4567' }, 'contact.phone.number:invalid_characters'],
    [{ countryCode: '5757', number: '3001234567' }, 'contact.phone.countryCode:invalid_length'],
    [{ countryCode: '57', number: '12' }, 'contact.phone:invalid_length'],
    [{ countryCode: '57', number: '3001234567890123' }, 'contact.phone:invalid_length'],
    [{ countryCode: '0', number: '3001234567' }, 'contact.phone.countryCode:invalid'],
    [{ countryCode: '', number: '3001234567' }, 'contact.phone.countryCode:required'],
  ])('teléfono %j → %s', (phone, issue) => {
    expect(
      issuesOf(() =>
        buildTboBookRequest(input({ contact: { email: 'reservas@agencia.example', phone } })),
      ),
    ).toContain(issue);
  });

  it('el email se valida', () => {
    expect(
      issuesOf(() =>
        buildTboBookRequest(input({ contact: { ...CONTACT, email: 'no-es-un-email' } })),
      ),
    ).toEqual(['contact.email:invalid']);
    expect(
      issuesOf(() => buildTboBookRequest(input({ contact: { ...CONTACT, email: '' } }))),
    ).toEqual(['contact.email:required']);
  });

  it('BookingType y PaymentMode son constantes: la entrada no los elige ni cuela PaymentInfo', () => {
    const smuggled = {
      ...input(),
      PaymentMode: 'SavedCard',
      BookingType: 'OnRequest',
      PaymentInfo: { CvvNumber: '123' },
    } as unknown as TboBookInput;
    const body = buildTboBookRequest(smuggled);
    expect(body.PaymentMode).toBe('Limit');
    expect(body.BookingType).toBe('Voucher');
    expect(Object.keys(body)).not.toContain('PaymentInfo');
  });

  it('el esquema de salida es estricto: una clave de más no pasa', () => {
    const parsed = TboBookRequestSchema.safeParse({
      ...buildTboBookRequest(input()),
      PaymentInfo: { CvvNumber: '123' },
    });
    expect(parsed.success).toBe(false);
  });
});
