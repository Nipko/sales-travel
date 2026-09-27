import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addOneCent } from '../lib/booking-probes.mjs';
import {
  CERT_CASES,
  SYNTHETIC_FIRST_NAMES,
  SYNTHETIC_LAST_NAMES,
  caseFolderName,
  caseOccupancies,
  certCase,
  certContact,
  describeFees,
  expandCaseSelection,
  selectOption,
  syntheticGuests,
} from '../lib/cases.mjs';

/** La tabla maestra de docs/tbo/07 §4.2, en el vocabulario neutral que recibe el ACL. */
const TABLE = {
  1: { rooms: [{ adults: 1, childrenAges: [] }], nationality: 'CO' },
  2: { rooms: [{ adults: 1, childrenAges: [7] }], nationality: 'PE' },
  3: { rooms: [{ adults: 2, childrenAges: [4, 10] }], nationality: 'BR' },
  4: {
    rooms: [
      { adults: 1, childrenAges: [] },
      { adults: 1, childrenAges: [] },
    ],
    nationality: 'MX',
  },
  5: {
    rooms: [
      { adults: 1, childrenAges: [8] },
      { adults: 1, childrenAges: [] },
    ],
    nationality: 'CL',
  },
  6: {
    rooms: [
      { adults: 1, childrenAges: [3, 11] },
      { adults: 2, childrenAges: [] },
    ],
    nationality: 'AR',
  },
};

describe('casos de certificación', () => {
  it('los casos 1 a 6 tienen la ocupación y la nacionalidad de 07 §4.2', () => {
    for (const [id, want] of Object.entries(TABLE)) {
      const kase = certCase(Number(id));
      assert.deepEqual(
        kase.rooms.map((r) => ({ adults: r.adults, childrenAges: [...r.childrenAges] })),
        want.rooms,
        `caso ${id}`,
      );
      assert.equal(kase.nationality, want.nationality);
    }
  });

  it('el 7 prueba la ocupación del 4 y después la del 1; el 8 lee el 4', () => {
    const seven = certCase(7);
    assert.deepEqual(
      caseOccupancies(seven).map((o) => o.occupancyOf),
      [4, 1],
    );
    assert.equal(seven.nationality, 'EC');
    assert.equal(certCase(8).detailOf, 4);
  });

  it('nombres de carpeta de 07 §5', () => {
    assert.equal(caseFolderName(certCase(1)), 'Case01_1Room_1A');
    assert.equal(caseFolderName(certCase(6)), 'Case06_2Rooms_1A2C_2A');
    assert.equal(caseFolderName(certCase(7), 4), 'Case07_Supplements_2Rooms_1A_1A');
    assert.equal(caseFolderName(certCase(7), 1), 'Case07_Supplements_1Room_1A');
    assert.equal(caseFolderName(certCase(8)), 'Case08_BookingDetail_OfCase04');
  });

  it('pedir el 4 o el 8 corre los dos', () => {
    assert.deepEqual(expandCaseSelection([4]), [4, 8]);
    assert.deepEqual(expandCaseSelection([8, 1]), [1, 4, 8]);
    assert.deepEqual(expandCaseSelection([2, 3]), [2, 3]);
  });

  it('GuestNationality distinta en cada caso que reserva (CK-01)', () => {
    const values = CERT_CASES.filter((c) => c.nationality).map((c) => c.nationality);
    assert.equal(new Set(values).size, values.length);
  });
});

describe('huéspedes sintéticos', () => {
  it('el caso 6 sale como la plantilla de 07 §4.8', () => {
    assert.deepEqual(syntheticGuests(certCase(6).rooms, 'Testseis'), [
      {
        guests: [
          { paxType: 'ADT', title: 'Mr', firstName: 'Mateo', lastName: 'Testseis' },
          { paxType: 'CHD', title: 'Ms', firstName: 'Lucia', lastName: 'Testseis', age: 3 },
          { paxType: 'CHD', title: 'Mr', firstName: 'Tomas', lastName: 'Testseis', age: 11 },
        ],
      },
      {
        guests: [
          { paxType: 'ADT', title: 'Mrs', firstName: 'Paula', lastName: 'Testseis' },
          { paxType: 'ADT', title: 'Mr', firstName: 'Andres', lastName: 'Testseis' },
        ],
      },
    ]);
  });

  it('un adulto primero en cada habitación, nombres sin repetir y todos de la lista (G-4)', () => {
    for (const kase of CERT_CASES.filter((c) => c.rooms)) {
      const rooms = syntheticGuests(kase.rooms, kase.lastName);
      const seen = new Set();
      for (const room of rooms) {
        assert.equal(room.guests[0].paxType, 'ADT');
        for (const guest of room.guests) {
          assert.ok(SYNTHETIC_FIRST_NAMES.includes(guest.firstName));
          assert.ok(SYNTHETIC_LAST_NAMES.includes(guest.lastName));
          assert.match(`${guest.firstName}${guest.lastName}`, /^[A-Za-z]+$/);
          assert.ok(!seen.has(guest.firstName), 'nombre repetido en la reserva');
          seen.add(guest.firstName);
        }
      }
    }
  });

  it('el teléfono viaja con los mismos dígitos, se parta como se parta', () => {
    const contact = certContact('reservas@example.com', '573000000000');
    assert.equal(`${contact.phone.countryCode}${contact.phone.number}`, '573000000000');
  });
});

function option(id, { fare, refundable = false, atProperty = 0, included = 0 }) {
  const fee = {
    description: 'Impuesto obligatorio',
    descriptionRaw: 'mandatory_tax',
    amount: { amountMinor: 2000, currency: 'AED' },
    roomIndex: 1,
  };
  return {
    hotelId: 'H',
    signature: id,
    context: { hotelCode: 'H', bookingCode: id, totalFare: fare, currency: 'USD' },
    pack: {
      id,
      cancellation: { refundable },
      ...(atProperty > 0 ? { atPropertyCharges: Array(atProperty).fill(fee) } : {}),
      ...(included > 0 ? { includedSupplements: Array(included).fill(fee) } : {}),
    },
  };
}

describe('elección de tarifa (07 §4.1 y §4.9)', () => {
  it('casos 1 a 6: la reembolsable más barata, aunque haya una no reembolsable más barata', () => {
    const picked = selectOption([
      option('a', { fare: '90.00' }),
      option('b', { fare: '120.50', refundable: true }),
      option('c', { fare: '110.25', refundable: true }),
    ]);
    assert.equal(picked.context.bookingCode, 'c');
  });

  it('sin reembolsables, la más barata; sin opciones, ninguna', () => {
    assert.equal(
      selectOption([option('a', { fare: '99.9' }), option('b', { fare: '99.10' })]).context
        .bookingCode,
      'b',
    );
    assert.equal(selectOption([]), undefined);
  });

  it('caso 7: la primera con AtProperty; si no, la primera con Included; si no, ninguna', () => {
    const atProperty = selectOption(
      [option('a', { fare: '1', included: 1 }), option('b', { fare: '2', atProperty: 1 })],
      'supplements',
    );
    assert.equal(atProperty.context.bookingCode, 'b');
    assert.equal(atProperty.supplementType, 'AtProperty');
    const included = selectOption([option('a', { fare: '1', included: 1 })], 'supplements');
    assert.equal(included.supplementType, 'Included');
    assert.equal(selectOption([option('a', { fare: '1' })], 'supplements'), undefined);
  });

  it('describe cada suplemento con importe, moneda y habitación', () => {
    const [fee] = option('a', { fare: '1', atProperty: 1 }).pack.atPropertyCharges;
    assert.deepEqual(describeFees([fee], 'AtProperty'), [
      'AtProperty mandatory_tax 20.00 AED (room 1)',
    ]);
  });
});

describe('PR-10: un centavo sobre el literal', () => {
  it('suma 0.01 sin coma flotante, conserva los decimales del literal', () => {
    assert.equal(addOneCent('85.82'), '85.83');
    assert.equal(addOneCent('85.822'), '85.832');
    assert.equal(addOneCent('100'), '100.01');
    assert.equal(addOneCent('0.99'), '1.00');
    assert.equal(addOneCent('152.8'), '152.81');
    assert.throws(() => addOneCent('1e3'), /no es un decimal/);
  });
});
