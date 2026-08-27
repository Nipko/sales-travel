/**
 * Reglas DECLARADAS por proveedor para las cuentas BYOC: qué campos necesita una cuenta para
 * poder autenticar, dónde puede viajar cada uno, y qué claves de `config` es seguro devolver
 * por el listado.
 *
 * Vive en un módulo aparte y como TABLA a propósito. El borde real del API (`dto.ts`) no puede
 * volverse una cadena de `if (providerCode === 'sabre')`: un proveedor nuevo se agrega acá y no
 * se toca nada más. Y el mismo dato sirve para las dos preguntas —qué se exige al entrar y qué
 * se echa de vuelta al salir—, así que no pueden divergir.
 *
 * Un proveedor SIN entrada acá se sigue aceptando **exactamente como hasta hoy**: no se inventan
 * requisitos que nadie verificó contra su ACL. A cambio, tampoco se afirma nada sobre él (ver
 * `safeConfigView` y `accountReadiness`).
 */

/** De dónde puede venir el valor de un campo. */
export type FieldOrigin =
  /**
   * Sólo del blob CIFRADO. En `config` es un error: `config` es un JSONB que se guarda en claro
   * y que además se devuelve por el listado.
   */
  | 'encrypted-only'
  /** Del blob cifrado o de `config`, porque es lo que el factory del proveedor lee hoy. */
  | 'encrypted-or-config';

export interface ProviderFieldRule {
  readonly key: string;
  readonly origin: FieldOrigin;
  /**
   * POR QUÉ el campo importa. Viaja LITERAL al 400: es lo único que va a leer quien carga la
   * cuenta por API, que es como se cargan hoy. "campo requerido" no le dice nada.
   */
  readonly reason: string;
  readonly required?: boolean;
  readonly minLength?: number;
  readonly maxLength?: number;
}

export interface ProviderSpec {
  readonly label: string;
  /**
   * Forma de la cuenta. `undefined` = no se declaró: no se exige nada y no se sabe si una
   * cuenta guardada está completa.
   */
  readonly fields?: readonly ProviderFieldRule[];
  /**
   * Claves de `config` cuyo VALOR es seguro devolver por el listado. `undefined` = no se
   * declararon: no se devuelve ningún valor de `config`, sólo los nombres de las claves.
   */
  readonly safeConfigKeys?: readonly string[];
  /**
   * Clave de `config` que, puesta en `true`, declara la cuenta como simulada. Una cuenta así no
   * autentica contra nadie, así que las reglas de obligatoriedad no aplican.
   */
  readonly mockConfigKey?: string;
}

/**
 * Sabre. Los tres obligatorios son los mismos que `missingSabreCredentials` exige en el ACL
 * (`providers/sabre/src/config.ts`): sin uno solo de ellos no hay `clientId` y por tanto no hay
 * token. Hoy la cuenta se guardaba igual, la búsqueda caía a fixtures, el factory lo detectaba y
 * dejaba a Sabre AUSENTE — sin error para nadie.
 *
 * `password` es `encrypted-only`: el factory se niega a leerla de `config`, y esta regla cierra
 * la misma puerta un paso antes, al guardar.
 *
 * `epr` es `encrypted-or-config` porque `SabreProviderFactory.toConfig` lo acepta de ambos
 * sitios, y el DTO no puede rechazar una forma que el sistema sí honra. Pero NO está en
 * `safeConfigKeys`: el EPR es el usuario de la oficina, la mitad de la credencial que acompaña a
 * la contraseña, y devolverlo al navegador no aporta nada que compense.
 *
 * Los límites de 3–4 de los PCC son los de `SabreConfigSchema`: fuera de rango, `parseSabreConfig`
 * lanza en la primera búsqueda y no al guardar.
 */
const SABRE: ProviderSpec = {
  label: 'Sabre',
  mockConfigKey: 'mock',
  fields: [
    {
      key: 'epr',
      origin: 'encrypted-or-config',
      required: true,
      reason:
        'Falta `epr` (usuario de la oficina). Sabre arma el clientId como V1:{EPR}:{PCC}:AA, así que sin EPR no se puede pedir el token y la cuenta queda inservible.',
    },
    {
      key: 'password',
      origin: 'encrypted-only',
      required: true,
      reason:
        'Falta `password`. Es el secreto con el que se firma la petición del token; sin ella la cuenta se guarda pero nunca autentica.',
    },
    {
      key: 'homePcc',
      origin: 'encrypted-or-config',
      required: true,
      minLength: 3,
      maxLength: 4,
      reason:
        'Falta `homePcc` (PCC de la oficina). Va DENTRO del clientId del que se deriva el token (V1:{EPR}:{PCC}:AA), así que sin él no hay autenticación posible: la cuenta se guarda, Sabre desaparece de las búsquedas y nadie ve un error.',
    },
    {
      key: 'ticketingPcc',
      origin: 'encrypted-or-config',
      minLength: 3,
      maxLength: 4,
      reason:
        'El PCC de emisión es un pseudo-city de 3 o 4 caracteres. Fuera de rango, la cuenta se guarda y revienta en la primera búsqueda.',
    },
    {
      key: 'sabreGroup',
      origin: 'encrypted-or-config',
      minLength: 3,
      maxLength: 4,
      reason:
        'X-Sabre-Group es un pseudo-city de 3 o 4 caracteres. Fuera de rango, la cuenta se guarda y revienta en la primera búsqueda.',
    },
    {
      key: 'sabreCurrentCity',
      origin: 'encrypted-or-config',
      minLength: 3,
      maxLength: 4,
      reason:
        'X-Sabre-Current-City es un pseudo-city de 3 o 4 caracteres. Fuera de rango, la cuenta se guarda y revienta en la primera búsqueda.',
    },
  ],
  safeConfigKeys: [
    'environment',
    'host',
    'soapHost',
    'agencyIata',
    'domain',
    'applicationId',
    'sabreGroup',
    'sabreCurrentCity',
    'homePcc',
    'ticketingPcc',
    'callPolicy',
    'allowCardBinPricing',
    'mock',
  ],
};

/**
 * Los proveedores que YA guardan cuentas declaran sólo su lista blanca de `config`, sin reglas
 * de obligatoriedad.
 *
 * No es pereza: exigir campos que no se verificaron contra cada ACL rechazaría cuentas que hoy
 * funcionan, y la tanda entera trata justo de no afirmar lo que no se puede sostener. Las claves
 * de abajo salen de leer qué lee cada factory de `config` — todas no secretas.
 */
const LATAM_NDC: ProviderSpec = {
  label: 'LATAM NDC',
  safeConfigKeys: [
    'apiUrl',
    'agencyId',
    'agencyIata',
    'agencyName',
    'travelAgentId',
    'country',
    'accountCode',
    'mock',
  ],
};

const AGENT_CARS: ProviderSpec = {
  label: 'AgentCars',
  safeConfigKeys: ['baseUrl', 'suggestUrl', 'sourceCountry', 'language'],
};

const DESPEGAR_HOTELS: ProviderSpec = {
  label: 'Despegar Hotels',
  safeConfigKeys: ['baseUrl', 'language', 'countryCode', 'currency', 'locale'],
};

/** BYO-email. `host`/`port`/`secure`/`from*` son datos de servidor; usuario y clave van cifrados. */
const EMAIL: ProviderSpec = {
  label: 'Email (SMTP)',
  safeConfigKeys: ['host', 'port', 'secure', 'fromEmail', 'fromName'],
};

export const PROVIDER_SPECS: Readonly<Record<string, ProviderSpec>> = {
  sabre: SABRE,
  'latam-ndc': LATAM_NDC,
  'agent-cars': AGENT_CARS,
  'despegar-hotels': DESPEGAR_HOTELS,
  email: EMAIL,
};

export function providerSpecFor(code: string): ProviderSpec | undefined {
  return PROVIDER_SPECS[code];
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export interface ProviderAccountIssue {
  /** Ruta dentro del cuerpo del POST, tal cual la espera Zod. */
  readonly path: readonly ['credentials' | 'config', string];
  readonly message: string;
}

/** ¿Esta cuenta se declaró simulada? Una cuenta simulada no autentica contra nadie. */
function isSimulated(spec: ProviderSpec, config: Record<string, unknown>): boolean {
  return spec.mockConfigKey !== undefined && config[spec.mockConfigKey] === true;
}

/**
 * Lo que está mal en una cuenta según las reglas DECLARADAS de su proveedor.
 *
 * Devuelve lista vacía cuando el proveedor no declara `fields`: aceptar como hoy es la respuesta
 * correcta ahí, no inventar requisitos.
 */
export function providerAccountIssues(input: {
  providerCode: string;
  credentials: Record<string, unknown>;
  config?: Record<string, unknown> | undefined;
}): readonly ProviderAccountIssue[] {
  const spec = providerSpecFor(input.providerCode);
  if (!spec?.fields) return [];

  const config = input.config ?? {};
  const simulated = isSimulated(spec, config);
  const issues: ProviderAccountIssue[] = [];

  for (const rule of spec.fields) {
    // Un secreto en `config` es un error incluso si además vino cifrado: `config` se persiste en
    // claro y se devuelve por el listado, así que basta con que ESTÉ ahí para que ya se filtró.
    if (rule.origin === 'encrypted-only' && rule.key in config) {
      issues.push({
        path: ['config', rule.key],
        message: `\`${rule.key}\` no puede viajar en \`config\`: config se guarda sin cifrar y se devuelve por el listado de cuentas. Mandalo dentro de \`credentials\`, que sí va cifrado.`,
      });
    }

    const fromCredentials = input.credentials[rule.key];
    const fromConfig = rule.origin === 'encrypted-or-config' ? config[rule.key] : undefined;
    const value = nonEmptyString(fromCredentials)
      ? fromCredentials.trim()
      : nonEmptyString(fromConfig)
        ? fromConfig.trim()
        : null;

    if (value === null) {
      // Sin valor sólo se protesta si el campo es obligatorio, y una cuenta declarada simulada
      // está exenta: no va a autenticar contra nada, y el factory la sirve marcada como tal.
      if (rule.required === true && !simulated) {
        issues.push({ path: ['credentials', rule.key], message: rule.reason });
      }
      continue;
    }

    const section = nonEmptyString(fromCredentials) ? 'credentials' : 'config';
    if (rule.minLength !== undefined && value.length < rule.minLength) {
      issues.push({
        path: [section, rule.key],
        message: `\`${rule.key}\` necesita al menos ${rule.minLength} caracteres. ${rule.reason}`,
      });
    } else if (rule.maxLength !== undefined && value.length > rule.maxLength) {
      issues.push({
        path: [section, rule.key],
        message: `\`${rule.key}\` admite como máximo ${rule.maxLength} caracteres. ${rule.reason}`,
      });
    }
  }

  return issues;
}

export interface SafeConfigView {
  /** Sólo las claves declaradas seguras, con su valor tal cual se guardó. */
  readonly config: Record<string, unknown>;
  /**
   * Nombres —NUNCA valores— de las claves de `config` que no se pudieron declarar seguras.
   * Es lo que permite que la pantalla diga "hay algo acá que no sé si puedo mostrar" en vez de
   * afirmar que la config está vacía.
   */
  readonly redactedConfigKeys: readonly string[];
  /** `false` cuando el proveedor no declara lista blanca: no se sabe qué es seguro mostrar. */
  readonly configVerified: boolean;
}

/**
 * Saneado de `config` para salir por el API.
 *
 * LISTA BLANCA por proveedor, no lista negra de nombres. Una lista negra (`/secret|password|
 * token/i`) protege exactamente contra los nombres que alguien pensó el día que la escribió: el
 * primer proveedor que llame a su secreto `epr`, `accountCode` o `apiKeyId` lo filtra, y nadie se
 * entera hasta que ya viajó. La lista blanca falla al revés: un campo nuevo no se muestra hasta
 * que alguien lo declara seguro. El coste del fallo es que la pantalla enseñe de menos —visible,
 * corregible con una línea— en vez de filtrar un secreto, que es irreversible.
 *
 * Y un proveedor SIN lista blanca no se trata como "todo seguro" ni como "no hay nada": se
 * devuelven los NOMBRES de sus claves con `configVerified: false`. Devolver `{}` a secas sería la
 * pantalla afirmando que la cuenta no tiene configuración, que es justo la clase de mentira que
 * esta tanda persigue.
 */
export function safeConfigView(
  providerCode: string,
  config: Record<string, unknown>,
): SafeConfigView {
  const allowed = providerSpecFor(providerCode)?.safeConfigKeys;
  const keys = Object.keys(config);

  if (!allowed) {
    return { config: {}, redactedConfigKeys: keys, configVerified: false };
  }

  const safe: Record<string, unknown> = {};
  const redacted: string[] = [];
  for (const key of keys) {
    if (allowed.includes(key)) safe[key] = config[key];
    else redacted.push(key);
  }
  return { config: safe, redactedConfigKeys: redacted, configVerified: true };
}

/**
 * Qué se sabe sobre si la cuenta puede autenticar.
 *
 * - `complete`   — están todos los campos que el proveedor declara obligatorios.
 * - `incomplete` — falta al menos uno; `missingRequiredFields` los NOMBRA (nunca sus valores).
 * - `simulated`  — la cuenta se declaró mock: sirve fixtures, no cotiza tarifas reales.
 * - `unknown`    — el proveedor no declara reglas, o el blob cifrado no se pudo leer.
 */
export type ProviderAccountReadiness = 'complete' | 'incomplete' | 'simulated' | 'unknown';

export interface ProviderAccountCompleteness {
  readonly readiness: ProviderAccountReadiness;
  /** Vacío salvo en `incomplete`. Sólo nombres de campo. */
  readonly missingRequiredFields: readonly string[];
}

/**
 * Completitud a partir de los NOMBRES de las claves con valor en el blob cifrado. El llamador
 * descifra, saca los nombres y descarta el texto plano: acá no entra ningún valor de credencial,
 * y por tanto ninguno puede salir.
 *
 * `presentCredentialKeys === null` significa "no se pudo leer el blob" ⇒ `unknown`. No es lo
 * mismo que "no falta nada", y colapsarlos sería afirmar que la cuenta está bien sin haberlo
 * mirado.
 */
export function accountReadiness(
  providerCode: string,
  presentCredentialKeys: readonly string[] | null,
  config: Record<string, unknown>,
): ProviderAccountCompleteness {
  const spec = providerSpecFor(providerCode);
  if (!spec?.fields) return { readiness: 'unknown', missingRequiredFields: [] };
  if (isSimulated(spec, config)) return { readiness: 'simulated', missingRequiredFields: [] };
  if (presentCredentialKeys === null) return { readiness: 'unknown', missingRequiredFields: [] };

  const missing = spec.fields
    .filter((rule) => rule.required === true)
    .filter((rule) => {
      if (presentCredentialKeys.includes(rule.key)) return false;
      return rule.origin === 'encrypted-or-config' ? !nonEmptyString(config[rule.key]) : true;
    })
    .map((rule) => rule.key);

  return missing.length === 0
    ? { readiness: 'complete', missingRequiredFields: [] }
    : { readiness: 'incomplete', missingRequiredFields: missing };
}
