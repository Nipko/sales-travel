import { z } from 'zod';
import { TboConfigError, TboCredentialsMissingError } from './errors';

/**
 * Único host que admite `http:`. El PDF exige HTTPS ("All APIs should be secured with HTTPS
 * protocol", p. 7) pero publica el entorno de test en `http://`; la excepción vale sólo para ese
 * host y con `environment: 'test'` (D-TBO-30 A; docs/tbo/01 §2.2). Si la sonda PR-03 confirma
 * HTTPS en test (Q-03), `TBO_BASE_URLS.test` pasa a `https://` y esta excepción se borra.
 */
export const TBO_TEST_HOST = 'api.tbotechnology.in';

/**
 * Sólo `test`. La URL live no se publica (`{Live-URL}/HotelAPI`, p. 7) y además cambia el path, así
 * que no se deriva de la de test: en live llega por la cuenta y no tiene valor por defecto
 * (docs/tbo/01 §2.3; Q-04).
 */
export const TBO_BASE_URLS = Object.freeze({
  test: 'http://api.tbotechnology.in/TBOHolidays_HotelAPI',
} as const);

export const TBO_ENVIRONMENTS = ['test', 'live'] as const;

export type TboEnvironment = (typeof TBO_ENVIRONMENTS)[number];

/** Lo que muestra un {@link TboSecret} en cualquier serialización. */
export const TBO_REDACTED = '[redacted]';

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/**
 * Un valor de credencial que no se deja volcar.
 *
 * El header Basic es base64 reversible: equivale a la contraseña en claro (docs/tbo/01 §0). Un
 * `logger.info({ cfg })` o un `JSON.stringify` de la configuración no pueden llevarla, y la forma
 * de garantizarlo sin depender de que cada llamador se acuerde es que el valor viva en un campo
 * privado y que toda serialización (JSON, `String()`, `util.inspect`) devuelva la marca.
 * El usuario va igual: es "la mitad de la credencial que acompaña a la contraseña" (§11.1).
 */
export class TboSecret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** El único acceso al valor. Quien lo llama es quien arma el header Basic. */
  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return TBO_REDACTED;
  }

  toString(): string {
    return TBO_REDACTED;
  }

  [INSPECT](): string {
    return `TboSecret(${TBO_REDACTED})`;
  }
}

/**
 * Motivos propios de los issues `custom`. Van en el mensaje como `ruta:motivo` en lugar del
 * genérico `custom`, que no dice qué regla falló; siguen siendo vocabulario nuestro, nunca el valor.
 */
type TboConfigIssueReason =
  | 'invalid_url'
  | 'unsupported_protocol'
  | 'credentials_in_url'
  | 'query_or_fragment'
  | 'https_required'
  | 'http_only_on_test_host'
  | 'live_on_test_endpoint'
  | 'colon_in_username';

function addReason(ctx: z.RefinementCtx, reason: TboConfigIssueReason, path?: string): void {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    params: { reason },
    ...(path === undefined ? {} : { path: [path] }),
  });
}

const TEST_BASE = new URL(TBO_BASE_URLS.test);

/**
 * `new URL` lanza un `TypeError` plano ante un texto que no es URL, y un `Error` plano no puede
 * escapar del ACL (RNF-12). Además Zod ejecuta los refinamientos aunque `.url()` ya haya fallado.
 */
function safeUrl(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

function trimTrailingSlashes(pathname: string): string {
  return pathname.replace(/\/+$/, '');
}

/** `protocol//host/path` sin barra final: la forma en que se guarda y se concatena el path. */
function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw);
  return `${url.protocol}//${url.host}${trimTrailingSlashes(url.pathname)}`;
}

/**
 * La regla de transporte de D-TBO-30 A, aparte para que la apliquen el esquema y la puerta de
 * `requireUsableTboConfig`: una config armada a mano, sin pasar por Zod, tampoco la esquiva.
 *
 * `live_on_test_endpoint` no está en la letra de RF-01, pero es el objetivo que D-TBO-30 declara
 * ("una credencial live nunca puede terminar en el host de test"): se compara el endpoint de test
 * completo (host y path) y no sólo el host, porque la URL live no se conoce y podría compartirlo.
 */
function transportViolation(
  environment: TboEnvironment,
  baseUrl: string,
): TboConfigIssueReason | undefined {
  const url = safeUrl(baseUrl);
  if (url === undefined) return 'invalid_url';
  const isTestEndpoint =
    url.host === TEST_BASE.host &&
    trimTrailingSlashes(url.pathname).toLowerCase() ===
      trimTrailingSlashes(TEST_BASE.pathname).toLowerCase();
  if (environment === 'live' && isTestEndpoint) return 'live_on_test_endpoint';
  if (url.protocol === 'http:') {
    if (environment !== 'test') return 'https_required';
    if (url.host !== TBO_TEST_HOST) return 'http_only_on_test_host';
  }
  return undefined;
}

const BaseUrlSchema = z
  .string()
  .url()
  .superRefine((raw, ctx) => {
    const url = safeUrl(raw);
    // `.url()` ya dejó su issue; repetirlo como `invalid_url` sería ruido en el mensaje.
    if (url === undefined) return;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      addReason(ctx, 'unsupported_protocol');
    }
    // Credenciales en la URL: `fetch` las rechaza y, peor, aparecerían en cualquier log de la URL.
    if (url.username !== '' || url.password !== '') addReason(ctx, 'credentials_in_url');
    // Se rechaza en vez de recortar: una query en la base es un error de carga y no se adivina.
    if (url.search !== '' || url.hash !== '') addReason(ctx, 'query_or_fragment');
  });

/**
 * Zod en el borde (RF-01, RNF-12). La config llega de `provider_accounts` —`credentials` cifradas
 * (`username`, `password`) y `config` en claro (`environment`, `baseUrl`)— unidas por el factory de
 * `apps/api`, o del arnés de certificación. Ninguna de las dos es de fiar sin validar.
 *
 * Las credenciales son opcionales en el esquema a propósito: la falta se reporta por nombre con
 * {@link missingTboCredentials} para que el factory pueda devolver "cuenta incompleta" en vez de
 * un error de parseo. Lo que SÍ llega tiene que ser válido.
 */
export const TboHotelsConfigSchema = z
  .object({
    environment: z.enum(TBO_ENVIRONMENTS),
    baseUrl: BaseUrlSchema.optional(),
    // RFC 7617: el user-id no puede llevar `:`, que separa usuario y contraseña en el header.
    username: z
      .string()
      .min(1)
      .refine((value) => !value.includes(':'), { params: { reason: 'colon_in_username' } })
      .optional(),
    // Sin `trim()`: un espacio puede ser parte de la contraseña (docs/tbo/01 §1.2; Q-06).
    password: z.string().min(1).optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.baseUrl === undefined || safeUrl(cfg.baseUrl) === undefined) return;
    const violation = transportViolation(cfg.environment, cfg.baseUrl);
    if (violation !== undefined) addReason(ctx, violation, 'baseUrl');
  })
  .transform((cfg): TboHotelsConfig => {
    const baseUrl =
      cfg.baseUrl !== undefined
        ? normalizeBaseUrl(cfg.baseUrl)
        : cfg.environment === 'test'
          ? TBO_BASE_URLS.test
          : undefined;
    return Object.freeze({
      environment: cfg.environment,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(cfg.username === undefined ? {} : { username: new TboSecret(cfg.username) }),
      ...(cfg.password === undefined ? {} : { password: new TboSecret(cfg.password) }),
    });
  });

/** Lo que acepta {@link parseTboConfig}: credenciales en claro, tal como salen de la bóveda. */
export type TboHotelsConfigInput = z.input<typeof TboHotelsConfigSchema>;

/**
 * Configuración runtime del ACL de TBO. El paquete no lee `process.env`: la arma el factory de
 * `apps/api` o el arnés, siempre con {@link parseTboConfig}.
 */
export interface TboHotelsConfig {
  readonly environment: TboEnvironment;
  /**
   * Normalizada, sin barra final. En `test` y sin valor en la cuenta, `TBO_BASE_URLS.test`; en
   * `live` no hay valor por defecto y su falta deja la cuenta incompleta.
   */
  readonly baseUrl?: string;
  readonly username?: TboSecret;
  readonly password?: TboSecret;
}

/** Config que ya pasó la puerta de credenciales: los tres campos garantizados. */
export interface TboUsableConfig {
  readonly environment: TboEnvironment;
  readonly baseUrl: string;
  readonly username: TboSecret;
  readonly password: TboSecret;
}

function issueRef(issue: z.ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
  if (issue.code === z.ZodIssueCode.custom) {
    const reason: unknown = issue.params?.['reason'];
    return `${path}:${typeof reason === 'string' ? reason : issue.code}`;
  }
  return `${path}:${issue.code}`;
}

/**
 * Valida y normaliza la config de una cuenta TBO.
 *
 * El error lleva sólo `ruta:código` de cada issue (RF-01 CA-4), nunca `issue.message`, que en
 * algunos códigos de Zod repite el valor recibido.
 */
export function parseTboConfig(input: unknown): TboHotelsConfig {
  const parsed = TboHotelsConfigSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new TboConfigError(parsed.error.issues.map(issueRef));
}

/**
 * `baseUrl` cuenta como credencial porque en live no tiene default: sin ella la cuenta está
 * incompleta igual que sin contraseña (RF-01 CA-1).
 */
export const TBO_REQUIRED_CREDENTIAL_FIELDS = Object.freeze([
  'username',
  'password',
  'baseUrl',
] as const);

export type TboRequiredCredentialField = (typeof TBO_REQUIRED_CREDENTIAL_FIELDS)[number];

function isFilledSecret(value: TboSecret | undefined): value is TboSecret {
  return value !== undefined && value.reveal().length > 0;
}

function isFilledText(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

/** Nombres —nunca valores— de lo que falta. Sirve al log y al mensaje del panel BYOC. */
export function missingTboCredentials(cfg: TboHotelsConfig): readonly TboRequiredCredentialField[] {
  return TBO_REQUIRED_CREDENTIAL_FIELDS.filter((field) =>
    field === 'baseUrl' ? !isFilledText(cfg.baseUrl) : !isFilledSecret(cfg[field]),
  );
}

/**
 * ¿Esta cuenta puede llamar a TBO? Sin credenciales usables el proveedor queda AUSENTE de la
 * búsqueda: no hay rama alternativa ni fixtures que ocupen su lugar.
 */
export function hasUsableTboCredentials(cfg: TboHotelsConfig): boolean {
  return missingTboCredentials(cfg).length === 0;
}

/**
 * La última puerta antes del cable (docs/tbo/01 §1.3). Además de las credenciales vuelve a aplicar
 * la regla de transporte: si alguien arma un `TboHotelsConfig` a mano en vez de parsearlo, una
 * contraseña live tampoco sale por `http`.
 */
export function requireUsableTboConfig(cfg: TboHotelsConfig): TboUsableConfig {
  const { environment, baseUrl, username, password } = cfg;
  if (!isFilledText(baseUrl) || !isFilledSecret(username) || !isFilledSecret(password)) {
    throw new TboCredentialsMissingError(missingTboCredentials(cfg));
  }
  const violation = transportViolation(environment, baseUrl);
  if (violation !== undefined) throw new TboConfigError([`baseUrl:${violation}`]);
  return Object.freeze({ environment, baseUrl, username, password });
}
