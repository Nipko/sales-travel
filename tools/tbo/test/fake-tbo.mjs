import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Un TBO falso con forma de `fetch`, para correr el arnés sin credenciales ni red. Las respuestas
 * de éxito salen de los fixtures del PDF que usa el propio ACL (`providers/tbo-hotels/src/__fixtures__`),
 * así que lo que el ACL lee aquí es lo que ya sabe leer. Las de error son las posturas de
 * docs/tbo/01 §8: nadie sabe todavía qué manda TBO, que es justo lo que las sondas van a contestar.
 *
 * Tiene estado: cada Search emite `BookingCode` nuevos, PreBook sólo acepta los emitidos, Book crea
 * una reserva que BookingDetail encuentra por localizador y por referencia, y Cancel la cancela.
 */

const PDF_FIXTURES = resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'providers',
  'tbo-hotels',
  'src',
  '__fixtures__',
  'pdf',
);

function fixture(name) {
  return JSON.parse(readFileSync(join(PDF_FIXTURES, name), 'utf8'));
}

export const TEST_USERNAME = 'cert-user-7';
// Con espacio y comillas: la redacción tiene que encontrarla también escapada dentro de un JSON.
export const TEST_PASSWORD = 'pa ss"word-9Q';
export const TEST_TOKEN = Buffer.from(`${TEST_USERNAME}:${TEST_PASSWORD}`, 'utf8').toString(
  'base64',
);

/** La línea de p. 28 que el ACL lee como tarifa "sólo con billete aéreo". */
const PACKAGE_ONLY_CONDITION =
  'Please note that this a special rate which should be sold only with an airline ticket as part of a package.';

function envelope(code, description, extra = {}) {
  return JSON.stringify({ Status: { Code: code, Description: description }, ...extra });
}

function respond(status, body, contentType = 'application/json; charset=utf-8') {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

const DAY_MS = 86_400_000;

/** `dd-mm-yyyy 00:00:00`, el formato de `CancelPolicies[].FromDate` (p. 28). */
function tboDate(isoDay, offsetDays) {
  const d = new Date(Date.parse(`${isoDay}T00:00:00Z`) + offsetDays * DAY_MS);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${d.getUTCFullYear()} 00:00:00`;
}

function nightsBetween(checkIn, checkOut) {
  return Math.max(1, Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / DAY_MS));
}

/**
 * @param {object} [behavior]
 * @param {boolean} [behavior.tls] `https://` responde; si no, la conexión se rechaza.
 * @param {boolean} [behavior.caseSensitive] El routing distingue mayúsculas (`/search` da 404).
 * @param {boolean} [behavior.rejectEmptyAges] `ChildrenAges: []` sin niños da 400.
 * @param {boolean} [behavior.rejectOmittedAges] Sin `ChildrenAges` da 400.
 * @param {boolean} [behavior.acceptMealOrdinal] `MealType: 0` pasa.
 * @param {number} [behavior.maxHotelCodes] Más códigos que esto da 400.
 * @param {number} [behavior.searchCode] `Status.Code` de un Search válido (200 o 201).
 * @param {number[]} [behavior.searchSequence] `Status.Code` de los primeros Search, en orden.
 * @param {string} [behavior.searchDescription] `Status.Description` de un Search válido.
 * @param {string} [behavior.searchCurrency] `Currency` del hotel en un Search válido.
 * @param {string} [behavior.searchBody] Cuerpo literal de un Search válido, en lugar del fixture.
 * @param {'all'|'none'|'multi-room'} [behavior.supplements] Qué tarifas traen suplementos AtProperty.
 * @param {boolean} [behavior.refundable] La segunda tarifa es reembolsable (y más cara).
 * @param {number[]} [behavior.prebookSequence] `Status.Code` de los primeros PreBook, en orden.
 * @param {boolean} [behavior.packageOnly] Las `RateConditions` de PreBook dicen "sólo paquete".
 * @param {'reject'|'accept'} [behavior.fareMismatch] Book con `TotalFare` distinto del PreBook.
 * @param {'duplicate'|'existing'|'reject'} [behavior.sameReference] Segundo Book con la misma referencia.
 * @param {number[]} [behavior.bookSequence] `Status.Code` de los primeros Book; `0` = corte de red
 *   que igual crea la reserva; `-1` = corte de red sin reserva.
 * @param {boolean} [behavior.mangleNames] BookingDetail devuelve las tildes como `?`.
 * @param {number} [behavior.cancelCode] `Status.Code` del Cancel (200 por defecto; 479 rechaza).
 * @param {string} [behavior.expectedToken] El Basic que acepta; por defecto el de las constantes.
 * @param {number} [behavior.cityHotels] Hoteles de `TBOHotelCodeList`; por defecto el del fixture.
 */
export function createFakeTbo(behavior = {}) {
  const b = {
    tls: false,
    caseSensitive: true,
    rejectEmptyAges: false,
    rejectOmittedAges: true,
    acceptMealOrdinal: false,
    maxHotelCodes: 100,
    searchCode: 200,
    searchSequence: [],
    searchDescription: 'Successful',
    searchCurrency: 'USD',
    searchBody: undefined,
    supplements: 'all',
    refundable: true,
    prebookSequence: [],
    packageOnly: false,
    fareMismatch: 'reject',
    sameReference: 'duplicate',
    bookSequence: [],
    mangleNames: false,
    cancelCode: 200,
    expectedToken: TEST_TOKEN,
    ...behavior,
  };
  const searchCodes = [...b.searchSequence];
  const prebookCodes = [...b.prebookSequence];
  const bookCodes = [...b.bookSequence];
  const requests = [];
  /** `BookingCode` → la tarifa que emitió un Search. */
  const rates = new Map();
  /** `ConfirmationNumber` → la reserva. */
  const bookings = new Map();
  let bookingSeq = 0;

  function searchResponse(body, codes) {
    const template = fixture('search-single-room.p15.json');
    const [model] = template.HotelResult[0].Rooms;
    const roomCount = body.PaxRooms.length;
    const session = randomUUID();
    const hotelCode = codes[0];
    const withSupplements =
      b.supplements === 'all' || (b.supplements === 'multi-room' && roomCount > 1);
    const options = [
      { name: 'Luxury Room, 1 King Bed', fare: 152.88, refundable: false },
      { name: 'Luxury Room, 2 Twin Beds', fare: 160.1, refundable: b.refundable },
    ];
    const rooms = options.map((option, i) => {
      const bookingCode = `${hotelCode}!TB!${i + 1}!TB!${session}`;
      const totalFare = Number((option.fare * roomCount).toFixed(2));
      const supplements = withSupplements
        ? Array.from({ length: roomCount }, (_, r) => [
            {
              Index: r + 1,
              Type: 'AtProperty',
              Description: 'mandatory_tax',
              Price: 20.0,
              Currency: 'AED',
            },
          ])
        : undefined;
      rates.set(bookingCode, {
        hotelCode,
        roomCount,
        name: option.name,
        totalFare,
        refundable: option.refundable,
        supplements,
        checkIn: body.CheckIn,
        checkOut: body.CheckOut,
      });
      const room = {
        ...model,
        Name: Array.from({ length: roomCount }, () => option.name),
        BookingCode: bookingCode,
        TotalFare: totalFare,
        TotalTax: Number((28.12 * roomCount).toFixed(2)),
        RecommendedSellingRate: String((totalFare * 1.05).toFixed(2)),
        RoomPromotion: Array.from({ length: roomCount }, () => 'Private sale'),
        IsRefundable: option.refundable,
      };
      if (supplements === undefined) delete room.Supplements;
      else room.Supplements = supplements;
      return room;
    });
    return JSON.stringify({
      Status: { Code: 200, Description: b.searchDescription },
      HotelResult: [{ HotelCode: hotelCode, Currency: b.searchCurrency, Rooms: rooms }],
    });
  }

  function prebookResponse(rate, bookingCode) {
    const template = fixture('prebook-limit-multi-room.p28.json');
    const [model] = template.HotelResult[0].Rooms;
    const nights = nightsBetween(rate.checkIn, rate.checkOut);
    const policies = rate.refundable
      ? [
          { FromDate: tboDate(rate.checkIn, -30), ChargeType: 'Fixed', CancellationCharge: 0.0 },
          {
            FromDate: tboDate(rate.checkIn, -3),
            ChargeType: 'Percentage',
            CancellationCharge: 100.0,
          },
        ]
      : [
          {
            FromDate: tboDate(rate.checkIn, -40),
            ChargeType: 'Percentage',
            CancellationCharge: 100.0,
          },
        ];
    const room = {
      ...model,
      Name: Array.from({ length: rate.roomCount }, () => rate.name),
      BookingCode: bookingCode,
      DayRates: Array.from({ length: rate.roomCount }, () =>
        Array.from({ length: nights }, () => ({ BasePrice: 60.5 })),
      ),
      TotalFare: rate.totalFare,
      TotalTax: Number((28.12 * rate.roomCount).toFixed(2)),
      RecommendedSellingRate: String((rate.totalFare * 1.05).toFixed(2)),
      RoomPromotion: Array.from({ length: rate.roomCount }, () => 'Private sale'),
      CancelPolicies: policies,
      IsRefundable: rate.refundable,
      Amenities: ['Free WiFi', 'Non-Smoking'],
    };
    if (rate.supplements === undefined) delete room.Supplements;
    else room.Supplements = rate.supplements;
    const conditions = template.HotelResult[0].RateConditions.filter(
      (line) => !line.includes('airline ticket'),
    );
    return JSON.stringify({
      Status: { Code: 200, Description: 'Successful' },
      HotelResult: [
        {
          HotelCode: rate.hotelCode,
          Currency: b.searchCurrency,
          Rooms: [room],
          RateConditions: b.packageOnly ? [PACKAGE_ONLY_CONDITION, ...conditions] : conditions,
        },
      ],
    });
  }

  function mangle(text) {
    return b.mangleNames ? String(text).replace(/[^\x20-\x7e]/g, '?') : text;
  }

  function detailResponse(booking) {
    const template = fixture('booking-detail.p49.json');
    const [model] = template.BookingDetail.Rooms;
    const perRoom = Number((booking.totalFare / booking.roomCount).toFixed(2));
    return JSON.stringify({
      Status: { Code: 200, Description: 'Successful' },
      BookingDetail: {
        ...template.BookingDetail,
        BookingStatus: booking.status,
        ConfirmationNumber: booking.confirmationNumber,
        InvoiceNumber: `MW${booking.seq}`,
        CheckIn: `${booking.checkIn}T00:00:00`,
        CheckOut: `${booking.checkOut}T00:00:00`,
        BookingDate: '2026-09-26T00:00:00',
        NoOfRooms: booking.roomCount,
        Rooms: booking.customerDetails.map((details) => ({
          ...model,
          Name: [booking.name],
          TotalFare: perRoom,
          IsRefundable: booking.refundable,
          CustomerDetails: [
            {
              CustomerNames: details.CustomerNames.map((guest) => ({
                ...guest,
                FirstName: mangle(guest.FirstName),
                LastName: mangle(guest.LastName),
              })),
            },
          ],
        })),
      },
    });
  }

  function book(body) {
    const rate = rates.get(body.BookingCode);
    if (rate === undefined) return respond(200, envelope(207, 'Rate is not available'));
    if (body.TotalFare !== rate.totalFare && b.fareMismatch === 'reject') {
      return respond(200, envelope(400, 'TotalFare does not match'));
    }
    const existing = [...bookings.values()].find(
      (x) => x.reference === body.BookingReferenceId && x.status !== 'Cancelled',
    );
    if (existing !== undefined && b.sameReference === 'reject') {
      return respond(200, envelope(400, 'Duplicate BookingReferenceId'));
    }
    if (existing !== undefined && b.sameReference === 'existing') {
      return respond(
        200,
        envelope(200, 'Successful', {
          ClientReferenceId: body.ClientReferenceId,
          ConfirmationNumber: existing.confirmationNumber,
        }),
      );
    }
    bookingSeq += 1;
    const confirmationNumber = `FK${String(bookingSeq).padStart(4, '0')}`;
    bookings.set(confirmationNumber, {
      seq: bookingSeq,
      confirmationNumber,
      reference: body.BookingReferenceId,
      status: 'Confirmed',
      roomCount: rate.roomCount,
      name: rate.name,
      totalFare: body.TotalFare,
      refundable: rate.refundable,
      checkIn: rate.checkIn,
      checkOut: rate.checkOut,
      customerDetails: body.CustomerDetails,
    });
    return respond(
      200,
      envelope(200, 'Successful', {
        ClientReferenceId: body.ClientReferenceId,
        ConfirmationNumber: confirmationNumber,
      }),
    );
  }

  function requireLimit(body) {
    return body?.PaymentMode === 'Limit'
      ? undefined
      : respond(200, envelope(400, 'PaymentMode is required'));
  }

  async function fetch(input, init = {}) {
    const url = new URL(String(input));
    const authorization = new Headers(init.headers).get('authorization');
    requests.push({
      url: url.href,
      method: init.method ?? 'GET',
      body: init.body,
      authorization,
      redirect: init.redirect,
    });

    if (url.protocol === 'https:' && !b.tls) {
      const cause = Object.assign(new Error('connect ECONNREFUSED 203.0.113.7:443'), {
        code: 'ECONNREFUSED',
      });
      throw new TypeError('fetch failed', { cause });
    }
    if (authorization !== `Basic ${b.expectedToken}`) {
      return respond(401, envelope(401, 'Access Credentials is incorrect'));
    }

    const segment = url.pathname.split('/').pop() ?? '';
    const route = b.caseSensitive ? segment : segment.toLowerCase();
    const is = (name) => route === (b.caseSensitive ? name : name.toLowerCase());
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;

    if (is('Search')) {
      const codes = String(body.HotelCodes).split(',');
      if (codes.length > b.maxHotelCodes)
        return respond(200, envelope(400, 'HotelCodes limit exceeded'));
      if (typeof body.Filters?.MealType === 'number' && !b.acceptMealOrdinal) {
        return respond(200, envelope(400, 'Invalid MealType'));
      }
      for (const room of body.PaxRooms) {
        if (room.Children !== 0) continue;
        if (room.ChildrenAges === undefined && b.rejectOmittedAges) {
          return respond(200, envelope(400, 'ChildrenAges is required'));
        }
        if (
          Array.isArray(room.ChildrenAges) &&
          room.ChildrenAges.length === 0 &&
          b.rejectEmptyAges
        ) {
          return respond(200, envelope(400, 'ChildrenAges is invalid'));
        }
      }
      const code = searchCodes.length > 0 ? searchCodes.shift() : b.searchCode;
      if (code === 201) {
        return respond(200, envelope(201, 'No Available rooms for given criteria'));
      }
      if (b.searchBody !== undefined) return respond(200, b.searchBody);
      return respond(200, searchResponse(body, codes));
    }
    if (is('HotelDetails')) {
      const payload = fixture('hotel-details.p59.json');
      payload.HotelDetails[0].HotelCode = String(body.Hotelcodes).split(',')[0];
      return respond(200, JSON.stringify(payload));
    }
    if (is('BookingDetailsbasedondate')) return respond(200, envelope(201, 'No booking found'));
    if (is('hotelcodelist')) {
      const codes = Array.from({ length: 150 }, (_, i) => 1_000_000 + i);
      return respond(200, JSON.stringify({ HotelCodes: codes }));
    }
    if (is('TBOHotelCodeList')) {
      const payload = fixture('tbo-hotel-code-list.p67.json');
      if (b.cityHotels !== undefined) {
        const [model] = payload.Hotels;
        payload.Hotels = Array.from({ length: b.cityHotels }, (_, i) => ({
          ...model,
          HotelCode: String(3_000_000 + i),
        }));
      }
      return respond(200, JSON.stringify(payload));
    }
    if (is('BookingDetail')) {
      const missing = requireLimit(body);
      if (missing) return missing;
      const booking =
        body.ConfirmationNumber !== undefined
          ? bookings.get(body.ConfirmationNumber)
          : [...bookings.values()].find((x) => x.reference === body.BookingReferenceId);
      if (booking === undefined) return respond(200, envelope(400, 'Booking not found'));
      return respond(200, detailResponse(booking));
    }
    if (is('PreBook')) {
      const missing = requireLimit(body);
      if (missing) return missing;
      const rate = rates.get(body.BookingCode);
      if (rate === undefined) return respond(200, envelope(207, 'Rate is not available'));
      const code = prebookCodes.length > 0 ? prebookCodes.shift() : 200;
      if (code !== 200) return respond(200, envelope(code, 'Rate is not available'));
      return respond(200, prebookResponse(rate, body.BookingCode));
    }
    if (is('Book')) {
      const missing = requireLimit(body);
      if (missing) return missing;
      const code = bookCodes.length > 0 ? bookCodes.shift() : 200;
      if (code === 0 || code === -1) {
        if (code === 0) book(body);
        const cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        throw new TypeError('fetch failed', { cause });
      }
      if (code !== 200) return respond(200, envelope(code, 'Booking rejected'));
      return book(body);
    }
    if (is('Cancel')) {
      const booking = bookings.get(body.ConfirmationNumber);
      if (booking === undefined || b.cancelCode !== 200) {
        return respond(200, envelope(479, 'Cancellation failed'));
      }
      booking.status = 'Cancelled';
      return respond(
        200,
        envelope(200, 'Cancelled', { ConfirmationNumber: booking.confirmationNumber }),
      );
    }
    return respond(
      404,
      '<html><body>404 - File or directory not found.</body></html>',
      'text/html',
    );
  }

  return { fetch, requests, bookings };
}
