import { inspect } from 'node:util';
import {
  TBO_BASE_URLS,
  TBO_TEST_HOST,
  TboConfigError,
  TboCredentialsMissingError,
  parseTboConfig,
  requireUsableTboConfig,
} from '@sales-travel/tbo-hotels';
import { z } from 'zod';
import { parseMasterKey } from './crypto.js';
import { SeedConfigError } from './errors.js';

export type SeedEnv = Readonly<Record<string, string | undefined>>;

/** Slug del tenant raíz de certificación (docs/tbo/07 §7.3). No se configura: es el contrato. */
export const CERT_TENANT_SLUG = 'tbo-cert';

/** La base de docker-compose.cert.yml. El seed no siembra ninguna otra (ver `runSeed`). */
export const CERT_DATABASE = 'sales_travel_cert';

/**
 * Lo que el seed lee además de las `PG*` y `PROVIDER_CREDENTIALS_KEY`. Cada una tiene que estar en
 * `SEED_ENV` de infrastructure/hostinger/render-cert-env.mjs y en el paso "Render .env" del job
 * `deploy-cert`: `stack-contract.test.ts` lo comprueba, porque una que falte llega vacía y el seed
 * usaría su valor por defecto sin avisar.
 */
export const SEED_ENV_VARIABLES: readonly string[] = Object.freeze([
  'CERT_TBO_USERNAME',
  'CERT_TBO_PASSWORD',
  'CERT_TBO_BASE_URL',
  'CERT_VENDEDOR_EMAIL',
  'CERT_VENDEDOR_PASSWORD',
  'CERT_VENDEDOR_NAME',
  'CERT_VENDEDOR_STATUS',
  'CERT_TENANT_NAME',
  'CERT_COUNTRY',
  'CERT_CURRENCY',
  'CERT_SUPPORT_EMAIL',
  'CERT_SUPPORT_PHONE',
  'CERT_WALLET_BALANCE',
  'CERT_HOTEL_MARKUP_PERCENT',
]);

/** Las que sólo pueden venir de un secret de GitHub, nunca de una variable. */
export const SEED_SECRET_VARIABLES: readonly string[] = Object.freeze([
  'CERT_TBO_USERNAME',
  'CERT_TBO_PASSWORD',
  'CERT_VENDEDOR_PASSWORD',
]);

export const SEED_DEFAULTS = Object.freeze({
  // Buzón de rol del dominio propio: el stack no envía correo, sólo es el nombre de usuario.
  vendedorEmail: 'tbo.tester@planetour.cloud',
  vendedorName: 'TBO Tester',
  // Nombre neutro (07 §7.3.1): el white-label no imita a ninguna agencia real.
  tenantName: 'Sales-Travel Certification',
  country: 'CO',
  // Contacto operativo de la agencia: sin él el Book se rechaza (D-TBO-23 A), y viaja a TBO en
  // `EmailId` y `PhoneNumber`. Buzón de rol del dominio propio, nunca el de una persona. El
  // teléfono es de la franja 555-0100 a 555-0199, que NANPA reserva para ficción: no es de nadie.
  supportEmail: 'reservas.cert@planetour.cloud',
  supportPhone: '+1 202 555 0100',
  // La moneda de perfil de la cuenta de test de TBO no se conoce hasta correr `check` (Q-82).
  // La cartera tiene que estar en la moneda de la reserva o la retención la rechaza.
  currency: 'USD',
  walletBalanceMajor: 50_000,
  hotelMarkupPercent: 5,
});

/**
 * Monedas ISO 4217 sin dos decimales. `Money` asume dos (packages/canonical/src/money.ts) y la
 * cartera guarda unidades menores: con una de estas el saldo quedaría multiplicado o dividido.
 */
const NOT_TWO_DECIMALS = new Set([
  'BHD',
  'BIF',
  'CLF',
  'CLP',
  'DJF',
  'GNF',
  'IQD',
  'ISK',
  'JOD',
  'JPY',
  'KMF',
  'KRW',
  'KWD',
  'LYD',
  'OMR',
  'PYG',
  'RWF',
  'TND',
  'UGX',
  'UYI',
  'UYW',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);

/** Lo que un teléfono escrito a mano puede traer además de dígitos, como lo limpia el api. */
const PHONE_SEPARATORS = /[\s().-]/g;

/**
 * La regla del contacto del Book (`parseInternationalPhone`, apps/api/src/hotels/
 * hotel-booking-contact.ts): `+`, prefijo de país y de 7 a 15 dígitos en total. Sin `+` el api no
 * sabe de qué país es y rechaza la reserva. `support-contact.contract.test.ts` la compara con la
 * del api.
 */
export function isInternationalPhone(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('+')) return false;
  return /^[1-9]\d{6,14}$/.test(trimmed.slice(1).replace(PHONE_SEPARATORS, ''));
}

/** bcrypt ignora lo que pasa de 72 bytes: una contraseña más larga valdría igual que su prefijo. */
const BCRYPT_MAX_BYTES = 72;

const REDACTED = '[redacted]';

/** Un secreto que ninguna serialización vuelca: JSON, `String()` ni `util.inspect`. */
export class SeedSecret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return `SeedSecret(${REDACTED})`;
  }
}

export type VendedorStatus = 'active' | 'suspended';

export interface SeedSettings {
  readonly database: {
    /** `current_database()` que se exige antes de escribir nada. */
    readonly expectedName: string;
    /**
     * La base es SÓLO del stack de certificación: se exige además que no haya cuentas de otros
     * proveedores en ningún tenant (07 §7.3.3). Los tests de integración, que comparten la base
     * del CI con los de `apps/api`, lo apagan.
     */
    readonly dedicated: boolean;
  };
  readonly tenant: {
    readonly slug: string;
    readonly name: string;
    readonly countryCode: string;
    readonly currency: string;
    /**
     * `tenants.support_email` y `support_phone`: el contacto operativo que el Book exige y manda
     * a TBO (docs/tbo/03 §3.5; D-TBO-23 A). El `vendedor` no los puede cargar desde el panel.
     */
    readonly supportEmail: string;
    readonly supportPhone: string;
  };
  readonly vendedor: {
    readonly email: string;
    readonly password: SeedSecret;
    readonly name: string;
    readonly status: VendedorStatus;
  };
  readonly tboAccount: {
    readonly username: SeedSecret;
    readonly password: SeedSecret;
    /** Siempre `test`: este stack nunca guarda una cuenta live. */
    readonly environment: 'test';
    readonly baseUrl: string;
  };
  readonly wallet: { readonly balanceMinor: number };
  /** Porcentaje × 100, como `markup_rules.value_minor` (5 % = 500). */
  readonly hotelMarkupBasisPoints: number;
  readonly credentialsKey: Buffer;
}

const blankToUndefined = (value: unknown): unknown => (value === '' ? undefined : value);

function optional<T extends z.ZodTypeAny>(schema: T): z.ZodEffects<z.ZodOptional<T>> {
  return z.preprocess(blankToUndefined, schema.optional());
}

const SeedEnvSchema = z.object({
  PGHOST: z.string().min(1),
  PGUSER: z.string().min(1),
  PGPASSWORD: z.string().min(1),
  PROVIDER_CREDENTIALS_KEY: z.string().refine((raw) => parseMasterKey(raw) !== undefined, {
    params: { reason: 'not_base64_32_bytes' },
  }),
  // Sin `trim()`: TBO no recorta la contraseña y un espacio puede ser parte de ella.
  CERT_TBO_USERNAME: z.string().min(1),
  CERT_TBO_PASSWORD: z.string().min(1),
  CERT_TBO_BASE_URL: optional(z.string().url()),
  CERT_VENDEDOR_EMAIL: optional(z.string().trim().toLowerCase().email().max(254)),
  CERT_VENDEDOR_PASSWORD: z
    .string()
    .min(12)
    .refine((value) => Buffer.byteLength(value, 'utf8') <= BCRYPT_MAX_BYTES, {
      params: { reason: 'longer_than_72_bytes' },
    }),
  CERT_VENDEDOR_NAME: optional(z.string().trim().min(1).max(120)),
  CERT_VENDEDOR_STATUS: optional(z.enum(['active', 'suspended'])),
  CERT_TENANT_NAME: optional(z.string().trim().min(1).max(120)),
  CERT_COUNTRY: optional(z.string().regex(/^[A-Z]{2}$/)),
  CERT_CURRENCY: optional(
    z
      .string()
      .regex(/^[A-Z]{3}$/)
      .refine((code) => !NOT_TWO_DECIMALS.has(code), { params: { reason: 'not_two_decimals' } }),
  ),
  // Los topes son los de _Mi Agencia_ (apps/api/src/tenants/branding.schemas.ts): un administrador
  // del stack puede guardar la marca del tenant sin tener que corregir lo que dejó el seed.
  CERT_SUPPORT_EMAIL: optional(z.string().trim().toLowerCase().email().max(160)),
  CERT_SUPPORT_PHONE: optional(
    z
      .string()
      .trim()
      .max(40)
      .refine(isInternationalPhone, { params: { reason: 'not_international' } }),
  ),
  // Unidades mayores, entero: el saldo es ficticio y no necesita centavos.
  CERT_WALLET_BALANCE: optional(z.string().regex(/^[1-9]\d{0,8}$/)),
  // Hasta dos decimales, mayor que 0 y como mucho 50 %.
  CERT_HOTEL_MARKUP_PERCENT: optional(
    z
      .string()
      .regex(/^\d{1,2}(\.\d{1,2})?$/)
      .refine((raw) => Number(raw) > 0 && Number(raw) <= 50, {
        params: { reason: 'out_of_range' },
      }),
  ),
});

/** `VARIABLE:código`. Nunca `issue.message`: algunos códigos de Zod repiten el valor recibido. */
function issueRef(issue: z.ZodIssue): string {
  const name = issue.path.length > 0 ? issue.path.join('.') : '<root>';
  const reason: unknown =
    issue.code === z.ZodIssueCode.custom ? issue.params?.['reason'] : undefined;
  return `${name}:${typeof reason === 'string' ? reason : issue.code}`;
}

/** Nombre del campo en la config del ACL → la variable que lo trae. */
const TBO_FIELD_TO_VARIABLE: Readonly<Record<string, string>> = {
  username: 'CERT_TBO_USERNAME',
  password: 'CERT_TBO_PASSWORD',
  baseUrl: 'CERT_TBO_BASE_URL',
};

function tboIssue(issue: string): string {
  const [field = '', ...rest] = issue.split(':');
  return `${TBO_FIELD_TO_VARIABLE[field] ?? `CERT_TBO_${field}`}:${rest.join(':') || 'invalid'}`;
}

/**
 * La cuenta pasa por las MISMAS reglas que el factory del api (`parseTboConfig` y la última puerta
 * `requireUsableTboConfig` del ACL): una que el api fuera a rechazar no se siembra.
 *
 * Además el host tiene que ser el de test de TBO. Este stack lo prueba un tercero con una cuenta
 * que no es la nuestra en producción; una credencial live aquí sería una reserva real.
 */
function tboAccountOf(
  username: string,
  password: string,
  rawBaseUrl: string | undefined,
  issues: string[],
): SeedSettings['tboAccount'] | undefined {
  let baseUrl: string;
  try {
    const usable = requireUsableTboConfig(
      parseTboConfig({
        environment: 'test',
        baseUrl: rawBaseUrl ?? TBO_BASE_URLS.test,
        username,
        password,
      }),
    );
    baseUrl = usable.baseUrl;
  } catch (err) {
    if (err instanceof TboConfigError) {
      issues.push(...err.issues.map(tboIssue));
      return undefined;
    }
    if (err instanceof TboCredentialsMissingError) {
      issues.push(...err.missing.map((field) => tboIssue(`${field}:required`)));
      return undefined;
    }
    throw err;
  }
  if (new URL(baseUrl).host !== TBO_TEST_HOST) {
    issues.push('CERT_TBO_BASE_URL:not_tbo_test_host');
    return undefined;
  }
  return {
    username: new SeedSecret(username),
    password: new SeedSecret(password),
    environment: 'test',
    baseUrl,
  };
}

/**
 * Valida el entorno del contenedor y arma la configuración del seed.
 *
 * @throws SeedConfigError con cada variable inválida, por nombre.
 */
export function resolveSeedEnv(env: SeedEnv): SeedSettings {
  const parsed = SeedEnvSchema.safeParse(env);
  if (!parsed.success) throw new SeedConfigError(parsed.error.issues.map(issueRef));
  const e = parsed.data;

  const issues: string[] = [];
  const tboAccount = tboAccountOf(
    e.CERT_TBO_USERNAME,
    e.CERT_TBO_PASSWORD,
    e.CERT_TBO_BASE_URL,
    issues,
  );
  // Ya pasó el `refine` del esquema; se vuelve a leer para tener los bytes.
  const credentialsKey = parseMasterKey(e.PROVIDER_CREDENTIALS_KEY);
  if (credentialsKey === undefined) issues.push('PROVIDER_CREDENTIALS_KEY:not_base64_32_bytes');
  if (tboAccount === undefined || credentialsKey === undefined) {
    throw new SeedConfigError(issues);
  }

  const balanceMajor =
    e.CERT_WALLET_BALANCE === undefined
      ? SEED_DEFAULTS.walletBalanceMajor
      : Number(e.CERT_WALLET_BALANCE);
  const markupPercent =
    e.CERT_HOTEL_MARKUP_PERCENT === undefined
      ? SEED_DEFAULTS.hotelMarkupPercent
      : Number(e.CERT_HOTEL_MARKUP_PERCENT);

  return {
    database: { expectedName: CERT_DATABASE, dedicated: true },
    tenant: {
      slug: CERT_TENANT_SLUG,
      name: e.CERT_TENANT_NAME ?? SEED_DEFAULTS.tenantName,
      countryCode: e.CERT_COUNTRY ?? SEED_DEFAULTS.country,
      currency: e.CERT_CURRENCY ?? SEED_DEFAULTS.currency,
      supportEmail: e.CERT_SUPPORT_EMAIL ?? SEED_DEFAULTS.supportEmail,
      supportPhone: e.CERT_SUPPORT_PHONE ?? SEED_DEFAULTS.supportPhone,
    },
    vendedor: {
      email: e.CERT_VENDEDOR_EMAIL ?? SEED_DEFAULTS.vendedorEmail,
      password: new SeedSecret(e.CERT_VENDEDOR_PASSWORD),
      name: e.CERT_VENDEDOR_NAME ?? SEED_DEFAULTS.vendedorName,
      status: e.CERT_VENDEDOR_STATUS ?? 'active',
    },
    tboAccount,
    wallet: { balanceMinor: balanceMajor * 100 },
    hotelMarkupBasisPoints: Math.round(markupPercent * 100),
    credentialsKey,
  };
}
