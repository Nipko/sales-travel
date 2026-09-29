import { inspect } from 'node:util';
import { z } from 'zod';
import { SeedConfigError } from './errors.js';

export type SeedEnv = Readonly<Record<string, string | undefined>>;

export const SEED_DEFAULTS = Object.freeze({
  // El slug del nodo de Planetour en producción, el que 0049 promueve.
  tenantSlug: 'platform',
  // Sólo se usan si el seed CREA la plataforma (una base nueva). A una que ya existe no se le tocan.
  country: 'CO',
  currency: 'USD',
});

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

export interface SeedSettings {
  readonly superadmin: {
    readonly email: string;
    /**
     * Sólo para CREAR el usuario. A uno que ya existe no se le cambia ni el nombre ni la contraseña:
     * darle el rol no es tomarle la cuenta.
     */
    readonly name: string | undefined;
    readonly password: SeedSecret | undefined;
  };
  readonly tenant: {
    readonly slug: string;
    /**
     * Sólo para CREAR la plataforma en una base que no la tiene. A un tenant que ya existe no se le
     * cambia el nombre (G-04: el seed viejo renombraba "Planetour S.A.S" a "Platform").
     */
    readonly name: string | undefined;
    readonly countryCode: string;
    readonly currency: string;
  };
}

const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

function optional<T extends z.ZodTypeAny>(schema: T): z.ZodEffects<z.ZodOptional<T>> {
  return z.preprocess(blankToUndefined, schema.optional());
}

const SeedEnvSchema = z.object({
  PGHOST: z.string().min(1),
  PGUSER: z.string().min(1),
  PGPASSWORD: z.string().min(1),
  // Sin ella, `pg` iría a la base con el nombre del usuario (`postgres`) y fallaría con un "relation
  // tenants does not exist" que no dice qué falta.
  PGDATABASE: z.string().min(1),
  SUPERADMIN_EMAIL: z.string().trim().toLowerCase().email().max(254),
  // Sin `trim()`: un espacio puede ser parte de la contraseña.
  SUPERADMIN_PASSWORD: optional(
    z
      .string()
      .min(12)
      .refine((value) => Buffer.byteLength(value, 'utf8') <= BCRYPT_MAX_BYTES, {
        params: { reason: 'longer_than_72_bytes' },
      }),
  ),
  SUPERADMIN_NAME: optional(z.string().trim().min(1).max(120)),
  // La regla de slug del alta de nodos del api (apps/api/src/tenants/dto.ts).
  SUPERADMIN_TENANT_SLUG: optional(
    z
      .string()
      .trim()
      .toLowerCase()
      .min(2)
      .max(50)
      .regex(/^[a-z0-9-]+$/),
  ),
  SUPERADMIN_TENANT_NAME: optional(z.string().trim().min(2).max(120)),
  SUPERADMIN_TENANT_COUNTRY: optional(z.string().regex(/^[A-Z]{2}$/)),
  SUPERADMIN_TENANT_CURRENCY: optional(z.string().regex(/^[A-Z]{3}$/)),
});

/** `VARIABLE:código`. Nunca `issue.message`: algunos códigos de Zod repiten el valor recibido. */
function issueRef(issue: z.ZodIssue): string {
  const name = issue.path.length > 0 ? issue.path.join('.') : '<root>';
  const reason: unknown =
    issue.code === z.ZodIssueCode.custom ? issue.params?.['reason'] : undefined;
  return `${name}:${typeof reason === 'string' ? reason : issue.code}`;
}

/**
 * Valida el entorno del contenedor y arma la configuración del seed.
 *
 * `SUPERADMIN_PASSWORD`, `SUPERADMIN_NAME` y `SUPERADMIN_TENANT_NAME` son opcionales aquí: sólo
 * hacen falta si el usuario o el tenant no existen, y eso lo decide el seed al leer la base.
 *
 * @throws SeedConfigError con cada variable inválida, por nombre.
 */
export function resolveSeedEnv(env: SeedEnv): SeedSettings {
  const parsed = SeedEnvSchema.safeParse(env);
  if (!parsed.success) throw new SeedConfigError(parsed.error.issues.map(issueRef));
  const e = parsed.data;
  return {
    superadmin: {
      email: e.SUPERADMIN_EMAIL,
      name: e.SUPERADMIN_NAME,
      password:
        e.SUPERADMIN_PASSWORD === undefined ? undefined : new SeedSecret(e.SUPERADMIN_PASSWORD),
    },
    tenant: {
      slug: e.SUPERADMIN_TENANT_SLUG ?? SEED_DEFAULTS.tenantSlug,
      name: e.SUPERADMIN_TENANT_NAME,
      countryCode: e.SUPERADMIN_TENANT_COUNTRY ?? SEED_DEFAULTS.country,
      currency: e.SUPERADMIN_TENANT_CURRENCY ?? SEED_DEFAULTS.currency,
    },
  };
}
