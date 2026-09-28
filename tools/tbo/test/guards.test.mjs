import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SYNTHETIC_FIRST_NAMES,
  SYNTHETIC_LAST_NAMES,
  caseFolderName,
  certCase,
  syntheticGuests,
} from '../lib/cases.mjs';
import {
  SEARCH_TO_BOOK_LIMIT_MS,
  blockingFailures,
  checkpointTable,
  evaluateGuards,
} from '../lib/guards.mjs';
import { zipEntriesOf } from '../lib/run-model.mjs';
import { HarnessSecrets, REDACTED } from '../lib/secrets.mjs';

/**
 * Las guardas G-1 a G-13 son puras: aquí corren sobre un modelo de corrida armado en memoria, sin
 * disco ni red. El modelo de partida es una corrida buena (las 13 pasan) y cada test le rompe una
 * cosa.
 */

const BASE = 'http://api.tbotechnology.in/TBOHolidays_HotelAPI';
const T0 = '2026-10-15T14:00:00.000Z';
const BUILD = {
  gitSha: 'abc123',
  gitDirty: false,
  acl: { name: '@sales-travel/tbo-hotels', version: '0.0.0' },
};
const secrets = new HarnessSecrets('cert-user-9', 'cert-pass-9');
const CTX = {
  secrets,
  firstNames: SYNTHETIC_FIRST_NAMES,
  lastNames: SYNTHETIC_LAST_NAMES,
  isTestEndpoint: (url) => new URL(url).hostname === 'api.tbotechnology.in',
  allowNonTestHost: false,
};

const ok = (extra = {}) => ({ Status: { Code: 200, Description: 'Successful' }, ...extra });

function part(name, json, raw) {
  return { name, json, bytes: Buffer.from(raw ?? JSON.stringify(json)) };
}

function call(seq, operation, label, rq, rs) {
  const base = `${String(seq).padStart(2, '0')}_${operation}${label ? `_${label}` : ''}`;
  return {
    seq,
    operation,
    label,
    url: `${BASE}/${operation}`,
    startedAt: T0,
    httpStatus: 200,
    tboCode: rs?.Status?.Code ?? null,
    request: part(`${base}_RQ.json`, rq),
    response: part(`${base}_RS.json`, rs),
  };
}

/** Cambia el JSON de un RQ o RS y sus bytes a la vez, como estarían en disco. */
function setJson(target, json) {
  target.json = json;
  target.bytes = Buffer.from(JSON.stringify(json));
}

function tboNames(rooms, lastName) {
  return syntheticGuests(rooms, lastName).map((room) => ({
    CustomerNames: room.guests.map((g) => ({
      Title: g.title,
      FirstName: g.firstName,
      LastName: g.lastName,
      Type: g.paxType === 'ADT' ? 'Adult' : 'Child',
    })),
  }));
}

const reference = (id) => `STT${String(id).padStart(17, '0')}`;

function bookingCase(id) {
  const def = certCase(id);
  const rooms = def.rooms ?? certCase(4).rooms;
  const code = `37656${id}!TB!1!TB!sesion-${id}`;
  const ref = reference(id);
  const cn = `CN${id}`;
  const supplements = rooms.map((_, i) => [
    { Index: i + 1, Type: 'AtProperty', Description: 'mandatory_tax', Price: 20, Currency: 'AED' },
  ]);
  const option = { BookingCode: code, TotalFare: 100.5, Supplements: supplements };
  const detail = (status) =>
    ok({ BookingDetail: { BookingStatus: status, ConfirmationNumber: cn } });
  return {
    id,
    folder: caseFolderName(def, id === 7 ? 4 : undefined),
    meta: {
      case: id,
      nationality: def.nationality,
      rooms,
      cancelAfter: true,
      build: BUILD,
    },
    calls: [
      call(
        1,
        'Search',
        null,
        {
          CheckIn: '2026-11-10',
          CheckOut: '2026-11-12',
          HotelCodes: '376565,1345318',
          GuestNationality: def.nationality,
          PaxRooms: rooms.map((r) => ({
            Adults: r.adults,
            Children: r.childrenAges.length,
            ChildrenAges: [...r.childrenAges],
          })),
          ResponseTime: 10,
          IsDetailedResponse: false,
          Filters: { Refundable: false, NoOfRooms: 0, MealType: 'All' },
        },
        ok({ HotelResult: [{ HotelCode: '376565', Currency: 'USD', Rooms: [option] }] }),
      ),
      call(
        2,
        'PreBook',
        null,
        { BookingCode: code, PaymentMode: 'Limit' },
        ok({ HotelResult: [{ HotelCode: '376565', Currency: 'USD', Rooms: [option] }] }),
      ),
      call(
        3,
        'Book',
        null,
        {
          BookingCode: code,
          CustomerDetails: tboNames(rooms, def.lastName),
          ClientReferenceId: ref,
          BookingReferenceId: ref,
          TotalFare: 100.5,
          EmailId: 'reservas@example.com',
          PhoneNumber: '573000000000',
          BookingType: 'Voucher',
          PaymentMode: 'Limit',
        },
        ok({ ClientReferenceId: ref, ConfirmationNumber: cn }),
      ),
      call(
        4,
        'BookingDetail',
        null,
        { ConfirmationNumber: cn, PaymentMode: 'Limit' },
        detail('Confirmed'),
      ),
      call(
        5,
        'BookingDetail',
        'BeforeCancel',
        { ConfirmationNumber: cn, PaymentMode: 'Limit' },
        detail('Confirmed'),
      ),
      call(
        6,
        'Cancel',
        null,
        { ConfirmationNumber: cn },
        { Status: { Code: 200, Description: 'Cancelled' }, ConfirmationNumber: cn },
      ),
      call(
        7,
        'BookingDetail',
        'AfterCancel',
        { ConfirmationNumber: cn, PaymentMode: 'Limit' },
        detail('Cancelled'),
      ),
    ],
  };
}

function caseEight() {
  const detail = ok({ BookingDetail: { BookingStatus: 'Confirmed', ConfirmationNumber: 'CN4' } });
  return {
    id: 8,
    folder: caseFolderName(certCase(8)),
    meta: { case: 8, build: BUILD },
    calls: [
      call(
        1,
        'BookingDetail',
        'ByConfirmationNumber',
        { ConfirmationNumber: 'CN4', PaymentMode: 'Limit' },
        detail,
      ),
      call(
        2,
        'BookingDetail',
        'ByBookingReferenceId',
        { BookingReferenceId: reference(4), PaymentMode: 'Limit' },
        detail,
      ),
    ],
  };
}

function modelOf(cases, run = { baseUrl: BASE, allowNonTestHost: false }) {
  const files = cases.flatMap((kase) =>
    kase.calls.flatMap((c) =>
      [c.request, c.response]
        .filter((p) => p !== undefined)
        .map((p) => ({ path: `${kase.folder}/${p.name}`, bytes: p.bytes })),
    ),
  );
  return {
    runId: 'r',
    run,
    cases,
    duplicates: [],
    files,
    attempts: [],
    entries: zipEntriesOf(cases),
  };
}

function goodModel(mutate) {
  const cases = [1, 2, 3, 4, 5, 6, 7].map(bookingCase);
  cases.push(caseEight());
  mutate?.(new Map(cases.map((c) => [c.id, c])));
  return modelOf(cases);
}

const byId = (results) => new Map(results.map((r) => [r.id, r]));
const guard = (model, id) => byId(evaluateGuards(model, CTX)).get(id);
const callOf = (kase, operation, label = null) =>
  kase.calls.find((c) => c.operation === operation && (c.label ?? null) === label);

describe('una corrida buena', () => {
  it('pasa las 13 guardas y todos los checkpoints visibles en el JSON', () => {
    const model = goodModel();
    const results = evaluateGuards(model, CTX);
    assert.deepEqual(
      results.map((r) => r.id),
      [
        'G-1',
        'G-2',
        'G-3',
        'G-4',
        'G-5',
        'G-6',
        'G-7',
        'G-8',
        'G-9',
        'G-10',
        'G-11',
        'G-12',
        'G-13',
      ],
    );
    for (const r of results) assert.ok(r.ok, `${r.id}: ${r.findings.join('; ')}`);
    assert.deepEqual(blockingFailures(results), []);
    const table = checkpointTable(model, results);
    for (const row of table) {
      assert.ok(['ok', 'no ocurrió'].includes(row.status), `${row.ck}: ${row.status}`);
    }
  });

  it('abortan G-1 a G-9, G-11 y G-12; G-10 y G-13 sólo advierten (07 §6.7)', () => {
    const blocking = evaluateGuards(goodModel(), CTX)
      .filter((r) => r.blocking)
      .map((r) => r.id);
    assert.deepEqual(blocking, [
      'G-1',
      'G-2',
      'G-3',
      'G-4',
      'G-5',
      'G-6',
      'G-7',
      'G-8',
      'G-9',
      'G-11',
      'G-12',
    ]);
  });
});

describe('G-1 credenciales y Authorization', () => {
  it('aborta si cualquier archivo de la corrida lleva la contraseña o el token, sin decir cuál es', () => {
    const model = goodModel();
    model.files.push({
      path: 'attempts/Case01_1Room_1A/try-01/calls.jsonl',
      bytes: Buffer.from('x cert-pass-9 y'),
    });
    const token = Buffer.from('cert-user-9:cert-pass-9').toString('base64');
    model.files.push({ path: 'probes/PR-06/calls.jsonl', bytes: Buffer.from(`Basic ${token}`) });
    const g = guard(model, 'G-1');
    assert.equal(g.ok, false);
    assert.match(g.findings.join('\n'), /try-01\/calls\.jsonl contiene TBO_PASSWORD/);
    assert.match(g.findings.join('\n'), /PR-06\/calls\.jsonl contiene BASIC_TOKEN/);
    assert.doesNotMatch(g.findings.join('\n'), /cert-pass-9|cert-user-9/);
  });

  it('aborta con Authorization en un RQ o con forma de cabecera en un RS', () => {
    const inRq = goodModel((c) => {
      const search = callOf(c.get(1), 'Search');
      setJson(search.request, { ...search.request.json, Authorization: 'x' });
    });
    assert.match(guard(inRq, 'G-1').findings.join(), /01_Search_RQ\.json contiene "Authorization"/);
    const inRs = goodModel((c) => {
      const book = callOf(c.get(2), 'Book');
      book.response.bytes = Buffer.from('{"echo":"Authorization: Basic Zm9vOmJhcg=="}');
    });
    assert.match(guard(inRs, 'G-1').findings.join(), /03_Book_RS\.json contiene "Authorization"/);
  });

  it('la palabra en las condiciones de un hotel no es una cabecera: pasa', () => {
    const model = goodModel((c) => {
      const prebook = callOf(c.get(3), 'PreBook');
      prebook.response.bytes = Buffer.from(
        JSON.stringify({
          ...prebook.response.json,
          RateConditions: ['Credit card authorization required at check-in'],
        }),
      );
    });
    assert.equal(guard(model, 'G-1').ok, true);
  });

  it('un RS con la credencial tapada pasa con nota; un RQ tapado aborta', () => {
    const model = goodModel((c) => {
      callOf(c.get(1), 'Search').response.bytes = Buffer.from(`{"x":"${REDACTED}"}`);
      callOf(c.get(2), 'Search').request.bytes = Buffer.from(`{"x":"${REDACTED}"}`);
    });
    const g = guard(model, 'G-1');
    assert.match(g.notes.join(), /Case01_1Room_1A\/01_Search_RS\.json: TBO repitió la credencial/);
    assert.match(
      g.findings.join(),
      /Case02_1Room_1A1C\/01_Search_RQ\.json lleva una credencial tapada/,
    );
  });
});

describe('D1 en la evidencia (G-2, G-3)', () => {
  it('G-2 aborta con PaymentInfo o cualquier clave de tarjeta, en cualquier nivel y casing', () => {
    const model = goodModel((c) => {
      const book = callOf(c.get(5), 'Book');
      setJson(book.request, { ...book.request.json, PaymentInfo: { CvvNumber: '000' } });
      const prebook = callOf(c.get(6), 'PreBook');
      setJson(prebook.request, { ...prebook.request.json, extra: [{ CardHolderlastName: 'x' }] });
    });
    const findings = guard(model, 'G-2').findings.join('\n');
    assert.match(findings, /Case05_2Rooms_1A1C_1A\/03_Book_RQ\.json: PaymentInfo/);
    assert.match(
      findings,
      /Case06_2Rooms_1A2C_2A\/02_PreBook_RQ\.json: extra\.0\.CardHolderlastName/,
    );
  });

  it('G-2 aborta con un RQ que no es JSON: no se puede afirmar D1', () => {
    const model = goodModel((c) => {
      const search = callOf(c.get(1), 'Search');
      search.request.json = undefined;
      search.request.bytes = Buffer.from('no-json');
    });
    assert.match(guard(model, 'G-2').findings.join(), /no es JSON/);
  });

  it('G-3 aborta sin PaymentMode en PreBook, Book o BookingDetail, o con otro valor en cualquier RQ', () => {
    const model = goodModel((c) => {
      const prebook = callOf(c.get(1), 'PreBook');
      setJson(prebook.request, { BookingCode: prebook.request.json.BookingCode });
      const book = callOf(c.get(2), 'Book');
      setJson(book.request, { ...book.request.json, PaymentMode: 'NewCard' });
    });
    const findings = guard(model, 'G-3').findings.join('\n');
    assert.match(findings, /Case01_1Room_1A\/02_PreBook_RQ\.json: PreBook sin PaymentMode "Limit"/);
    assert.match(findings, /Case02_1Room_1A1C\/03_Book_RQ\.json: PaymentMode no es "Limit"/);
  });
});

describe('G-4 nombres sintéticos', () => {
  it('aborta con un nombre o apellido fuera de la lista y no lo copia al hallazgo', () => {
    const model = goodModel((c) => {
      const book = callOf(c.get(3), 'Book');
      const details = structuredClone(book.request.json.CustomerDetails);
      details[0].CustomerNames[1].FirstName = 'Juanita';
      details[0].CustomerNames[2].LastName = 'Perez';
      setJson(book.request, { ...book.request.json, CustomerDetails: details });
    });
    const g = guard(model, 'G-4');
    assert.equal(g.ok, false);
    assert.match(g.findings.join('\n'), /CustomerNames\[1\]\.FirstName fuera de la lista/);
    assert.match(g.findings.join('\n'), /CustomerNames\[2\]\.LastName fuera de la lista/);
    assert.doesNotMatch(g.findings.join('\n'), /Juanita|Perez/);
  });
});

describe('G-5, G-6 y G-7 sobre el Search', () => {
  it('G-5 aborta con un Search de detalle en el zip', () => {
    const model = goodModel((c) => {
      const search = callOf(c.get(2), 'Search');
      setJson(search.request, { ...search.request.json, IsDetailedResponse: true });
    });
    assert.match(guard(model, 'G-5').findings.join(), /Case02_1Room_1A1C\/01_Search_RQ\.json/);
  });

  it('G-6 aborta con menos de 3 nacionalidades o una que no es la del caso', () => {
    const model = goodModel((c) => {
      for (const id of [1, 2, 3, 4, 5, 6, 7]) {
        const search = callOf(c.get(id), 'Search');
        setJson(search.request, { ...search.request.json, GuestNationality: id % 2 ? 'CO' : 'PE' });
      }
    });
    const findings = guard(model, 'G-6').findings.join('\n');
    assert.match(findings, /toma 2 valores/);
    assert.match(findings, /Case03_1Room_2A2C: GuestNationality no es la del huésped líder/);
  });

  it('G-7 aborta si el Book invierte las habitaciones del Search (caso 5)', () => {
    const model = goodModel((c) => {
      const book = callOf(c.get(5), 'Book');
      const details = [...book.request.json.CustomerDetails].reverse();
      setJson(book.request, { ...book.request.json, CustomerDetails: details });
    });
    const findings = guard(model, 'G-7').findings.join('\n');
    assert.match(findings, /habitación 1 con 1 Adult y 0 Child en Book frente a 1 y 1 en Search/);
  });

  it('G-7 aborta si el PaxRooms no es la ocupación de 07 §4.2', () => {
    const model = goodModel((c) => {
      const search = callOf(c.get(3), 'Search');
      const pax = structuredClone(search.request.json.PaxRooms);
      pax[0].ChildrenAges = [10, 4];
      setJson(search.request, { ...search.request.json, PaxRooms: pax });
    });
    assert.match(guard(model, 'G-7').findings.join(), /PaxRooms\[0\] no es la ocupación del caso/);
  });

  it('G-6 y G-7 comparan con la tabla de 07 §4.2 aunque falte case.json', () => {
    const model = goodModel((c) => {
      for (const kase of c.values()) kase.meta = undefined;
      const search = callOf(c.get(2), 'Search');
      setJson(search.request, {
        ...search.request.json,
        GuestNationality: 'MX',
        PaxRooms: [{ Adults: 2, Children: 0, ChildrenAges: [] }],
      });
      const book = callOf(c.get(2), 'Book');
      setJson(book.request, {
        ...book.request.json,
        CustomerDetails: tboNames([{ adults: 2, childrenAges: [] }], 'Testdos'),
      });
    });
    assert.match(
      guard(model, 'G-6').findings.join(),
      /Case02_1Room_1A1C: GuestNationality no es la del huésped líder/,
    );
    const g7 = guard(model, 'G-7').findings.join('\n');
    assert.match(g7, /Case02_1Room_1A1C: PaxRooms\[0\] no es la ocupación del caso/);
    // El 7 sin case.json: la del 4 (2 habitaciones) vale; ninguna otra.
    assert.doesNotMatch(g7, /Case07/);
  });

  it('G-7 del caso 7 acepta la ocupación del 1 y rechaza otra', () => {
    const one = [{ Adults: 1, Children: 0, ChildrenAges: [] }];
    const ofCaseOne = goodModel((c) => {
      const seven = c.get(7);
      seven.meta = { ...seven.meta, occupancyOf: 1, rooms: certCase(1).rooms };
      const search = callOf(seven, 'Search');
      setJson(search.request, { ...search.request.json, PaxRooms: one });
      const book = callOf(seven, 'Book');
      setJson(book.request, {
        ...book.request.json,
        CustomerDetails: tboNames(certCase(1).rooms, 'Testsiete'),
      });
    });
    assert.equal(guard(ofCaseOne, 'G-7').ok, true);

    const other = goodModel((c) => {
      const seven = c.get(7);
      const search = callOf(seven, 'Search');
      setJson(search.request, {
        ...search.request.json,
        PaxRooms: [
          { Adults: 2, Children: 0, ChildrenAges: [] },
          { Adults: 1, Children: 0, ChildrenAges: [] },
        ],
      });
    });
    assert.match(
      guard(other, 'G-7').findings.join(),
      /Case07_Supplements_2Rooms_1A_1A: PaxRooms\[0\] no es la ocupación del caso/,
    );
  });

  it('G-7 acepta la forma sin niños que fije PR-01 ([0] u omitido)', () => {
    const model = goodModel((c) => {
      const search = callOf(c.get(4), 'Search');
      setJson(search.request, {
        ...search.request.json,
        PaxRooms: [
          { Adults: 1, Children: 0, ChildrenAges: [0] },
          { Adults: 1, Children: 0 },
        ],
      });
    });
    assert.equal(guard(model, 'G-7').ok, true);
  });
});

describe('G-8 a G-12', () => {
  it('G-8 aborta si el Book no manda el TotalFare del PreBook', () => {
    const model = goodModel((c) => {
      const book = callOf(c.get(6), 'Book');
      setJson(book.request, { ...book.request.json, TotalFare: 100.51 });
    });
    assert.match(
      guard(model, 'G-8').findings.join(),
      /Case06_2Rooms_1A2C_2A: Book\.TotalFare 100\.51 y PreBook 100\.5/,
    );
  });

  it('G-9 aborta si falta un caso, un Book no confirma o falta el Cancel pedido', () => {
    const model = goodModel((c) => {
      const book = callOf(c.get(2), 'Book');
      setJson(book.response, { Status: { Code: 200 }, ClientReferenceId: reference(2) });
      c.get(5).calls = c.get(5).calls.filter((x) => x.operation !== 'Cancel');
    });
    model.cases = model.cases.filter((k) => k.id !== 3);
    const findings = guard(model, 'G-9').findings.join('\n');
    assert.match(findings, /falta el caso 3/);
    assert.match(findings, /Case02_1Room_1A1C: Book 200 con ConfirmationNumber/);
    assert.match(findings, /Case05_2Rooms_1A1C_1A: Cancel y BookingDetail posterior/);
  });

  it('G-9 aborta con una llamada reescrita (no es la aplicación), casos de builds distintos o un 8 ajeno', () => {
    const model = goodModel((c) => {
      callOf(c.get(1), 'Search').mutation = 'HotelCodes: 100 → 101';
      c.get(2).meta.build = { ...BUILD, gitSha: 'otro' };
      const byNumber = c.get(8).calls[0];
      setJson(byNumber.request, { ConfirmationNumber: 'CN9', PaymentMode: 'Limit' });
    });
    const findings = guard(model, 'G-9').findings.join('\n');
    assert.match(findings, /una llamada reescrita/);
    assert.match(findings, /builds distintos \(abc123@0\.0\.0, otro@0\.0\.0\)/);
    assert.match(findings, /el ConfirmationNumber no es el del Book del caso 4/);
  });

  it('G-9 no exige Cancel si la corrida se hizo con TBO_CANCEL_AFTER=false', () => {
    const model = goodModel((c) => {
      for (const id of [1, 2, 3, 4, 5, 6, 7]) {
        const kase = c.get(id);
        kase.meta.cancelAfter = false;
        kase.calls = kase.calls.filter((x) => x.seq <= 4);
      }
    });
    assert.equal(guard(model, 'G-9').ok, true);
    const ck15 = checkpointTable(model, evaluateGuards(model, CTX)).find((r) => r.ck === 'CK-15');
    assert.equal(ck15.status, 'ok');
  });

  it('G-10 sólo advierte si de Search a Book pasaron 30 minutos o más', () => {
    const model = goodModel((c) => {
      callOf(c.get(1), 'Book').startedAt = new Date(
        Date.parse(T0) + SEARCH_TO_BOOK_LIMIT_MS,
      ).toISOString();
    });
    const g = guard(model, 'G-10');
    assert.equal(g.ok, false);
    assert.equal(g.blocking, false);
    assert.match(g.findings.join(), /30 min de Search a Book/);
    assert.deepEqual(blockingFailures(evaluateGuards(model, CTX)), []);
  });

  it('G-11 aborta si la tarifa del caso 7 no trae suplementos; con Included pasa y lo anota', () => {
    const none = goodModel((c) => {
      for (const operation of ['Search', 'PreBook']) {
        const x = callOf(c.get(7), operation);
        const hotel = x.response.json.HotelResult[0];
        setJson(x.response, {
          ...x.response.json,
          HotelResult: [
            { ...hotel, Rooms: [{ BookingCode: hotel.Rooms[0].BookingCode, TotalFare: 100.5 }] },
          ],
        });
      }
    });
    assert.match(guard(none, 'G-11').findings.join(), /no trae Supplements/);

    const included = goodModel((c) => {
      const x = callOf(c.get(7), 'PreBook');
      const hotel = x.response.json.HotelResult[0];
      const room = {
        ...hotel.Rooms[0],
        Supplements: [[{ Index: 1, Type: 'Included', Price: 5, Currency: 'USD' }]],
      };
      setJson(x.response, { ...x.response.json, HotelResult: [{ ...hotel, Rooms: [room] }] });
    });
    const g = guard(included, 'G-11');
    assert.equal(g.ok, true);
    assert.match(g.notes.join(), /Included×1 \(PreBook\) · sin AtProperty/);
  });

  it('G-12 aborta contra otro host salvo con --allow-non-test-host', () => {
    const cases = goodModel().cases;
    const live = modelOf(cases, {
      baseUrl: 'https://live.example.com/HotelAPI',
      allowNonTestHost: false,
    });
    assert.match(guard(live, 'G-12').findings.join(), /no es contra el endpoint de test/);
    assert.equal(
      byId(evaluateGuards(live, { ...CTX, allowNonTestHost: true }))
        .get('G-12')
        .findings.some((f) => f.includes('endpoint de test')),
      false,
    );
    // Que el `run` se haya hecho con la opción no basta: `verify`/`zip` la tienen que pedir otra vez.
    const allowedAtRun = modelOf(cases, {
      baseUrl: 'https://live.example.com/HotelAPI',
      allowNonTestHost: true,
    });
    assert.match(guard(allowedAtRun, 'G-12').findings.join(), /no es contra el endpoint de test/);
  });

  it('G-13 sólo advierte con un RS que no es JSON (se entrega igual)', () => {
    const model = goodModel((c) => {
      const detail = callOf(c.get(1), 'BookingDetail');
      detail.response = {
        name: '04_BookingDetail_RS.txt',
        bytes: Buffer.from('<html>'),
        json: undefined,
      };
    });
    const g = guard(model, 'G-13');
    assert.equal(g.ok, false);
    assert.equal(g.blocking, false);
    assert.match(g.findings.join(), /04_BookingDetail_RS\.txt no es JSON/);
  });
});

describe('checkpoints visibles en el JSON', () => {
  it('CK-12 falla si BookingReferenceId y ClientReferenceId difieren o se repiten entre casos', () => {
    const model = goodModel((c) => {
      const book = callOf(c.get(2), 'Book');
      setJson(book.request, {
        ...book.request.json,
        BookingReferenceId: reference(1),
        ClientReferenceId: reference(1),
      });
    });
    const ck12 = checkpointTable(model, evaluateGuards(model, CTX)).find((r) => r.ck === 'CK-12');
    assert.equal(ck12.status, 'falla');
    assert.match(ck12.notes.join(), /repetido/);
  });

  it('CK-14 se marca a revisar si hubo una lectura de recuperación', () => {
    const model = goodModel((c) => {
      c.get(1).calls.push(
        call(
          8,
          'BookingDetail',
          'Recovery',
          { BookingReferenceId: reference(1), PaymentMode: 'Limit' },
          ok(),
        ),
      );
    });
    const ck14 = checkpointTable(model, evaluateGuards(model, CTX)).find((r) => r.ck === 'CK-14');
    assert.equal(ck14.status, 'revisar');
  });
});
