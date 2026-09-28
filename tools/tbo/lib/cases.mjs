/**
 * Los 8 casos de certificación de TBO (docs/tbo/07-certificacion.md §4.2), los huéspedes sintéticos
 * con que se reservan y la elección de la tarifa. Todo puro: lo usan `run`, `verify` y las sondas.
 *
 * Los `PaxRooms` NO se escriben aquí: se escribe la ocupación neutral (`rooms`) y el builder del ACL
 * arma el `PaxRooms` de producción, que es lo que TBO tiene que ver (07 §6.1). La tabla de 07 §4.2
 * es el resultado esperado, y la guarda G-7 lo comprueba sobre los bytes que salieron.
 */

/** Ocupación de un caso, en el vocabulario neutral de `HotelRoomOccupancy`. */
const room = (adults, childrenAges = []) => Object.freeze({ adults, childrenAges });

/**
 * - `occupancyText`: el texto de TBO (Cert), para el `README.txt` en inglés.
 * - `lastName`: `Test` + el número del caso en letras (07 §4.1).
 * - `occupancyOf`: el caso 7 usa la ocupación del 4 y, si no hay suplementos, la del 1 (07 §4.9).
 * - `detailOf`: el caso 8 no reserva; lee la reserva del caso 4 (07 §4.10).
 */
export const CERT_CASES = Object.freeze([
  {
    id: 1,
    slug: '1Room_1A',
    occupancyText: 'Room 1 - Adult 1',
    rooms: [room(1)],
    nationality: 'CO',
    lastName: 'Testuno',
  },
  {
    id: 2,
    slug: '1Room_1A1C',
    occupancyText: 'Room 1 - Adult 1, Child 1',
    rooms: [room(1, [7])],
    nationality: 'PE',
    lastName: 'Testdos',
  },
  {
    id: 3,
    slug: '1Room_2A2C',
    occupancyText: 'Room 1 - Adult 2, Child 2',
    rooms: [room(2, [4, 10])],
    nationality: 'BR',
    lastName: 'Testtres',
  },
  {
    id: 4,
    slug: '2Rooms_1A_1A',
    occupancyText: 'Room 1 - Adult 1; Room 2 - Adult 1',
    rooms: [room(1), room(1)],
    nationality: 'MX',
    lastName: 'Testcuatro',
  },
  {
    id: 5,
    slug: '2Rooms_1A1C_1A',
    occupancyText: 'Room 1 - Adult 1, Child 1; Room 2 - Adult 1',
    rooms: [room(1, [8]), room(1)],
    nationality: 'CL',
    lastName: 'Testcinco',
  },
  {
    id: 6,
    slug: '2Rooms_1A2C_2A',
    occupancyText: 'Room 1 - Adult 1, Child 2; Room 2 - Adult 2',
    rooms: [room(1, [3, 11]), room(2)],
    nationality: 'AR',
    lastName: 'Testseis',
  },
  {
    id: 7,
    slug: 'Supplements',
    occupancyText: 'Booking room with supplements',
    occupancyOf: [4, 1],
    nationality: 'EC',
    lastName: 'Testsiete',
    selection: 'supplements',
  },
  {
    id: 8,
    slug: 'BookingDetail_OfCase04',
    occupancyText: 'BookingDetail of case 04 by ConfirmationNumber and by BookingReferenceId',
    detailOf: 4,
  },
]);

export const CASE_IDS = Object.freeze(CERT_CASES.map((c) => c.id));

export function certCase(id) {
  const found = CERT_CASES.find((c) => c.id === id);
  if (found === undefined) throw new RangeError(`caso ${id} fuera de 1-8`);
  return found;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** `Case01_1Room_1A`; el 7 lleva además la ocupación que terminó usando (07 §5). */
export function caseFolderName(caseDef, usedOccupancyOf) {
  const base = `Case${pad2(caseDef.id)}_${caseDef.slug}`;
  if (caseDef.selection !== 'supplements' || usedOccupancyOf === undefined) return base;
  return `${base}_${certCase(usedOccupancyOf).slug}`;
}

/** Las ocupaciones a probar, en orden: una sola, salvo el caso 7. */
export function caseOccupancies(caseDef) {
  if (caseDef.occupancyOf !== undefined) {
    return caseDef.occupancyOf.map((id) => ({ occupancyOf: id, rooms: certCase(id).rooms }));
  }
  return [{ occupancyOf: undefined, rooms: caseDef.rooms }];
}

/**
 * Los casos que corre `run`. El 8 lee la reserva del 4 antes de que se cancele, así que pedir uno
 * es pedir los dos: un caso 8 de otra corrida hablaría de una reserva que ya no es la del zip.
 */
export function expandCaseSelection(ids) {
  const set = new Set(ids);
  if (set.has(4) || set.has(8)) {
    set.add(4);
    set.add(8);
  }
  return CASE_IDS.filter((id) => set.has(id));
}

// ───────────────────────── Huéspedes sintéticos ─────────────────────────

/**
 * La lista fija del arnés (07 §6.6; guarda G-4). Sólo ASCII: el ACL translitera (D-TBO-23 A) y un
 * nombre que cambiara al salir dejaría de ser el de la lista. Los niños llevan `Mr` o `Ms`, como los
 * ejemplos del PDF (p. 34, 39; Q-41). Con esta asignación, el caso 6 sale exactamente como la
 * plantilla de 07 §4.8.
 */
export const SYNTHETIC_ADULTS = Object.freeze([
  { title: 'Mr', firstName: 'Mateo' },
  { title: 'Mrs', firstName: 'Paula' },
  { title: 'Mr', firstName: 'Andres' },
  { title: 'Ms', firstName: 'Valeria' },
  { title: 'Mr', firstName: 'Diego' },
  { title: 'Mrs', firstName: 'Camila' },
  { title: 'Mr', firstName: 'Sebastian' },
  { title: 'Ms', firstName: 'Daniela' },
]);

export const SYNTHETIC_CHILDREN = Object.freeze([
  { title: 'Ms', firstName: 'Lucia' },
  { title: 'Mr', firstName: 'Tomas' },
  { title: 'Ms', firstName: 'Sofia' },
  { title: 'Mr', firstName: 'Martin' },
]);

/** Apellidos de las sondas con reserva (PR-10, PR-11); PR-09 manda tildes a propósito. */
export const PROBE_LAST_NAMES = Object.freeze(['Testdiez', 'Testonce']);

export const SYNTHETIC_FIRST_NAMES = Object.freeze(
  [...SYNTHETIC_ADULTS, ...SYNTHETIC_CHILDREN].map((g) => g.firstName),
);

export const SYNTHETIC_LAST_NAMES = Object.freeze([
  ...CERT_CASES.filter((c) => c.lastName !== undefined).map((c) => c.lastName),
  ...PROBE_LAST_NAMES,
]);

/**
 * Huéspedes por habitación (`HotelBookingRoomGuests[]`), en el orden de la ocupación: un adulto
 * primero en cada habitación y todos nombrados (07 §4.5-4.8; Q-42). Los nombres se reparten en
 * orden y no se repiten dentro de la reserva (el ACL rechaza dos huéspedes iguales, RF-18 CA-4).
 */
export function syntheticGuests(rooms, lastName) {
  let adult = 0;
  let child = 0;
  const take = (pool, index, paxType, age) => {
    const pick = pool[index];
    if (pick === undefined) throw new RangeError(`no hay más nombres sintéticos de ${paxType}`);
    return {
      paxType,
      title: pick.title,
      firstName: pick.firstName,
      lastName,
      ...(age === undefined ? {} : { age }),
    };
  };
  return rooms.map((r) => ({
    guests: [
      ...Array.from({ length: r.adults }, () => take(SYNTHETIC_ADULTS, adult++, 'ADT')),
      ...r.childrenAges.map((age) => take(SYNTHETIC_CHILDREN, child++, 'CHD', age)),
    ],
  }));
}

/**
 * `TBO_CERT_PHONE` → el teléfono del contacto neutral. El ACL concatena prefijo y número y los manda
 * sólo con dígitos (p. 35-36): cómo se parta no cambia lo que sale.
 */
export function certContact(email, phoneDigits) {
  return {
    email,
    phone: { countryCode: phoneDigits.slice(0, 2), number: phoneDigits.slice(2) },
  };
}

// ───────────────────────── Elección de tarifa ─────────────────────────

/** El criterio neutral de un Search de caso. `currency` no viaja (TBO cotiza en la del perfil). */
export function caseCriteria({ hotelCodes, checkIn, checkOut, rooms, nationality }) {
  return {
    hotelIds: [...hotelCodes],
    checkinDate: checkIn,
    checkoutDate: checkOut,
    rooms: rooms.map((r) => ({ adults: r.adults, childrenAges: [...r.childrenAges] })),
    currency: 'USD',
    guestNationality: nationality,
    refundableOnly: false,
  };
}

/**
 * Qué identifica a una tarifa entre dos Search: el `BookingCode` cambia en cada uno. Sirve para no
 * volver a elegir una que la aplicación no reservaría (sólo paquete).
 */
export function packSignature(hotelId, pack) {
  return [
    hotelId,
    pack.rooms.map((r) => r.name).join(' / '),
    pack.mealTypeRaw ?? pack.board,
    String(pack.cancellation.refundable),
  ].join('|');
}

function fareValue(text) {
  const value = Number(text);
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

/**
 * Las opciones reservables de un reporte de Search del ACL: cada roompack con el contexto que
 * PreBook y Book reenvían (`TboSearchPackContext`), en el orden en que TBO las devolvió.
 */
export function bookableOptions(report, excluded = new Set()) {
  const contexts = new Map((report?.packs ?? []).map((p) => [p.bookingCode, p]));
  const options = [];
  for (const offer of report?.offers ?? []) {
    for (const pack of offer.roompacks) {
      const context = contexts.get(pack.id);
      if (context === undefined) continue;
      const signature = packSignature(offer.hotelId, pack);
      if (excluded.has(signature)) continue;
      options.push({ hotelId: offer.hotelId, pack, context, signature });
    }
  }
  return options;
}

/**
 * La tarifa del caso (07 §4.1 y §4.9):
 *
 * - casos 1 a 6: la reembolsable más barata (se cancela sin cargo en test); si no hay, la más barata;
 * - caso 7: la primera con un suplemento `AtProperty`; si ninguna, la primera con `Included`, y se
 *   anota. Sin suplementos no hay caso 7 (G-11).
 *
 * Devuelve `undefined` si no hay ninguna que sirva.
 */
export function selectOption(options, mode = 'refundable') {
  if (mode === 'supplements') {
    const atProperty = options.find((o) => (o.pack.atPropertyCharges?.length ?? 0) > 0);
    if (atProperty !== undefined) return { ...atProperty, supplementType: 'AtProperty' };
    const included = options.find((o) => (o.pack.includedSupplements?.length ?? 0) > 0);
    if (included !== undefined) return { ...included, supplementType: 'Included' };
    return undefined;
  }
  const refundable = options.filter((o) => o.pack.cancellation.refundable);
  const pool = refundable.length > 0 ? refundable : options;
  let best;
  for (const option of pool) {
    if (
      best === undefined ||
      fareValue(option.context.totalFare) < fareValue(best.context.totalFare)
    )
      best = option;
  }
  return best;
}

/** `mandatory_tax 20.00 AED (room 1)`: lo que el `README.txt` dice de cada suplemento. */
export function describeFees(fees, type) {
  return (fees ?? []).map((fee) => {
    const amount =
      fee.amountText ?? (fee.amount.amountMinor / 100).toFixed(2).replace(/^-0\.00$/, '0.00');
    const where = fee.roomIndex === undefined ? 'booking' : `room ${fee.roomIndex}`;
    return `${type} ${fee.descriptionRaw ?? fee.description} ${amount} ${fee.amount.currency} (${where})`;
  });
}
