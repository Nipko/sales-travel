import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { DEFAULT_PATHS, main } from '../cert-cases.mjs';
import { DEFAULT_HOTEL_CODES } from '../lib/env.mjs';
import { TEST_PASSWORD, TEST_TOKEN, TEST_USERNAME, createFakeTbo } from './fake-tbo.mjs';

/**
 * El arnés de punta a punta contra el TBO falso: el ACL real (`dist`), el `fetch` grabador y la
 * escritura en disco. Sin red y sin credenciales reales.
 */

const NOW = Date.parse('2026-09-26T12:00:00Z');
const roots = [];

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function run(argv, { fake = createFakeTbo(), env = {} } = {}) {
  const outRoot = await mkdtemp(join(tmpdir(), 'tbo-cert-'));
  roots.push(outRoot);
  const stdout = [];
  const stderr = [];
  const code = await main(argv, {
    env: { TBO_USERNAME: TEST_USERNAME, TBO_PASSWORD: TEST_PASSWORD, ...env },
    envFile: join(outRoot, 'no-existe.env'),
    fetch: fake.fetch,
    now: () => NOW,
    sleep: async () => {},
    outRoot,
    gitSha: 'sha-de-prueba',
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  const runs = await readdir(outRoot).then((names) => names.filter((n) => n !== 'no-existe.env'));
  const dir = runs.length === 1 ? join(outRoot, runs[0]) : undefined;
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n'), fake, dir };
}

async function* files(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else yield path;
  }
}

/** G-1: nada de lo escrito ni de lo impreso contiene la credencial, en ninguna forma. */
async function assertNoSecrets(result) {
  const needles = [
    TEST_USERNAME,
    TEST_PASSWORD,
    JSON.stringify(TEST_PASSWORD).slice(1, -1),
    TEST_TOKEN,
  ];
  for (const needle of needles) {
    assert.ok(!result.stdout.includes(needle), 'stdout');
    assert.ok(!result.stderr.includes(needle), 'stderr');
  }
  if (result.dir === undefined) return;
  for await (const path of files(result.dir)) {
    const content = await readFile(path);
    for (const needle of needles) assert.ok(!content.includes(needle), path);
  }
}

async function jsonl(path) {
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

/** Todos los nombres de campo de un JSON, a cualquier profundidad. */
function keysOf(value) {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)]);
  }
  return [];
}

describe('check', () => {
  it('imprime Status.Code, la moneda del perfil, la latencia y las opciones; sale con 0', async () => {
    const result = await run(['check']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /HTTP 200 · Status\.Code 200 \(Successful\) · \d+ ms/);
    assert.match(result.stdout, /Moneda del perfil \(HotelResult\[\]\.Currency\): USD/);
    assert.match(result.stdout, /Opciones: 2 en 1 hoteles/);
    assert.match(result.stdout, /Lectura del ACL: ok · 2 packs válidos/);
    await assertNoSecrets(result);
  });

  it('el RQ grabado es el que armó el ACL para el caso 1 y el que recibió TBO, byte a byte', async () => {
    const result = await run(['check']);
    const [request] = result.fake.requests;
    assert.equal(request.redirect, 'manual');
    assert.equal(request.authorization, `Basic ${TEST_TOKEN}`);
    const [call] = await jsonl(join(result.dir, 'check', 'calls.jsonl'));
    assert.equal(await readFile(join(result.dir, call.requestFile), 'utf8'), request.body);
    const body = JSON.parse(request.body);
    assert.deepEqual(body.PaxRooms, [{ Adults: 1, Children: 0, ChildrenAges: [] }]);
    assert.equal(body.GuestNationality, 'CO');
    assert.equal(body.CheckIn, '2026-11-10');
    assert.equal(body.CheckOut, '2026-11-12');
    assert.equal(body.IsDetailedResponse, false);
    assert.equal(body.HotelCodes, DEFAULT_HOTEL_CODES.join(','));
    assert.equal(call.headers.authorization, 'Basic «REDACTADO»');

    const runJson = JSON.parse(await readFile(join(result.dir, 'run.json'), 'utf8'));
    assert.equal(runJson.command, 'check');
    assert.equal(runJson.gitSha, 'sha-de-prueba');
    assert.equal(runJson.baseUrl, 'http://api.tbotechnology.in/TBOHolidays_HotelAPI');
    assert.equal(runJson.ok, true);
    assert.equal(runJson.acl.name, '@sales-travel/tbo-hotels');
  });

  it('con credenciales que TBO rechaza sale con 1 y dice qué revisar', async () => {
    const result = await run(['check'], { fake: createFakeTbo({ expectedToken: 'otro' }) });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /HTTP 401 · Status\.Code 401/);
    assert.match(result.stdout, /CREDENTIALS_INVALID/);
    assert.match(result.stdout, /revisa TBO_USERNAME y TBO_PASSWORD/);
    await assertNoSecrets(result);
  });

  it('un 201 valida las credenciales aunque no muestre la moneda', async () => {
    const result = await run(['check'], { fake: createFakeTbo({ searchCode: 201 }) });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Sin disponibilidad \(201\)/);
  });

  it('si TBO repite la contraseña, la consola y el disco la tapan', async () => {
    const fake = createFakeTbo({ searchDescription: `Successful for ${TEST_PASSWORD}` });
    const result = await run(['check'], { fake });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Successful for «REDACTADO»/);
    const [call] = await jsonl(join(result.dir, 'check', 'calls.jsonl'));
    assert.deepEqual(call.redactedSecrets, ['TBO_PASSWORD']);
    await assertNoSecrets(result);
  });

  it('un perfil en una moneda sin dos decimales es un HALLAZGO, no un fallo de credenciales', async () => {
    const result = await run(['check'], { fake: createFakeTbo({ searchCurrency: 'CLP' }) });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Moneda del perfil \(HotelResult\[\]\.Currency\): CLP/);
    assert.match(result.stdout, /Lectura del ACL: TboUnsupportedCurrencyError/);
    assert.match(result.stdout, /HALLAZGO: el perfil cotiza en una moneda sin dos decimales/);
  });

  it('un 200 que el ACL no puede leer es un HALLAZGO y el RS queda en disco tal cual', async () => {
    const searchBody = '{"Status":{"Code":200,"Description":"Successful"},"HotelResult":"roto"}';
    const result = await run(['check'], { fake: createFakeTbo({ searchBody }) });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Lectura del ACL: TboResponseMappingError/);
    assert.match(result.stdout, /HALLAZGO: TBO respondió 200 y el ACL no pudo leerlo/);
    const [call] = await jsonl(join(result.dir, 'check', 'calls.jsonl'));
    assert.equal(await readFile(join(result.dir, call.responseFile), 'utf8'), searchBody);
  });

  it('un 200 del que el ACL descarta opciones es un HALLAZGO con sus motivos', async () => {
    const payload = JSON.parse(
      readFileSync(
        join(
          DEFAULT_PATHS.aclDist,
          '..',
          '..',
          'src',
          '__fixtures__',
          'pdf',
          'search-single-room.p15.json',
        ),
        'utf8',
      ),
    );
    delete payload.HotelResult[0].Rooms[1].BookingCode;
    const result = await run(['check'], {
      fake: createFakeTbo({ searchBody: JSON.stringify(payload) }),
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Lectura del ACL: ok · 1 packs válidos/);
    assert.match(
      result.stdout,
      /HALLAZGO: el ACL descartó 1 de 2 opciones y 0 hoteles \(PACK_SCHEMA×1\)/,
    );
    const check = JSON.parse(await readFile(join(result.dir, 'check', 'check.json'), 'utf8'));
    assert.deepEqual(check.discardedByAcl, {
      packs: 1,
      packsReceived: 2,
      hotels: 0,
      reasons: ['PACK_SCHEMA×1'],
    });
  });

  it('sin red sale con 1 y lo dice', async () => {
    const fake = {
      requests: [],
      fetch: async () => {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }),
        });
      },
    };
    const result = await run(['check'], { fake });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /Sin respuesta de TBO: ENOTFOUND \(2 intentos\)/);
  });
});

describe('probe', () => {
  it('corre PR-01 a PR-08, escribe el resumen y deja cada respuesta en su carpeta', async () => {
    const result = await run(['probe']);
    assert.equal(result.code, 0, result.stderr);
    const summary = JSON.parse(await readFile(join(result.dir, 'probes', 'summary.json'), 'utf8'));
    const byId = Object.fromEntries(summary.probes.map((p) => [p.id, p]));
    assert.deepEqual(Object.keys(byId), [
      'PR-01',
      'PR-02',
      'PR-03',
      'PR-04',
      'PR-05',
      'PR-06',
      'PR-07',
      'PR-08',
    ]);
    assert.deepEqual(
      summary.probes.map((p) => p.question),
      ['Q-13', 'Q-18', 'Q-03', 'Q-05', 'Q-37', 'Q-07', 'Q-08', 'Q-15'],
    );

    assert.match(byId['PR-01'].reading, /TBO acepta: ChildrenAges: \[\]; ChildrenAges: \[0\]\./);
    assert.match(
      byId['PR-01'].reading,
      /No acepta: ChildrenAges omitido \(HTTP 200, Status\.Code 400/,
    );
    assert.match(byId['PR-02'].reading, /no acepta el ordinal/);
    assert.equal(byId['PR-03'].variants[1].transportError, 'ECONNREFUSED');
    assert.match(byId['PR-03'].reading, /no hay TLS/);
    for (const name of ['Search', 'HotelDetails', 'BookingDetailsbasedondate', 'hotelcodelist']) {
      assert.match(byId['PR-04'].reading, new RegExp(`${name}: sólo el casing del PDF responde`));
    }
    assert.match(byId['PR-05'].variants[0].acl, /^found:false/);
    assert.match(byId['PR-06'].reading, /en los dos: HTTP 401 y Status\.Code 401/);
    assert.equal(byId['PR-07'].variants[0].tboCode, 207);
    assert.equal(byId['PR-08'].source, 'hotelcodelist (PR-04)');
    assert.match(byId['PR-08'].reading, /100 es un límite duro/);

    const md = await readFile(join(result.dir, 'probes', 'summary.md'), 'utf8');
    assert.match(md, /## PR-08 · Q-15 · Search con 101 HotelCodes/);
    await assertNoSecrets(result);
  });

  it('lo que sale hacia TBO: sólo su host, PaymentMode Limit y la mutación declarada', async () => {
    const result = await run(['probe']);
    for (const request of result.fake.requests) {
      assert.equal(new URL(request.url).hostname, 'api.tbotechnology.in');
      if (request.body === undefined) continue;
      const body = JSON.parse(request.body);
      if ('PaymentMode' in body) assert.equal(body.PaymentMode, 'Limit');
      // Los nombres de campo, no el cuerpo entero: un BookingReferenceId aleatorio puede traer
      // "CVV" entre sus letras (falló así en el CI del #20 con STT3R8W1NH0BKP3C8CVV).
      for (const key of keysOf(body)) assert.doesNotMatch(key, /Card|Cvv|PaymentInfo/i);
    }
    const pr06 = result.fake.requests.filter(
      (r) => r.authorization !== `Basic ${TEST_TOKEN}` && r.url.startsWith('http:'),
    );
    assert.equal(pr06.length, 1, 'sólo PR-06 usa otras credenciales');
    // Un usuario inventado, no el real con otra contraseña: los fallos no pueden bloquear la cuenta.
    const [pr06User] = Buffer.from(pr06[0].authorization.replace(/^Basic /, ''), 'base64')
      .toString('utf8')
      .split(':');
    assert.notEqual(pr06User, TEST_USERNAME);

    // PR-01: las tres formas salen de verdad distintas y sólo cambia `ChildrenAges`.
    const pr01 = await jsonl(join(result.dir, 'probes', 'PR-01', 'calls.jsonl'));
    const rooms = await Promise.all(
      pr01.map(async (call) => {
        const rq = JSON.parse(await readFile(join(result.dir, call.requestFile), 'utf8'));
        return [call.label, rq.PaxRooms];
      }),
    );
    assert.deepEqual(rooms, [
      ['ChildrenAges-empty-array', [{ Adults: 1, Children: 0, ChildrenAges: [] }]],
      ['ChildrenAges-zero', [{ Adults: 1, Children: 0, ChildrenAges: [0] }]],
      ['ChildrenAges-omit', [{ Adults: 1, Children: 0 }]],
    ]);

    const calls = await jsonl(join(result.dir, 'probes', 'PR-08', 'calls.jsonl'));
    const over = calls.find((c) => c.label === '101-codigos');
    assert.equal(over.mutation, 'HotelCodes: 100 → 101 códigos');
    const wire = JSON.parse(await readFile(join(result.dir, over.requestFile), 'utf8'));
    const acl = JSON.parse(await readFile(join(result.dir, over.aclRequestFile), 'utf8'));
    assert.equal(wire.HotelCodes.split(',').length, 101);
    assert.equal(acl.HotelCodes.split(',').length, 100);
    assert.deepEqual({ ...wire, HotelCodes: acl.HotelCodes }, acl);
  });

  it('con un TBO que no distingue mayúsculas, tiene TLS y acepta 101, la lectura cambia', async () => {
    const fake = createFakeTbo({
      tls: true,
      caseSensitive: false,
      acceptMealOrdinal: true,
      maxHotelCodes: 1000,
    });
    const result = await run(['probe', '--skip-hotelcodelist'], {
      fake,
      env: {
        TBO_HOTEL_CODES: Array.from({ length: 120 }, (_, i) => String(2_000_000 + i)).join(','),
      },
    });
    assert.equal(result.code, 0, result.stderr);
    const summary = JSON.parse(await readFile(join(result.dir, 'probes', 'summary.json'), 'utf8'));
    const byId = Object.fromEntries(summary.probes.map((p) => [p.id, p]));
    assert.match(byId['PR-02'].reading, /acepta también el ordinal 0/);
    assert.match(byId['PR-03'].reading, /Hay TLS en test/);
    assert.match(byId['PR-04'].reading, /Search: las dos grafías responden igual/);
    assert.match(
      byId['PR-04'].reading,
      /hotelcodelist: no se probó \(se pidió --skip-hotelcodelist\)/,
    );
    assert.equal(byId['PR-08'].source, 'TBO_HOTEL_CODES');
    assert.match(byId['PR-08'].reading, /101 pasa: 100 es una recomendación/);
  });

  it('--only corre sólo esas sondas; PR-08 sin 101 códigos se salta con motivo', async () => {
    const result = await run(['probe', '--only', 'PR-08']);
    assert.equal(result.code, 0, result.stderr);
    const summary = JSON.parse(await readFile(join(result.dir, 'probes', 'summary.json'), 'utf8'));
    assert.deepEqual(
      summary.probes.map((p) => [p.id, p.skipped]),
      [['PR-08', true]],
    );
    assert.match(summary.probes[0].reading, /hacen falta 101 códigos/);
    // Control + nada más: sin códigos no sale ningún Search de 100.
    assert.equal(result.fake.requests.length, 1);
  });

  it('PR-08 toma los 101 códigos de TBO_CITY_CODE por TBOHotelCodeList', async () => {
    const result = await run(['probe', '--only', 'PR-08'], {
      fake: createFakeTbo({ cityHotels: 120 }),
      env: { TBO_CITY_CODE: '115936' },
    });
    assert.equal(result.code, 0, result.stderr);
    const summary = JSON.parse(await readFile(join(result.dir, 'probes', 'summary.json'), 'utf8'));
    assert.equal(summary.probes[0].source, 'TBOHotelCodeList 115936');
    assert.match(summary.probes[0].reading, /100 es un límite duro/);
    const [cityCall] = result.fake.requests.filter((r) => r.url.endsWith('/TBOHotelCodeList'));
    assert.equal(JSON.parse(cityCall.body).CityCode, '115936');
    const searches = result.fake.requests.filter((r) => r.url.endsWith('/Search')).slice(1);
    assert.deepEqual(
      searches.map((r) => JSON.parse(r.body).HotelCodes.split(',')),
      [
        Array.from({ length: 100 }, (_, i) => String(3_000_000 + i)),
        Array.from({ length: 101 }, (_, i) => String(3_000_000 + i)),
      ],
    );
  });

  it('si el control no pasa, no corre ninguna sonda y sale con 1', async () => {
    const result = await run(['probe'], { fake: createFakeTbo({ expectedToken: 'otro' }) });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /El control no pasó/);
    assert.equal(result.fake.requests.length, 1);
    await assertNoSecrets(result);
  });
});

describe('uso', () => {
  it('los comandos que reservan exigen el contacto de rol y salen con 2 sin tocar la red', async () => {
    for (const argv of [['run'], ['all'], ['probe', '--bookings']]) {
      const result = await run(argv);
      assert.equal(result.code, 2, argv.join(' '));
      assert.match(result.stderr, /TBO_CERT_EMAIL/);
      assert.match(result.stderr, /TBO_CERT_PHONE/);
      assert.equal(result.fake.requests.length, 0);
      assert.equal(result.dir, undefined);
    }
  });

  it('all exige TBO_COMPANY_SLUG antes de reservar nada', async () => {
    const result = await run(['all'], {
      env: { TBO_CERT_EMAIL: 'reservas@example.com', TBO_CERT_PHONE: '573000000000' },
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /TBO_COMPANY_SLUG/);
    assert.equal(result.fake.requests.length, 0);
  });

  it('opciones que no aplican, sondas con reserva sin --bookings y casos fuera de 1-8 salen con 2', async () => {
    const cases = [
      [['probe', '--only', 'PR-09'], /agrega --bookings/],
      [['run', '--only', 'PR-01'], /--only no aplica a run/],
      [['check', '--cases', '1'], /--cases no aplica a check/],
      [['run', '--cases', '9'], /Caso desconocido: 9/],
      [['verify'], /necesita el id de la corrida/],
      [['verify', '..'], /Id de corrida inválido/],
      [['zip', 'no-existe'], /TBO_COMPANY_SLUG/],
      [['verify', 'no-existe'], /No existe la corrida no-existe/],
      [['cancel'], /necesita el id de la corrida/],
      [['cancel', 'no-existe'], /No existe la corrida no-existe/],
      [['check', 'sobra'], /Sobra el argumento sobra/],
    ];
    for (const [argv, message] of cases) {
      const result = await run(argv);
      assert.equal(result.code, 2, argv.join(' '));
      assert.match(result.stderr, message, argv.join(' '));
      assert.equal(result.fake.requests.length, 0);
      assert.equal(result.dir, undefined);
    }
  });

  it('verify y zip piden la credencial: sin ella G-1 no puede afirmar nada', async () => {
    const stderr = [];
    const code = await main(['verify', 'x'], {
      env: {},
      envFile: join(tmpdir(), 'no-existe.env'),
      stderr: (line) => stderr.push(line),
      stdout: () => {},
    });
    assert.equal(code, 2);
    assert.match(stderr.join('\n'), /Faltan TBO_USERNAME, TBO_PASSWORD: la guarda G-1/);
  });

  it('sin el ACL compilado indica cómo compilarlo', async () => {
    const stderr = [];
    const code = await main(['check'], {
      aclDist: join(tmpdir(), 'no-existe', 'index.js'),
      stderr: (line) => stderr.push(line),
      stdout: () => {},
    });
    assert.equal(code, 2);
    assert.match(stderr.join('\n'), /pnpm --filter @sales-travel\/tbo-hotels build/);
  });

  it('el dist por defecto es el del paquete del ACL', () => {
    assert.match(
      DEFAULT_PATHS.aclDist.replaceAll('\\', '/'),
      /providers\/tbo-hotels\/dist\/index\.js$/,
    );
  });
});
