import { providerMetaFor } from './provider-display';

/**
 * "¿Quién puede buscar y vender con cada proveedor?" — lado del navegador, sólo superadmin.
 *
 * La regla (kill-switch → ajuste más cercano en el árbol → global → variable legado → política
 * del proveedor) la resuelve el API (`/admin/providers`, 0048). Acá viven la lectura desconfiada
 * de sus respuestas y las frases que la pantalla necesita para decir QUÉ está pasando y POR QUÉ:
 * un interruptor que no explica su origen es uno que el superadmin no se atreve a tocar.
 */

export type EnablementVertical = 'flights' | 'hotels' | 'cars';
export type EnablementCallPolicy = 'always' | 'fallback' | 'opt-in';
/** `sales` (`código:ventas`) corta las ventas y deja la post-venta; `all` corta todo. */
export type EnablementKillLevel = 'all' | 'sales';
export type EnablementOrigin = 'kill-switch' | 'tenant' | 'global' | 'legacy-env' | 'default';

/** Espejo de `EnablementSettingView`. */
export interface EnablementSetting {
  readonly enabled: boolean;
  readonly reason: string | null;
  readonly updatedBy: string | null;
  readonly updatedByEmail: string | null;
  /** ISO 8601. */
  readonly updatedAt: string;
}

/** Espejo de `TenantOverrideView`. */
export interface TenantOverride extends EnablementSetting {
  readonly tenantId: string;
  readonly tenantName: string | null;
  readonly tenantSlug: string | null;
}

/** Espejo de `EffectiveEnablementView`. */
export interface EffectiveEnablement {
  readonly enabled: boolean;
  readonly origin: EnablementOrigin;
  readonly originTenantId?: string;
  readonly originTenantName?: string | null;
  readonly killSwitch?: EnablementKillLevel;
}

export interface LegacyEnvOptIn {
  readonly allTenants: boolean;
  readonly tenantIds: readonly string[];
}

export interface ProviderBase {
  readonly code: string;
  readonly vertical: EnablementVertical;
  readonly callPolicy: EnablementCallPolicy;
  readonly defaultEnabled: boolean;
  readonly killSwitch: EnablementKillLevel | null;
  readonly legacyEnv: LegacyEnvOptIn;
}

/** Espejo de `PlatformProviderView`: un proveedor con su ajuste global y sus excepciones. */
export interface PlatformProvider extends ProviderBase {
  readonly global: EnablementSetting | null;
  readonly overrides: readonly TenantOverride[];
  /** Lo que ve un tenant sin excepción propia ni de su red. */
  readonly baseline: EffectiveEnablement;
}

/** Espejo de `TenantProviderView`: un proveedor visto desde UN tenant. */
export interface TenantProvider extends ProviderBase {
  /** El ajuste del propio tenant; `null` = hereda. */
  readonly own: EnablementSetting | null;
  readonly effective: EffectiveEnablement;
}

export interface TenantProviders {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly tenantSlug: string;
  readonly providers: readonly TenantProvider[];
}

// ---------------------------------------------------------------------------------------------
// Lectura de las respuestas
// ---------------------------------------------------------------------------------------------

/*
 * Una respuesta que no tiene la forma completa se rechaza ENTERA (`undefined`) y la pantalla dice
 * que no pudo leerla. No se rellena ni se saltea un proveedor: en un panel que enciende y apaga
 * proveedores para toda la plataforma, pintar "deshabilitado" porque faltó un campo —o esconder
 * un proveedor— es peor que no pintar nada.
 */

const VERTICALS: readonly string[] = ['flights', 'hotels', 'cars'];
const CALL_POLICIES: readonly string[] = ['always', 'fallback', 'opt-in'];
const KILL_LEVELS: readonly string[] = ['all', 'sales'];
const ORIGINS: readonly string[] = ['kill-switch', 'tenant', 'global', 'legacy-env', 'default'];

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

function oneOf<T extends string>(value: unknown, allowed: readonly string[]): value is T {
  return typeof value === 'string' && allowed.includes(value);
}

function parseSetting(value: unknown): EnablementSetting | undefined {
  if (!isRecord(value)) return undefined;
  const { enabled, reason, updatedBy, updatedByEmail, updatedAt } = value;
  if (typeof enabled !== 'boolean' || typeof updatedAt !== 'string') return undefined;
  if (!isStringOrNull(reason) || !isStringOrNull(updatedBy)) return undefined;
  if (updatedByEmail !== undefined && !isStringOrNull(updatedByEmail)) return undefined;
  return {
    enabled,
    reason,
    updatedBy,
    updatedByEmail: updatedByEmail ?? null,
    updatedAt,
  };
}

function parseOverride(value: unknown): TenantOverride | undefined {
  const setting = parseSetting(value);
  if (setting === undefined || !isRecord(value)) return undefined;
  const { tenantId, tenantName, tenantSlug } = value;
  if (typeof tenantId !== 'string') return undefined;
  if (!isStringOrNull(tenantName) || !isStringOrNull(tenantSlug)) return undefined;
  return { ...setting, tenantId, tenantName, tenantSlug };
}

function parseEffective(value: unknown): EffectiveEnablement | undefined {
  if (!isRecord(value)) return undefined;
  const { enabled, origin, originTenantId, originTenantName, killSwitch } = value;
  if (typeof enabled !== 'boolean' || !oneOf<EnablementOrigin>(origin, ORIGINS)) return undefined;
  if (originTenantId !== undefined && typeof originTenantId !== 'string') return undefined;
  if (originTenantName !== undefined && !isStringOrNull(originTenantName)) return undefined;
  if (killSwitch !== undefined && !oneOf<EnablementKillLevel>(killSwitch, KILL_LEVELS)) {
    return undefined;
  }
  // Un "habilitado por el kill-switch" no existe: el API sólo lo usa para apagar.
  if (origin === 'kill-switch' && enabled) return undefined;
  return {
    enabled,
    origin,
    ...(originTenantId === undefined ? {} : { originTenantId }),
    ...(originTenantName === undefined ? {} : { originTenantName }),
    ...(killSwitch === undefined ? {} : { killSwitch }),
  };
}

function parseLegacy(value: unknown): LegacyEnvOptIn | undefined {
  if (!isRecord(value)) return undefined;
  const { allTenants, tenantIds } = value;
  if (typeof allTenants !== 'boolean' || !Array.isArray(tenantIds)) return undefined;
  if (!tenantIds.every((id): id is string => typeof id === 'string')) return undefined;
  return { allTenants, tenantIds };
}

function parseBase(value: unknown): ProviderBase | undefined {
  if (!isRecord(value)) return undefined;
  const { code, vertical, callPolicy, defaultEnabled, killSwitch } = value;
  if (typeof code !== 'string' || code === '') return undefined;
  if (!oneOf<EnablementVertical>(vertical, VERTICALS)) return undefined;
  if (!oneOf<EnablementCallPolicy>(callPolicy, CALL_POLICIES)) return undefined;
  if (typeof defaultEnabled !== 'boolean') return undefined;
  if (killSwitch !== null && !oneOf<EnablementKillLevel>(killSwitch, KILL_LEVELS)) {
    return undefined;
  }
  const legacyEnv = parseLegacy(value['legacyEnv']);
  if (legacyEnv === undefined) return undefined;
  return { code, vertical, callPolicy, defaultEnabled, killSwitch, legacyEnv };
}

/** Un proveedor de `GET /admin/providers`, o la respuesta de un PUT/DELETE. */
export function parsePlatformProvider(value: unknown): PlatformProvider | undefined {
  const base = parseBase(value);
  if (base === undefined || !isRecord(value)) return undefined;
  const { global, overrides } = value;
  const parsedGlobal = global === null ? null : parseSetting(global);
  if (parsedGlobal === undefined || !Array.isArray(overrides)) return undefined;
  const parsedOverrides = overrides.map(parseOverride);
  if (parsedOverrides.some((o) => o === undefined)) return undefined;
  const baseline = parseEffective(value['baseline']);
  if (baseline === undefined) return undefined;
  return {
    ...base,
    global: parsedGlobal,
    overrides: parsedOverrides as TenantOverride[],
    baseline,
  };
}

export function parsePlatformProviders(value: unknown): PlatformProvider[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = value.map(parsePlatformProvider);
  return parsed.some((p) => p === undefined) ? undefined : (parsed as PlatformProvider[]);
}

function parseTenantProvider(value: unknown): TenantProvider | undefined {
  const base = parseBase(value);
  if (base === undefined || !isRecord(value)) return undefined;
  const own = value['own'] === null ? null : parseSetting(value['own']);
  const effective = parseEffective(value['effective']);
  if (own === undefined || effective === undefined) return undefined;
  return { ...base, own, effective };
}

/** La respuesta de `GET /admin/providers/tenants/:tenantId`. */
export function parseTenantProviders(value: unknown): TenantProviders | undefined {
  if (!isRecord(value)) return undefined;
  const { tenantId, tenantName, tenantSlug, providers } = value;
  if (typeof tenantId !== 'string' || typeof tenantName !== 'string') return undefined;
  if (typeof tenantSlug !== 'string' || !Array.isArray(providers)) return undefined;
  const parsed = providers.map(parseTenantProvider);
  if (parsed.some((p) => p === undefined)) return undefined;
  return { tenantId, tenantName, tenantSlug, providers: parsed as TenantProvider[] };
}

// ---------------------------------------------------------------------------------------------
// Bordes del proxy (`app/api/admin/providers/...`)
// ---------------------------------------------------------------------------------------------

/** El mismo formato que el API y el CHECK de 0048. */
const PROVIDER_CODE = /^[a-z0-9-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isProviderCode(value: string): boolean {
  return PROVIDER_CODE.test(value);
}

export function isTenantId(value: string): boolean {
  return UUID.test(value);
}

/** Tope del motivo: el mismo que el CHECK de la columna y el esquema del API. */
export const REASON_MAX_LENGTH = 500;

export interface EnablementBody {
  readonly enabled: boolean;
  readonly reason: string | null;
}

/**
 * El cuerpo de un PUT, reconstruido campo por campo: al API sólo le llega `enabled` y `reason`,
 * nunca lo que el navegador haya querido agregar. `undefined` = cuerpo inválido (400).
 */
export function parseEnablementBody(value: unknown): EnablementBody | undefined {
  if (!isRecord(value) || typeof value['enabled'] !== 'boolean') return undefined;
  const reason = value['reason'];
  if (reason !== undefined && !isStringOrNull(reason)) return undefined;
  const normalized = normalizeReason(reason ?? '');
  if (normalized !== null && normalized.length > REASON_MAX_LENGTH) return undefined;
  return { enabled: value['enabled'], reason: normalized };
}

/** Vacío o sólo espacios es "sin motivo", como en el API. */
export function normalizeReason(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

export function reasonError(raw: string): string | undefined {
  const normalized = normalizeReason(raw);
  return normalized !== null && normalized.length > REASON_MAX_LENGTH
    ? `El motivo no puede superar los ${REASON_MAX_LENGTH} caracteres.`
    : undefined;
}

// ---------------------------------------------------------------------------------------------
// El control de tres posiciones
// ---------------------------------------------------------------------------------------------

export type EnablementChoice = 'inherit' | 'enabled' | 'disabled';

export const ENABLEMENT_CHOICES: readonly { value: EnablementChoice; label: string }[] = [
  { value: 'inherit', label: 'Heredar' },
  { value: 'enabled', label: 'Habilitado' },
  { value: 'disabled', label: 'Deshabilitado' },
];

export function choiceOf(setting: Pick<EnablementSetting, 'enabled'> | null): EnablementChoice {
  if (setting === null) return 'inherit';
  return setting.enabled ? 'enabled' : 'disabled';
}

/**
 * Qué pedirle al API para dejar un ajuste en `choice`. "Heredar" es quitar el ajuste (DELETE), no
 * un `enabled: null`: son dos acciones distintas en el API y en la auditoría.
 */
export type EnablementRequest =
  | { readonly method: 'DELETE' }
  | { readonly method: 'PUT'; readonly body: EnablementBody };

export function enablementRequest(choice: EnablementChoice, reason: string): EnablementRequest {
  if (choice === 'inherit') return { method: 'DELETE' };
  return {
    method: 'PUT',
    body: { enabled: choice === 'enabled', reason: normalizeReason(reason) },
  };
}

/**
 * El motivo con que arranca el diálogo: el guardado sólo si se edita el MISMO estado. Al cambiar
 * de estado arranca vacío: el motivo de haberlo habilitado no explica haberlo deshabilitado, y
 * reenviarlo sin mirar lo dejaría escrito en la auditoría como si lo explicara.
 */
export function initialReasonFor(
  current: Pick<EnablementSetting, 'enabled' | 'reason'> | null,
  to: EnablementChoice,
): string {
  return current !== null && choiceOf(current) === to ? (current.reason ?? '') : '';
}

// ---------------------------------------------------------------------------------------------
// El ajuste global ("Todos los tenants")
// ---------------------------------------------------------------------------------------------

export type GlobalSource = 'global' | 'legacy-env' | 'default';

/**
 * Lo que dice hoy la capa global SIN el kill-switch: el ajuste guardado, o la variable legado para
 * todos, o la política del proveedor. Es lo que pinta el interruptor "Todos los tenants": el
 * kill-switch se avisa aparte, porque es una decisión de operaciones que este panel no quita.
 */
export function globalSwitchState(provider: PlatformProvider): {
  readonly on: boolean;
  readonly source: GlobalSource;
} {
  if (provider.global !== null) return { on: provider.global.enabled, source: 'global' };
  if (provider.legacyEnv.allTenants) return { on: true, source: 'legacy-env' };
  return { on: provider.defaultEnabled, source: 'default' };
}

/** Cómo queda la capa global si se quita el ajuste guardado ("Restablecer"). */
export function globalResetOutcome(provider: PlatformProvider): {
  readonly on: boolean;
  readonly source: Exclude<GlobalSource, 'global'>;
} {
  if (provider.legacyEnv.allTenants) return { on: true, source: 'legacy-env' };
  return { on: provider.defaultEnabled, source: 'default' };
}

export function legacyEnvVar(vertical: EnablementVertical): string {
  return vertical === 'hotels' ? 'HOTEL_PROVIDERS_OPT_IN' : 'FLIGHT_PROVIDERS_OPT_IN';
}

function policyPhrase(callPolicy: EnablementCallPolicy): string {
  return callPolicy === 'opt-in'
    ? 'la política del proveedor lo deja apagado hasta que alguien lo habilite'
    : 'la política del proveedor lo deja encendido';
}

/** La línea bajo el interruptor global: de dónde sale lo que muestra. */
export function globalSourceLabel(provider: PlatformProvider): string {
  const { source } = globalSwitchState(provider);
  if (source === 'global') return 'Ajuste global de la plataforma.';
  if (source === 'legacy-env') {
    return `Sin ajuste global: lo enciende la variable ${legacyEnvVar(provider.vertical)} (legado).`;
  }
  return `Sin ajuste global: ${policyPhrase(provider.callPolicy)}.`;
}

// ---------------------------------------------------------------------------------------------
// El estado efectivo y su origen
// ---------------------------------------------------------------------------------------------

export function statusLabel(effective: Pick<EffectiveEnablement, 'enabled'>): string {
  return effective.enabled ? 'Habilitado' : 'Deshabilitado';
}

/** Lo que el kill-switch de operaciones corta, en palabras del superadmin. */
export function killSwitchLabel(level: EnablementKillLevel): string {
  return level === 'sales'
    ? 'Apagado de emergencia de operaciones (PROVIDERS_DISABLED, sólo ventas): no busca ni vende; la post-venta sigue.'
    : 'Apagado de emergencia de operaciones (PROVIDERS_DISABLED): cortado del todo, incluida la post-venta.';
}

/**
 * Por qué el estado efectivo es el que es. `viewingTenantId` es el tenant desde el que se mira:
 * un ajuste suyo es "propio" y uno de un ancestro es "heredado de".
 */
export function originLabel(
  effective: EffectiveEnablement,
  provider: Pick<ProviderBase, 'vertical' | 'callPolicy'>,
  viewingTenantId?: string,
): string {
  switch (effective.origin) {
    case 'kill-switch':
      return killSwitchLabel(effective.killSwitch ?? 'all');
    case 'tenant': {
      if (effective.originTenantId !== undefined && effective.originTenantId === viewingTenantId) {
        return 'Ajuste propio de esta agencia.';
      }
      const name = effective.originTenantName?.trim();
      return name ? `Heredado de ${name}.` : 'Heredado de un nivel superior de la red.';
    }
    case 'global':
      return 'Ajuste global de la plataforma.';
    case 'legacy-env':
      return `Variable ${legacyEnvVar(provider.vertical)} (legado, sin ajuste en la plataforma).`;
    case 'default': {
      const phrase = policyPhrase(provider.callPolicy);
      return `Sin ajustes: ${phrase}.`;
    }
  }
}

/** Las capas de la regla, de la que más manda a la que menos. */
export const PRECEDENCE: readonly { origin: EnablementOrigin; label: string }[] = [
  { origin: 'kill-switch', label: 'Emergencia' },
  { origin: 'tenant', label: 'Agencia o red' },
  { origin: 'global', label: 'Global' },
  { origin: 'legacy-env', label: 'Legado' },
  { origin: 'default', label: 'Política' },
];

// ---------------------------------------------------------------------------------------------
// Confirmaciones
// ---------------------------------------------------------------------------------------------

export interface EnablementConfirmation {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly destructive: boolean;
}

const POST_SALE_KEEPS =
  'Las reservas ya hechas no se tocan: se siguen consultando, cancelando y conciliando.';

/**
 * Qué confirmar antes de cambiar la excepción de un tenant, o `null` si no hace falta.
 *
 * Se confirma todo lo que puede APAGAR: deshabilitar, y volver a heredar desde "Habilitado" (lo
 * que herede puede ser apagado; el árbol de la red no está en esta pantalla para predecirlo).
 */
export function tenantChangeConfirmation(input: {
  readonly providerCode: string;
  readonly tenantName: string;
  readonly from: EnablementChoice;
  readonly to: EnablementChoice;
}): EnablementConfirmation | null {
  const provider = providerMetaFor(input.providerCode).name;
  const { tenantName, from, to } = input;
  if (to === from) return null;
  if (to === 'disabled') {
    return {
      title: `¿Deshabilitar ${provider} para ${tenantName}?`,
      description: `${tenantName} y las agencias de su red sin ajuste propio dejan de buscar y vender con ${provider}. ${POST_SALE_KEEPS}`,
      confirmLabel: 'Deshabilitar',
      destructive: true,
    };
  }
  if (to === 'inherit' && from === 'enabled') {
    return {
      title: `¿Quitar la habilitación de ${provider} para ${tenantName}?`,
      description: `Vuelve a heredar de su red o del ajuste global. Si allí está deshabilitado, dejará de buscar y vender con ${provider}. ${POST_SALE_KEEPS}`,
      confirmLabel: 'Heredar',
      destructive: false,
    };
  }
  return null;
}

type GlobalNext = { readonly kind: 'set'; readonly enabled: boolean } | { readonly kind: 'reset' };

/**
 * Los tenants que la variable legado enciende UNO POR UNO (`código@tenant`) y que este cambio de
 * la capa global mueve, o `null` si no mueve a ninguno. Un ajuste global le gana a esas entradas
 * (la variable sólo cuenta sin ningún ajuste en la base): fijarlo en "Deshabilitado" las apaga y
 * quitarlo las vuelve a encender, aunque lo que ven los tenants sin excepción no cambie. Los que
 * tienen excepción propia no se mueven; los que heredan una de su red, este panel no los ve.
 */
function legacyTenantsShift(
  provider: PlatformProvider,
  next: GlobalNext,
): { readonly count: number; readonly enabled: boolean } | null {
  if (provider.legacyEnv.allTenants) return null;
  const own = new Set(provider.overrides.map((o) => o.tenantId.toLowerCase()));
  const count = provider.legacyEnv.tenantIds.filter((id) => !own.has(id.toLowerCase())).length;
  if (count === 0) return null;
  const before = provider.global === null ? true : provider.global.enabled;
  const after = next.kind === 'reset' ? true : next.enabled;
  return before === after ? null : { count, enabled: after };
}

/**
 * Qué confirmar antes de cambiar la capa global. Encender para todos también se confirma: un
 * proveedor `opt-in` suele cobrar por consulta y el cambio alcanza a toda la plataforma.
 */
export function globalChangeConfirmation(
  provider: PlatformProvider,
  next: GlobalNext,
): EnablementConfirmation | null {
  const name = providerMetaFor(provider.code).name;
  const exceptions = provider.overrides.length;
  const exceptionNote =
    exceptions === 0
      ? ''
      : exceptions === 1
        ? ' La excepción por tenant de abajo sigue valiendo.'
        : ` Las ${exceptions} excepciones por tenant de abajo siguen valiendo.`;
  const current = globalSwitchState(provider).on;
  const reset = next.kind === 'reset';
  const target = reset ? globalResetOutcome(provider).on : next.enabled;
  if (target === current) {
    // Lo que ven los tenants sin excepción no cambia, pero los que la variable legado enciende uno
    // por uno sí: decir "ningún tenant cambia" encendería o apagaría a esos sin que se sepa.
    const shift = legacyTenantsShift(provider, next);
    if (shift === null) return null;
    const one = shift.count === 1;
    const envVar = `la variable ${legacyEnvVar(provider.vertical)} (legado)`;
    const listed = one
      ? 'el tenant que habilita por su cuenta'
      : `los ${shift.count} tenants que habilita uno por uno`;
    if (shift.enabled) {
      return {
        title: `¿Quitar el ajuste global de ${name}?`,
        description: `Sin ajuste global vuelve a contar ${envVar}: ${listed} ${one ? 'vuelve' : 'vuelven'} a buscar y vender con ${name}.${exceptionNote}`,
        confirmLabel: 'Quitar ajuste',
        destructive: false,
      };
    }
    return {
      title: `¿Deshabilitar ${name} para todos los tenants?`,
      description: `El ajuste global le gana a ${envVar}: ${listed} ${one ? 'deja' : 'dejan'} de buscar y vender con ${name}.${exceptionNote} ${POST_SALE_KEEPS}`,
      confirmLabel: 'Deshabilitar para todos',
      destructive: true,
    };
  }

  const resetNote = reset ? `Sin ajuste global, ${resetPhrase(provider)}. ` : '';
  const title = reset
    ? `¿Quitar el ajuste global de ${name}?`
    : target
      ? `¿Habilitar ${name} para todos los tenants?`
      : `¿Deshabilitar ${name} para todos los tenants?`;

  if (!target) {
    return {
      title,
      description: `${resetNote}Ningún tenant sin excepción propia podrá buscar ni vender con ${name}.${exceptionNote} ${POST_SALE_KEEPS}`,
      confirmLabel: reset ? 'Quitar ajuste' : 'Deshabilitar para todos',
      destructive: true,
    };
  }
  return {
    title,
    description: `${resetNote}Todos los tenants sin excepción propia podrán buscar y vender con ${name}.${exceptionNote}`,
    confirmLabel: reset ? 'Quitar ajuste' : 'Habilitar para todos',
    destructive: false,
  };
}

/** El diálogo de un cambio: la confirmación si la hay y, si no, un texto neutro. */
export interface EnablementChangeDialog extends EnablementConfirmation {
  /** ¿Se pide motivo? Sólo cuando se fija un ajuste: quitarlo (DELETE) no lleva cuerpo. */
  readonly withReason: boolean;
}

/**
 * Todo cambio pasa por un diálogo, confirme o no: es donde se escribe el motivo que queda en la
 * auditoría, y un clic suelto en un panel de plataforma no debería alcanzar para mover nada.
 */
export function tenantChangeDialog(input: {
  readonly providerCode: string;
  readonly tenantName: string;
  readonly from: EnablementChoice;
  readonly to: EnablementChoice;
}): EnablementChangeDialog {
  const withReason = input.to !== 'inherit';
  const confirmation = tenantChangeConfirmation(input);
  if (confirmation !== null) return { ...confirmation, withReason };

  const provider = providerMetaFor(input.providerCode).name;
  const { tenantName, from, to } = input;
  if (from === to) {
    return {
      title: `Motivo de ${provider} en ${tenantName}`,
      description: 'Cambia sólo la nota que acompaña al ajuste; el estado queda igual.',
      confirmLabel: 'Guardar motivo',
      destructive: false,
      withReason,
    };
  }
  if (to === 'enabled') {
    return {
      title: `¿Habilitar ${provider} para ${tenantName}?`,
      description: `${tenantName} y las agencias de su red sin ajuste propio podrán buscar y vender con ${provider}, aunque el ajuste global lo tenga apagado.`,
      confirmLabel: 'Habilitar',
      destructive: false,
      withReason,
    };
  }
  return {
    title: `¿Volver a heredar ${provider} en ${tenantName}?`,
    description: `Deja de estar deshabilitado por un ajuste propio: vale lo que decidan su red o el ajuste global.`,
    confirmLabel: 'Heredar',
    destructive: false,
    withReason,
  };
}

export function globalChangeDialog(
  provider: PlatformProvider,
  next: GlobalNext,
): EnablementChangeDialog {
  const withReason = next.kind === 'set';
  const confirmation = globalChangeConfirmation(provider, next);
  if (confirmation !== null) return { ...confirmation, withReason };

  const name = providerMetaFor(provider.code).name;
  if (next.kind === 'reset') {
    return {
      title: `¿Quitar el ajuste global de ${name}?`,
      description: `Sin ajuste global, ${resetPhrase(provider)}: ningún tenant cambia de estado.`,
      confirmLabel: 'Quitar ajuste',
      destructive: false,
      withReason,
    };
  }
  return {
    title: `Ajuste global de ${name}`,
    description:
      provider.global === null
        ? 'Deja escrito en la plataforma lo que hoy decide la política o la variable legado; ningún tenant cambia de estado.'
        : 'Cambia sólo la nota que acompaña al ajuste; el estado queda igual.',
    confirmLabel: 'Guardar',
    destructive: false,
    withReason,
  };
}

/** El aviso tras guardar. `tenantName` ausente = el ajuste global. */
export function savedMessage(
  providerCode: string,
  choice: EnablementChoice,
  tenantName?: string,
): string {
  const name = providerMetaFor(providerCode).name;
  if (tenantName === undefined) {
    if (choice === 'inherit') return `${name}: sin ajuste global.`;
    return `${name}: ${statusLabel({ enabled: choice === 'enabled' }).toLowerCase()} para todos los tenants.`;
  }
  if (choice === 'inherit') return `${name}: ${tenantName} vuelve a heredar.`;
  return `${name}: ${statusLabel({ enabled: choice === 'enabled' }).toLowerCase()} para ${tenantName}.`;
}

const CALL_POLICY_LABELS: Readonly<Record<EnablementCallPolicy, string>> = {
  always: 'Se consulta en cada búsqueda',
  fallback: 'De respaldo',
  'opt-in': 'Requiere habilitación',
};

export function callPolicyLabel(callPolicy: EnablementCallPolicy): string {
  return CALL_POLICY_LABELS[callPolicy];
}

function resetPhrase(provider: PlatformProvider): string {
  return globalResetOutcome(provider).source === 'legacy-env'
    ? `lo enciende la variable ${legacyEnvVar(provider.vertical)} (legado)`
    : policyPhrase(provider.callPolicy);
}

// ---------------------------------------------------------------------------------------------
// Listas
// ---------------------------------------------------------------------------------------------

const VERTICAL_LABELS: Readonly<Record<EnablementVertical, string>> = {
  flights: 'Vuelos',
  hotels: 'Hoteles',
  cars: 'Autos',
};

export function verticalLabel(vertical: EnablementVertical): string {
  return VERTICAL_LABELS[vertical];
}

/** Agrupa por vertical en el orden de la navegación (vuelos, hoteles, autos), sin grupos vacíos. */
export function groupByVertical<T extends { readonly vertical: EnablementVertical }>(
  providers: readonly T[],
): { vertical: EnablementVertical; label: string; providers: T[] }[] {
  return (['flights', 'hotels', 'cars'] as const)
    .map((vertical) => ({
      vertical,
      label: verticalLabel(vertical),
      providers: providers.filter((p) => p.vertical === vertical),
    }))
    .filter((g) => g.providers.length > 0);
}

/** Nombre para mostrar de una excepción: el tenant pudo borrarse o venir sin nombre. */
export function overrideTenantLabel(override: Pick<TenantOverride, 'tenantName' | 'tenantId'>) {
  return override.tenantName?.trim() || `Tenant ${override.tenantId.slice(0, 8)}`;
}

export function sortOverrides(overrides: readonly TenantOverride[]): TenantOverride[] {
  return [...overrides].sort((a, b) =>
    overrideTenantLabel(a).localeCompare(overrideTenantLabel(b), 'es', { sensitivity: 'base' }),
  );
}

/** "2 habilitados · 1 deshabilitado", o `null` sin excepciones. */
export function overridesSummary(overrides: readonly Pick<TenantOverride, 'enabled'>[]) {
  if (overrides.length === 0) return null;
  const on = overrides.filter((o) => o.enabled).length;
  const off = overrides.length - on;
  const parts = [
    on > 0 ? `${on} ${on === 1 ? 'habilitado' : 'habilitados'}` : null,
    off > 0 ? `${off} ${off === 1 ? 'deshabilitado' : 'deshabilitados'}` : null,
  ].filter((p): p is string => p !== null);
  return parts.join(' · ');
}

export interface TenantOption {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Tenants que se pueden agregar como excepción: coinciden por nombre o slug (sin tildes ni
 * mayúsculas) y todavía no tienen una. Sin texto no se sugiere nada: con cientos de agencias, una
 * lista entera no ayuda a encontrar ninguna.
 */
export function matchTenants(
  tenants: readonly TenantOption[],
  query: string,
  excludeIds: ReadonlySet<string>,
  limit = 8,
): TenantOption[] {
  const q = fold(query);
  if (q === '') return [];
  return tenants
    .filter((t) => !excludeIds.has(t.id.toLowerCase()))
    .filter((t) => fold(t.name).includes(q) || fold(t.slug).includes(q))
    .slice(0, limit);
}

/** Tenants que la variable legado enciende uno por uno, con su nombre si se conoce. */
export function legacyTenantLabels(
  legacy: LegacyEnvOptIn,
  names: ReadonlyMap<string, string>,
): string[] {
  return legacy.tenantIds.map((id) => names.get(id.toLowerCase()) ?? `Tenant ${id.slice(0, 8)}`);
}

/** "por ana@plataforma.co · 28 sep 2026". */
export function updatedLabel(setting: Pick<EnablementSetting, 'updatedAt' | 'updatedByEmail'>) {
  const date = new Date(setting.updatedAt);
  const when = Number.isNaN(date.getTime())
    ? null
    : date.toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' });
  const who = setting.updatedByEmail ?? null;
  return [who ? `por ${who}` : null, when].filter((p): p is string => p !== null).join(' · ');
}

/** El mensaje de una lectura o escritura fallida, para el superadmin. */
export function requestErrorMessage(
  status: number,
  message: string | undefined,
  kind: 'read' | 'write',
): string {
  if (status === 401) return 'Tu sesión venció. Volvé a iniciar sesión.';
  if (status === 403) {
    return 'Sólo el superadmin de la plataforma puede ver y cambiar la habilitación de proveedores.';
  }
  if (message && message.trim() !== '') return message;
  return kind === 'write'
    ? 'No se pudo guardar el cambio. Probá de nuevo.'
    : 'No se pudo cargar la habilitación de proveedores. Probá de nuevo.';
}
