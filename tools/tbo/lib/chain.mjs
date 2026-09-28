import { bookableOptions, describeFees, selectOption } from './cases.mjs';
import { errorOutcome, searchOutcome } from './harness.mjs';

/**
 * La cadena de una reserva de test, en el orden de la certificación: Search > PreBook > Book >
 * BookingDetail > Cancel (Cert, Integration on Test Account; 07 §2.4). Cada paso llama al ACL de
 * producción con el `fetch` grabador: lo que queda en disco es lo que mandaría la aplicación.
 *
 * Reintentos (07 §6.5): los del cliente del ACL y nada más. El Book y el Cancel NUNCA se repiten.
 * Un Book incierto se resuelve como en producción: 120 s y BookingDetail por `BookingReferenceId`
 * (p. 42; CK-14). Lo que esta función decide es qué hace el caso DESPUÉS de una cadena que no
 * terminó (`next`); el bucle de intentos vive en `run-cases.mjs`.
 */

/** "after 120 seconds of book response" (p. 42). */
export const BOOK_RECOVERY_DELAY_MS = 120_000;

/** Fallos de la cuenta: nada más va a funcionar con ella y seguir sólo gasta intentos. */
const ACCOUNT_KINDS = new Set(['CREDENTIALS_INVALID', 'ACCOUNT_BLOCKED', 'INSUFFICIENT_BALANCE']);
/** La tarifa o la sesión ya no están (201, 207, 315): se corre la fecha (07 §4.1). */
const RATE_GONE_KINDS = new Set(['NO_AVAILABILITY', 'RATE_UNAVAILABLE', 'OFFER_EXPIRED']);
/** El entorno de test "puede tener cortes breves sin aviso" (Cert, nota final): mismo Search. */
const TRANSIENT_KINDS = new Set(['TRANSPORT', 'THROTTLED', 'UPSTREAM']);

/** Una cuenta que TBO rechaza: se corta la corrida entera, no el caso. */
export class HarnessFatalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HarnessFatalError';
  }
}

/**
 * Qué hacer después de un error del ACL en Search o PreBook:
 *
 * - `fatal`: la cuenta (401, 402, 300);
 * - `next-date`: la tarifa se fue (201, 207, 315);
 * - `same`: otro Search igual (red, 429, 5xx, cupo local, ventana vencida en nuestro reloj);
 * - `stop`: un request nuestro que TBO rechaza (400) o una respuesta que el ACL no lee. Repetir
 *   daría lo mismo: es un hallazgo y va a `selfcheck.md` (07 §6.4).
 */
export function nextAfterError(err) {
  if (err === undefined) return 'same';
  if (err.name === 'TboApiError') {
    if (ACCOUNT_KINDS.has(err.kind)) return 'fatal';
    if (RATE_GONE_KINDS.has(err.kind)) return 'next-date';
    if (TRANSIENT_KINDS.has(err.kind)) return 'same';
    return 'stop';
  }
  if (err.name === 'TboOfferExpiredError' || err.name === 'TboDispatchRejectedError') return 'same';
  return 'stop';
}

/** Lo mismo para un Book que TBO rechazó (FAILED por el código del cuerpo, 03 §3.9). */
function nextAfterBookFailure(classification) {
  if (ACCOUNT_KINDS.has(classification.failureKind)) return 'fatal';
  if (['no-availability', 'rate-unavailable', 'session-expired'].includes(classification.reason))
    return 'next-date';
  if (classification.dispatched === false && classification.errorClass === 'TboOfferExpiredError')
    return 'same';
  return 'stop';
}

function trace(name, result, acl) {
  const last = result.calls.at(-1);
  return {
    step: name,
    calls: result.calls.length,
    httpStatus: last?.httpStatus ?? 0,
    tboCode: last?.tboCode ?? null,
    acl,
  };
}

export function searchStep(h, folder, criteria) {
  return h.step(folder, '', (step) =>
    h.adapter(step).searchAvailabilityReport(criteria, h.searchContext),
  );
}

export function prebookStep(h, folder, { option, report, rooms }) {
  return h.step(folder, '', (step) =>
    h.adapter(step).prebookReport(
      {
        hotelCode: option.context.hotelCode,
        bookingCode: option.context.bookingCode,
        searchId: report.searchId,
        searchSentAt: report.searchSentAt,
        rooms,
      },
      h.searchContext,
    ),
  );
}

/**
 * El Book, UNA vez, con el `BookingCode` y el literal de `TotalFare` del PreBook (C2 en la
 * aplicación, 03 §3.4). Devuelve la clasificación de 03 §3.9, lance o no el ACL.
 */
export async function bookStep(
  h,
  folder,
  { prebook, report, rooms, guests, contact, bookingReferenceId, label = '', rewrite },
) {
  const query = {
    bookingCode: prebook.pack.bookingCode,
    totalFare: prebook.pack.totalFare,
    bookingReferenceId,
    searchSentAt: report.searchSentAt,
    occupancy: rooms,
    rooms: guests,
    contact,
  };
  const result = await h.step(
    folder,
    label,
    (step) => h.adapter(step).bookReport(query, h.searchContext),
    rewrite === undefined ? {} : { rewrite },
  );
  if (result.error === undefined) {
    const { classification, reply } = result.value;
    return {
      result,
      classification,
      confirmationNumber: classification.confirmationNumber ?? reply.confirmationNumber,
      clientReferenceId: reply.clientReferenceId,
    };
  }
  const classification = h.acl.classifyTboBookOutcome(
    { kind: 'threw', error: result.error },
    { clientReferenceId: bookingReferenceId },
  );
  return { result, classification };
}

export function detailStep(h, folder, lookup, { purpose, label = '' }) {
  return h.step(folder, label, (step) =>
    h.adapter(step).bookingDetailReport({ ...lookup, purpose }, h.searchContext),
  );
}

/** BookingDetail por `BookingReferenceId` a los 120 s de un Book incierto (p. 42; CK-14). */
export async function recoveryStep(h, folder, bookingReferenceId) {
  await h.sleep(BOOK_RECOVERY_DELAY_MS);
  return detailStep(
    h,
    folder,
    { bookingReferenceId },
    { purpose: 'verification', label: 'Recovery' },
  );
}

function detailOutcome(result) {
  if (result.error !== undefined) return { found: false, acl: errorOutcome(result.error) };
  const report = result.value;
  if (!report.found) return { found: false, acl: `found:false (${report.failureKind})` };
  return {
    found: true,
    acl: `found · ${report.view.status ?? report.view.providerStatus ?? 'sin estado'}`,
    confirmationNumber: report.view.providerBookingId ?? report.detail?.confirmationNumber,
    status: report.view.status,
    providerStatus: report.view.providerStatus,
    hotelConfirmationNumber: report.view.hotelConfirmationNumber,
  };
}

/**
 * La cancelación de la aplicación (04 §4.4): BookingDetail previo, Cancel y BookingDetail posterior.
 * Nunca se repite; lo que no se sepa lo dice el resultado (07 §6.5).
 */
export async function cancelStep(h, folder, confirmationNumber) {
  const result = await h.step(
    folder,
    '',
    (step) =>
      h.adapter(step).cancelReport({ confirmationNumber, purpose: 'interactive' }, h.searchContext),
    {
      callLabel: (operation, previous) =>
        operation === 'BookingDetail'
          ? previous.includes('Cancel')
            ? 'AfterCancel'
            : 'BeforeCancel'
          : undefined,
    },
  );
  if (result.error !== undefined) {
    return {
      result,
      summary: { sent: undefined, success: false, acl: errorOutcome(result.error) },
    };
  }
  const report = result.value;
  return {
    result,
    summary: {
      sent: report.sent,
      ...(report.skipReason === undefined ? {} : { skipReason: report.skipReason }),
      ...(report.cancelCode === undefined ? {} : { cancelCode: report.cancelCode }),
      success: report.result.success,
      ...(report.result.bookingStatus === undefined
        ? {}
        : { bookingStatus: report.result.bookingStatus }),
      warnings: [...(report.result.warnings ?? [])],
      acl: report.result.success ? 'cancelled' : 'not-cancelled',
    },
  };
}

function selectedSummary(option) {
  const fees = [
    ...describeFees(option.pack.atPropertyCharges, 'AtProperty'),
    ...describeFees(option.pack.includedSupplements, 'Included'),
  ];
  return {
    hotelCode: option.context.hotelCode,
    bookingCode: option.context.bookingCode,
    searchTotalFare: option.context.totalFare,
    currency: option.context.currency,
    refundable: option.pack.cancellation.refundable,
    ...(option.supplementType === undefined ? {} : { supplementType: option.supplementType }),
    supplements: fees,
  };
}

/**
 * Una cadena completa. `input`:
 *
 * - `folder`: donde se graba (una carpeta de intento);
 * - `criteria`, `rooms`, `selection` (`refundable` | `supplements`), `excluded` (firmas de tarifas
 *   que no se vuelven a elegir);
 * - `guests`, `contact`, `cancelAfter`;
 * - `case8Folder` (sólo el caso 4): las dos lecturas del caso 8 antes del Cancel.
 *
 * Devuelve `status`:
 *
 * - `complete`: Search, PreBook, Book confirmado y BookingDetail que la encuentra (más el Cancel si
 *   se pidió, salga como salga: el resultado lo dice);
 * - `discarded`: no llegó a reservar nada; `next` dice cómo sigue el caso;
 * - `stopped`: hay o puede haber una reserva sin la cadena completa. No se reintenta sola.
 */
export async function runChain(h, input) {
  const { folder } = input;
  const out = { steps: [] };
  const end = (status, next, reason, extra = {}) => ({ ...out, status, next, reason, ...extra });

  const search = await searchStep(h, folder, input.criteria);
  const searchAcl = search.error ? errorOutcome(search.error) : searchOutcome(search.value);
  out.steps.push(trace('Search', search, searchAcl));
  if (search.error !== undefined) {
    return end('discarded', nextAfterError(search.error), `search:${searchAcl}`);
  }
  const report = search.value;
  const batches = report.batches;
  if (batches.every((b) => b.status === 'empty')) {
    return end('discarded', 'next-search', 'no-availability');
  }
  if (!batches.some((b) => b.status === 'ok')) {
    const failed = batches.find((b) => b.error !== undefined);
    return end(
      'discarded',
      nextAfterError(failed?.error),
      `search:${errorOutcome(failed?.error) ?? 'failed'}`,
    );
  }
  const option = selectOption(bookableOptions(report, input.excluded), input.selection);
  if (option === undefined) {
    const found = report.diagnostics.packsMapped;
    return end(
      'discarded',
      'next-search',
      input.selection === 'supplements' ? 'no-supplements' : 'no-options',
      { note: `${found} opciones leídas por el ACL` },
    );
  }
  out.selected = selectedSummary(option);

  const prebook = await prebookStep(h, folder, { option, report, rooms: input.rooms });
  const prebookAcl = prebook.error ? errorOutcome(prebook.error) : 'ok';
  out.steps.push(trace('PreBook', prebook, prebookAcl));
  if (prebook.error !== undefined) {
    return end('discarded', nextAfterError(prebook.error), `prebook:${prebookAcl}`);
  }
  const revalidated = prebook.value;
  out.prebook = {
    bookingCode: revalidated.pack.bookingCode,
    totalFare: revalidated.pack.totalFare,
    currency: revalidated.pack.currency,
    priceChanged: revalidated.pack.totalFare !== option.context.totalFare,
    signals: [...(revalidated.result.signals ?? [])],
  };
  // La aplicación no vende una tarifa "sólo con billete aéreo" (RF-17; D-TBO-22 A).
  if (out.prebook.signals.includes('PACKAGE_WITH_FLIGHT_ONLY')) {
    return end('discarded', 'same', 'package-only', { exclude: option.signature });
  }

  const bookingReferenceId = h.acl.generateTboBookingReference('test');
  out.bookingReferenceId = bookingReferenceId;
  const book = await bookStep(h, folder, {
    prebook: revalidated,
    report,
    rooms: input.rooms,
    guests: input.guests,
    contact: input.contact,
    bookingReferenceId,
  });
  const { classification } = book;
  out.steps.push(trace('Book', book.result, `${classification.outcome}:${classification.reason}`));
  out.book = {
    outcome: classification.outcome,
    reason: classification.reason,
    ...(book.confirmationNumber === undefined
      ? {}
      : { confirmationNumber: book.confirmationNumber }),
    ...(book.clientReferenceId === undefined ? {} : { clientReferenceId: book.clientReferenceId }),
  };

  if (classification.outcome === 'FAILED') {
    return end('discarded', nextAfterBookFailure(classification), `book:${classification.reason}`);
  }

  let confirmationNumber =
    classification.outcome === 'CONFIRMED' ? book.confirmationNumber : undefined;
  if (classification.outcome === 'UNCERTAIN') {
    const recovery = await recoveryStep(h, folder, bookingReferenceId);
    const read = detailOutcome(recovery);
    out.steps.push(trace('BookingDetail (recovery)', recovery, read.acl));
    out.recovery = read;
    if (!read.found || read.confirmationNumber === undefined) {
      // Puede existir igual (D-TBO-24 A): no se reintenta, se deja para verificar a mano.
      return end('stopped', 'stop', `book-uncertain:${classification.reason}`);
    }
    confirmationNumber = read.confirmationNumber;
  }

  const detail = await detailStep(h, folder, { confirmationNumber }, { purpose: 'recovery' });
  const read = detailOutcome(detail);
  out.steps.push(trace('BookingDetail', detail, read.acl));
  out.detail = read;
  out.confirmationNumber = confirmationNumber;

  if (input.case8Folder !== undefined && read.found) {
    const byConfirmation = await detailStep(
      h,
      input.case8Folder,
      { confirmationNumber },
      { purpose: 'interactive', label: 'ByConfirmationNumber' },
    );
    const byReference = await detailStep(
      h,
      input.case8Folder,
      { bookingReferenceId },
      { purpose: 'verification', label: 'ByBookingReferenceId' },
    );
    const a = detailOutcome(byConfirmation);
    const b = detailOutcome(byReference);
    out.steps.push(trace('Case 8 BookingDetail by ConfirmationNumber', byConfirmation, a.acl));
    out.steps.push(trace('Case 8 BookingDetail by BookingReferenceId', byReference, b.acl));
    out.case8 = {
      byConfirmationNumber: a,
      byBookingReferenceId: b,
      ok: a.found && b.found && b.confirmationNumber === confirmationNumber,
    };
  }

  if (input.cancelAfter) {
    const cancel = await cancelStep(h, folder, confirmationNumber);
    out.steps.push(trace('Cancel', cancel.result, cancel.summary.acl));
    out.cancel = cancel.summary;
  }

  if (classification.outcome !== 'CONFIRMED') {
    // Se encontró tras un Book incierto: existe, pero el Book no dio 200 con localizador (G-9).
    return end('stopped', 'stop', `book-recovered:${classification.reason}`);
  }
  if (!read.found) return end('stopped', 'stop', `detail:${read.acl}`);
  return end('complete', undefined, 'complete');
}
