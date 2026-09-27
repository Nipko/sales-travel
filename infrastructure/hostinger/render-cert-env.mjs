#!/usr/bin/env node
/**
 * Escribe los dos archivos de entorno del stack de certificación de TBO (docs/tbo/07 §7.2 A;
 * D-TBO-35 A; 08 RC-07). Lo corre el job `deploy-cert` de .github/workflows/deploy.yml:
 *
 *   node infrastructure/hostinger/render-cert-env.mjs <directorio>
 *
 * - `<directorio>/.env`: lo que interpola docker-compose.cert.yml.
 * - `<directorio>/seed.env`: lo que lee tools/seed-tbo-cert-tenant, con el formato de
 *   `docker run --env-file`, y que el job borra del VPS al terminar de sembrar.
 *
 * Por qué un script y no el heredoc del despliegue de producción: la salida sale de una lista
 * CERRADA. Lo que no esté en `STACK_ENV` o `SEED_ENV` no llega al stack aunque el runner tenga en
 * su entorno las credenciales de Despegar, LATAM, Sabre o AgentCars, y eso se prueba ejecutando
 * esta misma función con un entorno envenenado (tools/seed-tbo-cert-tenant/src/stack-contract.test.ts).
 *
 * Cada variable de entrada lleva el prefijo `CERT_`: si se reusara `JWT_SECRET` o
 * `PROVIDER_CREDENTIALS_KEY` de producción, una sesión o un volcado de una base servirían en la
 * otra, y un secret de entorno de GitHub que faltara caería en silencio al de repositorio.
 *
 * Los errores nombran la variable y el motivo, nunca el valor.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Base del stack (docker-compose.cert.yml, `POSTGRES_DB`). El seed se niega a sembrar otra. */
export const CERT_DATABASE = 'sales_travel_cert';

/** Red del proyecto `sales-travel-cert` donde viven Postgres y Redis. */
export const CERT_INTERNAL_NETWORK = 'sales-travel-cert_internal';

/**
 * `.env` de compose: sin comillas, así que sólo caracteres que ni la interpolación de compose
 * (`$`) ni su lector de `.env` (`#`, comillas, espacios) reinterpretan. Todo lo que va aquí se
 * genera con `openssl rand -base64`, que cabe en este juego.
 */
const COMPOSE_SAFE = /^[A-Za-z0-9+/=._~-]+$/;

/** @typedef {'tag' | 'secret' | 'key32' | 'days' | 'kill-switch' | 'text'} Kind */

/**
 * @typedef {object} EnvRule
 * @property {string} name  la variable en el archivo de salida
 * @property {string} from  la variable del entorno del job
 * @property {Kind} kind
 * @property {boolean} [optional]  vacía = no se escribe (el stack o el seed aplican su defecto)
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
  { name: 'CERT_WALLET_BALANCE', from: 'CERT_WALLET_BALANCE', kind: 'text', optional: true },
  {
    name: 'CERT_HOTEL_MARKUP_PERCENT',
    from: 'CERT_HOTEL_MARKUP_PERCENT',
    kind: 'text',
    optional: true,
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
    default:
      return 'unknown_kind';
  }
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
      if (!rule.optional) issues.push(`${rule.from}:required`);
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
 * @param {Readonly<Record<string, string | undefined>>} source el entorno del job
 * @returns {{ stack: string, seed: string, stackNames: string[], seedNames: string[] }}
 * @throws {CertEnvError}
 */
export function renderCertEnv(source) {
  /** @type {string[]} */
  const issues = [];
  const stack = pick(STACK_ENV, source, issues);
  const seed = [...Object.entries(SEED_CONNECTION), ...pick(SEED_ENV, source, issues)];
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
  // Una misma entrada alimenta los dos archivos (la contraseña de Postgres, la clave): se nombra una vez.
  if (issues.length > 0) throw new CertEnvError([...new Set(issues)]);
  return {
    stack: serialize(stack),
    seed: serialize(seed),
    stackNames: stack.map(([name]) => name),
    seedNames: seed.map(([name]) => name),
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
  for (const [file, body] of [
    ['.env', rendered.stack],
    ['seed.env', rendered.seed],
  ]) {
    const path = join(out, file);
    writeFileSync(path, body, { mode: 0o600 });
    // `mode` sólo aplica al crear: un archivo que ya existía conservaría sus permisos.
    chmodSync(path, 0o600);
  }
  // Sólo nombres: el log del job es visible para cualquiera con acceso al repositorio.
  process.stdout.write(`.env: ${rendered.stackNames.join(', ')}\n`);
  process.stdout.write(`seed.env: ${rendered.seedNames.join(', ')}\n`);
  return 0;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = main();
}
