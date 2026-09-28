import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { after, before, describe, it } from 'node:test';
import { DEFAULT_PATHS, parseArgs } from '../cert-cases.mjs';
import { loadAcl } from '../lib/acl.mjs';
import {
  DEFAULT_HOTEL_CODES,
  HarnessUsageError,
  mergeEnv,
  readDotEnvFile,
  readSettings,
} from '../lib/env.mjs';
import { HarnessSecrets, REDACTED } from '../lib/secrets.mjs';

const NOW = Date.parse('2026-09-26T12:00:00Z');

let acl;
let tmp;

before(async () => {
  acl = await loadAcl(DEFAULT_PATHS.aclDist);
  tmp = await mkdtemp(join(tmpdir(), 'tbo-env-'));
});

after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('readDotEnvFile', () => {
  it('sin archivo devuelve vacío: .env.tbo es opcional', async () => {
    assert.deepEqual(await readDotEnvFile(join(tmp, 'no-existe.env')), {});
  });

  it('lee CRLF, ignora comentarios y conserva los espacios de un valor entre comillas', async () => {
    const path = join(tmp, 'crlf.env');
    await writeFile(
      path,
      '﻿# comentario\r\nTBO_USERNAME=usuario\r\nTBO_PASSWORD=" con espacio "\r\n' +
        "# TBO_HOTEL_CODES=1,2\r\nTBO_NIGHTS = 3 \r\nTBO_CITY_CODE='115936'\r\n",
    );
    assert.deepEqual(await readDotEnvFile(path), {
      TBO_USERNAME: 'usuario',
      TBO_PASSWORD: ' con espacio ',
      TBO_NIGHTS: '3',
      TBO_CITY_CODE: '115936',
    });
  });

  it('el entorno del proceso manda sobre el archivo; una variable vacía no cuenta', () => {
    assert.deepEqual(
      mergeEnv({ TBO_NIGHTS: '3', TBO_USERNAME: 'archivo' }, { TBO_NIGHTS: '5', TBO_USERNAME: '' }),
      { TBO_NIGHTS: '5', TBO_USERNAME: 'archivo' },
    );
  });
});

describe('readSettings', () => {
  const creds = { TBO_USERNAME: 'usuario', TBO_PASSWORD: 'clave-secreta' };

  it('por defecto: endpoint de test, 13 códigos de Postman, hoy + 45 días y 2 noches', () => {
    const settings = readSettings(creds, {}, acl, NOW);
    assert.equal(settings.baseUrl, acl.TBO_BASE_URLS.test);
    assert.equal(settings.testEndpoint, true);
    assert.deepEqual(settings.hotelCodes, DEFAULT_HOTEL_CODES);
    assert.equal(settings.checkIn, '2026-11-10');
    assert.equal(settings.checkOut, '2026-11-12');
    assert.equal(settings.cityCode, undefined);
  });

  it('sin credenciales nombra las variables que faltan y nada más', () => {
    assert.throws(
      () => readSettings({ TBO_PASSWORD: 'clave-secreta' }, {}, acl, NOW),
      (err) => {
        assert.ok(err instanceof HarnessUsageError);
        assert.match(err.message, /TBO_USERNAME/);
        assert.doesNotMatch(err.message, /clave-secreta/);
        return true;
      },
    );
  });

  it('G-12: se niega a otro host salvo con --allow-non-test-host', () => {
    const env = { ...creds, TBO_BASE_URL: 'https://api.otro-host.example/TBOHolidays_HotelAPI' };
    assert.throws(() => readSettings(env, {}, acl, NOW), /--allow-non-test-host/);
    const settings = readSettings(env, { allowNonTestHost: true }, acl, NOW);
    assert.equal(settings.testEndpoint, false);
  });

  it('https sobre el mismo endpoint sigue siendo el de test (PR-03 / Q-03)', () => {
    const env = { ...creds, TBO_BASE_URL: 'https://api.tbotechnology.in/TBOHolidays_HotelAPI/' };
    const settings = readSettings(env, {}, acl, NOW);
    assert.equal(settings.testEndpoint, true);
    assert.equal(settings.baseUrl, 'https://api.tbotechnology.in/TBOHolidays_HotelAPI');
  });

  it('junta todos los problemas en un solo mensaje, sin valores de credenciales', () => {
    const env = {
      TBO_USERNAME: 'con:dos-puntos',
      TBO_PASSWORD: 'clave-secreta',
      TBO_NIGHTS: '0',
      TBO_CHECKIN_OFFSET_DAYS: 'mañana',
      TBO_HOTEL_CODES: '123, 45 6',
      TBO_CITY_CODE: 'a/b',
    };
    assert.throws(
      () => readSettings(env, {}, acl, NOW),
      (err) => {
        for (const piece of [
          'TBO_NIGHTS',
          'TBO_CHECKIN_OFFSET_DAYS',
          'TBO_HOTEL_CODES',
          'TBO_CITY_CODE',
          'username:colon_in_username',
        ]) {
          assert.ok(err.message.includes(piece), piece);
        }
        assert.doesNotMatch(err.message, /con:dos-puntos|clave-secreta/);
        return true;
      },
    );
  });

  it('TBO_HOTEL_CODES se limpia y deduplica conservando el orden', () => {
    const settings = readSettings({ ...creds, TBO_HOTEL_CODES: ' 3, 1 ,3,2,' }, {}, acl, NOW);
    assert.deepEqual(settings.hotelCodes, ['3', '1', '2']);
  });

  it('los comandos que reservan exigen el contacto de rol y leen TBO_CANCEL_AFTER', () => {
    assert.throws(
      () => readSettings(creds, {}, acl, NOW, { booking: true, zip: true }),
      (err) => {
        for (const piece of ['TBO_CERT_EMAIL', 'TBO_CERT_PHONE', 'TBO_COMPANY_SLUG']) {
          assert.ok(err.message.includes(piece), piece);
        }
        return true;
      },
    );
    assert.throws(
      () =>
        readSettings(
          {
            ...creds,
            TBO_CERT_EMAIL: 'no-es-email',
            TBO_CERT_PHONE: '+57 300',
            TBO_CANCEL_AFTER: 'quizas',
            TBO_COMPANY_SLUG: 'Mi_Empresa',
          },
          {},
          acl,
          NOW,
          { booking: true, zip: true },
        ),
      (err) => {
        for (const piece of [
          'TBO_CERT_EMAIL no es',
          'TBO_CERT_PHONE tiene',
          'TBO_CANCEL_AFTER',
          'TBO_COMPANY_SLUG admite',
        ]) {
          assert.ok(err.message.includes(piece), piece);
        }
        return true;
      },
    );
    const settings = readSettings(
      {
        ...creds,
        TBO_CERT_EMAIL: 'reservas@example.com',
        TBO_CERT_PHONE: '573000000000',
        TBO_CANCEL_AFTER: 'FALSE',
        TBO_COMPANY_SLUG: 'SalesTravel',
      },
      {},
      acl,
      NOW,
      { booking: true, zip: true },
    );
    assert.deepEqual(settings.booking, {
      email: 'reservas@example.com',
      phone: '573000000000',
      cancelAfter: false,
    });
    assert.deepEqual(settings.zip, { companySlug: 'SalesTravel' });
    // Sin pedirlo, ni se exige ni aparece: `check` y `probe` no reservan.
    assert.equal(readSettings(creds, {}, acl, NOW).booking, undefined);
  });

  it('TBO_CANCEL_AFTER es true por defecto', () => {
    const settings = readSettings(
      { ...creds, TBO_CERT_EMAIL: 'reservas@example.com', TBO_CERT_PHONE: '573000000000' },
      {},
      acl,
      NOW,
      { booking: true },
    );
    assert.equal(settings.booking.cancelAfter, true);
  });

  it('las credenciales no salen en un JSON ni en un inspect de la configuración', () => {
    const settings = readSettings(creds, {}, acl, NOW);
    const dumped = `${JSON.stringify(settings)} ${inspect(settings, { depth: 5 })}`;
    assert.doesNotMatch(dumped, /clave-secreta|usuario/);
  });
});

describe('HarnessSecrets', () => {
  it('tapa usuario, contraseña, token Basic y la contraseña escapada dentro de un JSON', () => {
    const secrets = new HarnessSecrets('user1', 'p"ss w');
    const token = Buffer.from('user1:p"ss w').toString('base64');
    const text = `a user1 b ${JSON.stringify({ p: 'p"ss w' })} c Basic ${token}`;
    const { text: scrubbed, hits } = secrets.scrubText(text);
    assert.doesNotMatch(scrubbed, /user1|ss w/);
    assert.ok(!scrubbed.includes(token));
    assert.deepEqual(hits.sort(), ['BASIC_TOKEN', 'TBO_PASSWORD', 'TBO_USERNAME']);
    assert.equal(JSON.stringify({ secrets }), `{"secrets":"${REDACTED}"}`);
    assert.doesNotMatch(inspect(secrets), /user1/);
  });

  it('sin secretos devuelve los mismos bytes: la evidencia es exacta', () => {
    const secrets = new HarnessSecrets('user1', 'pass1');
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0xff, 0x7d]);
    assert.equal(secrets.scrubBytes(bytes).bytes, bytes);
  });
});

describe('parseArgs', () => {
  it('lee comando, banderas y valores con espacio o con =', () => {
    assert.deepEqual(
      parseArgs(['probe', '--only', 'pr-01, PR-04', '--out=x', '--skip-hotelcodelist']),
      {
        command: 'probe',
        rest: [],
        flags: {
          allowNonTestHost: false,
          skipHotelCodeList: true,
          bookings: false,
          help: false,
          only: ['PR-01', 'PR-04'],
          out: 'x',
          cases: undefined,
          resume: undefined,
        },
      },
    );
  });

  it('lee el id de corrida de verify y zip, y --cases y --resume de run', () => {
    const verify = parseArgs(['verify', '2026-10-15T14-03-22Z']);
    assert.equal(verify.command, 'verify');
    assert.deepEqual(verify.rest, ['2026-10-15T14-03-22Z']);
    const run = parseArgs(['run', '--cases', '1, 4', '--resume=2026-10-15T14-03-22Z']);
    assert.deepEqual(run.flags.cases, ['1', '4']);
    assert.equal(run.flags.resume, '2026-10-15T14-03-22Z');
  });

  it('rechaza una opción desconocida o sin valor', () => {
    assert.throws(() => parseArgs(['check', '--forzar']), /Opción desconocida/);
    assert.throws(() => parseArgs(['probe', '--only']), /necesita un valor/);
  });
});
