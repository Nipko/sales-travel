import { CERT_CASES, certCase } from './cases.mjs';
import { isCardKey } from './recorder.mjs';
import { REDACTED } from './secrets.mjs';

/**
 * Guardas G-1 a G-13 (docs/tbo/07-certificacion.md §6.7; 08 RC-03): funciones PURAS sobre el modelo
 * de una corrida (`run-model.mjs`), sin disco ni red. `verify` y `zip` las corren sobre lo mismo
 * que va a salir; una que falla y es `blocking` impide armar el zip.
 *
 * Cada una devuelve `{ id, title, blocking, ok, findings, notes }`: `findings` explica el fallo
 * (rutas de archivo y nombres de campo, nunca valores de credencial) y `notes` lo que conviene
 * saber aunque pase.
 *
 * El modelo:
 *
 * - `run`: `run.json`;
 * - `cases[]`: `{ id, folder, meta (case.json), calls[] }`, cada llamada con `operation`, `label`,
 *   `seq`, `url`, `startedAt`, `httpStatus`, `tboCode`, `mutation`, `blocked`, `request` y
 *   `response` (`{ name, bytes, json }`);
 * - `files[]`: TODOS los archivos de la corrida (`{ path, bytes }`), intentos y sondas incluidos;
 * - `entries[]`: lo que entra al zip (`{ name, bytes }`).
 */

export const SEARCH_TO_BOOK_LIMIT_MS = 30 * 60_000;
const LIMIT_OPERATIONS = new Set(['PreBook', 'Book', 'BookingDetail']);

function normalizeKey(key) {
  return String(key)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Campo sin distinguir mayúsculas, como lee el envelope el ACL (docs/tbo/01 §8.1). */
export function pick(object, name) {
  if (!isRecord(object)) return undefined;
  const key = Object.keys(object).find((k) => normalizeKey(k) === normalizeKey(name));
  return key === undefined ? undefined : object[key];
}

function walkKeys(value, path, visit) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkKeys(item, [...path, index], visit));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    visit(key, child, [...path, key]);
    walkKeys(child, [...path, key], visit);
  }
}

function result(id, title, blocking, findings, notes = []) {
  return { id, title, blocking, ok: findings.length === 0, findings, notes };
}

const caseCalls = (model, ids = [1, 2, 3, 4, 5, 6, 7]) =>
  model.cases.filter((c) => ids.includes(c.id));

function callsOf(kase, operation, label) {
  return kase.calls.filter(
    (c) => c.operation === operation && (label === undefined || (c.label ?? '') === label),
  );
}

/**
 * Las llamadas de la cadena de un caso 1-7: el Search que emitió la tarifa (el último antes del
 * primer PreBook), el PreBook del Book, el Book y el BookingDetail que cierra la reserva.
 */
export function chainOf(kase) {
  const ordered = [...kase.calls].sort((a, b) => a.seq - b.seq);
  const firstPrebook = ordered.findIndex((c) => c.operation === 'PreBook');
  const book = ordered.find((c) => c.operation === 'Book');
  const bookIndex = book === undefined ? -1 : ordered.indexOf(book);
  const upTo = firstPrebook === -1 ? ordered.length : firstPrebook;
  const search = ordered
    .slice(0, upTo)
    .filter((c) => c.operation === 'Search')
    .at(-1);
  const prebook = ordered
    .slice(0, bookIndex === -1 ? ordered.length : bookIndex)
    .filter((c) => c.operation === 'PreBook')
    .at(-1);
  const detail = ordered
    .slice(bookIndex + 1)
    .find((c) => c.operation === 'BookingDetail' && !c.label);
  const cancel = ordered.find((c) => c.operation === 'Cancel');
  const afterCancel = ordered.find(
    (c) => c.operation === 'BookingDetail' && c.label === 'AfterCancel',
  );
  const recovery = ordered.find((c) => c.operation === 'BookingDetail' && c.label === 'Recovery');
  return { search, prebook, book, detail, cancel, afterCancel, recovery, ordered };
}

function roomsOfPrebookRs(json) {
  const hotel = pick(json, 'HotelResult');
  const first = Array.isArray(hotel) ? hotel[0] : undefined;
  const rooms = pick(first, 'Rooms');
  return Array.isArray(rooms) ? rooms : [];
}

function supplementsOf(roomOption) {
  const supplements = pick(roomOption, 'Supplements');
  if (!Array.isArray(supplements)) return [];
  return supplements.flatMap((item) => (Array.isArray(item) ? item : [item])).filter(isRecord);
}

function searchOptionByCode(json, bookingCode) {
  const hotels = pick(json, 'HotelResult');
  for (const hotel of Array.isArray(hotels) ? hotels : []) {
    const rooms = pick(hotel, 'Rooms');
    for (const option of Array.isArray(rooms) ? rooms : []) {
      if (pick(option, 'BookingCode') === bookingCode) return option;
    }
  }
  return undefined;
}

// ───────────────────────── G-1 a G-13 ─────────────────────────

/**
 * En los RQ, en el `README.txt` y en el manifiesto, `Authorization` no aparece nunca: lo escribimos
 * nosotros. En un RS sólo cuenta con forma de cabecera (`Authorization: Basic …`): las condiciones
 * de un hotel pueden decir "credit card authorization" y abortar por eso sería un falso positivo;
 * el token mismo lo encuentra la búsqueda de la credencial.
 */
const AUTH_ANYWHERE = /authorization/i;
const AUTH_HEADER = /authorization["']?\s*[:=]\s*["']?\s*(?:basic|bearer)\b/i;

export function g1Credentials(model, { secrets }) {
  const findings = [];
  const notes = [];
  for (const file of model.files) {
    const hits = secrets.findIn(file.bytes);
    if (hits.length > 0) findings.push(`${file.path} contiene ${hits.join(', ')}`);
  }
  for (const entry of model.entries) {
    const text = entry.bytes.toString('utf8');
    const isResponse = /_RS\.(json|txt)$/.test(entry.name);
    if (isResponse ? AUTH_HEADER.test(text) : AUTH_ANYWHERE.test(text)) {
      findings.push(`${entry.name} contiene "Authorization"`);
    }
    const hits = secrets.findIn(entry.bytes);
    if (hits.length > 0) findings.push(`${entry.name} (zip) contiene ${hits.join(', ')}`);
    if (text.includes(REDACTED)) {
      if (isResponse)
        notes.push(`${entry.name}: TBO repitió la credencial y se tapó; no es byte a byte`);
      else findings.push(`${entry.name} lleva una credencial tapada: un RQ no la puede contener`);
    }
  }
  return result(
    'G-1',
    'Sin usuario, contraseña ni token Basic en la corrida; sin Authorization en el zip',
    true,
    findings,
    notes,
  );
}

export function g2CardData(model) {
  const findings = [];
  for (const kase of model.cases) {
    for (const call of kase.calls) {
      if (call.request === undefined) continue;
      if (call.request.json === undefined) {
        findings.push(`${kase.folder}/${call.request.name} no es JSON: no se puede afirmar D1`);
        continue;
      }
      walkKeys(call.request.json, [], (key, _child, path) => {
        if (isCardKey(key)) findings.push(`${kase.folder}/${call.request.name}: ${path.join('.')}`);
      });
    }
  }
  return result('G-2', 'Ningún RQ con PaymentInfo ni claves de tarjeta', true, findings);
}

export function g3PaymentMode(model) {
  const findings = [];
  for (const kase of model.cases) {
    for (const call of kase.calls) {
      const json = call.request?.json;
      if (json === undefined) continue;
      const where = `${kase.folder}/${call.request.name}`;
      walkKeys(json, [], (key, child, path) => {
        if (normalizeKey(key) === 'paymentmode' && child !== 'Limit') {
          findings.push(`${where}: ${path.join('.')} no es "Limit"`);
        }
      });
      if (LIMIT_OPERATIONS.has(call.operation) && json.PaymentMode !== 'Limit') {
        findings.push(`${where}: ${call.operation} sin PaymentMode "Limit"`);
      }
    }
  }
  return result('G-3', 'PaymentMode "Limit" en todo PreBook, Book y BookingDetail', true, findings);
}

export function g4SyntheticNames(model, { firstNames, lastNames }) {
  const first = new Set(firstNames);
  const last = new Set(lastNames);
  const findings = [];
  for (const kase of model.cases) {
    for (const call of callsOf(kase, 'Book')) {
      const where = `${kase.folder}/${call.request?.name ?? 'Book'}`;
      const details = pick(call.request?.json, 'CustomerDetails');
      if (!Array.isArray(details)) {
        findings.push(`${where}: sin CustomerDetails`);
        continue;
      }
      details.forEach((room, r) => {
        const names = pick(room, 'CustomerNames');
        (Array.isArray(names) ? names : []).forEach((guest, g) => {
          // Sólo la posición: el valor es un nombre y no tiene por qué ir a un log.
          if (!first.has(pick(guest, 'FirstName')))
            findings.push(
              `${where}: CustomerDetails[${r}].CustomerNames[${g}].FirstName fuera de la lista`,
            );
          if (!last.has(pick(guest, 'LastName')))
            findings.push(
              `${where}: CustomerDetails[${r}].CustomerNames[${g}].LastName fuera de la lista`,
            );
        });
      });
    }
  }
  return result('G-4', 'Nombres del Book de la lista sintética del arnés', true, findings);
}

export function g5ListingSearch(model) {
  const findings = [];
  for (const kase of model.cases) {
    for (const call of callsOf(kase, 'Search')) {
      if (pick(call.request?.json, 'IsDetailedResponse') !== false) {
        findings.push(
          `${kase.folder}/${call.request?.name ?? 'Search'}: IsDetailedResponse no es false`,
        );
      }
    }
  }
  return result('G-5', 'IsDetailedResponse false en todo Search del zip', true, findings);
}

export function g6Nationality(model) {
  const values = new Set();
  const findings = [];
  for (const kase of caseCalls(model)) {
    // La de la tabla de 07 §4.2, no la de `case.json`: la guarda no se fía de lo que escribió el arnés.
    const want = certCase(kase.id).nationality;
    for (const call of callsOf(kase, 'Search')) {
      const nationality = pick(call.request?.json, 'GuestNationality');
      if (typeof nationality === 'string') values.add(nationality);
      if (nationality !== want) {
        findings.push(`${kase.folder}: GuestNationality no es la del huésped líder del caso`);
      }
    }
  }
  if (values.size < 3) {
    findings.push(
      `GuestNationality toma ${values.size} valores entre los casos 1-7; hacen falta 3`,
    );
  }
  return result(
    'G-6',
    'GuestNationality con al menos 3 valores entre los casos 1-7',
    true,
    findings,
    [`valores: ${[...values].sort().join(', ') || '—'}`],
  );
}

function countTypes(names) {
  let adults = 0;
  let children = 0;
  for (const guest of Array.isArray(names) ? names : []) {
    const type = pick(guest, 'Type');
    if (type === 'Adult') adults += 1;
    else if (type === 'Child') children += 1;
  }
  return { adults, children };
}

/**
 * La ocupación que el caso tiene que llevar según la tabla de 07 §4.2, no según `case.json`: sin
 * `case.json`, o con uno equivocado, la guarda compararía contra nada. El 7 admite la del 4 o la del
 * 1 (07 §4.9): la que declara `case.json` si es una de esas dos, si no la que tenga las habitaciones
 * del Search.
 */
function expectedRooms(kase, paxRooms) {
  const def = CERT_CASES.find((c) => c.id === kase.id);
  if (def?.rooms !== undefined) return def.rooms;
  const options = def?.occupancyOf ?? [];
  const declared = kase.meta?.occupancyOf;
  const id = options.includes(declared)
    ? declared
    : (options.find((o) => certCase(o).rooms.length === paxRooms.length) ?? options[0]);
  return id === undefined ? undefined : certCase(id).rooms;
}

export function g7Occupancy(model) {
  const findings = [];
  for (const kase of caseCalls(model)) {
    const { search, book } = chainOf(kase);
    const paxRooms = pick(search?.request?.json, 'PaxRooms');
    const details = pick(book?.request?.json, 'CustomerDetails');
    if (!Array.isArray(paxRooms) || !Array.isArray(details)) {
      findings.push(`${kase.folder}: falta PaxRooms del Search o CustomerDetails del Book`);
      continue;
    }
    if (paxRooms.length !== details.length) {
      findings.push(
        `${kase.folder}: ${paxRooms.length} habitaciones en Search y ${details.length} en Book`,
      );
    }
    const expected = expectedRooms(kase, paxRooms);
    if (Array.isArray(expected) && expected.length !== paxRooms.length) {
      findings.push(
        `${kase.folder}: PaxRooms no tiene las ${expected.length} habitaciones del caso`,
      );
    }
    paxRooms.forEach((room, i) => {
      const ages = pick(room, 'ChildrenAges');
      const children = pick(room, 'Children');
      const adults = pick(room, 'Adults');
      const agesWithChildren = children > 0 ? ages : [];
      if (children > 0 && (!Array.isArray(ages) || ages.length !== children)) {
        findings.push(`${kase.folder}: PaxRooms[${i}] Children no coincide con ChildrenAges`);
      }
      const want = expected?.[i];
      if (
        want !== undefined &&
        (want.adults !== adults ||
          JSON.stringify(want.childrenAges) !== JSON.stringify(agesWithChildren ?? []))
      ) {
        findings.push(`${kase.folder}: PaxRooms[${i}] no es la ocupación del caso (07 §4.2)`);
      }
      const got = countTypes(pick(details[i], 'CustomerNames'));
      if (got.adults !== adults || got.children !== children) {
        findings.push(
          `${kase.folder}: habitación ${i + 1} con ${got.adults} Adult y ${got.children} Child en ` +
            `Book frente a ${adults} y ${children} en Search`,
        );
      }
    });
  }
  return result('G-7', 'PaxRooms del Search y CustomerDetails del Book coinciden', true, findings);
}

export function g8TotalFare(model) {
  const findings = [];
  for (const kase of caseCalls(model)) {
    const { prebook, book } = chainOf(kase);
    const booked = pick(book?.request?.json, 'TotalFare');
    const quoted = pick(roomsOfPrebookRs(prebook?.response?.json)[0], 'TotalFare');
    if (typeof booked !== 'number' || typeof quoted !== 'number') {
      findings.push(`${kase.folder}: falta TotalFare en el Book o en la respuesta de PreBook`);
    } else if (booked !== quoted) {
      findings.push(`${kase.folder}: Book.TotalFare ${booked} y PreBook ${quoted}`);
    }
  }
  return result('G-8', 'Book.TotalFare igual al TotalFare del PreBook', true, findings);
}

function sameBuild(model) {
  const builds = new Set(
    model.cases
      .filter((c) => c.meta?.build !== undefined)
      .map((c) => `${c.meta.build.gitSha ?? '?'}@${c.meta.build.acl?.version ?? '?'}`),
  );
  return builds;
}

export function g9CompleteChains(model) {
  const findings = [];
  const present = new Set(model.cases.map((c) => c.id));
  for (const id of [1, 2, 3, 4, 5, 6, 7, 8]) {
    if (!present.has(id)) findings.push(`falta el caso ${id}`);
  }
  for (const folder of model.duplicates ?? []) {
    findings.push(`${folder}: otra carpeta para un caso que ya está (sobra una)`);
  }
  for (const kase of model.cases) {
    for (const call of kase.calls) {
      for (const part of [call.request, call.response]) {
        if (part?.missing) findings.push(`${kase.folder}/${part.name}: falta el archivo`);
      }
      if (call.mutation !== undefined)
        findings.push(`${kase.folder}: una llamada reescrita (${call.mutation})`);
      if (call.blocked !== undefined)
        findings.push(`${kase.folder}: una llamada bloqueada (${call.blocked})`);
    }
  }
  for (const kase of caseCalls(model)) {
    const c = chainOf(kase);
    const missing = [];
    if (c.search?.tboCode !== 200) missing.push('Search 200');
    if (c.prebook?.tboCode !== 200) missing.push('PreBook 200');
    const confirmation = pick(c.book?.response?.json, 'ConfirmationNumber');
    if (c.book?.tboCode !== 200 || typeof confirmation !== 'string' || confirmation === '') {
      missing.push('Book 200 con ConfirmationNumber');
    }
    if (c.detail?.tboCode !== 200) missing.push('BookingDetail 200');
    if (
      kase.meta?.cancelAfter === true &&
      (c.cancel === undefined || c.afterCancel === undefined)
    ) {
      missing.push('Cancel y BookingDetail posterior (TBO_CANCEL_AFTER=true)');
    }
    const order = [c.search, c.prebook, c.book, c.detail].map((x) => x?.seq ?? -1);
    if (!missing.length && order.some((seq, i) => i > 0 && seq <= order[i - 1])) {
      missing.push('orden Search > PreBook > Book > BookingDetail');
    }
    if (missing.length > 0) findings.push(`${kase.folder}: ${missing.join(', ')}`);
  }
  const case8 = model.cases.find((c) => c.id === 8);
  const case4 = model.cases.find((c) => c.id === 4);
  if (case8 !== undefined) {
    const byNumber = callsOf(case8, 'BookingDetail', 'ByConfirmationNumber').at(-1);
    const byReference = callsOf(case8, 'BookingDetail', 'ByBookingReferenceId').at(-1);
    if (byNumber?.tboCode !== 200 || byReference?.tboCode !== 200) {
      findings.push(
        `${case8.folder}: BookingDetail por ConfirmationNumber y por BookingReferenceId con 200`,
      );
    }
    const book4 = case4 === undefined ? undefined : chainOf(case4).book;
    if (book4 !== undefined) {
      const number = pick(book4.response?.json, 'ConfirmationNumber');
      const reference = pick(book4.request?.json, 'BookingReferenceId');
      if (pick(byNumber?.request?.json, 'ConfirmationNumber') !== number)
        findings.push(`${case8.folder}: el ConfirmationNumber no es el del Book del caso 4`);
      if (pick(byReference?.request?.json, 'BookingReferenceId') !== reference)
        findings.push(`${case8.folder}: el BookingReferenceId no es el del Book del caso 4`);
    }
  }
  const builds = sameBuild(model);
  if (builds.size > 1) {
    findings.push(
      `los casos salieron de builds distintos (${[...builds].join(', ')}): corre todos con el mismo`,
    );
  }
  return result(
    'G-9',
    'Cadena completa por caso y Book 200 con ConfirmationNumber',
    true,
    findings,
  );
}

export function g10Window(model) {
  const findings = [];
  for (const kase of caseCalls(model)) {
    const { search, book } = chainOf(kase);
    const elapsed = Date.parse(book?.startedAt) - Date.parse(search?.startedAt);
    if (Number.isFinite(elapsed) && elapsed >= SEARCH_TO_BOOK_LIMIT_MS) {
      findings.push(`${kase.folder}: ${Math.round(elapsed / 60_000)} min de Search a Book`);
    }
  }
  return result('G-10', 'Menos de 30 min de Search a Book', false, findings);
}

export function g11Supplements(model) {
  const case7 = model.cases.find((c) => c.id === 7);
  if (case7 === undefined)
    return result('G-11', 'El caso 7 tiene suplementos', true, ['falta el caso 7']);
  const { search, prebook } = chainOf(case7);
  let supplements = supplementsOf(roomsOfPrebookRs(prebook?.response?.json)[0]);
  let source = 'PreBook';
  if (supplements.length === 0) {
    const code = pick(prebook?.request?.json, 'BookingCode');
    supplements = supplementsOf(searchOptionByCode(search?.response?.json, code));
    source = 'Search';
  }
  const types = new Map();
  for (const s of supplements) {
    const type = String(pick(s, 'Type') ?? '?');
    types.set(type, (types.get(type) ?? 0) + 1);
  }
  const summary = [...types].map(([type, n]) => `${type}×${n}`).join(', ');
  return result(
    'G-11',
    'El caso 7 tiene al menos un suplemento',
    true,
    supplements.length === 0 ? [`${case7.folder}: la tarifa reservada no trae Supplements`] : [],
    supplements.length === 0
      ? []
      : [`${summary} (${source})${types.has('AtProperty') ? '' : ' · sin AtProperty'}`],
  );
}

/**
 * El permiso es el de ESTA invocación (`--allow-non-test-host` en `verify`/`zip`), no el que quedó en
 * `run.json`: empaquetar para TBO una corrida hecha contra otro host tiene que pedirse otra vez.
 */
export function g12TestHost(model, { isTestEndpoint, allowNonTestHost }) {
  const findings = [];
  const baseUrl = model.run?.baseUrl;
  if (typeof baseUrl !== 'string' || !isTestEndpoint(baseUrl)) {
    if (!allowNonTestHost)
      findings.push(`la corrida no es contra el endpoint de test (${baseUrl ?? 'sin run.json'})`);
  }
  const host = typeof baseUrl === 'string' ? new URL(baseUrl).hostname.toLowerCase() : undefined;
  for (const kase of model.cases) {
    for (const call of kase.calls) {
      if (host !== undefined && new URL(call.url).hostname.toLowerCase() !== host) {
        findings.push(`${kase.folder}: una llamada a otro host`);
      }
    }
  }
  return result('G-12', 'baseUrl es el endpoint de test de TBO', true, findings);
}

export function g13JsonResponses(model) {
  const findings = [];
  for (const kase of model.cases) {
    for (const call of kase.calls) {
      if (call.response !== undefined && call.response.json === undefined) {
        findings.push(
          `${kase.folder}/${call.response.name} no es JSON (se entrega igual: es un hallazgo)`,
        );
      }
    }
  }
  return result('G-13', 'Cada RS parsea como JSON', false, findings);
}

/**
 * Todas, en orden. `ctx`: `secrets` (G-1), `firstNames` y `lastNames` (G-4), `isTestEndpoint` y
 * `allowNonTestHost` (G-12).
 */
export function evaluateGuards(model, ctx) {
  return [
    g1Credentials(model, ctx),
    g2CardData(model),
    g3PaymentMode(model),
    g4SyntheticNames(model, ctx),
    g5ListingSearch(model),
    g6Nationality(model),
    g7Occupancy(model),
    g8TotalFare(model),
    g9CompleteChains(model),
    g10Window(model),
    g11Supplements(model),
    g12TestHost(model, ctx),
    g13JsonResponses(model),
  ];
}

export function blockingFailures(results) {
  return results.filter((r) => r.blocking && !r.ok);
}

// ───────────────────────── Checkpoints visibles en el JSON ─────────────────────────

function extraChecks(model) {
  const hotelCodes = [];
  const prebookCodes = [];
  const voucher = [];
  const references = [];
  const seenReferences = new Map();
  const cancellations = [];
  for (const kase of caseCalls(model)) {
    const c = chainOf(kase);
    const codes = pick(c.search?.request?.json, 'HotelCodes');
    if (typeof codes !== 'string' || codes.split(',').length > 100) {
      hotelCodes.push(`${kase.folder}: HotelCodes no es un CSV de hasta 100`);
    }
    const bookingCode = pick(c.prebook?.request?.json, 'BookingCode');
    if (searchOptionByCode(c.search?.response?.json, bookingCode) === undefined) {
      prebookCodes.push(
        `${kase.folder}: el BookingCode del PreBook no está en la respuesta del Search`,
      );
    }
    const bookRq = c.book?.request?.json;
    if (pick(bookRq, 'BookingType') !== 'Voucher')
      voucher.push(`${kase.folder}: BookingType no es "Voucher"`);
    const reference = pick(bookRq, 'BookingReferenceId');
    if (typeof reference !== 'string' || reference !== pick(bookRq, 'ClientReferenceId')) {
      references.push(`${kase.folder}: BookingReferenceId y ClientReferenceId no coinciden`);
    } else if (seenReferences.has(reference)) {
      references.push(
        `${kase.folder}: BookingReferenceId repetido (${seenReferences.get(reference)})`,
      );
    } else {
      seenReferences.set(reference, kase.folder);
    }
    if (kase.meta?.cancelAfter === true) {
      const status = pick(pick(c.afterCancel?.response?.json, 'BookingDetail'), 'BookingStatus');
      if (c.cancel?.tboCode !== 200 || typeof status !== 'string' || !/cancel/i.test(status)) {
        cancellations.push(`${kase.folder}: la lectura posterior no la muestra cancelada`);
      }
    }
  }
  return { hotelCodes, prebookCodes, voucher, references, cancellations };
}

/** La tabla de 07 §3 para `selfcheck.md`: sólo los checkpoints que se ven en el JSON (J). */
export function checkpointTable(model, guards) {
  const byId = new Map(guards.map((g) => [g.id, g]));
  const extra = extraChecks(model);
  // Las comprobaciones propias no abortan el zip (las guardas son G-1 a G-13, 07 §6.7): dicen si
  // lo que TBO va a mirar está mal (`falla`) o hay que mirarlo antes de enviar (`revisar`).
  const status = (ids, findings = [], severity = 'revisar') => {
    const failed = ids.map((id) => byId.get(id)).filter((g) => g !== undefined && !g.ok);
    if (failed.some((g) => g.blocking)) return 'falla';
    if (findings.length > 0) return severity;
    if (failed.length > 0) return 'revisar';
    return 'ok';
  };
  const recovered = model.cases.some((kase) => chainOf(kase).recovery !== undefined);
  return [
    { ck: 'CK-01', basis: 'G-6', status: status(['G-6']) },
    { ck: 'CK-02', basis: 'G-5', status: status(['G-5']) },
    { ck: 'CK-03', basis: 'G-7', status: status(['G-7']) },
    {
      ck: 'CK-04',
      basis: 'HotelCodes CSV ≤ 100',
      status: status([], extra.hotelCodes, 'falla'),
      notes: extra.hotelCodes,
    },
    { ck: 'CK-05', basis: 'G-9, G-10', status: status(['G-9', 'G-10']) },
    {
      ck: 'CK-06',
      basis: 'G-3; BookingCode del Search',
      status: status(['G-3'], extra.prebookCodes),
      notes: extra.prebookCodes,
    },
    { ck: 'CK-08', basis: 'G-11', status: status(['G-11']) },
    { ck: 'CK-10', basis: 'G-4, G-7', status: status(['G-4', 'G-7']) },
    {
      ck: 'CK-11',
      basis: 'G-2, G-3, G-8; BookingType',
      status: status(['G-2', 'G-3', 'G-8'], extra.voucher, 'falla'),
      notes: extra.voucher,
    },
    {
      ck: 'CK-12',
      basis: 'BookingReferenceId = ClientReferenceId, únicos',
      status: status([], extra.references, 'falla'),
      notes: extra.references,
    },
    { ck: 'CK-13', basis: 'G-9', status: status(['G-9']) },
    {
      ck: 'CK-14',
      basis: 'BookingDetail por BookingReferenceId a los 120 s',
      status: recovered ? 'revisar' : 'no ocurrió',
      notes: recovered ? ['un Book incierto se resolvió leyendo: revisar la captura Recovery'] : [],
    },
    {
      ck: 'CK-15',
      basis: 'Cancel + BookingDetail posterior',
      status: status([], extra.cancellations),
      notes: extra.cancellations,
    },
  ];
}
