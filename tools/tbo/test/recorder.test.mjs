import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { createEvidence, findSecretsOnDisk, peekEnvelope } from '../lib/evidence.mjs';
import { HarnessGuardError, createRecorder, d1Violation, operationOf } from '../lib/recorder.mjs';
import { HarnessSecrets } from '../lib/secrets.mjs';

const BASE = 'http://api.tbotechnology.in/TBOHolidays_HotelAPI';
const secrets = new HarnessSecrets('user-rec', 'pass-rec');
const token = Buffer.from('user-rec:pass-rec').toString('base64');
const HEADERS = {
  Authorization: `Basic ${token}`,
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

const roots = [];
let evidence;
let folder;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'tbo-rec-'));
  roots.push(root);
  evidence = await createEvidence(root, 'run');
  folder = evidence.folder('probes/PR-XX');
});

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

function recorderWith(fetchImpl) {
  const seen = [];
  const recorder = createRecorder({
    fetch: async (url, init) => {
      seen.push({ url, init });
      return fetchImpl(url, init);
    },
    secrets,
    now: () => Date.parse('2026-09-26T12:00:00Z'),
    allowedHostnames: ['api.tbotechnology.in'],
  });
  return { recorder, seen };
}

async function readCalls() {
  const text = await readFile(join(folder.dir, 'calls.jsonl'), 'utf8');
  return text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

describe('fetch grabador', () => {
  it('guarda el RQ y el RS byte a byte y le devuelve al ACL los mismos bytes', async () => {
    // BOM, un byte que no es UTF-8 y una ñ: re-serializar alteraría cualquiera de los tres.
    const served = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('{"Status":{"Code":200,"Description":"Añ'),
      Buffer.from([0xff]),
      Buffer.from('"}}'),
    ]);
    const { recorder } = recorderWith(async () => new Response(served, { status: 200 }));
    const body = '{"CheckIn":"2026-11-10",  "Espacios":"tal cual"}';
    const res = await recorder.fetchFor({ folder, label: 'exacto' })(`${BASE}/Search`, {
      method: 'POST',
      headers: HEADERS,
      body,
    });

    assert.deepEqual(Buffer.from(await res.arrayBuffer()), served);
    const [call] = await readCalls();
    assert.equal(call.operation, 'Search');
    assert.equal(call.httpStatus, 200);
    assert.equal(call.tboCode, 200);
    assert.equal(await readFile(join(evidence.dir, call.requestFile), 'utf8'), body);
    assert.deepEqual(await readFile(join(evidence.dir, call.responseFile)), served);
    assert.equal(call.headers.authorization, 'Basic «REDACTADO»');
  });

  it('nunca escribe el Authorization, el usuario ni la contraseña; si el RS los repite, se tapan', async () => {
    const echo = JSON.stringify({
      Status: { Code: 401, Description: 'user-rec / pass-rec invalid' },
    });
    const { recorder } = recorderWith(async () => new Response(echo, { status: 401 }));
    await recorder.fetchFor({ folder, label: 'eco' })(`${BASE}/Search`, {
      method: 'POST',
      headers: HEADERS,
      body: '{}',
    });
    const [call] = await readCalls();
    assert.deepEqual(call.redactedSecrets.sort(), ['TBO_PASSWORD', 'TBO_USERNAME']);
    for (const name of await readdir(folder.dir)) {
      const content = await readFile(join(folder.dir, name));
      assert.deepEqual(secrets.findIn(content), [], name);
      assert.ok(!content.includes(token), name);
    }
  });

  it('una reescritura de la sonda queda declarada y el RQ del ACL se guarda al lado', async () => {
    const { recorder, seen } = recorderWith(
      async () => new Response('{"Status":{"Code":400}}', { status: 200 }),
    );
    await recorder.fetchFor({
      folder,
      label: 'mut',
      rewrite: {
        description: 'Filters.MealType: "All" → 0',
        body: (json) => ({ ...json, Filters: { MealType: 0 } }),
        url: (url) => url.replace('/Search', '/search'),
      },
    })(`${BASE}/Search`, {
      method: 'POST',
      headers: HEADERS,
      body: '{"Filters":{"MealType":"All"}}',
    });

    assert.equal(seen[0].url, `${BASE}/search`);
    assert.equal(seen[0].init.body, '{"Filters":{"MealType":0}}');
    const [call] = await readCalls();
    assert.equal(call.mutation, 'Filters.MealType: "All" → 0');
    assert.equal(call.aclUrl, `${BASE}/Search`);
    assert.equal(
      await readFile(join(evidence.dir, call.aclRequestFile), 'utf8'),
      '{"Filters":{"MealType":"All"}}',
    );
    assert.equal(
      await readFile(join(evidence.dir, call.requestFile), 'utf8'),
      '{"Filters":{"MealType":0}}',
    );
  });

  for (const [name, rewrite, reason] of [
    [
      'una clave de tarjeta',
      { body: (json) => ({ ...json, PaymentInfo: { CardNumber: '4111111111111111' } }) },
      'D1_CARD_DATA',
    ],
    [
      'un PaymentMode que no es Limit',
      { body: (json) => ({ ...json, PaymentMode: 'NewCard' }) },
      'D1_PAYMENT_MODE',
    ],
    [
      'un PreBook sin PaymentMode',
      {
        body: (json) => {
          const copy = { ...json };
          delete copy.PaymentMode;
          return copy;
        },
      },
      'D1_PAYMENT_MODE',
    ],
    ['otro host', { url: () => 'https://attacker.example/Search' }, 'HOST'],
  ]) {
    it(`bloquea ${name}: no sale, no se escribe el body y la guarda lo reporta`, async () => {
      const { recorder, seen } = recorderWith(async () => new Response('{}'));
      await assert.rejects(
        recorder.fetchFor({ folder, label: 'bloqueo', rewrite })(`${BASE}/PreBook`, {
          method: 'POST',
          headers: HEADERS,
          body: '{"BookingCode":"x","PaymentMode":"Limit"}',
        }),
        (err) => err instanceof HarnessGuardError && err.reason === reason,
      );
      assert.equal(seen.length, 0);
      assert.equal(recorder.violations.length, 1);
      assert.deepEqual(await readdir(folder.dir), ['calls.jsonl']);
      const [call] = await readCalls();
      assert.equal(call.blocked, reason);
      assert.doesNotMatch(JSON.stringify(call), /4111/);
    });
  }

  it('una reescritura que ya no encaja corta con REWRITE_FAILED en vez de mandar otra cosa', async () => {
    const { recorder, seen } = recorderWith(async () => new Response('{}'));
    await assert.rejects(
      recorder.fetchFor({
        folder,
        label: 'roto',
        rewrite: {
          body: () => {
            throw new Error('el ACL ya no manda Filters');
          },
        },
      })(`${BASE}/Search`, { method: 'POST', headers: HEADERS, body: '{}' }),
      (err) => err instanceof HarnessGuardError && err.reason === 'REWRITE_FAILED',
    );
    assert.equal(seen.length, 0);
  });

  it('un fallo de red se graba con su código y se relanza el mismo error', async () => {
    const failure = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    const { recorder } = recorderWith(async () => {
      throw failure;
    });
    await assert.rejects(
      recorder.fetchFor({ folder, label: 'red' })(`${BASE}/Search`, {
        method: 'POST',
        headers: HEADERS,
        body: '{}',
      }),
      (err) => err === failure,
    );
    const [call] = await readCalls();
    assert.deepEqual(call.error, {
      name: 'TypeError',
      code: 'ECONNREFUSED',
      message: 'connect ECONNREFUSED',
      timedOut: false,
    });
    assert.equal(call.responseFile, undefined);
  });

  it('un 204 no rompe la Response que recibe el ACL', async () => {
    const { recorder } = recorderWith(async () => new Response(null, { status: 204 }));
    const res = await recorder.fetchFor({ folder, label: 'vacio' })(`${BASE}/CountryList`, {
      method: 'GET',
      headers: HEADERS,
    });
    assert.equal(res.status, 204);
  });
});

describe('piezas', () => {
  it('el nombre de la operación sale del último segmento sin distinguir mayúsculas', () => {
    assert.equal(operationOf(`${BASE}/search`), 'Search');
    assert.equal(operationOf(`${BASE}/Hoteldetails`), 'HotelDetails');
    assert.equal(operationOf(`${BASE}/BookingDetailsbasedondate`), 'BookingDetailsBasedOnDate');
    assert.equal(operationOf(`${BASE}/BookingDetail`), 'BookingDetail');
    assert.equal(operationOf(`${BASE}/hotelcodelist`), 'hotelcodelist');
  });

  it('D1 sobre el cable: tarjetas a cualquier profundidad y PaymentMode', () => {
    assert.equal(d1Violation('{"PaymentMode":"Limit","BookingCode":"x"}'), undefined);
    assert.deepEqual(d1Violation('{"a":[{"CardHolderlastName":"x"}]}'), {
      reason: 'D1_CARD_DATA',
      paths: ['a.0.CardHolderlastName'],
    });
    assert.equal(d1Violation('{"paymentMode":"SavedCard"}').reason, 'D1_PAYMENT_MODE');
    assert.equal(d1Violation(undefined), undefined);
  });

  it('G-3: PreBook, Book y BookingDetail salen siempre con PaymentMode "Limit"; Search no lo lleva', () => {
    for (const operation of ['PreBook', 'Book', 'BookingDetail']) {
      assert.deepEqual(d1Violation('{"BookingCode":"x"}', operation), {
        reason: 'D1_PAYMENT_MODE',
        paths: ['PaymentMode'],
      });
      assert.equal(d1Violation(undefined, operation)?.reason, 'D1_PAYMENT_MODE');
      assert.equal(
        d1Violation('{"x":{"PaymentMode":"Limit"}}', operation)?.reason,
        'D1_PAYMENT_MODE',
      );
      assert.equal(d1Violation('{"BookingCode":"x","PaymentMode":"Limit"}', operation), undefined);
    }
    assert.equal(d1Violation('{"CheckIn":"2026-11-10"}', 'Search'), undefined);
  });

  it('G-1 sobre el disco: encuentra usuario, contraseña escapada y token en cualquier carpeta', async () => {
    const tricky = new HarnessSecrets('user-g1', 'p"ss-g1');
    const tokenG1 = Buffer.from('user-g1:p"ss-g1').toString('base64');
    await evidence.writeJson('run.json', { ok: true });
    assert.deepEqual(await findSecretsOnDisk(evidence.dir, tricky), []);

    await evidence.writeText('probes/PR-01/01_Search_RS.json', JSON.stringify({ d: 'p"ss-g1' }));
    await evidence.folder('check').write('01_Search_RQ.json', `Basic ${tokenG1}`);
    await evidence.writeText('probes/summary.md', 'hola user-g1');
    const leaks = await findSecretsOnDisk(evidence.dir, tricky);
    assert.deepEqual(leaks.map((leak) => [leak.file, leak.secrets]).sort(), [
      ['check/01_Search_RQ.json', ['BASIC_TOKEN']],
      ['probes/PR-01/01_Search_RS.json', ['TBO_PASSWORD']],
      ['probes/summary.md', ['TBO_USERNAME']],
    ]);
    assert.doesNotMatch(JSON.stringify(leaks), /user-g1|ss-g1/);
  });

  it('el envelope se lee sin distinguir mayúsculas y un RS que no es JSON no rompe', () => {
    assert.deepEqual(
      peekEnvelope(Buffer.from('{"status":{"code":"201","description":"x"}}')).tboCode,
      201,
    );
    assert.equal(peekEnvelope(Buffer.from('<html>')).json, undefined);
  });
});
