import { PROBE_LAST_NAMES, bookableOptions, certContact, syntheticGuests } from './cases.mjs';
import {
  bookStep,
  cancelStep,
  detailStep,
  prebookStep,
  recoveryStep,
  searchStep,
} from './chain.mjs';
import {
  errorOutcome,
  outcomeOfSearch,
  parsedResponse,
  shortVariant as short,
  variantResult,
} from './harness.mjs';

/**
 * Sondas que RESERVAN en el entorno de test (docs/tbo/07 §6.8): PR-09, PR-10 y PR-11. Sólo corren
 * con `probe --bookings` y cancelan siempre lo que reservaron, pida lo que pida `TBO_CANCEL_AFTER`:
 * no son entregables y nunca entran al zip.
 *
 * Como las demás sondas, el RQ lo arma el ACL; cuando la pregunta es sobre algo que el ACL no manda
 * (tildes, un `TotalFare` distinto), la sonda reescribe ESE campo, lo declara en `calls.jsonl` y
 * guarda al lado el RQ original (`*_RQ.acl.json`). Las guardas D1 del grabador valen igual.
 */

const ONE_ADULT = Object.freeze([Object.freeze({ adults: 1, childrenAges: Object.freeze([]) })]);

const SKIPPED_NO_RATE = 'No se probó: no hubo una tarifa revalidada para reservar.';

/**
 * Un Search del caso 1 y hasta `count` tarifas distintas revalidadas con PreBook: reembolsables
 * primero, para que la cancelación no cueste, y nunca una "sólo paquete" (la aplicación no la
 * vende, RF-17).
 */
async function bookableRates(h, folder, count) {
  const criteria = h.criteriaCaseOne(h.settings.hotelCodes.slice(0, 100));
  const search = await searchStep(h, folder, criteria);
  const variants = [variantResult('Search caso 1', search, outcomeOfSearch(search))];
  const prebooks = [];
  if (search.error !== undefined || search.value === undefined) return { variants, prebooks };
  const options = bookableOptions(search.value);
  const ordered = [
    ...options.filter((o) => o.pack.cancellation.refundable),
    ...options.filter((o) => !o.pack.cancellation.refundable),
  ];
  for (const [index, option] of ordered.entries()) {
    if (prebooks.length >= count) break;
    const prebook = await prebookStep(h, folder, {
      option,
      report: search.value,
      rooms: ONE_ADULT,
    });
    const packageOnly =
      prebook.value?.result.signals?.includes('PACKAGE_WITH_FLIGHT_ONLY') === true;
    const acl = prebook.error
      ? errorOutcome(prebook.error)
      : packageOnly
        ? 'sólo paquete: no se reserva'
        : 'ok';
    variants.push(variantResult(`PreBook opción ${index + 1}`, prebook, acl));
    if (prebook.error === undefined && !packageOnly) prebooks.push(prebook.value);
  }
  return { variants, prebooks, report: search.value };
}

/**
 * Un Book de sonda y, si quedó incierto, su lectura a los 120 s (p. 42). Devuelve el localizador si
 * hay reserva, para cancelarla.
 */
async function probeBook(
  h,
  folder,
  { rates, prebook, guests, bookingReferenceId, label, rewrite },
) {
  const { booking } = h.settings;
  const book = await bookStep(h, folder, {
    prebook,
    report: rates.report,
    rooms: ONE_ADULT,
    guests,
    contact: certContact(booking.email, booking.phone),
    bookingReferenceId,
    label,
    ...(rewrite === undefined ? {} : { rewrite }),
  });
  const { classification } = book;
  const variants = [
    variantResult(
      `Book ${label}`,
      book.result,
      `${classification.outcome}:${classification.reason}`,
    ),
  ];
  let confirmationNumber =
    classification.outcome === 'CONFIRMED' ? book.confirmationNumber : undefined;
  if (classification.outcome === 'UNCERTAIN') {
    const recovery = await recoveryStep(h, folder, bookingReferenceId);
    const found = recovery.error === undefined && recovery.value.found;
    const acl = recovery.error ? errorOutcome(recovery.error) : found ? 'found' : 'found:false';
    variants.push(variantResult('BookingDetail a los 120 s', recovery, acl));
    if (found) confirmationNumber = recovery.value.view.providerBookingId;
  }
  return { classification, confirmationNumber, variants };
}

/** Cancela todo lo que la sonda reservó y dice qué no se pudo confirmar. */
async function cancelAll(h, folder, confirmationNumbers) {
  const variants = [];
  const alive = [];
  for (const number of [...new Set(confirmationNumbers.filter(Boolean))]) {
    const cancel = await cancelStep(h, folder, number);
    variants.push(variantResult(`Cancel ${number}`, cancel.result, cancel.summary.acl));
    if (cancel.summary.success !== true) alive.push(number);
  }
  const note =
    alive.length === 0
      ? ''
      : ` OJO: no se pudo confirmar la cancelación de ${alive.join(', ')}; revisarla en TBO.`;
  return { variants, note };
}

function leadGuestName(detailJson) {
  const guest = detailJson?.BookingDetail?.Rooms?.[0]?.CustomerDetails?.[0]?.CustomerNames?.[0];
  return guest === undefined ? undefined : `${guest.FirstName} ${guest.LastName}`;
}

/**
 * PR-09 (Q-43): tildes y `ñ` en el Book. El ACL translitera a ASCII (D-TBO-23 A), así que la sonda
 * pone de vuelta `José Muñoz` en el RQ que armó el ACL y mira qué devuelve BookingDetail.
 */
async function probeAccentedNames(h, folder) {
  const rates = await bookableRates(h, folder, 1);
  if (rates.prebooks.length === 0) {
    return { skipped: true, variants: rates.variants, reading: SKIPPED_NO_RATE };
  }
  const rewrite = {
    description: 'CustomerNames[0]: Jose Munoz (ASCII del ACL) → José Muñoz',
    body: (json) => {
      const room = json?.CustomerDetails?.[0];
      const name = room?.CustomerNames?.[0];
      if (name?.FirstName !== 'Jose' || name?.LastName !== 'Munoz')
        throw new Error('el ACL ya no translitera José Muñoz a Jose Munoz');
      return {
        ...json,
        CustomerDetails: [
          { ...room, CustomerNames: [{ ...name, FirstName: 'José', LastName: 'Muñoz' }] },
          ...json.CustomerDetails.slice(1),
        ],
      };
    },
  };
  const booked = await probeBook(h, folder, {
    rates,
    prebook: rates.prebooks[0],
    guests: [{ guests: [{ paxType: 'ADT', title: 'Mr', firstName: 'José', lastName: 'Muñoz' }] }],
    bookingReferenceId: h.acl.generateTboBookingReference('test'),
    label: 'tildes',
    rewrite,
  });
  const variants = [...rates.variants, ...booked.variants];
  let echoed;
  if (booked.confirmationNumber !== undefined) {
    const detail = await detailStep(
      h,
      folder,
      { confirmationNumber: booked.confirmationNumber },
      { purpose: 'interactive', label: 'nombres' },
    );
    variants.push(
      variantResult('BookingDetail', detail, detail.error ? errorOutcome(detail.error) : 'ok'),
    );
    echoed = leadGuestName(parsedResponse(detail.calls.at(-1)));
  }
  const cancel = await cancelAll(h, folder, [booked.confirmationNumber]);
  variants.push(...cancel.variants);
  const book = booked.variants[0];
  let reading;
  if (booked.classification.outcome === 'CONFIRMED') {
    reading =
      `TBO acepta tildes y ñ en el Book (${short(book)}). BookingDetail devuelve ` +
      `"${echoed ?? 'sin nombre'}"` +
      (echoed === 'José Muñoz'
        ? ': intactos. Se puede evaluar mandarlos en UTF-8 (D-TBO-23 C).'
        : ': alterados o ausentes. Se mantiene la transliteración (D-TBO-23 A).');
  } else if (booked.classification.outcome === 'FAILED') {
    reading = `TBO rechaza tildes y ñ (${short(book)}). Se mantiene la transliteración (D-TBO-23 A).`;
  } else {
    reading = `El Book quedó incierto (${booked.classification.reason}); no contesta Q-43.`;
  }
  return { variants, reading: reading + cancel.note };
}

/** `85.82` + 0.01 sobre el literal decimal, sin pasar por coma flotante. */
export function addOneCent(literal) {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(literal);
  if (match === null) throw new Error('TotalFare no es un decimal');
  const fraction = match[2] ?? '';
  const decimals = Math.max(2, fraction.length);
  const scaled =
    BigInt(`${match[1]}${fraction.padEnd(decimals, '0')}`) + 10n ** BigInt(decimals - 2);
  const digits = scaled.toString().padStart(decimals + 1, '0');
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

/** PR-10 (Q-33): el Book con `TotalFare` 0.01 por encima del PreBook. */
async function probeFareMismatch(h, folder) {
  const rates = await bookableRates(h, folder, 1);
  if (rates.prebooks.length === 0) {
    return { skipped: true, variants: rates.variants, reading: SKIPPED_NO_RATE };
  }
  const [prebook] = rates.prebooks;
  const plus = addOneCent(prebook.pack.totalFare);
  const rewrite = {
    description: `TotalFare: ${prebook.pack.totalFare} (PreBook) → ${plus}`,
    body: (json) => {
      if (json?.TotalFare !== Number(prebook.pack.totalFare))
        throw new Error('el ACL no mandó el TotalFare del PreBook');
      return { ...json, TotalFare: Number(plus) };
    },
  };
  const booked = await probeBook(h, folder, {
    rates,
    prebook,
    guests: syntheticGuests(ONE_ADULT, PROBE_LAST_NAMES[0]),
    bookingReferenceId: h.acl.generateTboBookingReference('test'),
    label: 'mas-un-centavo',
    rewrite,
  });
  const cancel = await cancelAll(h, folder, [booked.confirmationNumber]);
  const book = booked.variants[0];
  const { outcome, reason } = booked.classification;
  const reading =
    outcome === 'CONFIRMED'
      ? `TBO acepta un TotalFare 0.01 por encima del PreBook (${short(book)}): no lo valida contra el PreBook o tiene tolerancia. El ACL sigue mandando el literal del PreBook.`
      : outcome === 'FAILED'
        ? `TBO rechaza un TotalFare distinto del PreBook: ${short(book)}.`
        : `El Book quedó incierto (${reason}); no contesta Q-33.`;
  return {
    variants: [...rates.variants, ...booked.variants, ...cancel.variants],
    reading: reading + cancel.note,
  };
}

/** PR-11 (Q-35): dos Book con el mismo `BookingReferenceId` y `BookingCode` distintos. */
async function probeBookIdempotency(h, folder) {
  const rates = await bookableRates(h, folder, 2);
  if (rates.prebooks.length < 2) {
    return {
      skipped: true,
      variants: rates.variants,
      reading: 'No se probó: hacen falta dos tarifas distintas revalidadas en el mismo Search.',
    };
  }
  const reference = h.acl.generateTboBookingReference('test');
  const guests = syntheticGuests(ONE_ADULT, PROBE_LAST_NAMES[1]);
  const first = await probeBook(h, folder, {
    rates,
    prebook: rates.prebooks[0],
    guests,
    bookingReferenceId: reference,
    label: 'primero',
  });
  if (first.classification.outcome !== 'CONFIRMED') {
    // Sin una primera reserva confirmada el segundo Book no contesta Q-35 y sólo sumaría otra
    // reserva de test (o un duplicado de una que quizá existe).
    const cancel = await cancelAll(h, folder, [first.confirmationNumber]);
    return {
      variants: [...rates.variants, ...first.variants, ...cancel.variants],
      reading:
        `El primer Book no confirmó (${first.classification.reason}); no se manda el segundo y ` +
        `no contesta Q-35.${cancel.note}`,
    };
  }
  const second = await probeBook(h, folder, {
    rates,
    prebook: rates.prebooks[1],
    guests,
    bookingReferenceId: reference,
    label: 'segundo-misma-referencia',
  });
  const byReference = await detailStep(
    h,
    folder,
    { bookingReferenceId: reference },
    { purpose: 'verification', label: 'por-referencia' },
  );
  const found = byReference.error === undefined && byReference.value.found;
  const foundNumber = found ? byReference.value.view.providerBookingId : undefined;
  const cancel = await cancelAll(h, folder, [
    first.confirmationNumber,
    second.confirmationNumber,
    foundNumber,
  ]);
  let reading;
  if (second.classification.outcome === 'FAILED') {
    reading = `TBO rechaza el segundo Book con la misma referencia (${short(second.variants[0])}): (b).`;
  } else if (
    second.confirmationNumber !== undefined &&
    second.confirmationNumber === first.confirmationNumber
  ) {
    reading = `TBO devuelve la reserva existente (${first.confirmationNumber}): el Book es idempotente por BookingReferenceId, (a).`;
  } else if (second.confirmationNumber !== undefined) {
    reading =
      `TBO crea OTRA reserva (${first.confirmationNumber} y ${second.confirmationNumber}): el ` +
      `BookingReferenceId no protege de un duplicado, (c). BookingDetail por la referencia devuelve ` +
      `${foundNumber ?? 'ninguna'}. Se confirma que el Book nunca se reintenta (D-TBO-24 A).`;
  } else {
    reading = `El segundo Book quedó incierto (${second.classification.reason}); no contesta Q-35.`;
  }
  return {
    variants: [
      ...rates.variants,
      ...first.variants,
      ...second.variants,
      variantResult(
        'BookingDetail por la referencia',
        byReference,
        found ? 'found' : 'found:false',
      ),
      ...cancel.variants,
    ],
    reading: reading + cancel.note,
  };
}

export const BOOKING_PROBES = Object.freeze([
  {
    id: 'PR-09',
    question: 'Q-43',
    title: 'Book con tildes y ñ en los nombres',
    run: probeAccentedNames,
  },
  {
    id: 'PR-10',
    question: 'Q-33',
    title: 'Book con TotalFare 0.01 por encima del PreBook',
    run: probeFareMismatch,
  },
  {
    id: 'PR-11',
    question: 'Q-35',
    title: 'Dos Book con el mismo BookingReferenceId',
    run: probeBookIdempotency,
  },
]);
