import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { HarnessSecrets } from './secrets.mjs';

/**
 * Configuración del arnés: `.env.tbo` más el entorno del proceso (docs/tbo/07 §6.2). Nunca
 * imprime un valor de credencial: los errores nombran variables, no su contenido.
 */

/** Los 13 `HotelCodes` de la colección Postman (07 §4.1; VERIFICADO-POSTMAN). */
export const DEFAULT_HOTEL_CODES = Object.freeze([
  '376565',
  '1345318',
  '1345320',
  '1200255',
  '1128760',
  '1250333',
  '1078234',
  '1347149',
  '1358855',
  '1345321',
  '1108025',
  '1356271',
  '1267547',
]);

const DAY_MS = 86_400_000;

/** Un error de uso o de configuración: el arnés sale con código 2 y este mensaje. */
export class HarnessUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HarnessUsageError';
  }
}

/**
 * Lee `.env.tbo` si existe. La semántica es la de `loadDotEnv()` de
 * `tools/sabre/cert-probe.mjs:33-42` —archivo opcional, una variable por línea— con dos
 * diferencias que pide TBO:
 *
 * - entre comillas el valor se toma tal cual y sin recortar: un espacio puede ser parte de la
 *   contraseña, y el ACL tampoco la recorta (docs/tbo/01 §1.2; Q-06);
 * - las líneas terminan en `\n` o en `\r\n`: el archivo se edita en Windows.
 */
export async function readDotEnvFile(path) {
  if (!existsSync(path)) return {};
  const vars = {};
  for (const line of (await readFile(path, 'utf8')).split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=(.*)$/.exec(line);
    if (!match) continue;
    vars[match[1]] = unquote(match[2]);
  }
  return vars;
}

function unquote(raw) {
  const trimmed = raw.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.length >= 2 && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** El entorno del proceso manda sobre el archivo, como en Sabre; una variable vacía no cuenta. */
export function mergeEnv(fileVars, processEnv) {
  const merged = { ...fileVars };
  for (const [key, value] of Object.entries(processEnv)) {
    if (typeof value === 'string' && value !== '') merged[key] = value;
  }
  return merged;
}

function integerSetting(env, name, fallback, min, max, issues) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    issues.push(`${name} tiene que ser un entero entre ${min} y ${max}`);
    return fallback;
  }
  return value;
}

const CODE = /^[A-Za-z0-9]+$/;

function hotelCodesSetting(env, issues) {
  const raw = env.TBO_HOTEL_CODES;
  if (raw === undefined || raw.trim() === '') return [...DEFAULT_HOTEL_CODES];
  const codes = raw
    .split(',')
    .map((code) => code.trim())
    .filter((code) => code.length > 0);
  if (codes.length === 0 || codes.some((code) => !CODE.test(code))) {
    issues.push(
      'TBO_HOTEL_CODES tiene que ser una lista de códigos alfanuméricos separados por coma',
    );
    return [...DEFAULT_HOTEL_CODES];
  }
  // El orden es el de relevancia con que se eligieron, como en el ACL (docs/tbo/02 §4.3).
  return [...new Set(codes)];
}

function isoDay(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * ¿Es el endpoint de test de TBO? Host y path, sin mirar el protocolo: la sonda PR-03 prueba
 * `https://` sobre el mismo endpoint, y si Q-03 se cierra con TLS, `TBO_BASE_URL` pasa a `https`.
 */
export function isTboTestEndpoint(baseUrl, acl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  const test = new URL(acl.TBO_BASE_URLS.test);
  const bare = (pathname) => pathname.replace(/\/+$/, '').toLowerCase();
  return (
    url.hostname.toLowerCase() === acl.TBO_TEST_HOST && bare(url.pathname) === bare(test.pathname)
  );
}

/**
 * Lo que `check` y `probe` necesitan, validado. Lanza {@link HarnessUsageError} con TODOS los
 * problemas juntos: corregir el `.env.tbo` de a uno es una vuelta por variable.
 */
export function readSettings(env, flags, acl, now) {
  const missing = ['TBO_USERNAME', 'TBO_PASSWORD'].filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new HarnessUsageError(
      `Faltan credenciales de TEST de TBO: ${missing.join(', ')}.\n` +
        `Copia .env.tbo.example a .env.tbo (ya está en .gitignore) y rellénalo, o exporta las ` +
        `variables en la sesión. Ver tools/tbo/README.md.`,
    );
  }

  const issues = [];
  const baseUrl = env.TBO_BASE_URL || acl.TBO_BASE_URLS.test;
  const testEndpoint = isTboTestEndpoint(baseUrl, acl);
  // G-12 (07 §6.7): contra otro host el Search saldría con una credencial que no es la de test.
  if (!testEndpoint && !flags.allowNonTestHost) {
    issues.push(
      `TBO_BASE_URL no es el endpoint de test (${acl.TBO_BASE_URLS.test}); el arnés se niega ` +
        `salvo con --allow-non-test-host`,
    );
  }
  const offsetDays = integerSetting(env, 'TBO_CHECKIN_OFFSET_DAYS', 45, 1, 330, issues);
  const nights = integerSetting(env, 'TBO_NIGHTS', 2, 1, 30, issues);
  const hotelCodes = hotelCodesSetting(env, issues);
  const cityCode = env.TBO_CITY_CODE ? env.TBO_CITY_CODE.trim() : undefined;
  if (cityCode !== undefined && !CODE.test(cityCode)) {
    issues.push('TBO_CITY_CODE tiene que ser un código alfanumérico');
  }

  // La forma de la config la decide el ACL (usuario sin `:`, URL sin credenciales ni query,
  // transporte de D-TBO-30): el mensaje trae sólo `ruta:código`, nunca el valor (RF-01 CA-4).
  try {
    acl.parseTboConfig({
      environment: 'test',
      baseUrl,
      username: env.TBO_USERNAME,
      password: env.TBO_PASSWORD,
    });
  } catch (err) {
    if (!(err instanceof acl.TboConfigError)) throw err;
    issues.push(`el ACL rechaza la configuración: ${err.issues.join(', ')}`);
  }

  if (issues.length > 0) {
    throw new HarnessUsageError(
      `Configuración inválida:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`,
    );
  }

  return Object.freeze({
    baseUrl: new URL(baseUrl).href.replace(/\/+$/, ''),
    testEndpoint,
    offsetDays,
    nights,
    checkIn: isoDay(now + offsetDays * DAY_MS),
    checkOut: isoDay(now + (offsetDays + nights) * DAY_MS),
    hotelCodes: Object.freeze(hotelCodes),
    cityCode,
    secrets: new HarnessSecrets(env.TBO_USERNAME, env.TBO_PASSWORD),
  });
}
