import { z } from 'zod';
import { SabreConfigError } from './errors';

/**
 * Hosts por entorno.
 *
 * REST: VERIFICADO-SPEC — CERT en `booking-management-v1.yml:12`, PROD en `offer-price-ndc-v1.yml:15`
 * y `get-seats-agency-3.0.yml:101`. SOAP: CERT verificado en la colección; PROD sigue siendo
 * inferencia porque no existe contrato del carril SOAP (docs/sabre/01 §3.2).
 */
export const SABRE_HOSTS = {
  cert: {
    rest: 'https://api.cert.platform.sabre.com',
    soap: 'https://webservices.cert.platform.sabre.com',
  },
  prod: {
    rest: 'https://api.platform.sabre.com',
    soap: 'https://webservices.platform.sabre.com',
  },
} as const;

export type SabreEnvironment = keyof typeof SABRE_HOSTS;

/** El literal `AA` del `clientId` REST (`V1:{epr}:{pcc}:AA`) — docs/sabre/01 §2.1. */
export const SABRE_DEFAULT_DOMAIN = 'AA';

/** El `Domain` del `UsernameToken` SOAP es `DEFAULT` en 66 de 73 `SessionCreateRQ` — docs/sabre/01 §4.3. */
export const SABRE_DEFAULT_SOAP_DOMAIN = 'DEFAULT';

/** Único endpoint de token ejercitado y contratado: los 21 specs apuntan a v2 (docs/sabre/01 §2.2). */
export const SABRE_AUTH_PATH = '/v2/auth/token';

/**
 * Fallback de vida del token. Sabre **no documenta** `expires_in` en ningún contrato
 * (docs/sabre/01 §7.1): si la respuesta no lo trae, se usa este valor y se emite un warning
 * estructurado — nunca un silencio (RF-01 CA-3).
 */
export const SABRE_DEFAULT_TOKEN_TTL_SECONDS = 3600;

/** Margen sobre el TTL declarado por Sabre: 10 % (RF-01 CA-3). */
export const SABRE_TOKEN_TTL_MARGIN = 0.9;

export const SABRE_DEFAULT_CONVERSATION_ID_PREFIX = 'sales-travel';

export const SABRE_DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * El límite de Sabre es de CONCURRENCIA, no de TPS ("Active token count is exceeded",
 * `help/errors.txt`). El valor real lo fija el contrato con Sabre; éste es sólo un default
 * defensivo (RNF-04).
 */
export const SABRE_DEFAULT_MAX_CONCURRENT_REQUESTS = 4;

/**
 * Configuración runtime del ACL de Sabre. Se compone de dos mitades que viven separadas en
 * `provider_accounts`: `credentials` cifradas (`epr`, `password`) y `config` en claro (todo lo
 * demás). El factory de `apps/api` las une, igual que `latam-ndc.factory.ts` (docs/sabre/01 §8).
 *
 * `homePcc` NO es secreto —se imprime en el billete— pero entra en el `clientId` del token, por
 * eso viaja aquí junto a las credenciales.
 */
export interface SabreConfig {
  /** Base REST sin barra final, p.ej. `https://api.cert.platform.sabre.com`. */
  host: string;
  soapHost?: string;
  environment?: SabreEnvironment;
  epr?: string;
  password?: string;
  homePcc?: string;
  /** PCC de emisión → `targetPcc`. Campo bisagra del modelo consolidador (docs/sabre/01 §9). */
  ticketingPcc?: string;
  agencyIata?: string;
  /** Default `AA`. Configurable por la incoherencia AA/DEFAULT de docs/sabre/01 §4.3. */
  domain?: string;
  soapDomain?: string;
  conversationIdPrefix?: string;
  /** Header `Application-ID`, recomendado por Sabre en hotel/vehicle. Lo asigna el account manager. */
  applicationId?: string;
  /** Header `X-Sabre-Group` (carril ATK). Obligatorio cuando el body lleva `targetPcc`. */
  sabreGroup?: string;
  /** Header `X-Sabre-Current-City` (carril ATH). Obligatorio cuando el body lleva `targetPcc`. */
  sabreCurrentCity?: string;
  tokenTtlSeconds?: number;
  maxConcurrentRequests?: number;
  requestTimeoutMs?: number;
  /** Forzar modo mock incluso con credenciales presentes. */
  mock?: boolean;
}

/**
 * Zod en el borde: la config llega de `provider_accounts` (JSONB + blob descifrado) o de env,
 * ninguna de las dos es de fiar sin validar.
 */
export const SabreConfigSchema = z.object({
  host: z.string().url(),
  soapHost: z.string().url().optional(),
  environment: z.enum(['cert', 'prod']).optional(),
  epr: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  homePcc: z.string().min(3).max(4).optional(),
  ticketingPcc: z.string().min(3).max(4).optional(),
  agencyIata: z.string().min(1).optional(),
  domain: z.string().min(1).default(SABRE_DEFAULT_DOMAIN),
  soapDomain: z.string().min(1).default(SABRE_DEFAULT_SOAP_DOMAIN),
  conversationIdPrefix: z.string().min(1).default(SABRE_DEFAULT_CONVERSATION_ID_PREFIX),
  applicationId: z.string().min(1).optional(),
  sabreGroup: z.string().min(3).max(4).optional(),
  sabreCurrentCity: z.string().min(3).max(4).optional(),
  tokenTtlSeconds: z.number().int().positive().default(SABRE_DEFAULT_TOKEN_TTL_SECONDS),
  maxConcurrentRequests: z.number().int().positive().default(SABRE_DEFAULT_MAX_CONCURRENT_REQUESTS),
  requestTimeoutMs: z.number().int().positive().default(SABRE_DEFAULT_REQUEST_TIMEOUT_MS),
  mock: z.boolean().optional(),
});

type _AssertSchemaMatchesInterface =
  z.infer<typeof SabreConfigSchema> extends SabreConfig ? true : never;

/**
 * Valida y normaliza config externa.
 *
 * El mensaje de error se construye **sólo con la ruta y el código del issue de Zod**: nunca con
 * `issue.message`, que en algunos códigos incluye el valor recibido. Un `password` inválido no
 * puede acabar en un stack trace (RNF-07).
 */
export function parseSabreConfig(input: unknown): SabreConfig {
  const parsed = SabreConfigSchema.safeParse(input);
  if (parsed.success) {
    return { ...parsed.data, host: parsed.data.host.replace(/\/+$/, '') };
  }
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}:${issue.code}`)
    .join(', ');
  throw new SabreConfigError(`config de Sabre inválida (${detail})`);
}

/** Las tres credenciales que construyen el `clientId` del token. Sin una sola, no hay ATK. */
const REQUIRED_CREDENTIAL_FIELDS = ['epr', 'password', 'homePcc'] as const;

/**
 * Nombres —nunca valores— de las credenciales que faltan. Sirve para el log estructurado y para
 * el mensaje del panel BYOC.
 */
export function missingSabreCredentials(cfg: SabreConfig): readonly string[] {
  return REQUIRED_CREDENTIAL_FIELDS.filter((field) => {
    const value = cfg[field];
    return typeof value !== 'string' || value.length === 0;
  });
}

/**
 * Modo mock: sin `epr`, `password` u `homePcc` no se puede derivar el `secret`, así que el
 * adapter devuelve fixtures en vez de fallar. Es lo que permite que CI y dev corran sin
 * credenciales de Sabre (docs/sabre/11 §6.4).
 */
export function isMockMode(cfg: SabreConfig): boolean {
  if (cfg.mock === true) return true;
  return missingSabreCredentials(cfg).length > 0;
}

export function sabreDomain(cfg: SabreConfig): string {
  return cfg.domain ?? SABRE_DEFAULT_DOMAIN;
}

export function sabreTokenTtlSeconds(cfg: SabreConfig): number {
  return cfg.tokenTtlSeconds ?? SABRE_DEFAULT_TOKEN_TTL_SECONDS;
}

export function sabreRequestTimeoutMs(cfg: SabreConfig): number {
  return cfg.requestTimeoutMs ?? SABRE_DEFAULT_REQUEST_TIMEOUT_MS;
}

export function sabreConversationIdPrefix(cfg: SabreConfig): string {
  return cfg.conversationIdPrefix ?? SABRE_DEFAULT_CONVERSATION_ID_PREFIX;
}

/** Une host y path sin duplicar ni perder la barra. */
export function sabreUrl(cfg: SabreConfig, path: string): string {
  const base = cfg.host.replace(/\/+$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}
