import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { readZip } from '../lib/zip.mjs';
import { createFakeTbo } from './fake-tbo.mjs';
import {
  NOW,
  SECRET_NEEDLES,
  assertNoSecrets,
  cleanup,
  jsonl,
  newRoot,
  readJson,
  runHarness,
} from './support.mjs';

/**
 * `run`, `verify`, `zip` y `all` de punta a punta contra el TBO falso (docs/tbo/09 PR-7.1): los 8
 * casos con el `PaxRooms` exacto de 07 §4.2, la secuencia Search > PreBook > Book > BookingDetail >
 * Cancel, las guardas que abortan el zip y los reintentos de 07 §4.1 y §6.5. Sin red.
 */

after(cleanup);

/** Los `PaxRooms` exactos de la tabla maestra de 07 §4.2, como texto: byte a byte. */
const PAX_ROOMS = {
  Case01_1Room_1A: '[{"Adults":1,"Children":0,"ChildrenAges":[]}]',
  Case02_1Room_1A1C: '[{"Adults":1,"Children":1,"ChildrenAges":[7]}]',
  Case03_1Room_2A2C: '[{"Adults":2,"Children":2,"ChildrenAges":[4,10]}]',
  Case04_2Rooms_1A_1A:
    '[{"Adults":1,"Children":0,"ChildrenAges":[]},{"Adults":1,"Children":0,"ChildrenAges":[]}]',
  Case05_2Rooms_1A1C_1A:
    '[{"Adults":1,"Children":1,"ChildrenAges":[8]},{"Adults":1,"Children":0,"ChildrenAges":[]}]',
  Case06_2Rooms_1A2C_2A:
    '[{"Adults":1,"Children":2,"ChildrenAges":[3,11]},{"Adults":2,"Children":0,"ChildrenAges":[]}]',
  Case07_Supplements_2Rooms_1A_1A:
    '[{"Adults":1,"Children":0,"ChildrenAges":[]},{"Adults":1,"Children":0,"ChildrenAges":[]}]',
};

const NATIONALITY = {
  Case01_1Room_1A: 'CO',
  Case02_1Room_1A1C: 'PE',
  Case03_1Room_2A2C: 'BR',
  Case04_2Rooms_1A_1A: 'MX',
  Case05_2Rooms_1A1C_1A: 'CL',
  Case06_2Rooms_1A2C_2A: 'AR',
  Case07_Supplements_2Rooms_1A_1A: 'EC',
};

const CHAIN = [
  'Search',
  'PreBook',
  'Book',
  'BookingDetail',
  'BookingDetail_BeforeCancel',
  'Cancel',
  'BookingDetail_AfterCancel',
];

const ZIP = 'SalesTravel_TBO_HotelAPI_JSON_Certification_20260926.zip';

function zipEntries(result) {
  return readFile(join(result.dir, ZIP)).then(readZip);
}

function entryJson(entries, name) {
  const entry = entries.find((e) => e.name === name);
  assert.ok(entry, `falta ${name} en el zip`);
  return JSON.parse(entry.bytes.toString('utf8'));
}

describe('all: de las credenciales al zip, en una corrida', () => {
  let result;
  let entries;

  it('corre check, los 8 casos, las guardas y el zip; sale con 0', async () => {
    result = await runHarness(['all']);
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /TBO check/);
    assert.match(result.stdout, /Caso 08: completo en Case08_BookingDetail_OfCase04/);
    assert.match(result.stdout, /G-9 {2}ok/);
    assert.match(result.stdout, new RegExp(`Zip: ${ZIP}`));
    entries = await zipEntries(result);
    assert.ok(entries.every((e) => e.crcOk));
  });

  it('el zip lleva README, manifiesto y sólo los RQ/RS de los 8 casos, en orden', () => {
    const names = entries.map((e) => e.name);
    assert.deepEqual(names.slice(0, 2), ['README.txt', 'manifest.json']);
    const folders = [...new Set(names.slice(2).map((n) => n.split('/')[0]))];
    assert.deepEqual(folders, [
      'Case01_1Room_1A',
      'Case02_1Room_1A1C',
      'Case03_1Room_2A2C',
      'Case04_2Rooms_1A_1A',
      'Case05_2Rooms_1A1C_1A',
      'Case06_2Rooms_1A2C_2A',
      'Case07_Supplements_2Rooms_1A_1A',
      'Case08_BookingDetail_OfCase04',
    ]);
    for (const name of names.slice(2))
      assert.match(name, /^Case0\d_[^/]+\/\d{2}_[A-Za-z_]+_R[QS]\.json$/);
    // Ni el log de llamadas (lleva `Authorization: Basic «REDACTADO»`), ni sondas, ni intentos.
    assert.ok(!names.some((n) => /calls\.jsonl|acl-events|case\.json|probes|attempts/.test(n)));
  });

  it('el zip no contiene Authorization ni la credencial en ninguna forma (G-1)', () => {
    for (const entry of entries) {
      for (const needle of SECRET_NEEDLES) assert.ok(!entry.bytes.includes(needle), entry.name);
      assert.doesNotMatch(entry.bytes.toString('utf8'), /authorization/i, entry.name);
    }
  });

  it('cada caso 1-7: PaxRooms exacto de 07 §4.2, su nacionalidad y la secuencia completa', () => {
    for (const [folder, pax] of Object.entries(PAX_ROOMS)) {
      const search = entryJson(entries, `${folder}/01_Search_RQ.json`);
      assert.equal(JSON.stringify(search.PaxRooms), pax, folder);
      assert.equal(search.GuestNationality, NATIONALITY[folder], folder);
      assert.equal(search.IsDetailedResponse, false);
      const steps = entries
        .filter((e) => e.name.startsWith(`${folder}/`) && e.name.endsWith('_RQ.json'))
        .map((e) => e.name.slice(folder.length + 4, -'_RQ.json'.length));
      assert.deepEqual(steps, CHAIN, folder);
    }
  });

  it('los RQ del zip son los bytes que recibió TBO, sin re-serializar (RC-02)', () => {
    const sent = new Set(result.fake.requests.map((r) => r.body));
    for (const entry of entries.filter((e) => e.name.endsWith('_RQ.json'))) {
      assert.ok(sent.has(entry.bytes.toString('utf8')), entry.name);
    }
  });

  it('Book: PaymentMode Limit, Voucher, TotalFare del PreBook y huéspedes en el orden de PaxRooms', () => {
    const book = entryJson(entries, 'Case06_2Rooms_1A2C_2A/03_Book_RQ.json');
    const prebook = entryJson(entries, 'Case06_2Rooms_1A2C_2A/02_PreBook_RS.json');
    assert.equal(book.PaymentMode, 'Limit');
    assert.equal(book.BookingType, 'Voucher');
    assert.equal(book.PaymentInfo, undefined);
    assert.equal(book.TotalFare, prebook.HotelResult[0].Rooms[0].TotalFare);
    assert.equal(book.BookingReferenceId, book.ClientReferenceId);
    assert.deepEqual(
      book.CustomerDetails.map((room) => room.CustomerNames.map((g) => `${g.Type}:${g.FirstName}`)),
      [
        ['Adult:Mateo', 'Child:Lucia', 'Child:Tomas'],
        ['Adult:Paula', 'Adult:Andres'],
      ],
    );
    assert.equal(book.EmailId, 'reservas-cert@example.com');
    assert.equal(book.PhoneNumber, '573000000000');
  });

  it('caso 7 con suplementos AtProperty; caso 8 lee la reserva del 4 por las dos claves', async () => {
    const prebook = entryJson(entries, 'Case07_Supplements_2Rooms_1A_1A/02_PreBook_RS.json');
    const types = prebook.HotelResult[0].Rooms[0].Supplements.flat().map((s) => s.Type);
    assert.deepEqual(types, ['AtProperty', 'AtProperty']);
    const book4 = entryJson(entries, 'Case04_2Rooms_1A_1A/03_Book_RQ.json');
    const booked4 = entryJson(entries, 'Case04_2Rooms_1A_1A/03_Book_RS.json');
    assert.deepEqual(
      entryJson(
        entries,
        'Case08_BookingDetail_OfCase04/01_BookingDetail_ByConfirmationNumber_RQ.json',
      ),
      { ConfirmationNumber: booked4.ConfirmationNumber, PaymentMode: 'Limit' },
    );
    assert.deepEqual(
      entryJson(
        entries,
        'Case08_BookingDetail_OfCase04/02_BookingDetail_ByBookingReferenceId_RQ.json',
      ),
      { BookingReferenceId: book4.BookingReferenceId, PaymentMode: 'Limit' },
    );
    const readme = entries[0].bytes.toString('utf8');
    assert.match(readme, /07 supplements found: AtProperty mandatory_tax 20\.00 AED \(room 1\)/);
    assert.match(readme, /Company: SalesTravel {3}Run: 2026-09-26T12-00-00Z/);
    assert.match(readme, /Application build: sha-de-prueba/);
    assert.match(readme, /Case01_1Room_1A\/03_Book +\| 2026-09-26T12:00:00\.000Z \| 200 +\| 200/);
  });

  it('el manifiesto trae el SHA-256 de cada archivo del zip', () => {
    const manifest = entryJson(entries, 'manifest.json');
    const others = entries.filter((e) => e.name !== 'manifest.json');
    assert.equal(manifest.files.length, others.length);
    for (const file of manifest.files) {
      const entry = others.find((e) => e.name === file.name);
      assert.equal(file.sha256, createHash('sha256').update(entry.bytes).digest('hex'), file.name);
    }
    assert.equal(manifest.gitSha, 'sha-de-prueba');
  });

  it('cancela todas las reservas al final (TBO_CANCEL_AFTER=true) y lo deja escrito', async () => {
    const statuses = [...result.fake.bookings.values()].map((b) => b.status);
    assert.equal(statuses.length, 7);
    assert.ok(statuses.every((s) => s === 'Cancelled'));
    const selfcheck = await readFile(join(result.dir, 'selfcheck.md'), 'utf8');
    assert.match(selfcheck, /Resultado: se puede armar el zip/);
    assert.match(selfcheck, /\| CK-15 \| ok \|/);
    assert.doesNotMatch(result.stdout, /quedan ACTIVAS/);
  });

  it('nada de lo escrito ni de lo impreso lleva la credencial', async () => {
    await assertNoSecrets(result);
  });
});

describe('TBO_CANCEL_AFTER=false', () => {
  it('no cancela, lista las reservas activas y el README lo dice', async () => {
    const run = await runHarness(['run'], { env: { TBO_CANCEL_AFTER: 'false' } });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.fake.requests.filter((r) => r.url.endsWith('/Cancel')).length, 0);
    assert.ok([...run.fake.bookings.values()].every((b) => b.status === 'Confirmed'));
    assert.match(run.stdout, /Reservas de test que quedan ACTIVAS en TBO/);
    assert.match(
      run.stdout,
      /Caso 01 · ConfirmationNumber FK0001 · BookingReferenceId STT\w{17} · sin Cancel/,
    );

    const zip = await runHarness(['zip', run.runs[0]], { outRoot: run.root, fake: run.fake });
    assert.equal(zip.code, 0, zip.stdout);
    const [readme] = await readZip(await readFile(join(run.dir, ZIP)));
    assert.match(readme.bytes.toString('utf8'), /no \(TBO_CANCEL_AFTER=false\)/);
  });

  it('cancel <runId> cancela después lo que quedó activo, fuera del zip, y no repite', async () => {
    const run = await runHarness(['run'], { env: { TBO_CANCEL_AFTER: 'false' } });
    assert.match(run.stdout, new RegExp(`cert-cases\\.mjs cancel ${run.runs[0]}`));
    const cancel = await runHarness(['cancel', run.runs[0]], {
      outRoot: run.root,
      fake: run.fake,
      withBooking: false,
    });
    assert.equal(cancel.code, 0, cancel.stderr);
    assert.match(cancel.stdout, /7 reserva\(s\) activa\(s\)/);
    assert.ok([...run.fake.bookings.values()].every((b) => b.status === 'Cancelled'));
    const cases = await readJson(join(run.dir, 'cases.json'));
    assert.ok(cases.cases.filter((c) => c.case !== 8).every((c) => c.cancel.success === true));
    assert.ok(existsSync(join(run.dir, 'cancellations', 'Case01', '02_Cancel_RQ.json')));
    assert.doesNotMatch(cancel.stdout, /quedan ACTIVAS/);

    const cancels = run.fake.requests.filter((r) => r.url.endsWith('/Cancel')).length;
    const again = await runHarness(['cancel', run.runs[0]], {
      outRoot: run.root,
      fake: run.fake,
      withBooking: false,
    });
    assert.equal(again.code, 0);
    assert.match(again.stdout, /0 reserva\(s\) activa\(s\)/);
    assert.equal(run.fake.requests.filter((r) => r.url.endsWith('/Cancel')).length, cancels);

    const zip = await runHarness(['zip', run.runs[0]], { outRoot: run.root });
    assert.equal(zip.code, 0, zip.stdout);
    const names = (await readZip(await readFile(join(run.dir, ZIP)))).map((e) => e.name);
    assert.ok(!names.some((n) => n.startsWith('cancellations/')));
    await assertNoSecrets(cancel);
  });
});

describe('reservas que quedan vivas', () => {
  it('un segundo cancel no escribe encima de la captura del primero', async () => {
    const fake = createFakeTbo();
    const run = await runHarness(['run', '--cases', '1'], {
      fake,
      env: { TBO_CANCEL_AFTER: 'false' },
    });
    assert.equal(run.code, 0, run.stderr);
    const failing = createFakeTbo({ cancelCode: 479 });
    // El mismo estado de reservas, con un Cancel que TBO rechaza.
    for (const [key, value] of fake.bookings) failing.bookings.set(key, value);
    const first = await runHarness(['cancel', run.runs[0]], {
      outRoot: run.root,
      fake: failing,
      withBooking: false,
    });
    assert.equal(first.code, 1);
    const folder = join(run.dir, 'cancellations', 'Case01');
    const before = await readdir(folder);
    const originals = new Map();
    for (const name of before.filter((n) => /^\d{2}_/.test(n))) {
      originals.set(name, await readFile(join(folder, name)));
    }
    assert.ok(originals.size > 0);

    const second = await runHarness(['cancel', run.runs[0]], {
      outRoot: run.root,
      fake,
      withBooking: false,
    });
    assert.equal(second.code, 0, second.stderr);
    for (const [name, bytes] of originals) {
      assert.deepEqual(await readFile(join(folder, name)), bytes, name);
    }
    const after = (await readdir(folder)).filter((n) => /^\d{2}_/.test(n));
    assert.ok(after.length > originals.size);
    const calls = await jsonl(join(folder, 'calls.jsonl'));
    assert.equal(new Set(calls.map((c) => c.requestFile)).size, calls.length);
  });

  it('repetir un caso con --resume no pierde la reserva activa anterior: cancel la encuentra', async () => {
    const fake = createFakeTbo();
    const first = await runHarness(['run', '--cases', '1'], {
      fake,
      env: { TBO_CANCEL_AFTER: 'false' },
    });
    const [runId] = first.runs;
    const again = await runHarness(['run', '--cases', '1', '--resume', runId], {
      fake,
      outRoot: first.root,
      now: NOW + 3_600_000,
      env: { TBO_CANCEL_AFTER: 'false' },
    });
    assert.equal(again.code, 0, again.stderr);
    const active = again.stdout.slice(again.stdout.indexOf('quedan ACTIVAS'));
    assert.match(active, /Caso 01 · ConfirmationNumber FK0001/);
    assert.match(active, /Caso 01 · ConfirmationNumber FK0002/);
    const cases = await readJson(join(first.dir, 'cases.json'));
    assert.equal(cases.cases[0].confirmationNumber, 'FK0002');
    assert.deepEqual(
      cases.superseded.map((r) => r.confirmationNumber),
      ['FK0001'],
    );

    const cancel = await runHarness(['cancel', runId], {
      outRoot: first.root,
      fake,
      withBooking: false,
    });
    assert.equal(cancel.code, 0, cancel.stderr);
    assert.match(cancel.stdout, /2 reserva\(s\) activa\(s\)/);
    assert.ok([...fake.bookings.values()].every((b) => b.status === 'Cancelled'));
  });

  it('si la corrida se corta, igual lista lo que dejó activo', async () => {
    const fake = createFakeTbo({ bookSequence: [200, 402] });
    const result = await runHarness(['run', '--cases', '1,2'], {
      fake,
      env: { TBO_CANCEL_AFTER: 'false' },
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /TBO rechaza la cuenta/);
    assert.match(
      result.stdout,
      /quedan ACTIVAS[\s\S]*Caso 01 · ConfirmationNumber FK0001[\s\S]*cert-cases\.mjs cancel/,
    );
  });
});

describe('intentos (07 §4.1 y §6.5)', () => {
  it('201 y 207 corren la fecha 7 días; los intentos quedan en attempts/ y fuera del caso', async () => {
    const fake = createFakeTbo({ searchSequence: [201], prebookSequence: [207] });
    const result = await runHarness(['run', '--cases', '1'], { fake });
    assert.equal(result.code, 0, result.stderr);
    const searches = fake.requests
      .filter((r) => r.url.endsWith('/Search'))
      .map((r) => JSON.parse(r.body).CheckIn);
    assert.deepEqual(searches, ['2026-11-10', '2026-11-17', '2026-11-24']);
    const index = await jsonl(join(result.dir, 'attempts', 'index.jsonl'));
    assert.deepEqual(
      index.map((a) => [a.try, a.status, a.reason]),
      [
        ['attempts/Case01_1Room_1A/try-01', 'discarded', 'no-availability'],
        ['attempts/Case01_1Room_1A/try-02', 'discarded', 'prebook:RATE_UNAVAILABLE'],
        ['attempts/Case01_1Room_1A/try-03', 'complete', 'complete'],
      ],
    );
    assert.equal(index[2].promotedTo, 'Case01_1Room_1A');
    const kept = await readdir(join(result.dir, 'Case01_1Room_1A'));
    assert.ok(kept.includes('01_Search_RQ.json'));
    const calls = await jsonl(join(result.dir, 'Case01_1Room_1A', 'calls.jsonl'));
    assert.ok(calls.every((c) => c.requestFile.startsWith('Case01_1Room_1A/')));
    const caseJson = await readJson(join(result.dir, 'Case01_1Room_1A', 'case.json'));
    assert.equal(caseJson.checkIn, '2026-11-24');
    assert.equal(caseJson.tries, 3);
  });

  it('una tarifa "sólo paquete" no se reserva: se descarta y no se vuelve a elegir', async () => {
    const fake = createFakeTbo({ packageOnly: true });
    const result = await runHarness(['run', '--cases', '1'], { fake });
    assert.equal(result.code, 1);
    assert.equal(fake.requests.filter((r) => r.url.endsWith('/Book')).length, 0);
    const index = await jsonl(join(result.dir, 'attempts', 'index.jsonl'));
    assert.deepEqual(
      index.slice(0, 3).map((a) => a.reason),
      ['package-only', 'package-only', 'no-options'],
    );
    assert.match(result.stdout, /Caso 01: FALLÓ \(sin cadena completa/);
  });

  it('un Book incierto se lee a los 120 s por BookingReferenceId y NUNCA se repite', async () => {
    const fake = createFakeTbo({ bookSequence: [0] });
    const sleeps = [];
    const result = await runHarness(['run', '--cases', '1'], { fake, sleeps });
    assert.equal(result.code, 1);
    assert.ok(sleeps.includes(120_000));
    assert.equal(fake.requests.filter((r) => r.url.endsWith('/Book')).length, 1);
    const files = await readdir(join(result.dir, 'attempts', 'Case01_1Room_1A', 'try-01'));
    assert.ok(files.includes('04_BookingDetail_Recovery_RQ.json'), files.join());
    const recovery = JSON.parse(
      await readFile(
        join(
          result.dir,
          'attempts',
          'Case01_1Room_1A',
          'try-01',
          '04_BookingDetail_Recovery_RQ.json',
        ),
        'utf8',
      ),
    );
    assert.match(recovery.BookingReferenceId, /^STT[0-9A-Z]{17}$/);
    // Existía: se canceló para no dejarla consumiendo el Limit, y el caso se detiene.
    assert.ok([...fake.bookings.values()].every((b) => b.status === 'Cancelled'));
    assert.match(result.stdout, /Caso 01: FALLÓ \(book-recovered:transport\)/);
    assert.equal(existsSync(join(result.dir, 'Case01_1Room_1A')), false);
  });

  it('un Book incierto que no aparece a los 120 s detiene el caso y pide verificarlo por su referencia', async () => {
    const fake = createFakeTbo({ bookSequence: [-1] });
    const result = await runHarness(['run', '--cases', '1'], { fake });
    assert.equal(result.code, 1);
    assert.equal(fake.requests.filter((r) => r.url.endsWith('/Book')).length, 1);
    assert.match(result.stdout, /Caso 01: FALLÓ \(book-uncertain:transport\)/);
    assert.match(
      result.stdout,
      /Book incierto que la lectura de los 120 s no encontró[\s\S]*Caso 01 · BookingReferenceId STT[0-9A-Z]{17}/,
    );
  });

  it('TBO_CITY_CODE parte los HotelCodes de la ciudad en lotes de 100', async () => {
    const fake = createFakeTbo({ cityHotels: 150 });
    const result = await runHarness(['run', '--cases', '1'], {
      fake,
      env: { TBO_CITY_CODE: '115936' },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /HotelCodes: 150 \(TBOHotelCodeList 115936\) en 2 lote\(s\)/);
    const [search] = fake.requests.filter((r) => r.url.endsWith('/Search'));
    assert.equal(JSON.parse(search.body).HotelCodes.split(',').length, 100);
  });

  it('caso 7 sin suplementos: todos los lotes con la ocupación del 4, después la del 1, después la fecha', async () => {
    const fake = createFakeTbo({ cityHotels: 150, supplements: 'none' });
    const result = await runHarness(['run', '--cases', '7'], {
      fake,
      env: { TBO_CITY_CODE: '115936' },
    });
    assert.equal(result.code, 1);
    const searches = fake.requests
      .filter((r) => r.url.endsWith('/Search'))
      .map((r) => JSON.parse(r.body))
      .map((b) => [b.PaxRooms.length, b.HotelCodes.split(',').length, b.CheckIn]);
    assert.deepEqual(searches.slice(0, 5), [
      [2, 100, '2026-11-10'],
      [2, 50, '2026-11-10'],
      [1, 100, '2026-11-10'],
      [1, 50, '2026-11-10'],
      [2, 100, '2026-11-17'],
    ]);
    assert.equal(fake.requests.filter((r) => r.url.endsWith('/Book')).length, 0);
  });

  it('una cuenta que TBO rechaza (402) corta la corrida entera', async () => {
    const fake = createFakeTbo({ bookSequence: [402] });
    const result = await runHarness(['run', '--cases', '1,2'], { fake });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /TBO rechaza la cuenta \(book:agent-blocked\)/);
    assert.equal(fake.requests.filter((r) => r.url.endsWith('/Book')).length, 1);
    const searches = fake.requests.filter((r) => r.url.endsWith('/Search'));
    assert.equal(searches.length, 1, 'el caso 2 no llegó a buscar');
    await assertNoSecrets(result);
  });

  it('pedir el caso 4 corre también el 8', async () => {
    const result = await runHarness(['run', '--cases', '4']);
    assert.equal(result.code, 0, result.stderr);
    const cases = await readJson(join(result.dir, 'cases.json'));
    assert.deepEqual(
      cases.cases.map((c) => [c.case, c.status]),
      [
        [4, 'complete'],
        [8, 'complete'],
      ],
    );
  });
});

describe('verify y zip: las guardas que abortan', () => {
  it('verify de una corrida incompleta sale con 1 y el selfcheck dice qué falta', async () => {
    const run = await runHarness(['run', '--cases', '1']);
    const verify = await runHarness(['verify', run.runs[0]], { outRoot: run.root });
    assert.equal(verify.code, 1);
    assert.match(verify.stdout, /G-9 {2}FALLA/);
    assert.match(verify.stdout, /No se puede armar el zip: G-6, G-9, G-11/);
    const selfcheck = await readFile(join(run.dir, 'selfcheck.md'), 'utf8');
    assert.match(selfcheck, /falta el caso 2/);
    const zip = await runHarness(['zip', run.runs[0]], { outRoot: run.root });
    assert.equal(zip.code, 1);
    assert.equal(existsSync(join(run.dir, ZIP)), false);
  });

  it('verify avisa si la corrida salió de un árbol con cambios sin commitear (RC-01)', async () => {
    const run = await runHarness(['run', '--cases', '1'], { gitDirty: true });
    const verify = await runHarness(['verify', run.runs[0]], { outRoot: run.root });
    assert.match(verify.stdout, /OJO: la corrida se hizo con cambios sin commitear/);
    const selfcheck = await readFile(join(run.dir, 'selfcheck.md'), 'utf8');
    assert.match(selfcheck, /build sha-de-prueba \(con cambios sin commitear\)/);
  });

  it('zip no se arma si un archivo de la corrida lleva la contraseña o una cabecera Authorization', async () => {
    const run = await runHarness(['run']);
    assert.equal(run.code, 0, run.stderr);
    const target = join(run.dir, 'Case02_1Room_1A1C', '03_Book_RS.json');
    const original = await readFile(target);

    await writeFile(
      target,
      `${original.toString('utf8').slice(0, -1)},"Echo":"${JSON.stringify(SECRET_NEEDLES[1]).slice(1, -1)}"}`,
    );
    const leaked = await runHarness(['zip', run.runs[0]], { outRoot: run.root });
    assert.equal(leaked.code, 1);
    assert.match(leaked.stdout, /G-1 {2}FALLA/);
    assert.match(leaked.stdout, /Case02_1Room_1A1C\/03_Book_RS\.json contiene TBO_PASSWORD/);
    assert.equal(existsSync(join(run.dir, ZIP)), false);
    for (const needle of SECRET_NEEDLES) assert.ok(!leaked.stdout.includes(needle));

    await writeFile(
      target,
      `{"Header":"Authorization: Basic Zm9vOmJhcg==",${original.toString('utf8').slice(1)}`,
    );
    const header = await runHarness(['zip', run.runs[0]], { outRoot: run.root });
    assert.equal(header.code, 1);
    assert.match(header.stdout, /03_Book_RS\.json contiene "Authorization"/);
    assert.equal(existsSync(join(run.dir, ZIP)), false);

    await writeFile(target, original);
    const clean = await runHarness(['zip', run.runs[0]], { outRoot: run.root });
    assert.equal(clean.code, 0, clean.stdout);
    assert.ok(existsSync(join(run.dir, ZIP)));

    // Un zip anterior no sobrevive a una corrida que dejó de pasar las guardas: no se puede enviar.
    await writeFile(target, `${original.toString('utf8').slice(0, -1)},"Echo":"cert-user-7"}`);
    const verify = await runHarness(['verify', run.runs[0]], { outRoot: run.root });
    assert.match(verify.stdout, new RegExp(`OJO: ${ZIP} es de antes y ya no pasa las guardas`));
    const stale = await runHarness(['zip', run.runs[0]], { outRoot: run.root });
    assert.equal(stale.code, 1);
    assert.match(stale.stdout, new RegExp(`Borré ${ZIP}`));
    assert.equal(existsSync(join(run.dir, ZIP)), false);
  });

  it('zip se niega si un RQ del caso lleva datos de tarjeta (G-2), aunque el grabador no lo hubiera dejado salir', async () => {
    const run = await runHarness(['run']);
    const target = join(run.dir, 'Case03_1Room_2A2C', '03_Book_RQ.json');
    const book = JSON.parse(await readFile(target, 'utf8'));
    await writeFile(target, JSON.stringify({ ...book, PaymentInfo: { CardNumber: '4111' } }));
    const zip = await runHarness(['zip', run.runs[0]], { outRoot: run.root });
    assert.equal(zip.code, 1);
    assert.match(zip.stdout, /G-2 {2}FALLA/);
    assert.equal(existsSync(join(run.dir, ZIP)), false);
  });
});

describe('run --resume', () => {
  it('completa una corrida en dos invocaciones y reemplaza el caso que vuelve a correr', async () => {
    const root = await newRoot();
    const first = await runHarness(['run', '--cases', '1,2,3'], { outRoot: root });
    assert.equal(first.code, 0, first.stderr);
    const [runId] = first.runs;
    const second = await runHarness(['run', '--cases', '1,4,5,6,7', '--resume', runId], {
      outRoot: root,
      now: NOW + 3_600_000,
    });
    assert.equal(second.code, 0, second.stderr);
    assert.deepEqual(second.runs, [runId]);

    const dir = join(root, runId);
    const cases = await readJson(join(dir, 'cases.json'));
    assert.deepEqual(
      cases.cases.map((c) => c.case),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    const parked = await readdir(join(dir, 'attempts', 'superseded'));
    assert.deepEqual(parked, ['2026-09-26T13-00-00Z']);
    assert.ok(
      existsSync(
        join(dir, 'attempts', 'superseded', parked[0], 'Case01_1Room_1A', '01_Search_RQ.json'),
      ),
    );
    const invocations = await jsonl(join(dir, 'invocations.jsonl'));
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].command, 'run');

    const zip = await runHarness(['zip', runId], { outRoot: root });
    assert.equal(zip.code, 0, zip.stdout);
  });

  it('no retoma una corrida que no existe ni una hecha contra otro endpoint', async () => {
    const missing = await runHarness(['run', '--resume', '2020-01-01T00-00-00Z']);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /No existe la corrida/);

    const run = await runHarness(['run', '--cases', '1']);
    const other = await runHarness(['run', '--cases', '2', '--resume', run.runs[0]], {
      outRoot: run.root,
      env: { TBO_BASE_URL: 'http://otro.example.com/HotelAPI' },
    });
    // Otro host sin --allow-non-test-host ya es un error de configuración (G-12).
    assert.equal(other.code, 2);
  });
});
