import {
  TBO_HOTEL_DETAILS_LIMITS,
  TBO_HOTELS_PROVIDER_CODE,
  TboConfigError,
  missingTboCredentials,
  parseTboConfig,
  type TboContentLanguage,
  type TboHotelsConfig,
} from '@sales-travel/tbo-hotels';
import { z } from 'zod';
import { SyncConfigError } from './errors.js';
import { PLATFORM_DESTINATION_PROVIDER } from './match-rules.js';

/**
 * Etapa E0: las variables `TBO_SYNC_*` validadas con Zod al arrancar (docs/tbo/05 §6.3 y §6.6;
 * 08 RF-30 y RNF-12). Las variables de entorno son un borde (CLAUDE.md): el sync de Despegar sólo
 * comprueba que existan (`tools/sync-hotel-inventory/src/index.ts`), y aquí un número mal escrito
 * no puede convertirse en un presupuesto `NaN` que nunca se agota.
 *
 * La cuenta de TBO sale de la bóveda de Planetour, la raíz `platform`, donde la carga el superadmin
 * desde el panel (D-TBO-04, decisión del founder del 2026-09-29; `vault.ts`). `TBO_SYNC_USERNAME` y
 * `TBO_SYNC_PASSWORD` quedan sólo como override explícito (el stack de certificación): con las dos,
 * mandan sobre la bóveda, junto con `TBO_SYNC_ENVIRONMENT` y `TBO_SYNC_BASE_URL`, que sin ellas no
 * se usan (la cuenta de la bóveda trae su entorno y su URL).
 *
 * Salidas, en este orden:
 *
 * 1. `TBO_SYNC_ENABLED=false` → `skip`, aunque lo demás esté mal: el kill-switch no puede depender
 *    de que el resto de la configuración sea válida.
 * 2. Cualquier variable inválida → `SyncConfigError` y salida 1, antes de tocar la base. Los issues
 *    son `VARIABLE:código`, nunca el valor.
 * 3. `run`, con el override o sin él. Si no hay override ni cuenta en la bóveda, `cli.ts` sale con 0
 *    ("sin credenciales"), como el sync de Despegar sin su API key.
 */

/**
 * E6 no llama a TBO: es SQL sobre lo que E3 dejó (05 §6.3), y no gasta presupuesto. E2A baja las
 * ciudades de TODOS los países de TBO (cobertura global del buscador, ~250 llamadas la primera vez)
 * y es opt-in: no está en {@link DEFAULT_SYNC_STAGES}.
 */
export const SYNC_STAGES = ['E1', 'E2', 'E2A', 'E3', 'E4', 'E5', 'E6'] as const;
export type SyncStage = (typeof SYNC_STAGES)[number];

/**
 * Las etapas de una corrida sin `TBO_SYNC_STAGES`: todas menos E2A, que se pide a mano
 * (`stages=E1,E2A`) porque su primera pasada gasta una llamada por país del mundo.
 */
export const DEFAULT_SYNC_STAGES: readonly SyncStage[] = Object.freeze(
  SYNC_STAGES.filter((stage) => stage !== 'E2A'),
);

/**
 * A qué hoteles les toca contenido de HotelDetails (E4). `demand`: sólo los de ciudades con
 * búsquedas recientes, que es la recomendación "al inicio" de 05 §14 punto 3 (b) y D-TBO-12 (A)
 * mientras no se conozca el QPS (Q-10). `all`: además el resto, con sus propios idiomas.
 */
export const CONTENT_SCOPES = ['demand', 'all'] as const;
export type ContentScope = (typeof CONTENT_SCOPES)[number];

/** Idiomas de HotelDetails en mayúsculas, como los pide TBO (p. 58; 05 §10). */
const CONTENT_LANGUAGE_CODES = ['ES', 'PT', 'EN'] as const;

/**
 * Lista cerrada de D-TBO-12 (A): los domésticos CO, PE y BR más los emisivos que la decisión da
 * como ejemplo. Es la recomendación, no la lista comercial final: se amplía o recorta con
 * `TBO_SYNC_COUNTRIES` sin tocar código.
 */
export const DEFAULT_SYNC_COUNTRIES = Object.freeze([
  'CO',
  'PE',
  'BR',
  'US',
  'MX',
  'DO',
  'AR',
  'CL',
  'ES',
] as const);

/**
 * Techo de `TBO_SYNC_CITIES`. La lista es para una corrida acotada (el stack de certificación,
 * docs/tbo/07 §7.3 punto 6, o reintentar una ciudad concreta), no para recorrer un país ciudad por
 * ciudad.
 */
export const MAX_SYNC_CITIES = 50;

export const SYNC_LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type SyncLogLevel = (typeof SYNC_LOG_LEVELS)[number];

/** Cuándo vuelve a tocarle a una ciudad (05 §6.3, frecuencias de E3). */
export interface CityCadence {
  /** Ciudades de destinos buscados: "diaria". 20 h y no 24 para que la corrida de mañana a la misma hora la alcance. */
  readonly demandMaxAgeMs: number;
  /** El resto: "semanal". */
  readonly regularMaxAgeMs: number;
  /** Ciudades que ya dieron 0 hoteles (aldeas de `CityList`, p. 54): "mensual". */
  readonly emptyMaxAgeMs: number;
  /** Qué tan atrás se mira `search_logs` para decidir qué destinos tienen demanda. */
  readonly demandWindowMs: number;
}

/** Etapa E4 (05 §6.3 y §10; 09 PR-3.3). */
export interface ContentSettings {
  readonly scope: ContentScope;
  /**
   * Idiomas de los hoteles de destinos con demanda, en orden de prioridad: ES, PT y EN (05 §14
   * punto 8 (a); D-TBO-12 A). EN también es el respaldo cuando un idioma falla (05 §10).
   */
  readonly demandLangs: readonly TboContentLanguage[];
  /**
   * Idiomas del resto, sólo con `scope = all`: ES y PT; su inglés es el texto `listing` de
   * TBOHotelCodeList y la lectura bajo demanda del API (05 §14 punto 8 (b)).
   */
  readonly regularLangs: readonly TboContentLanguage[];
  /** Códigos por llamada: 10 por defecto y nunca más de 13 hasta que TBO publique su máximo (Q-62). */
  readonly batchSize: number;
  /** Contenido `details` más viejo que esto se vuelve a pedir ("más de X días", 05 §6.3). */
  readonly maxAgeMs: number;
}

export interface SyncSettings {
  readonly providerCode: string;
  /**
   * El proveedor cuyo espacio de ids es el del destino de la UI (`PLATFORM_DESTINATION_PROVIDER`):
   * `source_provider_code` del mapa de destinos y el otro lado de las equivalencias de E6.
   */
  readonly destinationSourceProvider: string;
  readonly countries: readonly string[];
  /**
   * `CityCode` de TBO a los que se limitan E3 y E4 (`TBO_SYNC_CITIES`), dentro de `countries`. Sin
   * la lista, todas las ciudades de esos países. E2, E5 y E6 no cambian: la lista de ciudades se
   * sigue pidiendo por país, que es como TBO la da.
   */
  readonly cities?: readonly string[];
  readonly stages: ReadonlySet<SyncStage>;
  /** Llamadas lógicas a TBO por corrida (`TBO_SYNC_MAX_CALLS`, 05 §6.4). */
  readonly maxCalls: number;
  readonly maxDurationMs: number;
  /** Fracción de hoteles activos que una ciudad puede perder sin que se sospeche de la respuesta. */
  readonly sweepMaxDrop: number;
  readonly maxConsecutiveThrottled: number;
  readonly maxConsecutiveErrors: number;
  readonly cadence: CityCadence;
  readonly content: ContentSettings;
}

/** Lo que va al cliente de contenido del ACL y a su limitador. */
export interface SyncClientSettings {
  /** 1 req/s de partida y una sola conexión (05 §10; Q-10). */
  readonly requestsPerSecond: number;
  /** `IsDetailedResponse` de TBOHotelCodeList; `true` hasta cerrar Q-63 (05 §6.3). */
  readonly detailedCityHotels: boolean;
  /** Sólo acorta los 180 s de `hotelcodelist` (05 §10). */
  readonly codelistTimeoutMs: number | undefined;
}

export type SyncEnv = Readonly<Record<string, string | undefined>>;

/**
 * La cuenta por variables de entorno, que le gana a la bóveda. `absent` dice qué mitad falta y qué
 * variables de credencial están cargadas pero no se usan: sólo nombres, para el log.
 */
export type SyncCredentialOverride =
  | { readonly kind: 'env'; readonly tbo: TboHotelsConfig }
  | {
      readonly kind: 'absent';
      readonly missing: readonly string[];
      readonly ignored: readonly string[];
    };

export type SyncEnvResolution =
  | { readonly kind: 'skip'; readonly reason: string }
  | {
      readonly kind: 'run';
      readonly settings: SyncSettings;
      readonly client: SyncClientSettings;
      readonly override: SyncCredentialOverride;
    };

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const FALSE_VALUES: ReadonlySet<string> = new Set(['false', '0', 'no', 'off']);
const TRUE_VALUES: ReadonlySet<string> = new Set(['true', '1', 'yes', 'on']);

function blankToUndefined(value: unknown): unknown {
  return typeof value === 'string' && value.trim() === '' ? undefined : value;
}

/** Enumerados sin distinguir mayúsculas ni espacios: `LIVE` y ` debug ` son lo que parecen. */
function lowered(value: unknown): unknown {
  const present = blankToUndefined(value);
  return typeof present === 'string' ? present.trim().toLowerCase() : present;
}

function flag(fallback: boolean): z.ZodType<boolean, z.ZodTypeDef, unknown> {
  return z.preprocess(blankToUndefined, z.string().optional()).transform((value, ctx) => {
    if (value === undefined) return fallback;
    const normalized = value.trim().toLowerCase();
    if (TRUE_VALUES.has(normalized)) return true;
    if (FALSE_VALUES.has(normalized)) return false;
    ctx.addIssue({ code: z.ZodIssueCode.custom, params: { reason: 'not_a_boolean' } });
    return z.NEVER;
  });
}

function integer(
  min: number,
  max: number,
  fallback: number,
): z.ZodType<number, z.ZodTypeDef, unknown> {
  return z.preprocess(
    blankToUndefined,
    z.coerce.number().int().min(min).max(max).default(fallback),
  );
}

function csv<T extends z.ZodTypeAny>(
  item: T,
  fallback: readonly string[],
  maxItems: number,
): z.ZodType<z.output<T>[], z.ZodTypeDef, unknown> {
  return z
    .preprocess(blankToUndefined, z.string().default(fallback.join(',')))
    .transform((raw) =>
      raw
        .split(',')
        .map((part) => part.trim().toUpperCase())
        .filter((part) => part.length > 0),
    )
    .pipe(z.array(item).min(1).max(maxItems))
    .transform((items) => [...new Set(items)] as z.output<T>[]);
}

/** Como `csv`, sin valor por defecto: vacía = sin lista. Una lista de sólo comas no vale como vacía. */
function optionalCsv<T extends z.ZodTypeAny>(
  item: T,
  maxItems: number,
): z.ZodType<z.output<T>[] | undefined, z.ZodTypeDef, unknown> {
  return z
    .preprocess(blankToUndefined, z.string().optional())
    .transform((raw) =>
      raw
        ?.split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    )
    .pipe(z.array(item).min(1).max(maxItems).optional())
    .transform((items) =>
      items === undefined ? undefined : ([...new Set(items)] as z.output<T>[]),
    );
}

const SyncEnvSchema = z.object({
  TBO_SYNC_ENABLED: flag(true),
  TBO_SYNC_ENVIRONMENT: z.preprocess(lowered, z.enum(['test', 'live']).default('test')),
  TBO_SYNC_BASE_URL: z.preprocess(blankToUndefined, z.string().optional()),
  TBO_SYNC_COUNTRIES: csv(z.string().regex(/^[A-Z]{2}$/), DEFAULT_SYNC_COUNTRIES, 60),
  // `CityList[].Code` y `TBOHotelCodeList.CityCode`: un número en texto (pp. 54 y 65; 05 §2.3
  // y §2.5).
  TBO_SYNC_CITIES: optionalCsv(z.string().regex(/^\d{1,10}$/), MAX_SYNC_CITIES),
  TBO_SYNC_STAGES: csv(z.enum(SYNC_STAGES), DEFAULT_SYNC_STAGES, SYNC_STAGES.length),
  TBO_SYNC_MAX_CALLS: integer(1, 100_000, 2_500),
  TBO_SYNC_MAX_MINUTES: integer(1, 360, 45),
  // El techo es el cupo que el limitador deja a lo que no es dinero (5 QPS menos la reserva).
  TBO_SYNC_RPS: integer(1, 4, 1),
  TBO_SYNC_SWEEP_MAX_DROP: z.preprocess(
    blankToUndefined,
    z.coerce.number().min(0).max(1).default(0.5),
  ),
  TBO_SYNC_MAX_CONSECUTIVE_429: integer(1, 50, 3),
  TBO_SYNC_MAX_CONSECUTIVE_ERRORS: integer(1, 1_000, 10),
  TBO_SYNC_DETAILED_RESPONSE: flag(true),
  TBO_SYNC_CODELIST_TIMEOUT_MS: z.preprocess(
    blankToUndefined,
    z.coerce.number().int().min(1_000).max(180_000).optional(),
  ),
  TBO_SYNC_DEMAND_REFRESH_HOURS: integer(1, 720, 20),
  TBO_SYNC_REFRESH_DAYS: integer(1, 365, 7),
  TBO_SYNC_EMPTY_REFRESH_DAYS: integer(1, 365, 30),
  TBO_SYNC_DEMAND_WINDOW_DAYS: integer(1, 90, 14),
  TBO_SYNC_CONTENT_SCOPE: z.preprocess(lowered, z.enum(CONTENT_SCOPES).default('demand')),
  TBO_SYNC_LANGS: csv(z.enum(CONTENT_LANGUAGE_CODES), ['ES', 'PT', 'EN'], 3),
  TBO_SYNC_LANGS_REGULAR: csv(z.enum(CONTENT_LANGUAGE_CODES), ['ES', 'PT'], 3),
  TBO_SYNC_DETAILS_BATCH: integer(
    1,
    TBO_HOTEL_DETAILS_LIMITS.maxCodesPerRequest,
    TBO_HOTEL_DETAILS_LIMITS.defaultBatchSize,
  ),
  TBO_SYNC_CONTENT_REFRESH_DAYS: integer(1, 365, 30),
  TBO_SYNC_LOG_LEVEL: z.preprocess(lowered, z.enum(SYNC_LOG_LEVELS).default('info')),
});

/**
 * Todas las `TBO_SYNC_*` que lee la herramienta. El contenedor no hereda el `.env` del VPS: el
 * workflow las pasa una a una con `-e` y `deploy.yml` las escribe en ese `.env` (05 §6.6). Una
 * variable nueva que falte en cualquiera de los dos llegaría vacía sin que nada lo avise; el test de
 * contrato del despliegue compara contra esta lista.
 */
export const SYNC_ENV_VARIABLES: readonly string[] = Object.freeze([
  'TBO_SYNC_USERNAME',
  'TBO_SYNC_PASSWORD',
  ...Object.keys(SyncEnvSchema.shape),
]);

/** Credenciales: sólo desde `secrets.*` de GitHub y nunca en la línea de comandos del VPS. */
export const SYNC_SECRET_VARIABLES: readonly string[] = Object.freeze(['TBO_SYNC_PASSWORD']);

/** Las que sólo cuentan con el override: sin usuario y contraseña, la cuenta es la de la bóveda. */
const OVERRIDE_VARIABLES = Object.freeze([
  'TBO_SYNC_USERNAME',
  'TBO_SYNC_PASSWORD',
  'TBO_SYNC_ENVIRONMENT',
  'TBO_SYNC_BASE_URL',
] as const);

/** `ES` → `es`: el valor de `hotel_content.lang` (0041) y del ACL. */
function contentLanguages(
  codes: readonly (typeof CONTENT_LANGUAGE_CODES)[number][],
): TboContentLanguage[] {
  return codes.map((code) => code.toLowerCase() as TboContentLanguage);
}

/** `VARIABLE[.índice]:código`. Nunca `issue.message`, que en algunos códigos repite el valor. */
function issueRefs(error: z.ZodError): string[] {
  return error.issues.slice(0, 20).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '<env>';
    const reason: unknown =
      issue.code === z.ZodIssueCode.custom ? issue.params?.['reason'] : undefined;
    return `${path}:${typeof reason === 'string' ? reason : issue.code}`;
  });
}

/** Los campos de la config del ACL, con el nombre de la variable que los trae. */
const ACL_FIELD_TO_ENV: Readonly<Record<string, string>> = {
  environment: 'TBO_SYNC_ENVIRONMENT',
  baseUrl: 'TBO_SYNC_BASE_URL',
  username: 'TBO_SYNC_USERNAME',
  password: 'TBO_SYNC_PASSWORD',
};

function renameAclIssue(issue: string): string {
  const [field = '', ...rest] = issue.split(':');
  const variable = ACL_FIELD_TO_ENV[field] ?? `TBO_SYNC_${field}`;
  return [variable, ...rest].join(':');
}

/**
 * El override por entorno: usuario y contraseña, los dos, o nada. Con uno solo no hay cuenta que
 * armar y se sigue con la bóveda; `cli.ts` avisa qué variable quedó sin usar.
 */
function resolveOverride(
  env: SyncEnv,
  vars: z.output<typeof SyncEnvSchema>,
): SyncCredentialOverride {
  // La contraseña no se recorta: un espacio puede ser parte de ella (docs/tbo/01 §1.2).
  const missing = [
    (env['TBO_SYNC_USERNAME'] ?? '').trim() === '' ? 'TBO_SYNC_USERNAME' : undefined,
    (env['TBO_SYNC_PASSWORD'] ?? '') === '' ? 'TBO_SYNC_PASSWORD' : undefined,
  ].filter((name): name is string => name !== undefined);
  if (missing.length > 0) {
    const ignored = OVERRIDE_VARIABLES.filter((name) => (env[name] ?? '').trim() !== '');
    return { kind: 'absent', missing, ignored };
  }

  let tbo: TboHotelsConfig;
  try {
    tbo = parseTboConfig({
      environment: vars.TBO_SYNC_ENVIRONMENT,
      ...(vars.TBO_SYNC_BASE_URL === undefined ? {} : { baseUrl: vars.TBO_SYNC_BASE_URL }),
      username: env['TBO_SYNC_USERNAME']?.trim(),
      password: env['TBO_SYNC_PASSWORD'],
    });
  } catch (err) {
    if (err instanceof TboConfigError) throw new SyncConfigError(err.issues.map(renameAclIssue));
    throw err;
  }
  // En `live` la URL no tiene valor por defecto (01 §2.3): con usuario y contraseña cargados, que
  // falte es un despliegue a medias, no una cuenta sin configurar.
  if (missingTboCredentials(tbo).includes('baseUrl')) {
    throw new SyncConfigError(['TBO_SYNC_BASE_URL:required']);
  }
  return { kind: 'env', tbo };
}

/** El nivel se lee aparte y sin lanzar: el logger existe antes de validar el resto. */
export function readLogLevel(env: SyncEnv): SyncLogLevel {
  const raw = env['TBO_SYNC_LOG_LEVEL']?.trim().toLowerCase();
  return (SYNC_LOG_LEVELS as readonly string[]).includes(raw ?? '')
    ? (raw as SyncLogLevel)
    : 'info';
}

export function resolveSyncEnv(env: SyncEnv): SyncEnvResolution {
  const enabled = env['TBO_SYNC_ENABLED']?.trim().toLowerCase();
  if (enabled !== undefined && FALSE_VALUES.has(enabled)) {
    return { kind: 'skip', reason: 'TBO_SYNC_ENABLED=false' };
  }

  const parsed = SyncEnvSchema.safeParse(env);
  if (!parsed.success) throw new SyncConfigError(issueRefs(parsed.error));
  const vars = parsed.data;

  return {
    kind: 'run',
    override: resolveOverride(env, vars),
    settings: {
      providerCode: TBO_HOTELS_PROVIDER_CODE,
      destinationSourceProvider: PLATFORM_DESTINATION_PROVIDER,
      countries: vars.TBO_SYNC_COUNTRIES,
      ...(vars.TBO_SYNC_CITIES === undefined ? {} : { cities: vars.TBO_SYNC_CITIES }),
      stages: new Set(vars.TBO_SYNC_STAGES),
      maxCalls: vars.TBO_SYNC_MAX_CALLS,
      maxDurationMs: vars.TBO_SYNC_MAX_MINUTES * 60_000,
      sweepMaxDrop: vars.TBO_SYNC_SWEEP_MAX_DROP,
      maxConsecutiveThrottled: vars.TBO_SYNC_MAX_CONSECUTIVE_429,
      maxConsecutiveErrors: vars.TBO_SYNC_MAX_CONSECUTIVE_ERRORS,
      cadence: {
        demandMaxAgeMs: vars.TBO_SYNC_DEMAND_REFRESH_HOURS * HOUR_MS,
        regularMaxAgeMs: vars.TBO_SYNC_REFRESH_DAYS * DAY_MS,
        emptyMaxAgeMs: vars.TBO_SYNC_EMPTY_REFRESH_DAYS * DAY_MS,
        demandWindowMs: vars.TBO_SYNC_DEMAND_WINDOW_DAYS * DAY_MS,
      },
      content: {
        scope: vars.TBO_SYNC_CONTENT_SCOPE,
        demandLangs: contentLanguages(vars.TBO_SYNC_LANGS),
        regularLangs: contentLanguages(vars.TBO_SYNC_LANGS_REGULAR),
        batchSize: vars.TBO_SYNC_DETAILS_BATCH,
        maxAgeMs: vars.TBO_SYNC_CONTENT_REFRESH_DAYS * DAY_MS,
      },
    },
    client: {
      requestsPerSecond: vars.TBO_SYNC_RPS,
      detailedCityHotels: vars.TBO_SYNC_DETAILED_RESPONSE,
      codelistTimeoutMs: vars.TBO_SYNC_CODELIST_TIMEOUT_MS,
    },
  };
}
