#!/usr/bin/env node
/**
 * Escribe los archivos de entorno del stack de certificación de TBO (docs/tbo/07 §7.2 A;
 * D-TBO-35 A; 08 RC-07). Lo corre el job `deploy-cert` de .github/workflows/deploy.yml:
 *
 *   node infrastructure/hostinger/render-cert-env.mjs <directorio>
 *
 * - `<directorio>/.env`: lo que interpola docker-compose.cert.yml.
 * - `<directorio>/seed.env`: lo que lee tools/seed-tbo-cert-tenant, con el formato de
 *   `docker run --env-file`, y que el job borra del VPS al terminar de sembrar.
 * - `<directorio>/catalog.env`: sólo si el despacho pide el sync del catálogo (input `cert_catalog`),
 *   lo que lee tools/sync-tbo-hotel-inventory, con el mismo formato y la misma vida corta que seed.env.
 *
 * Por qué un script y no el heredoc del despliegue de producción: la salida sale de una lista
 * CERRADA. Lo que no esté en `STACK_ENV`, `SEED_ENV` o `CATALOG_ENV` no llega al stack aunque el
 * runner tenga en su entorno las credenciales de Despegar, LATAM, Sabre o AgentCars, o la cuenta de
 * catálogo de producción (`TBO_SYNC_*`), y eso se prueba ejecutando
 * esta misma función con un entorno envenenado (tools/seed-tbo-cert-tenant/src/stack-contract.test.ts).
 *
 * Cada variable de entrada lleva el prefijo `CERT_`: si se reusara `JWT_SECRET` o
 * `PROVIDER_CREDENTIALS_KEY` de producción, una sesión o un volcado de una base servirían en la
 * otra, y un secret de entorno de GitHub que faltara caería en silencio al de repositorio.
 *
 * Los errores nombran la variable y el motivo, nunca el valor.
 */
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Base del stack (docker-compose.cert.yml, `POSTGRES_DB`). El seed se niega a sembrar otra. */
export const CERT_DATABASE = 'sales_travel_cert';

/** Red del proyecto `sales-travel-cert` donde viven Postgres y Redis. */
export const CERT_INTERNAL_NETWORK = 'sales-travel-cert_internal';

/** Red del proyecto con salida a internet, la del api: por ella el sync del catálogo llega a TBO. */
export const CERT_EGRESS_NETWORK = 'sales-travel-cert_egress';

/**
 * `.env` de compose: sin comillas, así que sólo caracteres que ni la interpolación de compose
 * (`$`) ni su lector de `.env` (`#`, comillas, espacios) reinterpretan. Todo lo que va aquí se
 * genera con `openssl rand -base64`, que cabe en este juego.
 */
const COMPOSE_SAFE = /^[A-Za-z0-9+/=._~-]+$/;

/**
 * @typedef {'tag' | 'secret' | 'key32' | 'days' | 'kill-switch' | 'text' | 'countries' | 'cities' | 'calls'} Kind
 */

/**
 * @typedef {object} EnvRule
 * @property {string} name  la variable en el archivo de salida
 * @property {string} from  la variable del entorno del job
 * @property {Kind} kind
 * @property {boolean} [optional]  vacía = no se escribe (el stack o el seed aplican su defecto)
 * @property {string} [fallback]  vacía = se escribe este valor en lugar del defecto del consumidor
 * @property {number} [minLength]
 */

/** @type {readonly EnvRule[]} */
export const STACK_ENV = Object.freeze([
  { name: 'IMAGE_TAG', from: 'IMAGE_TAG', kind: 'tag' },
  { name: 'POSTGRES_ADMIN_PASSWORD', from: 'CERT_POSTGRES_ADMIN_PASSWORD', kind: 'secret' },
  { name: 'APP_USER_PASSWORD', from: 'CERT_APP_USER_PASSWORD', kind: 'secret' },
  { name: 'REDIS_PASSWORD', from: 'CERT_REDIS_PASSWORD', kind: 'secret' },
  // El api rechaza un JWT_SECRET de menos de 32 caracteres al arrancar.
  { name: 'JWT_SECRET', from: 'CERT_JWT_SECRET', kind: 'secret', minLength: 32 },
  { name: 'PROVIDER_CREDENTIALS_KEY', from: 'CERT_PROVIDER_CREDENTIALS_KEY', kind: 'key32' },
  { name: 'PROVIDER_PAYLOADS_KEY', from: 'CERT_PROVIDER_PAYLOADS_KEY', kind: 'key32' },
  {
    name: 'PROVIDER_PAYLOADS_RETENTION_DAYS',
    from: 'CERT_PROVIDER_PAYLOADS_RETENTION_DAYS',
    kind: 'days',
    optional: true,
  },
  {
    name: 'PROVIDERS_DISABLED',
    from: 'CERT_PROVIDERS_DISABLED',
    kind: 'kill-switch',
    optional: true,
  },
]);

/**
 * Lo que el `.env` del stack lleva CALCULADO a partir de otra entrada, en vez de leído del job.
 *
 * `INTERNAL_PROXY_SECRET`: el secreto que comparten cert-api y cert-web-b2b (`x-internal-proxy`)
 * para que el api crea la IP y el navegador del usuario que el panel le reenvía. Se deriva del
 * `JWT_SECRET` del stack igual que en producción (.github/workflows/deploy.yml): sha256 hex de
 * `internal-proxy:` + JWT_SECRET. Así no hay un secret más que cargar en el entorno `tbo-cert`, y
 * el hash no deja recuperar el JWT_SECRET.
 *
 * @type {readonly { name: string, from: string, derive: (value: string) => string }[]}
 */
export const STACK_DERIVED = Object.freeze([
  { name: 'INTERNAL_PROXY_SECRET', from: 'CERT_JWT_SECRET', derive: internalProxySecret },
]);

/**
 * El mismo cálculo que el paso `Render .env` de producción.
 *
 * @param {string} jwtSecret
 */
export function internalProxySecret(jwtSecret) {
  return createHash('sha256').update(`internal-proxy:${jwtSecret}`).digest('hex');
}

/**
 * Conexión del seed: el superusuario del stack, como `migrate` y tools/seed-superadmin. Fijos
 * porque son los nombres de docker-compose.cert.yml.
 */
export const SEED_CONNECTION = Object.freeze({
  PGHOST: 'postgres',
  PGPORT: '5432',
  PGUSER: 'postgres',
  PGDATABASE: CERT_DATABASE,
});

/** @type {readonly EnvRule[]} */
export const SEED_ENV = Object.freeze([
  { name: 'PGPASSWORD', from: 'CERT_POSTGRES_ADMIN_PASSWORD', kind: 'secret' },
  // La misma clave que el api: la cuenta de TBO y los documentos de los clientes se cifran con ella.
  { name: 'PROVIDER_CREDENTIALS_KEY', from: 'CERT_PROVIDER_CREDENTIALS_KEY', kind: 'key32' },
  { name: 'CERT_TBO_USERNAME', from: 'CERT_TBO_USERNAME', kind: 'text' },
  { name: 'CERT_TBO_PASSWORD', from: 'CERT_TBO_PASSWORD', kind: 'text' },
  { name: 'CERT_TBO_BASE_URL', from: 'CERT_TBO_BASE_URL', kind: 'text', optional: true },
  { name: 'CERT_VENDEDOR_EMAIL', from: 'CERT_VENDEDOR_EMAIL', kind: 'text', optional: true },
  { name: 'CERT_VENDEDOR_PASSWORD', from: 'CERT_VENDEDOR_PASSWORD', kind: 'text' },
  { name: 'CERT_VENDEDOR_NAME', from: 'CERT_VENDEDOR_NAME', kind: 'text', optional: true },
  { name: 'CERT_VENDEDOR_STATUS', from: 'CERT_VENDEDOR_STATUS', kind: 'text', optional: true },
  { name: 'CERT_TENANT_NAME', from: 'CERT_TENANT_NAME', kind: 'text', optional: true },
  { name: 'CERT_COUNTRY', from: 'CERT_COUNTRY', kind: 'text', optional: true },
  { name: 'CERT_CURRENCY', from: 'CERT_CURRENCY', kind: 'text', optional: true },
  // Contacto operativo del tenant, que el Book exige y manda a TBO. Vacías, el seed pone un buzón
  // de rol y un teléfono ficticio (tools/seed-tbo-cert-tenant, `SEED_DEFAULTS`).
  { name: 'CERT_SUPPORT_EMAIL', from: 'CERT_SUPPORT_EMAIL', kind: 'text', optional: true },
  { name: 'CERT_SUPPORT_PHONE', from: 'CERT_SUPPORT_PHONE', kind: 'text', optional: true },
  { name: 'CERT_WALLET_BALANCE', from: 'CERT_WALLET_BALANCE', kind: 'text', optional: true },
  {
    name: 'CERT_HOTEL_MARKUP_PERCENT',
    from: 'CERT_HOTEL_MARKUP_PERCENT',
    kind: 'text',
    optional: true,
  },
]);

/**
 * Sync del catálogo de TBO en la base del stack (docs/tbo/07 §7.3 punto 6): sin él, las sugerencias
 * de destino salen vacías y la búsqueda responde que el catálogo no está sincronizado. Lo pide el
 * input `cert_catalog` del job, que llega aquí como `CERT_CATALOG_MODE`; cada modo son unas etapas
 * del sync, y siempre acotadas a una lista cerrada:
 *
 * - `none`: no se escribe catalog.env y el job no corre el sync.
 * - `cities`: E1 y E2, la lista de ciudades de `CERT_CATALOG_COUNTRIES` (una llamada por país más
 *   una), para elegir los `CityCode`. Ningún hotel.
 * - `hotels`: E3 y E4 de las ciudades de `CERT_CATALOG_CITIES`: sus hoteles (nombre, estrellas,
 *   dirección) y su contenido. E2 corre igual para un país que todavía no tiene ciudades en la base.
 */
export const CATALOG_MODE_VARIABLE = 'CERT_CATALOG_MODE';

/** @type {Readonly<Record<string, string | null>>} modo → `TBO_SYNC_STAGES` */
export const CATALOG_STAGES = Object.freeze({ none: null, cities: 'E1,E2', hotels: 'E3,E4' });

/** Techos de la lista cerrada: la corrida de certificación no recorre un país entero. */
export const CATALOG_LIMITS = Object.freeze({ countries: 5, cities: 20, calls: 5000 });

/** Conexión del sync: la misma que la del seed. Escribe tablas de catálogo, que `app_user` sólo lee. */
export const CATALOG_CONNECTION = SEED_CONNECTION;

/**
 * Lo que no se configura. El stack sólo habla con el entorno de test de TBO, y sus búsquedas no
 * cuentan como demanda del sync (docs/tbo/05 §8.5): con el alcance `demand` por defecto, E4 no
 * pediría ningún contenido. Español porque la web lo está (07 Anexo B §0); el inglés lo dejan E3
 * (`listing`) y la lectura bajo demanda del api. 20 minutos, debajo del tope del paso del job.
 */
export const CATALOG_FIXED = Object.freeze({
  TBO_SYNC_ENVIRONMENT: 'test',
  TBO_SYNC_MAX_MINUTES: '20',
  TBO_SYNC_CONTENT_SCOPE: 'all',
  TBO_SYNC_LANGS: 'ES',
  TBO_SYNC_LANGS_REGULAR: 'ES',
});

/**
 * Nunca las `TBO_SYNC_*` del runner ni de producción: ésas son la cuenta de catálogo de plataforma
 * (D-TBO-04 A), que puede ser la live, y un `vars.TBO_SYNC_*` que faltara en el entorno `tbo-cert`
 * caería en silencio al de repositorio. La cuenta es la de test del stack, la misma que el seed
 * cifra en la bóveda; con la base URL que el seed ya validó como host de test.
 *
 * @type {readonly EnvRule[]}
 */
export const CATALOG_ENV = Object.freeze([
  { name: 'PGPASSWORD', from: 'CERT_POSTGRES_ADMIN_PASSWORD', kind: 'secret' },
  { name: 'TBO_SYNC_USERNAME', from: 'CERT_TBO_USERNAME', kind: 'text' },
  { name: 'TBO_SYNC_PASSWORD', from: 'CERT_TBO_PASSWORD', kind: 'text' },
  { name: 'TBO_SYNC_BASE_URL', from: 'CERT_TBO_BASE_URL', kind: 'text', optional: true },
  { name: 'TBO_SYNC_COUNTRIES', from: 'CERT_CATALOG_COUNTRIES', kind: 'countries' },
  // Obligatoria en `hotels` (`renderCertEnv`). En `cities` no cambia nada: E1 y E2 van por país.
  { name: 'TBO_SYNC_CITIES', from: 'CERT_CATALOG_CITIES', kind: 'cities', optional: true },
  {
    name: 'TBO_SYNC_MAX_CALLS',
    from: 'CERT_CATALOG_MAX_CALLS',
    kind: 'calls',
    optional: true,
    fallback: '500',
  },
]);

export class CertEnvError extends Error {
  /** @param {readonly string[]} issues `VARIABLE:motivo`, sin valores */
  constructor(issues) {
    super(`entorno del stack de certificación inválido: ${issues.join(', ')}`);
    this.name = 'CertEnvError';
    this.issues = issues;
  }
}

/**
 * @param {Kind} kind
 * @param {string} value no vacío
 * @param {number | undefined} minLength
 * @returns {string | undefined} el motivo, o `undefined` si vale
 */
function problemOf(kind, value, minLength) {
  switch (kind) {
    case 'tag':
      return /^[A-Za-z0-9._-]{1,128}$/.test(value) ? undefined : 'invalid_tag';
    case 'secret':
      if (!COMPOSE_SAFE.test(value)) return 'unsafe_characters';
      return value.length < (minLength ?? 16) ? 'too_short' : undefined;
    case 'key32':
      return /^[A-Za-z0-9+/]+={0,2}$/.test(value) && Buffer.from(value, 'base64').length === 32
        ? undefined
        : 'not_base64_32_bytes';
    case 'days':
      // Fuera de 1 a 90 el api no falla: apaga la bóveda de payloads y sólo lo loguea.
      return /^\d{1,2}$/.test(value) && Number(value) >= 1 && Number(value) <= 90
        ? undefined
        : 'not_1_to_90_days';
    case 'kill-switch':
      // `código` o `código:ventas`, separados por comas, como lee circuit-breaker.service.ts.
      return /^[a-z0-9-]+(:ventas)?(,[a-z0-9-]+(:ventas)?)*$/.test(value)
        ? undefined
        : 'invalid_provider_list';
    case 'text':
      // `docker run --env-file` toma el valor tal cual hasta el fin de línea: sólo un salto de
      // línea o un NUL lo corta.
      return /[\r\n\0]/.test(value) ? 'line_break' : undefined;
    case 'countries':
      return listProblem(value, /^[A-Za-z]{2}$/, CATALOG_LIMITS.countries, 'not_iso2_list');
    case 'cities':
      return listProblem(value, /^\d{1,10}$/, CATALOG_LIMITS.cities, 'not_city_code_list');
    case 'calls':
      return /^\d{1,4}$/.test(value) && Number(value) >= 1 && Number(value) <= CATALOG_LIMITS.calls
        ? undefined
        : 'not_1_to_5000_calls';
    default:
      return 'unknown_kind';
  }
}

/**
 * Una lista separada por comas en la que cada elemento cumple `item`. El sync vuelve a validarla con
 * su Zod; aquí se corta antes de tocar el VPS, y con el techo propio del stack.
 *
 * @param {string} value
 * @param {RegExp} item
 * @param {number} max
 * @param {string} reason
 * @returns {string | undefined}
 */
function listProblem(value, item, max, reason) {
  const items = value.split(',').map((part) => part.trim());
  if (!items.every((part) => item.test(part))) return reason;
  return new Set(items.map((part) => part.toUpperCase())).size > max ? 'too_many' : undefined;
}

/**
 * @param {readonly EnvRule[]} rules
 * @param {Readonly<Record<string, string | undefined>>} source
 * @param {string[]} issues
 * @returns {[string, string][]}
 */
function pick(rules, source, issues) {
  /** @type {[string, string][]} */
  const out = [];
  for (const rule of rules) {
    const raw = source[rule.from] ?? '';
    if (raw === '') {
      if (rule.fallback !== undefined) out.push([rule.name, rule.fallback]);
      else if (!rule.optional) issues.push(`${rule.from}:required`);
      continue;
    }
    const problem = problemOf(rule.kind, raw, rule.minLength);
    if (problem !== undefined) {
      issues.push(`${rule.from}:${problem}`);
      continue;
    }
    out.push([rule.name, raw]);
  }
  return out;
}

/** @param {readonly (readonly [string, string])[]} entries */
function serialize(entries) {
  const header = '# Generado por infrastructure/hostinger/render-cert-env.mjs. No se edita a mano.';
  return [header, ...entries.map(([name, value]) => `${name}=${value}`), ''].join('\n');
}

/**
 * `catalog.env`, o `null` si el modo es `none`.
 *
 * @param {Readonly<Record<string, string | undefined>>} source
 * @param {string[]} issues
 * @returns {[string, string][] | null}
 */
function pickCatalog(source, issues) {
  const mode = source[CATALOG_MODE_VARIABLE] || 'none';
  if (!Object.hasOwn(CATALOG_STAGES, mode)) {
    issues.push(`${CATALOG_MODE_VARIABLE}:invalid_mode`);
    return null;
  }
  const stages = CATALOG_STAGES[mode];
  if (stages === null || stages === undefined) return null;
  // Sin la lista, E3 recorrería todas las ciudades de los países en el orden de sus códigos.
  if (mode === 'hotels' && (source['CERT_CATALOG_CITIES'] ?? '') === '') {
    issues.push('CERT_CATALOG_CITIES:required');
  }
  return [
    ...Object.entries(CATALOG_CONNECTION),
    ...Object.entries(CATALOG_FIXED),
    ['TBO_SYNC_STAGES', stages],
    ...pick(CATALOG_ENV, source, issues),
  ];
}

/**
 * @param {Readonly<Record<string, string | undefined>>} source el entorno del job
 * @returns {{
 *   stack: string, seed: string, catalog: string | null,
 *   stackNames: string[], seedNames: string[], catalogNames: string[],
 * }}
 * @throws {CertEnvError}
 */
export function renderCertEnv(source) {
  /** @type {string[]} */
  const issues = [];
  const stack = pick(STACK_ENV, source, issues);
  // Sólo de una entrada que pasó su regla: si no, el issue ya está anotado y el render falla abajo.
  for (const derived of STACK_DERIVED) {
    const raw = source[derived.from] ?? '';
    if (raw !== '' && !issues.some((issue) => issue.startsWith(`${derived.from}:`))) {
      stack.push([derived.name, derived.derive(raw)]);
    }
  }
  const seed = [...Object.entries(SEED_CONNECTION), ...pick(SEED_ENV, source, issues)];
  const catalog = pickCatalog(source, issues);
  // Con la misma clave el api apaga la bóveda de RQ/RS en silencio, y esas RQ/RS son la evidencia
  // ante un hallazgo de TBO (D-TBO-31 A): mejor que el despliegue falle.
  const credentialsKey = source['CERT_PROVIDER_CREDENTIALS_KEY'] ?? '';
  const payloadsKey = source['CERT_PROVIDER_PAYLOADS_KEY'] ?? '';
  if (
    credentialsKey !== '' &&
    Buffer.from(credentialsKey, 'base64').equals(Buffer.from(payloadsKey, 'base64'))
  ) {
    issues.push('CERT_PROVIDER_PAYLOADS_KEY:same_as_credentials_key');
  }
  // Una misma entrada alimenta varios archivos (la contraseña de Postgres, la cuenta de TBO): se
  // nombra una vez.
  if (issues.length > 0) throw new CertEnvError([...new Set(issues)]);
  return {
    stack: serialize(stack),
    seed: serialize(seed),
    catalog: catalog === null ? null : serialize(catalog),
    stackNames: stack.map(([name]) => name),
    seedNames: seed.map(([name]) => name),
    catalogNames: (catalog ?? []).map(([name]) => name),
  };
}

function main() {
  const dir = process.argv[2];
  if (dir === undefined || dir === '') {
    process.stderr.write('uso: node render-cert-env.mjs <directorio de salida>\n');
    return 2;
  }
  let rendered;
  try {
    rendered = renderCertEnv(process.env);
  } catch (err) {
    if (!(err instanceof CertEnvError)) throw err;
    for (const issue of err.issues) process.stderr.write(`::error::${issue}\n`);
    return 1;
  }
  const out = resolve(dir);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  /** @type {[string, string | null][]} */
  const files = [
    ['.env', rendered.stack],
    ['seed.env', rendered.seed],
    ['catalog.env', rendered.catalog],
  ];
  for (const [file, body] of files) {
    const path = join(out, file);
    // Sin sync pedido no queda catalog.env en el directorio: uno de un render anterior (el mismo
    // directorio reusado en local) no puede colarse con otra cuenta o con otra lista.
    if (body === null) {
      rmSync(path, { force: true });
      continue;
    }
    writeFileSync(path, body, { mode: 0o600 });
    // `mode` sólo aplica al crear: un archivo que ya existía conservaría sus permisos.
    chmodSync(path, 0o600);
  }
  // Sólo nombres: el log del job es visible para cualquiera con acceso al repositorio.
  process.stdout.write(`.env: ${rendered.stackNames.join(', ')}\n`);
  process.stdout.write(`seed.env: ${rendered.seedNames.join(', ')}\n`);
  if (rendered.catalog !== null) {
    process.stdout.write(`catalog.env: ${rendered.catalogNames.join(', ')}\n`);
  }
  return 0;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = main();
}
