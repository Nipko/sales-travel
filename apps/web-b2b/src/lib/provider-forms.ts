/**
 * Especificación de los formularios BYOC del panel de red y las reglas que se aplican en el
 * borde, antes de mandar nada a `POST /provider-accounts`.
 *
 * Vive fuera de `page.tsx` por dos razones concretas:
 *
 *  1. El endpoint acepta `credentials`/`config` como `z.record(z.unknown())` passthrough —la
 *     forma depende del proveedor—, así que **este módulo es el único borde que puede rechazar
 *     una credencial mal formada**. Lo que pase de aquí se guarda cifrado y sólo revienta en la
 *     primera búsqueda, ya disfrazado de "el proveedor no responde".
 *  2. Un formulario dentro de un componente sólo se puede probar montando el componente. Aquí
 *     las reglas entran por la puerta pública y se prueban con `vitest` sin DOM.
 */

/** Estados que acepta `provider_accounts.status` (CHECK de la migración 0012). */
export type ProviderAccountStatus = 'active' | 'sandbox' | 'disabled';

/** Orden en el que se ofrecen en el `select`. `sandbox` primero: es el default del API. */
export const PROVIDER_ACCOUNT_STATUSES: readonly ProviderAccountStatus[] = [
  'sandbox',
  'active',
  'disabled',
];

export const STATUS_LABELS: Readonly<Record<ProviderAccountStatus, string>> = {
  sandbox: 'Sandbox',
  active: 'Activo',
  disabled: 'Deshabilitado',
};

/**
 * `resolve_provider_account` filtra por `pa.status = 'active'` (migración 0012), tanto para la
 * cuenta propia como para la heredada. Cualquier otro estado guarda la credencial pero **no
 * habilita el proveedor**, y no produce ningún error visible: la búsqueda simplemente sale sin
 * ese proveedor. Toda la cartelería de esta pantalla cuelga de este hecho.
 */
export function statusEnablesProvider(status: string): boolean {
  return status === 'active';
}

export function isProviderAccountStatus(value: string): value is ProviderAccountStatus {
  return value === 'active' || value === 'sandbox' || value === 'disabled';
}

export interface ProviderFieldOption {
  readonly value: string;
  readonly label: string;
}

export interface ProviderField {
  readonly key: string;
  readonly label: string;
  /** `true` ⇒ input `password`; nunca se muestra de vuelta ni se resume en la lista. */
  readonly secret?: boolean;
  readonly required?: boolean;
  /** Motivo por el que es obligatorio. Se muestra como error cuando falta. */
  readonly requiredMessage?: string;
  /** Ayuda permanente bajo el campo. */
  readonly help?: string;
  readonly placeholder?: string;
  /** Con `options` se pinta un `select` en vez de un `input`. */
  readonly options?: readonly ProviderFieldOption[];
  /** Valor que se envía cuando el operador no toca el campo. */
  readonly defaultValue?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  /** El valor tiene que ser una URL absoluta http(s). */
  readonly url?: boolean;
}

export type ProviderSection = 'credentials' | 'config';

export interface ProviderForm {
  readonly label: string;
  /** Nota de cabecera del formulario: qué necesita este proveedor y de dónde sale. */
  readonly note?: string;
  readonly credentials: readonly ProviderField[];
  readonly config: readonly ProviderField[];
  /**
   * ¿El proveedor cae a credenciales de PLATAFORMA cuando el tenant no resuelve ninguna cuenta?
   *
   * No es un detalle de redacción: decide si es cierto decirle al operador que sin cuenta el
   * proveedor «no aparece en las búsquedas». Para Sabre lo es —`SabreProviderFactory` es BYOC puro,
   * cero `process.env`, y sin cuenta resoluble queda AUSENTE en vez de en modo mock silencioso—.
   * Para LATAM NDC NO lo es: su factory tiene `envConfig()` y sigue cotizando con las credenciales
   * de la plataforma. Afirmar lo mismo de los dos es mentirle a la mitad de los operadores.
   */
  readonly fallsBackToPlatformCredentials: boolean;
}

const LATAM_NDC: ProviderForm = {
  label: 'LATAM NDC',
  credentials: [
    { key: 'apiKey', label: 'API Key', secret: true },
    { key: 'apiSecret', label: 'API Secret', secret: true },
    { key: 'agencyId', label: 'Agency ID' },
    { key: 'agencyIata', label: 'IATA' },
    { key: 'agencyName', label: 'Nombre de agencia' },
    { key: 'travelAgentId', label: 'Travel Agent ID' },
    { key: 'country', label: 'País (POS)' },
    { key: 'accountCode', label: 'Account Code' },
  ],
  config: [{ key: 'apiUrl', label: 'API URL', url: true }],
  // Su factory tiene envConfig(): sin cuenta del tenant sigue cotizando con las de plataforma.
  fallsBackToPlatformCredentials: true,
};

// AgentCars (renta de autos). El token es secreto; sourceCountry = POS del agente.
// baseUrl/suggestUrl/language son opcionales (el adapter usa defaults de desarrollo).
const AGENT_CARS: ProviderForm = {
  label: 'AgentCars',
  credentials: [{ key: 'accessToken', label: 'Access Token', secret: true }],
  config: [
    { key: 'sourceCountry', label: 'País origen / POS', placeholder: 'CO' },
    { key: 'baseUrl', label: 'Base URL (opcional)', url: true },
    { key: 'suggestUrl', label: 'Suggest URL (opcional)', url: true },
    { key: 'language', label: 'Idioma (opcional)', placeholder: 'es' },
  ],
  // Idem LATAM: el adapter admite credenciales de plataforma por entorno.
  fallsBackToPlatformCredentials: true,
};

/**
 * Sabre. Reparto de mitades tal y como lo lee `SabreProviderFactory.toConfig`:
 *
 *  - `epr`, `password`, `homePcc` y `ticketingPcc` van en `credentials` (blob cifrado). `epr`,
 *    `homePcc` y `ticketingPcc` **no son secretos** —el PCC se imprime en el billete— pero el
 *    factory los lee primero de ahí, así que ahí se guardan.
 *  - `password` va SÓLO en `credentials`: el factory se niega a leerla de `config`, que es un
 *    JSONB en claro que además se devuelve por el listado.
 *
 * Los tres obligatorios son los mismos que `missingSabreCredentials` exige en el ACL. Sin uno
 * solo de ellos la cuenta se guarda, la búsqueda cae a fixtures, el factory lo detecta y deja a
 * Sabre AUSENTE — sin error para el operador. Por eso se cortan aquí.
 *
 * Los límites de 3–4 caracteres de los PCC no son estética: son los de `SabreConfigSchema`, y un
 * valor fuera de rango hace que `parseSabreConfig` lance en la primera búsqueda, no al guardar.
 */
const SABRE: ProviderForm = {
  label: 'Sabre',
  note: 'Sabre autentica con un clientId con la forma V1:{EPR}:{PCC}:AA. EPR, contraseña y PCC de la oficina salen del alta que hace tu account manager de Sabre; el resto sólo hace falta si tu contrato lo pide.',
  credentials: [
    {
      key: 'epr',
      label: 'EPR (usuario de la oficina)',
      required: true,
      requiredMessage:
        'El EPR es obligatorio: forma parte del clientId con el que Sabre emite el token.',
      placeholder: '1234567',
      help: 'Usuario que Sabre asignó a la oficina. Se guarda cifrado junto al resto.',
    },
    {
      key: 'password',
      label: 'Contraseña',
      secret: true,
      required: true,
      requiredMessage:
        'La contraseña es obligatoria: sin ella no se puede pedir el token, y no se puede guardar a medias.',
      help: 'Se cifra al guardar y no se muestra de vuelta. Para rotarla hay que volver a cargar la cuenta completa.',
    },
    {
      key: 'homePcc',
      label: 'PCC de la oficina',
      required: true,
      requiredMessage:
        'El PCC de la oficina es obligatorio: va dentro del clientId del que se deriva el token, así que sin él no hay autenticación posible.',
      minLength: 3,
      maxLength: 4,
      placeholder: 'AB1C',
      help: 'Pseudo-city de tu oficina, 3 o 4 caracteres. No es secreto —se imprime en el billete— pero sí determina qué tarifas privadas ves.',
    },
    {
      key: 'ticketingPcc',
      label: 'PCC de emisión (opcional)',
      minLength: 3,
      maxLength: 4,
      placeholder: 'AB1C',
      help: 'Sólo si emitís desde un PCC distinto al de la oficina. Es la bisagra del modelo consolidador: emitir contra el PCC del consolidador con tu oficina.',
    },
  ],
  config: [
    {
      key: 'environment',
      label: 'Entorno',
      required: true,
      defaultValue: 'cert',
      options: [
        { value: 'cert', label: 'CERT (pruebas)' },
        { value: 'prod', label: 'Producción' },
      ],
      help: 'CERT no emite ni factura y usa credenciales distintas a las de producción. Pasá a Producción sólo con las credenciales productivas en la mano.',
    },
    {
      key: 'agencyIata',
      label: 'IATA de la agencia (opcional)',
      placeholder: '12345678',
    },
    {
      key: 'applicationId',
      label: 'Application-ID (opcional)',
      help: 'Cabecera que Sabre recomienda en algunos productos. Lo asigna tu account manager; si no te lo dieron, dejalo vacío.',
    },
    {
      key: 'sabreGroup',
      label: 'X-Sabre-Group (opcional)',
      minLength: 3,
      maxLength: 4,
      help: 'Sabre lo pide en las llamadas que van contra un PCC de emisión distinto al de la oficina.',
    },
    {
      key: 'sabreCurrentCity',
      label: 'X-Sabre-Current-City (opcional)',
      minLength: 3,
      maxLength: 4,
      help: 'Alternativa a X-Sabre-Group según el carril de autenticación de tu contrato.',
    },
    {
      key: 'domain',
      label: 'Domain (opcional)',
      placeholder: 'AA',
      help: 'Dejalo vacío salvo que Sabre te indique otro valor: por defecto se usa AA.',
    },
    {
      key: 'host',
      label: 'Host REST (opcional)',
      url: true,
      placeholder: 'https://api.cert.platform.sabre.com',
      help: 'Sólo para sobrescribir el host del entorno elegido. Vacío = el host estándar de CERT o Producción.',
    },
    {
      key: 'soapHost',
      label: 'Host SOAP (opcional)',
      url: true,
      placeholder: 'https://webservices.cert.platform.sabre.com',
    },
  ],
  // BYOC PURO: cero process.env en SabreProviderFactory. Sin cuenta resoluble queda AUSENTE,
  // no en modo mock — un tenant cotizando fixtures le pasa precios inventados a un cliente.
  fallsBackToPlatformCredentials: false,
};

export const PROVIDERS: Readonly<Record<string, ProviderForm>> = {
  'latam-ndc': LATAM_NDC,
  'agent-cars': AGENT_CARS,
  sabre: SABRE,
};

/**
 * Sin fallback, a propósito. La versión anterior caía a LATAM NDC ante un código desconocido y
 * pintaba SUS campos: el operador cargaba API Key y API Secret creyendo que configuraba otro
 * proveedor, la cuenta se guardaba con la forma de credencial equivocada y el fallo recién
 * aparecía en la primera búsqueda. Con un proveedor de vuelos era invisible; con tres es una
 * fuga de credenciales al formulario del proveedor que no es.
 */
export function providerFormFor(code: string): ProviderForm | undefined {
  return PROVIDERS[code];
}

export function providerFields(
  form: ProviderForm,
  section: ProviderSection,
): readonly ProviderField[] {
  return section === 'credentials' ? form.credentials : form.config;
}

/** Clave estable de un campo dentro del formulario: `credentials` y `config` pueden repetir `key`. */
export function fieldKey(section: ProviderSection, key: string): string {
  return `${section}.${key}`;
}

export interface DraftSections {
  readonly credentials: Readonly<Record<string, string>>;
  readonly config: Readonly<Record<string, string>>;
}

export interface DraftValidation {
  readonly ok: boolean;
  /** `credentials.epr` → mensaje. Vacío cuando `ok`. */
  readonly fieldErrors: Readonly<Record<string, string>>;
  /** Resumen anunciable con `role="alert"`; `null` cuando `ok`. */
  readonly summary: string | null;
}

/** Valor efectivo de un campo: lo tecleado (recortado) o su default declarado. */
function effectiveValue(field: ProviderField, raw: string | undefined): string {
  const typed = (raw ?? '').trim();
  if (typed.length > 0) return typed;
  return field.defaultValue ?? '';
}

/**
 * Absoluta **y** http(s). Las dos mitades hacen falta: `new URL()` acepta cualquier esquema, así
 * que sin el filtro de protocolo un `javascript:…` o un `file:///…` pasarían por "URL válida" y
 * acabarían guardados como host del proveedor.
 */
function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Primer problema del campo, o `null`. El orden importa: "falta" antes que "está mal". */
function fieldIssue(field: ProviderField, value: string): string | null {
  if (value.length === 0) {
    if (!field.required) return null;
    return field.requiredMessage ?? `${field.label} es obligatorio.`;
  }
  if (field.options && !field.options.some((o) => o.value === value)) {
    return `${field.label}: elegí una de las opciones disponibles.`;
  }
  if (field.minLength !== undefined && value.length < field.minLength) {
    return `${field.label} necesita al menos ${field.minLength} caracteres.`;
  }
  if (field.maxLength !== undefined && value.length > field.maxLength) {
    return `${field.label} admite como máximo ${field.maxLength} caracteres.`;
  }
  if (field.url === true && !isAbsoluteHttpUrl(value)) {
    return `${field.label} tiene que ser una URL completa (https://…).`;
  }
  return null;
}

/**
 * Valida el borrador contra la forma declarada del proveedor. Es la puerta que evita que una
 * credencial inservible se guarde cifrada y falle recién en la primera cotización.
 */
export function validateProviderDraft(form: ProviderForm, draft: DraftSections): DraftValidation {
  const fieldErrors: Record<string, string> = {};
  const sections: readonly ProviderSection[] = ['credentials', 'config'];

  for (const section of sections) {
    for (const field of providerFields(form, section)) {
      const issue = fieldIssue(field, effectiveValue(field, draft[section][field.key]));
      if (issue !== null) fieldErrors[fieldKey(section, field.key)] = issue;
    }
  }

  const messages = Object.values(fieldErrors);
  const first = messages[0];
  if (first === undefined) return { ok: true, fieldErrors: {}, summary: null };

  return {
    ok: false,
    fieldErrors,
    summary:
      messages.length === 1 ? first : `Revisá ${messages.length} campos antes de guardar. ${first}`,
  };
}

export interface ProviderAccountPayload {
  readonly credentials: Record<string, string>;
  readonly config: Record<string, string>;
}

/**
 * Arma el cuerpo del `POST`, quedándose SÓLO con los campos declarados por el proveedor elegido.
 *
 * El filtrado no es cosmético: el formulario conserva lo tecleado al cambiar de proveedor en el
 * `select`, y sin este filtro un `apiKey` de LATAM acabaría dentro del blob cifrado de la cuenta
 * de Sabre — un secreto guardado en la cuenta del proveedor que no es.
 *
 * Los campos vacíos se omiten en vez de mandarse como `""`: `config` es un JSONB que se devuelve
 * por el listado, y una clave vacía es ruido que después hay que interpretar.
 */
export function buildProviderAccountPayload(
  form: ProviderForm,
  draft: DraftSections,
): ProviderAccountPayload {
  const credentials: Record<string, string> = {};
  const config: Record<string, string> = {};
  const target: Record<ProviderSection, Record<string, string>> = { credentials, config };

  for (const section of ['credentials', 'config'] as const) {
    for (const field of providerFields(form, section)) {
      const value = effectiveValue(field, draft[section][field.key]);
      if (value.length > 0) target[section][field.key] = value;
    }
  }

  return { credentials, config };
}

/* ---------- cartelería: estado y herencia ---------- */

export type NoticeTone = 'warn' | 'ok' | 'muted';

export interface Notice {
  readonly tone: NoticeTone;
  readonly title: string;
  readonly body: string;
}

/**
 * Lo que significa cada estado EN TÉRMINOS DE SI EL PROVEEDOR FUNCIONA, que es la pregunta que
 * el operador se está haciendo y que la etiqueta "sandbox" no responde.
 */
export function statusNotice(status: ProviderAccountStatus): Notice {
  switch (status) {
    case 'active':
      return {
        tone: 'ok',
        title: 'Activo: es el único estado que habilita el proveedor',
        // No dice "empieza a cotizar": estar activa es condición necesaria, no suficiente. La
        // credencial puede estar incompleta y el ACL dejar al proveedor ausente sin decir nada.
        body: 'La resolución de credenciales sólo mira cuentas activas: al guardar, ésta pasa a ser la cuenta que resuelve esta agencia. Que además aparezca en las búsquedas depende de que las credenciales estén completas, y eso no se comprueba al guardar.',
      };
    case 'sandbox':
      return {
        tone: 'warn',
        title: 'Sandbox NO habilita el proveedor',
        // Dice qué le pasa a ESTA cuenta, no qué le pasa al proveedor: la agencia puede seguir
        // resolviendo por otra cuenta propia activa o por la de un ancestro heredable.
        body: 'La credencial se guarda cifrada, pero la resolución la ignora: esta cuenta no va a habilitar nada y no vas a ver ningún error explicando por qué. Para promoverla, volvé a esta pantalla, cargá los mismos datos y guardá con estado Activo.',
      };
    case 'disabled':
      return {
        tone: 'muted',
        title: 'Deshabilitado: la cuenta queda guardada pero fuera de servicio',
        body: 'Igual que Sandbox, la resolución la ignora. Si un ancestro tiene una cuenta activa y heredable de este proveedor, la agencia vuelve a cotizar con la del ancestro.',
      };
  }
}

/** Etiqueta que aplica el API cuando el cuerpo no manda ninguna (`label ?? 'default'`). */
export const DEFAULT_ACCOUNT_LABEL = 'default';

/**
 * La etiqueta tal y como va a quedar guardada.
 *
 * Existe porque la etiqueta NO es un adorno: el upsert es por `(tenant_id, provider_code, label)`,
 * así que decide si una cuenta nueva se crea al lado de la que hay o PISA la que hay. Que el aviso
 * y el `POST` normalicen distinto es exactamente el fallo que este módulo tiene que hacer
 * imposible: un campo vacío se guardaba como `default` —pisando la cuenta activa— mientras el
 * aviso, mirando la cadena vacía, decía "no cambia la cuenta que está en uso".
 */
export function normalizeAccountLabel(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_ACCOUNT_LABEL;
}

/**
 * Qué le pasa a la herencia al guardar. `null` en `resolved` = hoy no resuelve ninguna cuenta
 * para este proveedor (ni propia ni heredada).
 */
interface InheritanceContext {
  readonly resolved: ResolvedAccountRef | null;
  readonly nextStatus: ProviderAccountStatus;
  /** Ya normalizada con {@link normalizeAccountLabel}: la misma que va a viajar en el `POST`. */
  readonly nextLabel: string;
}

/** La cuenta que `resolve_provider_account` devuelve hoy para este tenant y proveedor. */
export interface ResolvedAccountRef {
  readonly inherited: boolean;
  readonly label: string;
}

export type InheritanceEffect =
  /** Hoy hereda del padre; al guardar activa, pasa a usar la propia. */
  | 'overrides-inherited'
  /** Hoy hereda del padre y lo va a seguir haciendo: sandbox/disabled no resuelven. */
  | 'keeps-inherited'
  /** No resolvía nada; esta cuenta activa pasa a ser la que resuelve. */
  | 'first-own'
  /** Ya tenía cuenta propia activa CON ESTA MISMA ETIQUETA: el upsert la pisa de verdad. */
  | 'replaces-own'
  /** Ya tenía cuenta propia activa con OTRA etiqueta: quedan dos activas y el desempate no existe. */
  | 'rivals-own'
  /** Ya tenía cuenta propia activa CON ESTA MISMA ETIQUETA y se guarda inactiva: la apaga. */
  | 'downgrades-own'
  /** Ya tiene otra cuenta propia activa con otra etiqueta; ésta, inactiva, no la toca. */
  | 'keeps-own'
  /** Guardar inactiva sin nada resuelto: no cambia nada operativo. */
  | 'no-effect';

/**
 * Se deduce del mismo criterio que aplica `resolve_provider_account` (migración 0012):
 *
 * ```sql
 * ORDER BY nlevel(t.path) DESC
 * LIMIT 1
 * ```
 *
 * El único criterio de orden es la PROFUNDIDAD DEL TENANT dueño. Eso ordena propia-vs-heredada
 * (la propia cuelga más abajo), pero entre dos cuentas del MISMO tenant las dos filas empatan y
 * la consulta no tiene desempate: Postgres devuelve la que quiera. De ahí `rivals-own`, separado
 * de `replaces-own`: sólo la misma etiqueta reemplaza de verdad, porque el upsert es por
 * `(tenant, provider_code, label)` y sobrescribe esa fila. Con otra etiqueta no se reemplaza
 * nada — se añade una segunda cuenta activa y deja de saberse cuál se usa.
 */
function inheritanceEffect(ctx: InheritanceContext): InheritanceEffect {
  const active = statusEnablesProvider(ctx.nextStatus);
  const resolved = ctx.resolved;

  if (resolved === null) return active ? 'first-own' : 'no-effect';
  if (resolved.inherited) return active ? 'overrides-inherited' : 'keeps-inherited';

  const sameRow = resolved.label === ctx.nextLabel;
  if (active) return sameRow ? 'replaces-own' : 'rivals-own';
  return sameRow ? 'downgrades-own' : 'keeps-own';
}

interface InheritanceNames {
  readonly tenantName: string;
  /** Nombre del tenant dueño de la cuenta heredada, si se conoce. */
  readonly ownerName: string;
  readonly providerLabel: string;
  /** Etiqueta normalizada de la cuenta que se está por guardar. */
  readonly nextLabel: string;
  /** Etiqueta de la cuenta que resuelve hoy; `null` cuando no resuelve ninguna. */
  readonly resolvedLabel: string | null;
  /** Ver `ProviderForm.fallsBackToPlatformCredentials`. Decide si «sin cuenta no aparece» es cierto. */
  readonly fallsBackToPlatform: boolean;
}

/** El efecto, redactado para alguien que no conoce el modelo interno. */
function inheritanceMessage(effect: InheritanceEffect, names: InheritanceNames): Notice {
  const { tenantName, ownerName, providerLabel, nextLabel, resolvedLabel } = names;
  switch (effect) {
    case 'overrides-inherited':
      return {
        tone: 'warn',
        title: `${tenantName} va a dejar de usar las credenciales de ${ownerName}`,
        body: `Hoy ${tenantName} cotiza ${providerLabel} con la cuenta de ${ownerName}. Al guardar ésta como Activa, pasa a resolver la suya propia —cuelga más abajo en el árbol, así que gana— y la heredada deja de aplicarse. Si la borrás más adelante, vuelve a heredar.`,
      };
    case 'keeps-inherited':
      return {
        tone: 'muted',
        title: `${tenantName} sigue usando las credenciales de ${ownerName}`,
        body: `Guardada en un estado que no habilita el proveedor, esta cuenta no reemplaza a la heredada: ${tenantName} sigue cotizando ${providerLabel} con la cuenta de ${ownerName}.`,
      };
    case 'first-own':
      return {
        tone: 'ok',
        title: `${providerLabel} pasa a resolver para ${tenantName}`,
        // Esta pantalla garantiza QUÉ CUENTA RESUELVE. No garantiza que el proveedor aparezca en
        // la búsqueda, y por eso no lo promete: hace falta además que la credencial esté completa
        // y que el proveedor esté habilitado en la plataforma (`PLATFORM_DEFAULT_FLIGHT_PROVIDERS`
        // y su `callPolicy`), dos interruptores del servidor que este panel ni ve ni controla.
        body:
          `Hoy ${tenantName} no resuelve ninguna cuenta de ${providerLabel} —ni propia ni heredada—. ` +
          (names.fallsBackToPlatform
            ? `${providerLabel} puede estar cotizando igual con las credenciales de la plataforma. `
            : `${providerLabel} no aparece en las búsquedas de ${tenantName}. `) +
          `Al guardar, ésta pasa a ser la cuenta que resuelve. Que además aparezca en la búsqueda depende de que las credenciales estén completas y de que el proveedor esté habilitado en la plataforma.`,
      };
    case 'replaces-own':
      return {
        tone: 'warn',
        title: `Reemplaza la cuenta «${nextLabel}», que es la que está en uso`,
        body: `${tenantName} ya cotiza ${providerLabel} con su cuenta propia «${nextLabel}». Guardar con esa misma etiqueta SOBRESCRIBE esa cuenta: las credenciales de ahora se pierden y quedan éstas. Si querías conservarla, cambiá la etiqueta.`,
      };
    case 'rivals-own':
      return {
        tone: 'warn',
        title: `${tenantName} va a quedar con dos cuentas activas de ${providerLabel}`,
        // La afirmación honesta: NO sabemos cuál gana. La resolución sólo desempata por
        // profundidad del tenant, y dos cuentas del mismo tenant empatan.
        body: `Hoy resuelve la cuenta propia «${resolvedLabel ?? DEFAULT_ACCOUNT_LABEL}» y ésta se guarda como «${nextLabel}», así que quedan las dos activas. Esto NO reemplaza a la que está en uso: la resolución sólo desempata por nivel en el árbol, y entre dos cuentas de la misma agencia no hay criterio — no podemos decirte cuál va a usar. Si lo que querés es reemplazarla, guardá con la etiqueta «${resolvedLabel ?? DEFAULT_ACCOUNT_LABEL}»; si querés convivir con las dos, desactivá una.`,
      };
    case 'downgrades-own':
      return {
        tone: 'warn',
        title: `Vas a sacar de servicio la cuenta de ${providerLabel} que ${tenantName} usa hoy`,
        // No promete que el proveedor desaparezca: puede caer a otra cuenta propia activa o a la
        // de un ancestro heredable, y esta pantalla no sabe si alguna de las dos existe.
        body:
          `Estás reguardando la cuenta propia «${nextLabel}», que hoy es la que resuelve, en un estado que no habilita el proveedor. Al guardar deja de estar en uso: ${tenantName} va a caer en la que siga —otra cuenta propia activa, o la de un ancestro heredable— y, si no hay ninguna, ` +
          (names.fallsBackToPlatform
            ? `${providerLabel} pasa a depender de las credenciales de la plataforma.`
            : `${providerLabel} deja de aparecer en sus búsquedas.`),
      };
    case 'keeps-own':
      return {
        tone: 'muted',
        title: 'No cambia la cuenta que está en uso',
        body: `${tenantName} seguirá cotizando ${providerLabel} con su cuenta propia «${resolvedLabel ?? DEFAULT_ACCOUNT_LABEL}»: ésta se guarda con otra etiqueta («${nextLabel}») y en un estado que no habilita el proveedor.`,
      };
    case 'no-effect':
      return {
        tone: 'muted',
        title: 'Se guarda, pero no habilita nada todavía',
        body: `${providerLabel} sigue sin resolver ninguna cuenta para ${tenantName}. Guardá con estado Activo cuando quieras que ésta sea la cuenta que resuelve.`,
      };
  }
}

/* ---------- la única puerta de guardado ---------- */

export interface AccountDraft {
  /** Etiqueta en crudo, tal y como está en el input. */
  readonly label: string;
  readonly status: ProviderAccountStatus;
  readonly sections: DraftSections;
}

export interface SubmissionContext {
  readonly resolved: ResolvedAccountRef | null;
  readonly tenantName: string;
  /** Nombre del dueño de la cuenta heredada; sólo se usa cuando `resolved.inherited`. */
  readonly ownerName: string;
}

export interface AccountSubmission {
  /** Etiqueta normalizada. La MISMA que se anuncia y la que hay que mandar en el `POST`. */
  readonly label: string;
  readonly effect: InheritanceEffect;
  readonly notice: Notice;
  readonly payload: ProviderAccountPayload;
}

/**
 * Arma de una sola vez lo que se le dice al operador y lo que se le manda al API.
 *
 * `inheritanceEffect` e `inheritanceMessage` no se exportan a propósito: el fallo que motivó esta
 * función fue tener dos caminos —el aviso miraba la etiqueta en crudo, el `POST` la normalizada— y
 * el aviso terminaba describiendo un guardado que no era el que iba a ocurrir. Con una sola puerta
 * eso no se puede volver a escribir; con dos funciones exportadas, sí.
 */
export function prepareAccountSubmission(
  form: ProviderForm,
  draft: AccountDraft,
  ctx: SubmissionContext,
): AccountSubmission {
  const label = normalizeAccountLabel(draft.label);
  const effect = inheritanceEffect({
    resolved: ctx.resolved,
    nextStatus: draft.status,
    nextLabel: label,
  });

  return {
    label,
    effect,
    notice: inheritanceMessage(effect, {
      tenantName: ctx.tenantName,
      ownerName: ctx.ownerName,
      providerLabel: form.label,
      nextLabel: label,
      resolvedLabel: ctx.resolved?.label ?? null,
      fallsBackToPlatform: form.fallsBackToPlatformCredentials,
    }),
    payload: buildProviderAccountPayload(form, draft.sections),
  };
}

/* ---------- qué se puede AFIRMAR de una cuenta ya resuelta ---------- */

/**
 * Lo que el panel puede decir sobre si una cuenta resuelta sirve, además de que pasó el filtro
 * `status = 'active'`.
 *
 *  - `complete`: el servidor comprobó los obligatorios contra el ACL y están todos.
 *  - `simulated`: la cuenta se declaró simulada; devuelve fixtures, no tarifas del proveedor.
 *  - `missing-fields`: obligatorios que faltan, dicho por el servidor o vistos en la `config`.
 *  - `unverifiable`: obligatorios que nadie confirmó. No es lo mismo que "está bien".
 *  - `nothing-required`: el proveedor no declara obligatorios; no hay nada que comprobar.
 */
export type AccountCertainty =
  | { readonly kind: 'complete' }
  | { readonly kind: 'simulated' }
  | { readonly kind: 'missing-fields'; readonly fields: readonly string[] }
  | { readonly kind: 'unverifiable'; readonly fields: readonly string[] }
  | { readonly kind: 'nothing-required' };

/** Veredicto de `GET /provider-accounts/resolve` sobre la cuenta resuelta. */
export type AccountReadiness = 'complete' | 'incomplete' | 'simulated' | 'unknown';

/**
 * El veredicto tal y como llega por la red: sin tipar, porque un API que todavía no lo manda o
 * que manda otra cosa NO puede convertirse en una afirmación de esta pantalla.
 */
export interface ServerReadinessInput {
  readonly readiness?: unknown;
  readonly missingRequiredFields?: unknown;
}

function isAccountReadiness(value: unknown): value is AccountReadiness {
  return (
    value === 'complete' || value === 'incomplete' || value === 'simulated' || value === 'unknown'
  );
}

/** Nombres de campo tal y como los manda el servidor (claves, no etiquetas). */
function readMissingFieldKeys(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/** La etiqueta del campo si el formulario lo conoce; si no, la clave cruda, que es mejor que nada. */
function fieldLabelFor(form: ProviderForm, key: string): string {
  const field = [...form.credentials, ...form.config].find((f) => f.key === key);
  return field?.label ?? key;
}

/**
 * Qué se puede comprobar de la cuenta resuelta, con dos fuentes de distinta autoridad.
 *
 * 1. `server`: el veredicto de `GET /provider-accounts/resolve`. Es el único que ve el blob
 *    descifrado y lo compara contra los obligatorios del ACL, así que cuando se pronuncia manda.
 *    Llega sin tipar y se valida acá: un despliegue del API que todavía no lo mande, o que mande
 *    un valor que no reconocemos, NO puede convertirse en "la cuenta está bien".
 *
 * 2. Lo poco que se deduce sin él. `visibleConfig` es la `config` de la cuenta, o `undefined`
 *    cuando el panel no la ve: caso de una cuenta HEREDADA, cuya fila pertenece a un ancestro y la
 *    RLS de `provider_accounts` no deja leer (migración 0012). Los campos de la sección
 *    `credentials` nunca son comprobables por esta vía: van en `credentials_enc` y el listado no
 *    los devuelve. Por eso, sin el veredicto del servidor, los tres obligatorios de Sabre (EPR,
 *    contraseña, PCC) caen en `unverifiable` — que es lo que hay que decir, no "funciona".
 *
 * Un obligatorio de `config` con `defaultValue` no cuenta como ausente: tiene un valor declarado
 * al que caer, así que gritar "le falta" sería otra afirmación falsa.
 */
export function accountCertainty(
  form: ProviderForm,
  visibleConfig: Record<string, unknown> | undefined,
  server?: ServerReadinessInput,
): AccountCertainty {
  // El servidor SÍ ve el blob descifrado y compara contra la lista de obligatorios del ACL. Si
  // se pronuncia, manda: lo de abajo es lo poco que se puede deducir sin verlo.
  if (isAccountReadiness(server?.readiness)) {
    switch (server.readiness) {
      case 'complete':
        return { kind: 'complete' };
      case 'simulated':
        return { kind: 'simulated' };
      case 'incomplete': {
        const keys = readMissingFieldKeys(server.missingRequiredFields);
        // Un `incomplete` sin campos no se puede convertir en "le falta X" — se degrada a duda.
        if (keys.length > 0) {
          return { kind: 'missing-fields', fields: keys.map((k) => fieldLabelFor(form, k)) };
        }
        break;
      }
      case 'unknown':
        break;
    }
  }

  const missing: string[] = [];
  const unverifiable: string[] = [];

  for (const field of form.credentials) {
    if (field.required === true) unverifiable.push(field.label);
  }

  for (const field of form.config) {
    if (field.required !== true) continue;
    if (field.defaultValue !== undefined) continue;
    if (visibleConfig === undefined) {
      unverifiable.push(field.label);
      continue;
    }
    const raw = visibleConfig[field.key];
    if (typeof raw !== 'string' || raw.trim().length === 0) missing.push(field.label);
  }

  // Un defecto conocido manda sobre una duda: si ya sabemos que algo falta, decirlo es más útil.
  if (missing.length > 0) return { kind: 'missing-fields', fields: missing };
  if (unverifiable.length > 0) return { kind: 'unverifiable', fields: unverifiable };
  return { kind: 'nothing-required' };
}

/**
 * La advertencia que acompaña al origen. `null` = no hay nada honesto que añadir.
 *
 * Ninguna rama dice "funciona": esta pantalla no tiene con qué saberlo.
 */
export function accountCertaintyNotice(
  certainty: AccountCertainty,
): { readonly tone: NoticeTone; readonly text: string } | null {
  switch (certainty.kind) {
    case 'complete':
      return {
        tone: 'ok',
        // "Completa", no "funciona": que estén los campos no dice que la contraseña sea buena ni
        // que el proveedor esté activado para este tenant.
        text: 'Completa: tiene cargados todos los campos obligatorios del proveedor.',
      };
    case 'simulated':
      return {
        tone: 'warn',
        text: 'Declarada como simulada: devuelve resultados de prueba, no tarifas reales del proveedor.',
      };
    case 'missing-fields':
      return {
        tone: 'warn',
        text: `Incompleta: le falta ${listar(certainty.fields)}. Está activa, pero no tiene todo lo que el proveedor exige.`,
      };
    case 'unverifiable':
      return {
        tone: 'muted',
        // El motivo cambia según el campo (blob cifrado, o fila de un ancestro que la RLS oculta),
        // pero la consecuencia para el operador es una sola: el API no lo devuelve.
        text: `Pasa el filtro de estado; si está completa, no lo podemos ver: el API no devuelve ${listar(certainty.fields)}. Si el proveedor no aparece en las búsquedas, volvé a cargar la cuenta entera.`,
      };
    case 'nothing-required':
      return null;
  }
}

/** "a, b y c" — para enumerar campos dentro de una frase. */
function listar(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`;
}

/**
 * Qué significa marcar la cuenta como heredable, dicho en función de si este nodo tiene hijos.
 * Un checkbox mudo en una agencia hoja no dice nada; en el consolidador decide toda la red.
 */
export function inheritableHelp(childCount: number): string {
  if (childCount <= 0) {
    return 'Esta agencia todavía no tiene sub-agencias, así que hoy no cambia nada. Dejalo marcado y las que cuelgues después van a poder heredar estas credenciales si no cargan las suyas.';
  }
  const sub = childCount === 1 ? 'su sub-agencia' : `sus ${childCount} sub-agencias`;
  // "pueden heredar", no "van a cotizar con": heredar es lo que se decide acá; cuál cuenta gana
  // depende además del estado, de lo que carguen ellas y de si hay un nodo intermedio con la suya.
  return `Marcado, ${sub} —y todo lo que cuelgue de ellas— pueden heredar estas credenciales mientras no carguen las propias, no haya un nodo intermedio con las suyas, y esta cuenta esté Activa. Desmarcado, dejan de poder heredarla: pasan a la del ancestro heredable que siga, y si no hay ninguno, se quedan sin este proveedor.`;
}

/**
 * Resumen legible de la `config` guardada, para la lista de cuentas. Sólo campos declarados y no
 * secretos: `config` viaja en claro y se devuelve por el listado, pero eso no es excusa para
 * pintar cualquier clave que alguien haya metido por API.
 */
export function accountConfigSummary(
  form: ProviderForm,
  config: Record<string, unknown>,
): readonly string[] {
  const out: string[] = [];
  for (const field of form.config) {
    if (field.secret === true) continue;
    const raw = config[field.key];
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const option = field.options?.find((o) => o.value === raw);
    out.push(`${field.label.replace(/\s*\(opcional\)$/, '')}: ${option?.label ?? raw}`);
  }
  return out;
}
