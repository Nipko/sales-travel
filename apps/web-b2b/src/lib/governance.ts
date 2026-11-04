import type { EnablementChangeDialog } from './provider-enablement';

/**
 * Gobierno de proveedores y formas de pago — lado del navegador, sólo superadmin
 * (docs/platform/14-opciones-de-pago.md).
 *
 * La regla (el nodo más cercano que diga algo; en el mismo nodo la regla a mano le gana al perfil;
 * después la global; si nadie dice nada, apagado) la resuelve el API (`/admin/governance`). Acá
 * viven la lectura desconfiada de sus respuestas, la validación de los cuerpos que reenvía el proxy
 * y las frases con que la pantalla explica de dónde sale cada celda.
 */

export type GovernanceVertical = 'flights' | 'hotels' | 'cars';
export type PaymentPciScope = 'none' | 'saq-a' | 'out-of-scope';

export interface GovernedPaymentMethod {
  readonly code: string;
  readonly use: string;
  readonly label: string;
  readonly description: string;
  readonly pci: PaymentPciScope;
}

/** Un proveedor del catálogo con sus formas de pago (`GET /admin/governance/catalog`). */
export interface GovernedProvider {
  readonly code: string;
  readonly label: string;
  readonly vertical: GovernanceVertical;
  readonly paymentMethods: readonly GovernedPaymentMethod[];
}

/** `method: ''` = el proveedor mismo. */
export interface GovernanceItemKey {
  readonly provider: string;
  readonly method: string;
}

export interface ProfileItem extends GovernanceItemKey {
  readonly enabled: boolean;
}

/** Espejo de `ProfileView`. */
export interface GovernanceProfile {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly isDefaultForNewNodes: boolean;
  readonly archived: boolean;
  readonly items: readonly ProfileItem[];
  readonly tenantCount: number;
  /** ISO 8601. */
  readonly updatedAt: string;
}

/** Espejo de `RuleView`. `tenantId: null` = regla global. */
export interface GovernanceRule extends GovernanceItemKey {
  readonly tenantId: string | null;
  readonly enabled: boolean;
  readonly reason: string | null;
  readonly updatedAt: string;
}

export type GovernanceOrigin =
  | { readonly kind: 'rule'; readonly tenantId: string | null }
  | {
      readonly kind: 'profile';
      readonly tenantId: string;
      readonly profileId: string;
      readonly profileName: string;
    }
  | { readonly kind: 'default' }
  | { readonly kind: 'provider-off' };

export interface EffectiveCell extends GovernanceItemKey {
  readonly enabled: boolean;
  readonly origin: GovernanceOrigin;
  readonly originTenantName: string | null;
}

/** Espejo de `TenantGovernanceView`. */
export interface TenantGovernance {
  readonly tenant: { readonly id: string; readonly name: string; readonly type: string };
  readonly profile: { readonly id: string; readonly name: string } | null;
  readonly rules: readonly GovernanceRule[];
  readonly effective: readonly EffectiveCell[];
}

// ---------------------------------------------------------------------------------------------
// Lectura de las respuestas
// ---------------------------------------------------------------------------------------------

/*
 * Como en la habilitación de proveedores: una respuesta con forma incompleta se rechaza ENTERA. En
 * un panel que decide qué se vende y qué se cobra, pintar «apagado» porque faltó un campo es peor
 * que no pintar nada.
 */

type Raw = Record<string, unknown>;

const VERTICALS: readonly string[] = ['flights', 'hotels', 'cars'];
const PCI_SCOPES: readonly string[] = ['none', 'saq-a', 'out-of-scope'];

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

function oneOf<T extends string>(value: unknown, allowed: readonly string[]): value is T {
  return typeof value === 'string' && allowed.includes(value);
}

/** Todos o ninguno: un elemento roto invalida la lista. */
function allOf<T>(value: unknown, parse: (v: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = value.map(parse);
  return parsed.some((p) => p === undefined) ? undefined : (parsed as T[]);
}

/** Una fecha que llega como ISO (JSON de un `Date`). */
function isDateString(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
}

function parseMethod(value: unknown): GovernedPaymentMethod | undefined {
  if (!isRecord(value)) return undefined;
  const { code, use, label, description, pci } = value;
  if (typeof code !== 'string' || code === '' || typeof use !== 'string') return undefined;
  if (typeof label !== 'string' || typeof description !== 'string') return undefined;
  if (!oneOf<PaymentPciScope>(pci, PCI_SCOPES)) return undefined;
  return { code, use, label, description, pci };
}

function parseProvider(value: unknown): GovernedProvider | undefined {
  if (!isRecord(value)) return undefined;
  const { code, label, vertical } = value;
  if (typeof code !== 'string' || code === '' || typeof label !== 'string') return undefined;
  if (!oneOf<GovernanceVertical>(vertical, VERTICALS)) return undefined;
  const paymentMethods = allOf(value['paymentMethods'], parseMethod);
  if (paymentMethods === undefined) return undefined;
  return { code, label, vertical, paymentMethods };
}

/** `GET /admin/governance/catalog`. */
export function parseCatalog(value: unknown): GovernedProvider[] | undefined {
  return allOf(value, parseProvider);
}

function parseItem(value: unknown): ProfileItem | undefined {
  if (!isRecord(value)) return undefined;
  const { provider, method, enabled } = value;
  if (typeof provider !== 'string' || provider === '' || typeof method !== 'string') {
    return undefined;
  }
  if (typeof enabled !== 'boolean') return undefined;
  return { provider, method, enabled };
}

/** Un perfil, o la respuesta de crear, editar, duplicar, archivar o marcar predeterminado. */
export function parseProfile(value: unknown): GovernanceProfile | undefined {
  if (!isRecord(value)) return undefined;
  const { id, name, description, isDefaultForNewNodes, archived, tenantCount, updatedAt } = value;
  if (typeof id !== 'string' || id === '' || typeof name !== 'string') return undefined;
  if (!isStringOrNull(description)) return undefined;
  if (typeof isDefaultForNewNodes !== 'boolean' || typeof archived !== 'boolean') return undefined;
  if (typeof tenantCount !== 'number' || !Number.isInteger(tenantCount) || tenantCount < 0) {
    return undefined;
  }
  if (!isDateString(updatedAt)) return undefined;
  const items = allOf(value['items'], parseItem);
  if (items === undefined) return undefined;
  return {
    id: id.toLowerCase(),
    name,
    description,
    isDefaultForNewNodes,
    archived,
    items,
    tenantCount,
    updatedAt,
  };
}

/** `GET /admin/governance/profiles`. */
export function parseProfiles(value: unknown): GovernanceProfile[] | undefined {
  return allOf(value, parseProfile);
}

function parseRule(value: unknown): GovernanceRule | undefined {
  const item = parseItem(value);
  if (item === undefined || !isRecord(value)) return undefined;
  const { tenantId, reason, updatedAt } = value;
  if (!isStringOrNull(tenantId) || !isStringOrNull(reason) || !isDateString(updatedAt)) {
    return undefined;
  }
  return {
    ...item,
    tenantId: tenantId === null ? null : tenantId.toLowerCase(),
    reason,
    updatedAt,
  };
}

/** `GET /admin/governance/rules`, o la respuesta de `PUT /admin/governance/rules`. */
export function parseRules(value: unknown): GovernanceRule[] | undefined {
  return allOf(value, parseRule);
}

function parseOrigin(value: unknown): GovernanceOrigin | undefined {
  if (!isRecord(value)) return undefined;
  switch (value['kind']) {
    case 'rule': {
      const tenantId = value['tenantId'];
      if (!isStringOrNull(tenantId)) return undefined;
      return { kind: 'rule', tenantId: tenantId === null ? null : tenantId.toLowerCase() };
    }
    case 'profile': {
      const { tenantId, profileId, profileName } = value;
      if (typeof tenantId !== 'string' || typeof profileId !== 'string') return undefined;
      if (typeof profileName !== 'string') return undefined;
      return {
        kind: 'profile',
        tenantId: tenantId.toLowerCase(),
        profileId: profileId.toLowerCase(),
        profileName,
      };
    }
    case 'default':
      return { kind: 'default' };
    case 'provider-off':
      return { kind: 'provider-off' };
    default:
      return undefined;
  }
}

function parseCell(value: unknown): EffectiveCell | undefined {
  if (!isRecord(value)) return undefined;
  const { provider, method, enabled, originTenantName } = value;
  if (typeof provider !== 'string' || provider === '' || typeof method !== 'string') {
    return undefined;
  }
  if (typeof enabled !== 'boolean') return undefined;
  if (originTenantName !== undefined && !isStringOrNull(originTenantName)) return undefined;
  const origin = parseOrigin(value['origin']);
  if (origin === undefined) return undefined;
  // Las dos razones de apagado no pueden venir encendidas: sería una matriz que se contradice.
  if (enabled && (origin.kind === 'default' || origin.kind === 'provider-off')) return undefined;
  return { provider, method, enabled, origin, originTenantName: originTenantName ?? null };
}

/** `GET /admin/governance/tenants/:tenantId` y `PUT .../profile`. */
export function parseTenantGovernance(value: unknown): TenantGovernance | undefined {
  if (!isRecord(value)) return undefined;
  const tenant = value['tenant'];
  if (!isRecord(tenant)) return undefined;
  const { id, name, type } = tenant;
  if (typeof id !== 'string' || typeof name !== 'string' || typeof type !== 'string') {
    return undefined;
  }
  const rawProfile = value['profile'];
  let profile: TenantGovernance['profile'];
  if (rawProfile === null) profile = null;
  else if (
    isRecord(rawProfile) &&
    typeof rawProfile['id'] === 'string' &&
    typeof rawProfile['name'] === 'string'
  ) {
    profile = { id: rawProfile['id'].toLowerCase(), name: rawProfile['name'] };
  } else return undefined;
  const rules = allOf(value['rules'], parseRule);
  const effective = allOf(value['effective'], parseCell);
  if (rules === undefined || effective === undefined) return undefined;
  return { tenant: { id: id.toLowerCase(), name, type }, profile, rules, effective };
}

// ---------------------------------------------------------------------------------------------
// Bordes del proxy (`app/api/admin/governance/...`)
// ---------------------------------------------------------------------------------------------

/** El mismo formato que `governance.schemas.ts` del API. */
const PROVIDER_CODE = /^[a-z0-9-]{1,64}$/;
const METHOD_CODE = /^[a-z0-9_]{0,64}$/;

export function isGovernanceProviderCode(value: unknown): value is string {
  return typeof value === 'string' && PROVIDER_CODE.test(value);
}

/** `''` es válido: es el proveedor mismo. */
export function isGovernanceMethodCode(value: unknown): value is string {
  return typeof value === 'string' && METHOD_CODE.test(value);
}

export const PROFILE_NAME_MIN = 2;
export const PROFILE_NAME_MAX = 80;
export const DESCRIPTION_MAX = 500;
export const REASON_MAX = 500;
export const PROFILE_ITEMS_MAX = 200;

/** Vacío o sólo espacios es «sin texto», como en el API. */
function normalizeText(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/** El nombre de un perfil: `undefined` si no cumple el largo. */
export function parseProfileName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length >= PROFILE_NAME_MIN && trimmed.length <= PROFILE_NAME_MAX
    ? trimmed
    : undefined;
}

/** Descripción o motivo opcional: `null` si vacío, `undefined` si no es texto o se pasa del tope. */
export function parseOptionalText(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  const normalized = normalizeText(value);
  return normalized !== null && normalized.length > max ? undefined : normalized;
}

/** La lista de elementos de un perfil, rearmada uno por uno y sin repetidos. */
export function parseProfileItems(value: unknown): ProfileItem[] | undefined {
  if (!Array.isArray(value) || value.length > PROFILE_ITEMS_MAX) return undefined;
  const seen = new Set<string>();
  const items: ProfileItem[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) return undefined;
    const { provider, enabled } = raw;
    const method = raw['method'] ?? '';
    if (!isGovernanceProviderCode(provider) || !isGovernanceMethodCode(method)) return undefined;
    if (typeof enabled !== 'boolean') return undefined;
    const key = itemKey({ provider, method });
    if (seen.has(key)) return undefined;
    seen.add(key);
    items.push({ provider, method, enabled });
  }
  return items;
}

// ---------------------------------------------------------------------------------------------
// La matriz: una celda por proveedor y por cada forma de pago
// ---------------------------------------------------------------------------------------------

/** Encendido, apagado o «no lo decide» (el perfil no lo dice / la regla no existe: hereda). */
export type CellChoice = 'on' | 'off' | 'unset';

export function itemKey(key: GovernanceItemKey): string {
  return `${key.provider}:${key.method}`;
}

/** Las decisiones de un perfil o de un conjunto de reglas, por celda. */
export function choicesOf(
  items: readonly Pick<ProfileItem, 'provider' | 'method' | 'enabled'>[],
): Map<string, CellChoice> {
  return new Map(items.map((i) => [itemKey(i), i.enabled ? 'on' : 'off'] as const));
}

export function choiceAt(choices: ReadonlyMap<string, CellChoice>, key: GovernanceItemKey) {
  return choices.get(itemKey(key)) ?? 'unset';
}

/**
 * Los elementos explícitos de un perfil, en el orden del catálogo. «No decide» no viaja: un
 * elemento ausente es exactamente eso para el API.
 */
export function itemsFromChoices(
  catalog: readonly GovernedProvider[],
  choices: ReadonlyMap<string, CellChoice>,
): ProfileItem[] {
  return catalogKeys(catalog).flatMap((key): ProfileItem[] => {
    const choice = choiceAt(choices, key);
    return choice === 'unset' ? [] : [{ ...key, enabled: choice === 'on' }];
  });
}

/** Cada celda del catálogo: el proveedor y después sus formas de pago. */
export function catalogKeys(catalog: readonly GovernedProvider[]): GovernanceItemKey[] {
  return catalog.flatMap((p) => [
    { provider: p.code, method: '' },
    ...p.paymentMethods.map((m) => ({ provider: p.code, method: m.code })),
  ]);
}

const VERTICAL_LABELS: Readonly<Record<GovernanceVertical, string>> = {
  flights: 'Vuelos',
  hotels: 'Hoteles',
  cars: 'Autos',
};

/** Agrupa por vertical (vuelos, hoteles, autos), sin grupos vacíos. */
export function groupCatalog(
  catalog: readonly GovernedProvider[],
): { vertical: GovernanceVertical; label: string; providers: GovernedProvider[] }[] {
  return (['flights', 'hotels', 'cars'] as const)
    .map((vertical) => ({
      vertical,
      label: VERTICAL_LABELS[vertical],
      providers: catalog.filter((p) => p.vertical === vertical),
    }))
    .filter((g) => g.providers.length > 0);
}

/** El nombre de una celda para leer en voz alta o en un aviso: «LATAM NDC · Enlace de pago». */
export function cellLabel(catalog: readonly GovernedProvider[], key: GovernanceItemKey): string {
  const provider = catalog.find((p) => p.code === key.provider);
  if (provider === undefined) return key.method === '' ? key.provider : itemKey(key);
  if (key.method === '') return provider.label;
  const method = provider.paymentMethods.find((m) => m.code === key.method);
  return `${provider.label} · ${method?.label ?? key.method}`;
}

export const PCI_LABELS: Readonly<Record<PaymentPciScope, string>> = {
  none: 'Sin tarjeta',
  'saq-a': 'PCI SAQ-A',
  'out-of-scope': 'Fuera de SAQ-A',
};

export const PCI_OUT_OF_SCOPE_WARNING = 'La tarjeta pasa por nuestro servidor: fuera de PCI SAQ-A.';

/** Cuántas celdas enciende y apaga un perfil, para la lista. */
export function profileSummary(profile: Pick<GovernanceProfile, 'items'>): string {
  const on = profile.items.filter((i) => i.enabled).length;
  const off = profile.items.length - on;
  if (profile.items.length === 0) return 'No decide nada: todo queda a la herencia.';
  const parts = [
    on === 1 ? '1 encendido' : `${on} encendidos`,
    off === 1 ? '1 apagado' : `${off} apagados`,
  ];
  return parts.join(' · ');
}

export function nodesUsingLabel(count: number): string {
  if (count === 0) return 'Ningún nodo lo usa';
  return count === 1 ? '1 nodo lo usa' : `${count} nodos lo usan`;
}

/** El aviso al editar un perfil enlazado: lo que cambia alcanza a todos los que lo usan. */
export function profileEditWarning(tenantCount: number): string | null {
  if (tenantCount === 0) return null;
  return tenantCount === 1
    ? 'Cambia a 1 nodo que usa este perfil: el cambio vale para él al guardar.'
    : `Cambia a ${tenantCount} nodos que usan este perfil: el cambio vale para todos al guardar.`;
}

/** El perfil que se propone al dar de alta un nodo, si hay uno vigente marcado. */
export function defaultProfileFor(profiles: readonly GovernanceProfile[]): string {
  return profiles.find((p) => p.isDefaultForNewNodes && !p.archived)?.id ?? '';
}

/** Los perfiles que se pueden asignar, más el actual aunque esté archivado (para no perderlo). */
export function assignableProfiles(
  profiles: readonly GovernanceProfile[],
  currentId?: string | null,
): GovernanceProfile[] {
  return profiles
    .filter((p) => !p.archived || p.id === currentId)
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

/**
 * Las validaciones del formulario de perfil, para mostrar antes de llamar al API.
 * `undefined` = sin errores.
 */
export function profileFormErrors(input: {
  readonly name: string;
  readonly description: string;
}): { name?: string; description?: string } | undefined {
  const errors: { name?: string; description?: string } = {};
  if (parseProfileName(input.name) === undefined) {
    errors.name = `El nombre lleva entre ${PROFILE_NAME_MIN} y ${PROFILE_NAME_MAX} caracteres.`;
  }
  if (input.description.trim().length > DESCRIPTION_MAX) {
    errors.description = `La descripción no puede superar los ${DESCRIPTION_MAX} caracteres.`;
  }
  return Object.keys(errors).length === 0 ? undefined : errors;
}

// ---------------------------------------------------------------------------------------------
// El origen de cada celda efectiva
// ---------------------------------------------------------------------------------------------

/**
 * Por qué una celda está como está. `viewingTenantId` es el nodo desde el que se mira: lo suyo se
 * dice «en este nodo».
 */
export function effectiveOriginLabel(cell: EffectiveCell, viewingTenantId?: string): string {
  const { origin } = cell;
  const where = (tenantId: string): string => {
    if (viewingTenantId !== undefined && tenantId === viewingTenantId.toLowerCase()) {
      return 'este nodo';
    }
    return cell.originTenantName?.trim() || 'un nodo superior';
  };
  switch (origin.kind) {
    case 'rule':
      return origin.tenantId === null
        ? 'Regla global'
        : `Regla a mano en ${where(origin.tenantId)}`;
    case 'profile':
      return `Perfil «${origin.profileName}» en ${where(origin.tenantId)}`;
    case 'default':
      return 'Apagado: nadie lo habilitó';
    case 'provider-off':
      return 'Apagado: el proveedor está apagado';
  }
}

export function savedRuleMessage(label: string, choice: CellChoice, scope: string): string {
  if (choice === 'unset') return `${label}: se quitó la regla de ${scope}.`;
  return `${label}: ${choice === 'on' ? 'encendido' : 'apagado'} en ${scope}.`;
}

// ---------------------------------------------------------------------------------------------
// El diálogo de una regla a mano
// ---------------------------------------------------------------------------------------------

const ALREADY_SOLD =
  'Las reservas ya hechas no se tocan: se siguen consultando, cancelando y conciliando.';

/**
 * Qué confirmar antes de fijar o quitar una regla a mano. `tenantName: null` = regla global.
 * Toda regla pasa por el diálogo: es donde se escribe el motivo que queda en la auditoría.
 */
export function ruleChangeDialog(input: {
  readonly label: string;
  readonly tenantName: string | null;
  readonly from: CellChoice;
  readonly to: CellChoice;
}): EnablementChangeDialog {
  const { label, tenantName, from, to } = input;
  const where = tenantName === null ? 'para toda la plataforma' : `en ${tenantName}`;
  const reach =
    tenantName === null
      ? 'Vale para toda la plataforma, salvo donde un nodo (con regla a mano o perfil) diga otra cosa.'
      : `Vale para ${tenantName} y su red, salvo donde un nodo más cercano diga otra cosa. Le gana al perfil asignado a ${tenantName}.`;
  if (to === 'unset') {
    return {
      title: `¿Quitar la regla de ${label} ${where}?`,
      description:
        tenantName === null
          ? 'Sin regla global, donde ningún nodo lo decida queda apagado: nada se enciende solo.'
          : `${tenantName} vuelve a seguir su perfil o lo que herede de su red.`,
      confirmLabel: 'Quitar regla',
      destructive: from === 'on',
      withReason: false,
    };
  }
  if (to === 'off') {
    return {
      title: from === 'off' ? `Motivo de la regla de ${label}` : `¿Apagar ${label} ${where}?`,
      description: `${reach} Deja de venderse o cobrarse con esto. ${ALREADY_SOLD}`,
      confirmLabel: from === 'off' ? 'Guardar motivo' : 'Apagar',
      destructive: from !== 'off',
      withReason: true,
    };
  }
  return {
    title: from === 'on' ? `Motivo de la regla de ${label}` : `¿Encender ${label} ${where}?`,
    description: reach,
    confirmLabel: from === 'on' ? 'Guardar motivo' : 'Encender',
    destructive: false,
    withReason: true,
  };
}
