import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  caseCriteria,
  caseFolderName,
  caseOccupancies,
  certCase,
  certContact,
  syntheticGuests,
} from './cases.mjs';
import { HarnessFatalError, cancelStep, runChain } from './chain.mjs';
import { errorOutcome } from './harness.mjs';

/**
 * `run` (docs/tbo/07 §6.3): las cadenas de los casos pedidos, cada una con sus intentos.
 *
 * Cada intento se graba en `attempts/CaseNN_…/try-XX/`. El que completa la cadena pasa a
 * `CaseNN_…/` en la raíz de la corrida; los demás se quedan en `attempts/` con su motivo en
 * `attempts/index.jsonl`, fuera del zip (07 §2.5: se entregan si TBO pide "all the JSON logs").
 *
 * Intentos (07 §4.1): sin disponibilidad o sin una tarifa que sirva, el siguiente lote de
 * `HotelCodes`, la siguiente ocupación (caso 7) y, al final, el check-in corrido 7 días, hasta 3
 * veces; tarifa caída o sesión vencida (207, 315), directamente la fecha siguiente. El Book no se
 * repite nunca: un Book incierto detiene el caso para verificarlo a mano.
 */

export const DATE_SHIFT_DAYS = 7;
export const MAX_DATE_SHIFTS = 3;
/** Techo de Search por caso: una cuenta sin inventario no puede dejar el arnés buscando. */
export const MAX_TRIES_PER_CASE = 12;
/** Tope de `HotelCodes` por Search (p. 10; CK-04). */
const HOTEL_CODES_PER_SEARCH = 100;

const DAY_MS = 86_400_000;
const pad2 = (n) => String(n).padStart(2, '0');

function shiftDay(isoDay, days) {
  return new Date(Date.parse(`${isoDay}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Los lotes de `HotelCodes`: los de `TBO_HOTEL_CODES` si se dieron; si no y hay `TBO_CITY_CODE`, los
 * de esa ciudad por `TBOHotelCodeList` (07 §4.1; R-03); si no, los 13 de la colección.
 */
async function hotelCodeBatches(h, say) {
  const { settings } = h;
  let codes = [...settings.hotelCodes];
  let source = settings.hotelCodesSource === 'default' ? 'colección Postman' : 'TBO_HOTEL_CODES';
  if (settings.hotelCodesSource === 'default' && settings.cityCode !== undefined) {
    const result = await h.step(
      h.evidence.folder('hotelcodes'),
      `ciudad-${settings.cityCode}`,
      (step) => h.staticClient(step).listCityHotels(settings.cityCode),
    );
    const found = [...new Set((result.value?.hotels ?? []).map((hotel) => hotel.hotelId))];
    if (found.length === 0) {
      throw new HarnessFatalError(
        `TBOHotelCodeList de la ciudad ${settings.cityCode} no trajo hoteles` +
          `${result.error ? ` (${errorOutcome(result.error)})` : ''}: revisa TBO_CITY_CODE.`,
      );
    }
    codes = found;
    source = `TBOHotelCodeList ${settings.cityCode}`;
  }
  const batches = chunk(codes, HOTEL_CODES_PER_SEARCH);
  say(`HotelCodes: ${codes.length} (${source}) en ${batches.length} lote(s) de hasta 100`);
  return batches;
}

function describeSteps(steps) {
  return steps
    .map((s) => {
      const code = s.tboCode ?? (s.httpStatus === 0 ? 'sin respuesta' : `HTTP ${s.httpStatus}`);
      return `${s.step} ${code}${s.acl ? ` (${s.acl})` : ''}`;
    })
    .join(' → ');
}

/** Un intento libre: una corrida retomada no pisa los de antes. */
function nextTryRel(evidence, base, from) {
  for (let n = from; ; n++) {
    const rel = `attempts/${base}/try-${pad2(n)}`;
    if (!existsSync(join(evidence.dir, rel))) return { rel, n };
  }
}

function caseRecord(caseDef, chain, extra) {
  return {
    case: caseDef.id,
    nationality: caseDef.nationality,
    ...extra,
    ...(chain?.selected === undefined ? {} : { selected: chain.selected }),
    ...(chain?.prebook === undefined ? {} : { prebook: chain.prebook }),
    ...(chain?.bookingReferenceId === undefined
      ? {}
      : { bookingReferenceId: chain.bookingReferenceId }),
    ...(chain?.book === undefined ? {} : { book: chain.book }),
    ...(chain?.confirmationNumber === undefined
      ? {}
      : { confirmationNumber: chain.confirmationNumber }),
    ...(chain?.detail === undefined ? {} : { detail: chain.detail }),
    ...(chain?.cancel === undefined ? {} : { cancel: chain.cancel }),
    ...(chain?.recovery === undefined ? {} : { recovery: chain.recovery }),
  };
}

/**
 * Corre un caso de 1 a 7 (el 8 va dentro del 4). Devuelve el registro para `cases.json` y, si
 * es el 4, el del 8.
 */
async function runCase(h, say, caseDef, ctx) {
  const occupancies = caseOccupancies(caseDef);
  const base = caseFolderName(caseDef);
  const lastName = caseDef.lastName;
  const excluded = new Set();
  const attemptsFolder = h.evidence.folder('attempts');
  let shift = 0;
  let batch = 0;
  let occ = 0;
  let tries = 0;
  let tryNumber = 1;

  // Todos los lotes con una ocupación antes de pasar a la siguiente: el 7 prefiere la del 4 en
  // cualquier lote a la del 1 (07 §4.9).
  const advanceSearch = () => {
    batch += 1;
    if (batch < ctx.batches.length) return;
    batch = 0;
    occ += 1;
    if (occ < occupancies.length) return;
    occ = 0;
    shift += 1;
  };

  while (tries < MAX_TRIES_PER_CASE && shift <= MAX_DATE_SHIFTS) {
    tries += 1;
    const { rel, n } = nextTryRel(h.evidence, base, tryNumber);
    tryNumber = n + 1;
    const folder = h.evidence.folder(rel);
    const occupancy = occupancies[occ];
    const checkIn = shiftDay(h.settings.checkIn, shift * DATE_SHIFT_DAYS);
    const checkOut = shiftDay(h.settings.checkOut, shift * DATE_SHIFT_DAYS);
    const case8Rel =
      caseDef.id === 4 ? nextTryRel(h.evidence, caseFolderName(certCase(8)), n).rel : undefined;

    const chain = await runChain(h, {
      folder,
      criteria: caseCriteria({
        hotelCodes: ctx.batches[batch],
        checkIn,
        checkOut,
        rooms: occupancy.rooms,
        nationality: caseDef.nationality,
      }),
      rooms: occupancy.rooms,
      selection: caseDef.selection ?? 'refundable',
      excluded,
      guests: syntheticGuests(occupancy.rooms, lastName),
      contact: ctx.contact,
      cancelAfter: ctx.cancelAfter,
      ...(case8Rel === undefined ? {} : { case8Folder: h.evidence.folder(case8Rel) }),
    });

    const label = `Caso ${pad2(caseDef.id)} · intento ${tries} · CheckIn ${checkIn}`;
    const why = chain.status === 'complete' ? '' : ` · ${chain.status}: ${chain.reason}`;
    say(`  ${label}: ${describeSteps(chain.steps)}${why}`);
    const attempt = {
      case: caseDef.id,
      try: rel,
      checkIn,
      checkOut,
      batch,
      ...(occupancy.occupancyOf === undefined ? {} : { occupancyOf: occupancy.occupancyOf }),
      status: chain.status,
      reason: chain.reason,
      ...(chain.note === undefined ? {} : { note: chain.note }),
      at: new Date(h.now()).toISOString(),
    };

    if (chain.status === 'complete') {
      const folderName = caseFolderName(caseDef, occupancy.occupancyOf);
      await h.evidence.promote(rel, folderName, ctx.stamp, `Case${pad2(caseDef.id)}_`);
      const record = caseRecord(caseDef, chain, {
        status: 'complete',
        folder: folderName,
        tries,
        checkIn,
        checkOut,
        rooms: occupancy.rooms,
        ...(occupancy.occupancyOf === undefined ? {} : { occupancyOf: occupancy.occupancyOf }),
        cancelAfter: ctx.cancelAfter,
        build: ctx.build,
      });
      await h.evidence.writeJson(`${folderName}/case.json`, record);
      await attemptsFolder.appendJsonl('index.jsonl', { ...attempt, promotedTo: folderName });
      const records = [record];
      if (caseDef.id === 4) records.push(await promoteCase8(h, chain, case8Rel, ctx, record));
      return records;
    }

    await attemptsFolder.appendJsonl('index.jsonl', attempt);
    await h.evidence.writeJson(`${rel}/attempt.json`, caseRecord(caseDef, chain, attempt));
    if (chain.next === 'fatal') {
      throw new HarnessFatalError(
        `${label}: TBO rechaza la cuenta (${chain.reason}). Nada más va a funcionar con ella; ` +
          'revisa credenciales, saldo Limit o bloqueo con TBO.',
      );
    }
    if (chain.next === 'stop') {
      const records = [
        caseRecord(caseDef, chain, {
          status: 'failed',
          folder: null,
          tries,
          reason: chain.reason,
          attempt: rel,
          cancelAfter: ctx.cancelAfter,
          build: ctx.build,
        }),
      ];
      if (caseDef.id === 4) records.push(case8Failed(ctx, 'el caso 4 no completó su cadena'));
      return records;
    }
    if (chain.exclude !== undefined) excluded.add(chain.exclude);
    if (chain.next === 'next-date') {
      shift += 1;
      batch = 0;
      occ = 0;
    } else if (chain.next === 'next-search') {
      advanceSearch();
    }
  }

  const reason =
    tries >= MAX_TRIES_PER_CASE
      ? `sin cadena completa en ${MAX_TRIES_PER_CASE} intentos`
      : `sin cadena completa con el check-in corrido ${MAX_DATE_SHIFTS} veces`;
  const records = [
    {
      case: caseDef.id,
      nationality: caseDef.nationality,
      status: 'failed',
      folder: null,
      tries,
      reason,
      cancelAfter: ctx.cancelAfter,
      build: ctx.build,
    },
  ];
  if (caseDef.id === 4) records.push(case8Failed(ctx, 'el caso 4 no completó su cadena'));
  return records;
}

function case8Failed(ctx, reason) {
  return { case: 8, status: 'failed', folder: null, reason, build: ctx.build };
}

async function promoteCase8(h, chain, case8Rel, ctx, case4) {
  if (chain.case8?.ok !== true) {
    return case8Failed(ctx, 'las dos lecturas de la reserva del caso 4 no la encontraron');
  }
  const folderName = caseFolderName(certCase(8));
  await h.evidence.promote(case8Rel, folderName, ctx.stamp, 'Case08_');
  const record = {
    case: 8,
    status: 'complete',
    folder: folderName,
    ofCase: 4,
    confirmationNumber: case4.confirmationNumber,
    bookingReferenceId: case4.bookingReferenceId,
    detail: chain.case8,
    build: ctx.build,
  };
  await h.evidence.writeJson(`${folderName}/case.json`, record);
  return record;
}

/**
 * Corre los casos pedidos (ya expandidos: el 8 va con el 4) y escribe `cases.json`, sumando los de
 * una corrida retomada. Devuelve `true` si todos los pedidos completaron su cadena.
 */
export async function runCases(h, say, { cases, build, stamp }) {
  const { booking } = h.settings;
  say(
    `TBO run · ${h.settings.baseUrl} · CheckIn ${h.settings.checkIn} · ${h.settings.nights} noches · ` +
      `casos ${cases.join(', ')} · ${booking.cancelAfter ? 'cancela al final' : 'NO cancela (TBO_CANCEL_AFTER=false)'}`,
  );
  const ctx = {
    batches: await hotelCodeBatches(h, say),
    contact: certContact(booking.email, booking.phone),
    cancelAfter: booking.cancelAfter,
    build,
    stamp,
  };

  const previous = (await h.evidence.readJson('cases.json')) ?? { cases: [] };
  const byCase = new Map(previous.cases.map((record) => [record.case, record]));
  // Repetir un caso con `--resume` reemplaza su registro: si la reserva anterior sigue viva
  // (TBO_CANCEL_AFTER=false o un Cancel sin confirmar), queda aquí para que `cancel` la encuentre.
  const superseded = [...(previous.superseded ?? [])];
  const save = () =>
    h.evidence.writeJson('cases.json', {
      runId: h.evidence.runId,
      cases: [...byCase.values()].sort((a, b) => a.case - b.case),
      ...(superseded.length === 0 ? {} : { superseded }),
    });

  let ok = true;
  try {
    for (const id of cases.filter((c) => c !== 8)) {
      const caseDef = certCase(id);
      say(
        `\nCaso ${pad2(id)} · ${caseDef.occupancyText} · GuestNationality ${caseDef.nationality}`,
      );
      const records = await runCase(h, say, caseDef, ctx);
      for (const record of records) {
        const replaced = byCase.get(record.case);
        if (replaced !== undefined && needsFollowUp(replaced)) {
          superseded.push({ ...replaced, supersededAt: new Date(h.now()).toISOString() });
        }
        byCase.set(record.case, record);
        const where = record.folder ?? record.attempt ?? '—';
        say(
          record.status === 'complete'
            ? `  Caso ${pad2(record.case)}: completo en ${where}` +
                (record.confirmationNumber
                  ? ` · ConfirmationNumber ${record.confirmationNumber}`
                  : '')
            : `  Caso ${pad2(record.case)}: FALLÓ (${record.reason}) · ${where}`,
        );
        if (record.status !== 'complete') ok = false;
      }
      await save();
    }
  } finally {
    await save();
    // También si la corrida se corta (cuenta rechazada, guarda): lo reservado antes sigue vivo.
    reportActive([...byCase.values(), ...superseded], say, h.evidence.runId);
  }
  return ok;
}

function activeBookings(records) {
  return records.filter(
    (r) => r.confirmationNumber !== undefined && r.case !== 8 && r.cancel?.success !== true,
  );
}

const isUncertainBook = (record) => record.reason?.startsWith('book-uncertain') === true;

/** Una reserva viva o un Book incierto: lo que alguien tiene que cancelar o verificar con TBO. */
function needsFollowUp(record) {
  return activeBookings([record]).length > 0 || isUncertainBook(record);
}

/**
 * Lo que queda vivo en TBO y lo que hay que verificar a mano: un Book incierto que la lectura de
 * los 120 s no encontró puede existir igual (D-TBO-24 A), y sólo se busca por su referencia.
 */
function reportActive(records, say, runId) {
  const active = activeBookings(records);
  if (active.length > 0) {
    say('\nReservas de test que quedan ACTIVAS en TBO (consumen el Limit de la cuenta):');
    for (const r of active) {
      say(
        `  Caso ${pad2(r.case)} · ConfirmationNumber ${r.confirmationNumber} · BookingReferenceId ` +
          `${r.bookingReferenceId}${r.cancel ? ` · Cancel: ${r.cancel.acl}` : ' · sin Cancel'}`,
      );
    }
    say(`  Para cancelarlas: node tools/tbo/cert-cases.mjs cancel ${runId}`);
  }
  const unknown = records.filter(isUncertainBook);
  if (unknown.length > 0) {
    say('\nBook incierto que la lectura de los 120 s no encontró; puede existir igual:');
    for (const r of unknown) {
      say(
        `  Caso ${pad2(r.case)} · BookingReferenceId ${r.bookingReferenceId} · verificarla con TBO ` +
          'antes de volver a correr el caso',
      );
    }
  }
}

/**
 * `cancel <runId>`: cancela lo que una corrida dejó activo (con `TBO_CANCEL_AFTER=false`, o un
 * Cancel que no se confirmó). Cada cancelación es la de la aplicación —BookingDetail, Cancel y
 * BookingDetail— y se graba en `cancellations/CaseNN/`, fuera del zip. Nunca repite un Cancel
 * dentro de la misma invocación. Devuelve `true` si todas quedaron confirmadas.
 */
export async function cancelActive(h, say) {
  const index = await h.evidence.readJson('cases.json');
  if (index === undefined) {
    say(`La corrida ${h.evidence.runId} no tiene cases.json: no reservó nada.`);
    return true;
  }
  const records = [...index.cases, ...(index.superseded ?? [])];
  const pending = activeBookings(records);
  say(`TBO cancel · corrida ${h.evidence.runId} · ${pending.length} reserva(s) activa(s)`);
  let ok = true;
  for (const record of pending) {
    const folder = h.evidence.folder(`cancellations/Case${pad2(record.case)}`);
    const { summary } = await cancelStep(h, folder, record.confirmationNumber);
    record.cancel = { ...summary, at: new Date(h.now()).toISOString(), by: 'cancel' };
    say(
      `  Caso ${pad2(record.case)} · ${record.confirmationNumber}: ${summary.acl}` +
        (summary.bookingStatus ? ` (${summary.bookingStatus})` : ''),
    );
    if (summary.success !== true) ok = false;
    await h.evidence.writeJson('cases.json', index);
  }
  reportActive(records, say, h.evidence.runId);
  return ok;
}
