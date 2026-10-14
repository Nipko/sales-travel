import { describe, expect, it } from 'vitest';
import type { HotelRoomItem, HotelRoomOccupancy, HotelRoompack } from '../actions';
import { hotelRateRows, type HotelRateRow } from './hotel-rate-view';
import { rateRefundability, type RateRefundability } from './rate-refundability';
import {
  ROOM_NAME_VECTORS,
  filterGroupsBySlots,
  knownSlotChoice,
  normalizeRoomName,
  occupancyText,
  roomDisplayName,
  roomSlotOptions,
  roomTypeGroups,
  roomTypesCountText,
  slotChoiceSummary,
  type RoomSlot,
  type RoomSlotFacet,
} from './room-type-groups';

function room(name: string, extra: Partial<HotelRoomItem> = {}): HotelRoomItem {
  return { name, reference: 1, bedOptions: [], ...extra };
}

function pack(
  id: string,
  saleMinor: number,
  rooms: HotelRoomItem[],
  extra: Partial<HotelRoompack> = {},
): HotelRoompack {
  return {
    id,
    provider: { name: 'tbo-hotels', offerRef: `${id}-REF` },
    board: 'RO',
    rooms,
    cancellation: { refundable: false, status: 'non_refundable', rules: [] },
    price: { total: { amountMinor: saleMinor, currency: 'USD' }, taxesDetail: [] },
    ...extra,
  };
}

const DESPEGAR = { provider: { name: 'despegar-hotels', offerRef: 'D-REF' } };
const REFUNDABLE = {
  cancellation: { refundable: true, status: 'fully_refundable', rules: [] },
} as const satisfies Partial<HotelRoompack>;

interface Plan {
  readonly row: HotelRateRow;
  readonly refund: RateRefundability;
}

/** Como las arma la pantalla: filas por precio de venta, cada una con su reembolso. */
function plans(...roompacks: HotelRoompack[]): Plan[] {
  return hotelRateRows({ roompacks }, false).map((row) => ({
    row,
    refund: rateRefundability(row.pack),
  }));
}

function ids(group: { plans: readonly Plan[] }): string[] {
  return group.plans.map((p) => p.row.pack.id);
}

describe('normalizeRoomName — la clave que el ACL de TBO espeja', () => {
  it.each(ROOM_NAME_VECTORS)('«$name» → «$key»', ({ name, key }) => {
    expect(normalizeRoomName(name)).toBe(key);
  });

  it('la tabla cubre tildes, mayúsculas, puntuación, compatibilidad Unicode y vacíos', () => {
    expect(ROOM_NAME_VECTORS.length).toBeGreaterThanOrEqual(10);
    expect(ROOM_NAME_VECTORS.some((v) => v.key === '')).toBe(true);
    expect(Object.isFrozen(ROOM_NAME_VECTORS)).toBe(true);
  });
});

describe('occupancyText', () => {
  it.each([
    [{ adults: 2, childrenAges: [] }, '2 adultos'],
    [{ adults: 1, childrenAges: [5] }, '1 adulto, 1 niño (5 años)'],
    [{ adults: 2, childrenAges: [3, 7] }, '2 adultos, 2 niños (3 y 7 años)'],
    [{ adults: 2, childrenAges: [1, 4, 9] }, '2 adultos, 3 niños (1, 4 y 9 años)'],
    [{ adults: 1, childrenAges: [1] }, '1 adulto, 1 niño (1 año)'],
    [{ adults: 0, childrenAges: [] }, ''],
  ])('%o → «%s»', (occupancy, text) => {
    expect(occupancyText(occupancy)).toBe(text);
  });
});

describe('roomTypeGroups — identidad de la habitación', () => {
  it('el mismo id con varios regímenes es UN grupo, con los planes por precio de venta', () => {
    const [group, ...rest] = roomTypeGroups(
      plans(
        pack('HB', 300_00, [room('Deluxe King', { roomTypeId: '77' })], { board: 'HB' }),
        pack('RO', 200_00, [room('Deluxe King', { roomTypeId: '77' })]),
        pack('BB', 250_00, [room('Deluxe King', { roomTypeId: '77' })], { board: 'BB' }),
      ),
    );
    expect(rest).toHaveLength(0);
    expect(ids(group!)).toEqual(['RO', 'BB', 'HB']);
    expect(group!.title).toBe('Deluxe King');
    expect(group!.boards).toEqual(['Solo alojamiento', 'Desayuno', 'Media pensión']);
    expect(group!.slots[0]?.roomTypeId).toBe('77');
    expect(group!.slots[0]?.roomTypeIds).toEqual({ 'tbo-hotels': '77' });
  });

  it('sin ids, con mayúsculas, tildes y puntuación distintas: UN grupo', () => {
    const groups = roomTypeGroups(
      plans(
        pack('A', 100_00, [room('Habitación Doble, Estándar')]),
        pack('B', 110_00, [room('HABITACION DOBLE - ESTANDAR')]),
        pack('C', 120_00, [room('  habitación doble estándar ')]),
      ),
    );
    expect(groups).toHaveLength(1);
    expect(ids(groups[0]!)).toEqual(['A', 'B', 'C']);
    // El nombre que se ve es el del plan más barato, como lo dio el proveedor.
    expect(groups[0]!.title).toBe('Habitación Doble, Estándar');
  });

  it('el id en unos packs y no en otros con el mismo nombre: se fusiona', () => {
    const groups = roomTypeGroups(
      plans(
        pack('SIN', 90_00, [room('Superior Twin')]),
        pack('CON', 95_00, [room('superior twin', { roomTypeId: '12' })]),
      ),
    );
    expect(groups).toHaveLength(1);
    expect(ids(groups[0]!)).toEqual(['SIN', 'CON']);
    // El id del grupo sale del plan que lo tiene, aunque no sea el más barato.
    expect(groups[0]!.slots[0]?.roomTypeId).toBe('12');
  });

  it('el mismo nombre con dos ids no se fusiona, y el que no trae id queda aparte', () => {
    const groups = roomTypeGroups(
      plans(
        pack('ID1', 100_00, [room('Deluxe Room', { roomTypeId: '1' })]),
        pack('ID2', 120_00, [room('Deluxe Room', { roomTypeId: '2' })]),
        pack('SIN', 130_00, [room('Deluxe Room')]),
      ),
    );
    expect(groups.map(ids)).toEqual([['ID1'], ['ID2'], ['SIN']]);
    expect(new Set(groups.map((g) => g.key)).size).toBe(3);
  });

  it('ids iguales de proveedores distintos no son la misma habitación', () => {
    const groups = roomTypeGroups(
      plans(
        pack('T', 100_00, [room('Doble', { roomTypeId: '5' })]),
        pack('D', 110_00, [room('Suite', { roomTypeId: '5' })], DESPEGAR),
      ),
    );
    expect(groups.map(ids)).toEqual([['T'], ['D']]);
  });

  it('un pack con el id de otro proveedor no le presta el id a un nombre sin id', () => {
    const groups = roomTypeGroups(
      plans(
        pack('D', 100_00, [room('Doble', { roomTypeId: '5' })], DESPEGAR),
        pack('T1', 110_00, [room('Doble')]),
        pack('T2', 120_00, [room('Doble', { roomTypeId: '9' })]),
      ),
    );
    // T1 hereda el 9 (su proveedor tiene un solo id para «doble») y el grupo de TBO se junta con
    // el de Despegar por nombre: cada uno tiene un solo grupo con ese nombre.
    expect(groups).toHaveLength(1);
    expect(ids(groups[0]!)).toEqual(['D', 'T1', 'T2']);
    expect(groups[0]!.slots[0]?.roomTypeIds).toEqual({ 'despegar-hotels': '5', 'tbo-hotels': '9' });
  });
});

describe('roomTypeGroups — varios proveedores en una tarjeta', () => {
  it('sin ids, el mismo nombre de dos proveedores es un grupo, con un plan de cada uno', () => {
    const groups = roomTypeGroups(
      plans(
        pack('T', 100_00, [room('Doble estándar')]),
        pack('D', 90_00, [room('DOBLE ESTÁNDAR')], DESPEGAR),
      ),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.plans.map((p) => p.row.pack.provider?.name)).toEqual([
      'despegar-hotels',
      'tbo-hotels',
    ]);
  });

  it('con ids, se juntan por nombre si ninguno de los dos tiene otro grupo con ese nombre', () => {
    const groups = roomTypeGroups(
      plans(
        pack('T', 100_00, [room('Deluxe', { roomTypeId: '1' })]),
        pack('D', 90_00, [room('Deluxe', { roomTypeId: 'X' })], DESPEGAR),
      ),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key.startsWith('m:')).toBe(true);
  });

  it('si un proveedor tiene dos habitaciones con ese nombre, no se junta con ninguna', () => {
    const groups = roomTypeGroups(
      plans(
        pack('T1', 100_00, [room('Deluxe', { roomTypeId: '1' })]),
        pack('T2', 105_00, [room('Deluxe', { roomTypeId: '2' })]),
        pack('D', 90_00, [room('Deluxe', { roomTypeId: 'X' })], DESPEGAR),
      ),
    );
    expect(groups.map(ids)).toEqual([['D'], ['T1'], ['T2']]);
  });

  it('el grupo por nombre con planes de un proveedor ambiguo no se suma al grupo con id', () => {
    const groups = roomTypeGroups(
      plans(
        // En TBO «doble» tiene dos ids (1 y 2), así que T3 no resuelve el suyo.
        pack('T1', 100_00, [room('Doble', { roomTypeId: '1' }), room('Suite')]),
        pack('T2', 110_00, [room('Doble', { roomTypeId: '2' })]),
        pack('T3', 120_00, [room('Doble'), room('Suite')]),
        pack(
          'D',
          130_00,
          [room('Doble', { roomTypeId: 'X' }), room('Suite', { roomTypeId: 'Y' })],
          DESPEGAR,
        ),
      ),
    );
    // T1 y D se juntan (cada proveedor tiene un solo grupo «doble|suite» con id); T3 queda solo.
    expect(groups.map(ids)).toEqual([['T1', 'D'], ['T2'], ['T3']]);
  });

  it('un nombre vacío no junta grupos de proveedores distintos', () => {
    const groups = roomTypeGroups(
      plans(
        pack('T', 100_00, [room('', { roomTypeId: '1' })]),
        pack('D', 90_00, [room('  ', { roomTypeId: 'X' })], DESPEGAR),
      ),
    );
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.title === 'Habitación')).toBe(true);
  });
});

describe('roomTypeGroups — varias habitaciones', () => {
  const occupancyA = { adults: 2, childrenAges: [] };
  const occupancyB = { adults: 1, childrenAges: [6] };

  it('la combinación es sensible al orden: «Doble + Suite» no es «Suite + Doble»', () => {
    const groups = roomTypeGroups(
      plans(
        pack('DS', 300_00, [room('Doble'), room('Suite')]),
        pack('SD', 320_00, [room('Suite'), room('Doble')]),
        pack('DS2', 310_00, [room('doble'), room('suite')], { board: 'BB' }),
      ),
    );
    expect(groups.map((g) => g.title)).toEqual(['Doble + Suite', 'Suite + Doble']);
    expect(groups.map(ids)).toEqual([['DS', 'DS2'], ['SD']]);
  });

  it('dos habitaciones iguales: «2 × Doble», con la ocupación de cada una', () => {
    const [group] = roomTypeGroups(
      plans(
        pack('A', 300_00, [
          room('Doble', { occupancy: occupancyA, bedOptions: ['1 cama queen'] }),
          room('Doble', { occupancy: occupancyB }),
        ]),
      ),
    );
    expect(group!.title).toBe('2 × Doble');
    expect(group!.slots).toEqual([
      expect.objectContaining({
        index: 0,
        name: 'Doble',
        beds: '1 cama queen',
        occupancyText: '2 adultos',
      }),
      expect.objectContaining({
        index: 1,
        name: 'Doble',
        occupancyText: '1 adulto, 1 niño (6 años)',
      }),
    ]);
  });

  it('las camas y la ocupación salen del primer plan que las informa', () => {
    const [group] = roomTypeGroups(
      plans(
        pack('A', 100_00, [room('Doble')]),
        pack('B', 200_00, [
          room('Doble', { bedOptions: ['', ' 2 camas dobles '], occupancy: occupancyA }),
        ]),
      ),
    );
    expect(group!.slots[0]?.beds).toBe('2 camas dobles');
    expect(group!.slots[0]?.occupancyText).toBe('2 adultos');
  });
});

describe('roomTypeGroups — «desde» y orden', () => {
  it('el «desde» ignora las vencidas; si vencieron todas, la más barata y marcada', () => {
    const rates = plans(pack('A', 100_00, [room('Doble')]), pack('B', 150_00, [room('Doble')]));
    const [vigente] = roomTypeGroups(rates, (p) => p.row.pack.id === 'A');
    expect(vigente!.from.row.pack.id).toBe('B');
    expect(vigente!.fromExpired).toBe(false);

    const [vencido] = roomTypeGroups(rates, () => true);
    expect(vencido!.from.row.pack.id).toBe('A');
    expect(vencido!.fromExpired).toBe(true);
  });

  it('los grupos van por su «desde»; ante un empate, el que llegó primero', () => {
    const groups = roomTypeGroups(
      plans(
        pack('SUITE', 300_00, [room('Suite')]),
        pack('DOBLE', 200_00, [room('Doble')]),
        pack('TWIN', 200_00, [room('Twin')]),
        pack('DOBLE-VENCIDA', 50_00, [room('Doble')]),
      ),
      (p) => p.row.pack.id === 'DOBLE-VENCIDA',
    );
    expect(groups.map((g) => g.title)).toEqual(['Doble', 'Twin', 'Suite']);
  });

  it('anyRefundable lee el reembolso del plan y, sin él, lo declarado', () => {
    const [group] = roomTypeGroups(
      plans(pack('A', 100_00, [room('Doble')]), pack('B', 200_00, [room('Doble')], REFUNDABLE)),
    );
    expect(group!.anyRefundable).toBe(true);

    const rows = hotelRateRows(
      { roompacks: [pack('C', 100_00, [room('Doble')], REFUNDABLE)] },
      false,
    );
    const [declared] = roomTypeGroups(rows.map((row) => ({ row })));
    expect(declared!.anyRefundable).toBe(true);
    const [read] = roomTypeGroups(rows.map((row) => ({ row, refund: { refundable: false } })));
    expect(read!.anyRefundable).toBe(false);
  });
});

describe('roomTypeGroups — casos borde', () => {
  it('un pack sin habitaciones es «Habitación», sin líneas de detalle', () => {
    const [group] = roomTypeGroups(plans(pack('A', 100_00, [])));
    expect(group!.title).toBe('Habitación');
    expect(group!.slots).toEqual([]);
  });

  it('nombres vacíos: «Habitación», y en varias habitaciones cada una con el suyo', () => {
    const groups = roomTypeGroups(
      plans(pack('A', 100_00, [room('  ')]), pack('B', 200_00, [room(''), room('Suite')])),
    );
    expect(groups.map((g) => g.title)).toEqual(['Habitación', 'Habitación + Suite']);
    expect(roomDisplayName({ name: '' })).toBe('Habitación');
  });

  it('una habitación sin nombre ni id no hereda el id de otra sin nombre', () => {
    const groups = roomTypeGroups(
      plans(pack('ID', 100_00, [room('', { roomTypeId: '1' })]), pack('SIN', 200_00, [room('')])),
    );
    expect(groups.map(ids)).toEqual([['ID'], ['SIN']]);
    expect(groups[1]!.slots[0]?.roomTypeId).toBeUndefined();
    expect(groups[1]!.slots[0]?.roomTypeIds).toEqual({});
  });

  it('sin tarifas, sin grupos', () => {
    expect(roomTypeGroups([])).toEqual([]);
  });
});

describe('roomTypesCountText', () => {
  it('singular y plural', () => {
    expect(roomTypesCountText(1, 1)).toBe('1 tipo de habitación · 1 tarifa');
    expect(roomTypesCountText(3, 8)).toBe('3 tipos de habitación · 8 tarifas');
  });
});

// ───────────────────────── El tipo de cada habitación (TBO-11) ─────────────────────────

describe('RoomSlot.identities — con qué identidad llegó cada habitación', () => {
  it('un grupo de un proveedor: una por habitación', () => {
    const [group] = roomTypeGroups(
      plans(pack('A', 100_00, [room('Doble', { roomTypeId: '7' }), room('Suite')])),
    );
    expect(group!.slots.map((s) => s.identities)).toEqual([['id:tbo-hotels:7'], ['n:suite']]);
  });

  it('un grupo que junta proveedores por nombre: una por cada proveedor', () => {
    const [group] = roomTypeGroups(
      plans(
        pack('T', 100_00, [room('Deluxe', { roomTypeId: '1' })]),
        pack('D', 90_00, [room('Deluxe', { roomTypeId: 'X' })], DESPEGAR),
      ),
    );
    expect(group!.slots[0]?.identities).toEqual(['id:despegar-hotels:X', 'id:tbo-hotels:1']);
  });
});

describe('roomSlotOptions — qué se elige en cada habitación', () => {
  const occupancyA: HotelRoomOccupancy = { adults: 2, childrenAges: [] };
  const occupancyB: HotelRoomOccupancy = { adults: 1, childrenAges: [6] };
  const r = (name: string, occupancy: HotelRoomOccupancy, extra: Partial<HotelRoomItem> = {}) =>
    room(name, { occupancy, ...extra });

  /** Combinaciones de dos habitaciones: Doble+Doble, Doble+Suite (dos regímenes) y Suite+Suite. */
  function combos() {
    return roomTypeGroups(
      plans(
        pack('DD', 200_00, [r('Doble', occupancyA), r('Doble', occupancyB)]),
        pack('DS', 300_00, [r('Doble', occupancyA), r('Suite', occupancyB)]),
        pack('SS', 400_00, [r('Suite', occupancyA), r('Suite', occupancyB)]),
        pack('DS2', 310_00, [r('doble', occupancyA), r('suite', occupancyB)], { board: 'BB' }),
      ),
    );
  }

  function labels(facet: RoomSlotFacet | undefined): string[] {
    return (facet?.options ?? []).map((o) => `${o.label}=${o.count}`);
  }

  it('una entrada por habitación, con su ocupación y sus tipos en el orden de los grupos', () => {
    const facets = roomSlotOptions(combos());
    expect(facets.map((f) => [f.index, f.occupancyText])).toEqual([
      [0, '2 adultos'],
      [1, '1 adulto, 1 niño (6 años)'],
    ]);
    // Las cuentas son combinaciones (grupos), no tarifas: DS y DS2 son la misma.
    expect(labels(facets[0])).toEqual(['Doble=2', 'Suite=1']);
    expect(labels(facets[1])).toEqual(['Doble=1', 'Suite=2']);
    expect(facets[0]?.options.map((o) => o.identity)).toEqual(['n:doble', 'n:suite']);
  });

  it('las cuentas respetan lo elegido en las DEMÁS habitaciones, no en la propia', () => {
    const groups = combos();
    const facets = roomSlotOptions(groups, { 1: 'n:suite' });
    expect(labels(facets[0])).toEqual(['Doble=1', 'Suite=1']);
    expect(labels(facets[1])).toEqual(['Doble=1', 'Suite=2']);

    const both = roomSlotOptions(groups, { 0: 'n:doble', 1: 'n:suite' });
    expect(labels(both[0])).toEqual(['Doble=1', 'Suite=1']);
    expect(labels(both[1])).toEqual(['Doble=1', 'Suite=1']);
    // Una opción que no dejaría ninguna combinación cuenta 0 (la pantalla no deja elegirla).
    expect(labels(roomSlotOptions(groups, { 0: 'n:suite' })[1])).toEqual(['Doble=0', 'Suite=1']);
  });

  it('el rótulo es el nombre original más frecuente; ante un empate, el del grupo más barato', () => {
    const facets = roomSlotOptions(
      roomTypeGroups(
        plans(
          pack('A', 100_00, [r('DOBLE ESTANDAR', occupancyA), r('Suite', occupancyB)]),
          pack('B', 200_00, [r('Doble Estándar', occupancyA), r('Twin', occupancyB)]),
          pack('C', 300_00, [r('Doble Estándar', occupancyA), r('Junior', occupancyB)]),
          pack('D', 400_00, [r('Suite', occupancyA), r('SUITE JUNIOR', occupancyB)]),
          pack('E', 500_00, [r('Doble Estándar', occupancyA), r('Suite Junior', occupancyB)]),
        ),
      ),
    );
    expect(labels(facets[0])).toEqual(['Doble Estándar=4', 'Suite=1']);
    // Empate 1 a 1 en «suite junior» (D y E): el de la combinación más barata.
    expect(labels(facets[1])).toEqual(['Suite=1', 'Twin=1', 'Junior=1', 'SUITE JUNIOR=2']);
  });

  it('el mismo tipo en dos proveedores es UNA opción, también donde lo vende uno solo', () => {
    const groups = roomTypeGroups(
      plans(
        // TBO y Despegar venden «Doble + Suite» con sus ids: se juntan por nombre.
        pack('T', 300_00, [
          r('Doble', occupancyA, { roomTypeId: '1' }),
          r('Suite', occupancyB, { roomTypeId: '2' }),
        ]),
        pack(
          'D',
          290_00,
          [
            r('Doble', occupancyA, { roomTypeId: 'X' }),
            r('Suite', occupancyB, { roomTypeId: 'Y' }),
          ],
          DESPEGAR,
        ),
        // Sólo TBO vende «Doble + Doble»; sólo Despegar, «Suite + Doble».
        pack('TT', 250_00, [
          r('Doble', occupancyA, { roomTypeId: '1' }),
          r('Doble', occupancyB, { roomTypeId: '1' }),
        ]),
        pack(
          'DD',
          350_00,
          [
            r('Suite', occupancyA, { roomTypeId: 'Y' }),
            r('Doble', occupancyB, { roomTypeId: 'X' }),
          ],
          DESPEGAR,
        ),
      ),
    );
    expect(groups).toHaveLength(3);
    const facets = roomSlotOptions(groups);
    expect(labels(facets[0])).toEqual(['Doble=2', 'Suite=1']);
    expect(labels(facets[1])).toEqual(['Doble=2', 'Suite=1']);
    // La opción es la identidad menor de la clase: no depende del orden de los grupos.
    const doble = facets[1]?.options[0]?.identity;
    expect(doble).toBe('id:despegar-hotels:X');
    expect(roomSlotOptions([...groups].reverse())[1]?.options.map((o) => o.identity)).toContain(
      doble,
    );
    expect(filterGroupsBySlots(groups, { 1: doble }).map((g) => g.title)).toEqual([
      '2 × Doble',
      'Suite + Doble',
    ]);
  });

  it('dos tipos con el mismo nombre: se distinguen por sus camas o, sin ellas, por un número', () => {
    const conCamas = roomSlotOptions(
      roomTypeGroups(
        plans(
          pack('A', 100_00, [
            r('Deluxe Room', occupancyA, { roomTypeId: '1', bedOptions: ['1 cama king'] }),
            r('Suite', occupancyB),
          ]),
          pack('B', 200_00, [
            r('Deluxe Room', occupancyA, { roomTypeId: '2', bedOptions: ['2 camas dobles'] }),
            r('Suite', occupancyB),
          ]),
        ),
      ),
    );
    expect(conCamas[0]?.options.map((o) => o.label)).toEqual([
      'Deluxe Room · 1 cama king',
      'Deluxe Room · 2 camas dobles',
    ]);

    const sinCamas = roomSlotOptions(
      roomTypeGroups(
        plans(
          pack('A', 100_00, [
            r('Deluxe Room', occupancyA, { roomTypeId: '1', bedOptions: ['1 cama king'] }),
            r('Suite', occupancyB),
          ]),
          pack('B', 200_00, [
            r('DELUXE ROOM', occupancyA, { roomTypeId: '2' }),
            r('Suite', occupancyB),
          ]),
          pack('C', 300_00, [r('', occupancyA), r('Suite', occupancyB)]),
        ),
      ),
    );
    expect(sinCamas[0]?.options.map((o) => o.label)).toEqual([
      'Deluxe Room · tipo 1',
      'DELUXE ROOM · tipo 2',
      'Habitación',
    ]);

    // Las mismas camas tampoco distinguen: también por número.
    const mismasCamas = roomSlotOptions(
      roomTypeGroups(
        plans(
          pack('A', 100_00, [room('Twin', { roomTypeId: '1', bedOptions: ['2 camas'] })]),
          pack('B', 200_00, [room('Twin', { roomTypeId: '2', bedOptions: ['2 CAMAS'] })]),
        ),
      ),
    );
    expect(mismasCamas[0]?.options.map((o) => o.label)).toEqual(['Twin · tipo 1', 'Twin · tipo 2']);
  });

  it('sin grupos o sin habitaciones, nada que elegir; un pack sin habitaciones no suma opciones', () => {
    expect(roomSlotOptions([])).toEqual([]);
    expect(roomSlotOptions(roomTypeGroups(plans(pack('A', 100_00, []))))).toEqual([]);
    const facets = roomSlotOptions(
      roomTypeGroups(plans(pack('A', 100_00, []), pack('B', 200_00, [r('Doble', occupancyA)]))),
    );
    expect(labels(facets[0])).toEqual(['Doble=1']);
  });

  it('sin ocupación en las tarifas, la habitación va sin ella', () => {
    const [facet] = roomSlotOptions(roomTypeGroups(plans(pack('A', 100_00, [room('Doble')]))));
    expect(facet).toEqual({
      index: 0,
      options: [{ identity: 'n:doble', label: 'Doble', count: 1 }],
    });
  });

  it('una habitación sin identidad (armada a mano) no es una opción ni cumple una elección', () => {
    const slot: RoomSlot = {
      index: 0,
      name: 'Doble',
      nameKey: 'doble',
      roomTypeIds: {},
      identities: [],
    };
    const groups = [{ slots: [slot] }, { slots: [{ ...slot, identities: ['n:doble'] }] }];
    expect(roomSlotOptions(groups)[0]?.options.map((o) => o.identity)).toEqual(['n:doble']);
    expect(filterGroupsBySlots(groups, { 0: 'n:doble' })).toEqual([groups[1]]);
  });
});

describe('filterGroupsBySlots', () => {
  const groups = roomTypeGroups(
    plans(
      pack('DD', 200_00, [room('Doble'), room('Doble')]),
      pack('DS', 300_00, [room('Doble'), room('Suite')]),
      pack('SD', 350_00, [room('Suite'), room('Doble')]),
      pack('X', 50_00, []),
    ),
  );

  it('sin elección (o con «Cualquier tipo»), todas, en su orden', () => {
    expect(filterGroupsBySlots(groups, {})).toEqual(groups);
    expect(filterGroupsBySlots(groups, { 0: undefined, 1: undefined })).toEqual(groups);
  });

  it('sólo las combinaciones que cumplen cada habitación elegida, sin armar ninguna nueva', () => {
    expect(filterGroupsBySlots(groups, { 0: 'n:doble' }).map((g) => g.title)).toEqual([
      '2 × Doble',
      'Doble + Suite',
    ]);
    expect(filterGroupsBySlots(groups, { 1: 'n:doble' }).map((g) => g.title)).toEqual([
      '2 × Doble',
      'Suite + Doble',
    ]);
    expect(filterGroupsBySlots(groups, { 0: 'n:suite', 1: 'n:doble' }).map((g) => g.title)).toEqual(
      ['Suite + Doble'],
    );
    // «Suite + Suite» no la vende nadie: no aparece.
    expect(filterGroupsBySlots(groups, { 0: 'n:suite', 1: 'n:suite' })).toEqual([]);
  });

  it('una combinación sin la habitación elegida no la cumple', () => {
    expect(filterGroupsBySlots(groups, { 0: 'n:doble' }).some((g) => g.slots.length === 0)).toBe(
      false,
    );
    expect(filterGroupsBySlots(groups, { 2: 'n:doble' })).toEqual([]);
  });
});

describe('knownSlotChoice', () => {
  it('olvida lo elegido que ya no está entre las opciones de esa habitación', () => {
    const facets = roomSlotOptions(
      roomTypeGroups(plans(pack('DS', 300_00, [room('Doble'), room('Suite')]))),
    );
    expect(
      knownSlotChoice(facets, { 0: 'n:doble', 1: 'n:doble', 2: 'n:suite', 3: undefined }),
    ).toEqual({ 0: 'n:doble' });
    expect(knownSlotChoice([], { 0: 'n:doble' })).toEqual({});
  });
});

describe('slotChoiceSummary', () => {
  it('sin nada elegido, nada', () => {
    expect(slotChoiceSummary(3, {})).toBeUndefined();
    expect(slotChoiceSummary(3, { 0: undefined })).toBeUndefined();
  });

  it('cuántas combinaciones quedan, en singular y plural', () => {
    expect(slotChoiceSummary(1, { 0: 'n:doble' })).toBe('1 combinación con esta elección');
    expect(slotChoiceSummary(3, { 0: 'n:doble' })).toBe('3 combinaciones con esta elección');
  });

  it('sin ninguna: la habitación que se tocó por último o, si ya no está elegida, la última', () => {
    const chosen = { 0: 'n:doble', 2: 'n:suite' };
    expect(slotChoiceSummary(0, chosen, 0)).toBe(
      'No hay combinaciones con esa elección: prueba otro tipo para la habitación 1.',
    );
    expect(slotChoiceSummary(0, chosen, 1)).toBe(
      'No hay combinaciones con esa elección: prueba otro tipo para la habitación 3.',
    );
    expect(slotChoiceSummary(0, chosen)).toBe(
      'No hay combinaciones con esa elección: prueba otro tipo para la habitación 3.',
    );
  });
});
