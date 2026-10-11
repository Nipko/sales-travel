import { describe, expect, it } from 'vitest';
import type { HotelRoomItem, HotelRoompack } from '../actions';
import { hotelRateRows, type HotelRateRow } from './hotel-rate-view';
import { rateRefundability, type RateRefundability } from './rate-refundability';
import {
  ROOM_NAME_VECTORS,
  normalizeRoomName,
  occupancyText,
  roomDisplayName,
  roomTypeGroups,
  roomTypesCountText,
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
