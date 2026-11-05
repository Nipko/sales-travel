import type { Route } from 'next';
import { PLATFORM_TIME_ZONE, todayIn } from './platform-overview';
import { isUuid } from './wallets';

/**
 * Plataforma → Actividad (`GET /admin/audit`, `GET /admin/audit/export`): quién hizo qué, dónde y
 * cuándo, en toda la plataforma. Los filtros y su URL, la lectura de las respuestas y los textos de
 * la pantalla. Sin I/O. Los nombres de cada evento son los de lib/audit-format (eventLabel,
 * eventDetail), los mismos del historial de una persona y de la Actividad de la red.
 */

export const PLATFORM_ACTIVITY: Route = '/admin/plataforma/actividad';

// ───────────────────────────── Categorías ─────────────────────────────

/** PLATFORM_AUDIT_CATEGORIES del API (apps/api/src/audit/audit-categories.ts). */
export const ACTIVITY_CATEGORIES = [
  'access',
  'team',
  'network',
  'wallets',
  'providers',
  'orders',
  'system',
  'superadmins',
] as const;
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

export function isActivityCategory(value: unknown): value is ActivityCategory {
  return typeof value === 'string' && (ACTIVITY_CATEGORIES as readonly string[]).includes(value);
}

/** Los chips: "Todo" (`null`) y cada categoría. */
export const ACTIVITY_CATEGORY_CHIPS: readonly {
  readonly id: ActivityCategory | null;
  readonly label: string;
}[] = [
  { id: null, label: 'Todo' },
  { id: 'access', label: 'Accesos' },
  { id: 'team', label: 'Equipo' },
  { id: 'network', label: 'Red' },
  { id: 'wallets', label: 'Carteras' },
  { id: 'providers', label: 'Proveedores' },
  { id: 'orders', label: 'Reservas' },
  { id: 'system', label: 'Sistema' },
  { id: 'superadmins', label: 'Superadmins' },
];

/**
 * Qué tipos entran en cada categoría, por el prefijo del tipo. Espejo de
 * PLATFORM_AUDIT_CATEGORY_PREFIXES del API: un test compara las dos listas.
 */
export const ACTIVITY_CATEGORY_PREFIXES: Readonly<
  Record<
    ActivityCategory,
    { readonly include: readonly string[]; readonly exclude?: readonly string[] }
  >
> = {
  access: { include: ['auth.'] },
  team: { include: ['User', 'Membership', 'users.'] },
  network: {
    include: ['tenant.', 'Tenant', 'booking.', 'Markup', 'mail.'],
    exclude: ['tenant.provider_disclosure'],
  },
  wallets: { include: ['portfolio.', 'portfolios.', 'wallet_hold.'] },
  providers: { include: ['platform.provider', 'Provider', 'tenant.provider_disclosure'] },
  orders: { include: ['Order', 'Hotel', 'CarReservation', 'platform.order.'] },
  system: { include: ['system.', 'platform.announcement', 'platform.audit', 'platform.orders'] },
  superadmins: { include: ['platform.superadmin', 'platform.change_request', 'db.'] },
};

/** La categoría de un tipo de evento, o `null` (sólo aparece en "Todo"). */
export function activityCategoryOf(eventType: string): ActivityCategory | null {
  for (const category of ACTIVITY_CATEGORIES) {
    const { include, exclude = [] } = ACTIVITY_CATEGORY_PREFIXES[category];
    if (
      include.some((p) => eventType.startsWith(p)) &&
      !exclude.some((p) => eventType.startsWith(p))
    ) {
      return category;
    }
  }
  return null;
}

export function activityCategoryLabel(category: ActivityCategory | null): string {
  return ACTIVITY_CATEGORY_CHIPS.find((c) => c.id === category)?.label ?? 'Todo';
}

// ───────────────────────────── Filtros ─────────────────────────────

/** Lo más largo que admite el API (AUDIT_MAX_DAYS). */
export const ACTIVITY_MAX_DAYS = 92;
/** Sin fechas, los últimos 7 días (AUDIT_DEFAULT_DAYS del API). */
export const ACTIVITY_DEFAULT_DAYS = 7;
/** Lo más que exporta un CSV (ADMIN_AUDIT_EXPORT_MAX_ROWS del API). */
export const ACTIVITY_EXPORT_MAX_ROWS = 5000;

export const EVENT_TYPE = /^[A-Za-z0-9_.]{2,80}$/;
export const AGGREGATE_TYPE = /^[a-z_]{2,40}$/;
export const AGGREGATE_ID_MAX = 100;
/** Lo que el API acepta como correo: algo@algo.algo, sin espacios. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const EMAIL_MAX = 254;

export interface ActivityFilters {
  /** `null` = "Todo" (sin los latidos del barrido, que van en "Sistema"). */
  readonly category: ActivityCategory | null;
  /** Días de Bogotá, `AAAA-MM-DD`, ambos incluidos. `null` = los últimos 7 días. */
  readonly from: string | null;
  readonly to: string | null;
  /** Un nodo y su red, o `null`: toda la plataforma (con los eventos sin nodo). */
  readonly tenantId: string | null;
  /** El correo de quien actuó, tal como se escribe. No va en la URL (ver activityHref). */
  readonly actorEmail: string;
  /** Un tipo exacto (desde el detalle de un evento). */
  readonly eventType: string | null;
  /** Una entidad y su id (desde el detalle de un evento o la ficha de una reserva). */
  readonly aggregateType: string | null;
  readonly aggregateId: string | null;
  /**
   * Sólo lo que hicieron superadmins (plenos, supervisados o que ya no lo son) y los cambios hechos
   * directo en la base, fuera del panel.
   */
  readonly platformOnly: boolean;
}

export const DEFAULT_ACTIVITY_FILTERS: ActivityFilters = {
  category: null,
  from: null,
  to: null,
  tenantId: null,
  actorEmail: '',
  eventType: null,
  aggregateType: null,
  aggregateId: null,
  platformOnly: false,
};

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** Un día calendario que existe (`2026-02-30` no). */
export function isCalendarDay(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = ISO_DAY.exec(value);
  if (m === null) return false;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return date.toISOString().slice(0, 10) === value;
}

export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Días entre dos fechas, ambas incluidas. */
export function spanDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

/** El período que se mira: el puesto o, sin fechas, los últimos 7 días hasta hoy (Bogotá). */
export function effectivePeriod(
  filters: Pick<ActivityFilters, 'from' | 'to'>,
  now: Date,
): { readonly from: string; readonly to: string } {
  const to = filters.to ?? todayIn(PLATFORM_TIME_ZONE, now);
  const from = filters.from ?? addDays(to, -(ACTIVITY_DEFAULT_DAYS - 1));
  return from <= to ? { from, to } : { from: to, to: from };
}

/**
 * Cambia "desde" o "hasta". El pedido nunca vuelve con un 400: si queda al revés, el otro extremo lo
 * acompaña; si pasa de 92 días, el otro extremo se acerca.
 */
export function withDate(
  filters: ActivityFilters,
  key: 'from' | 'to',
  value: string,
  now: Date,
): ActivityFilters {
  if (!isCalendarDay(value)) return filters;
  const current = effectivePeriod(filters, now);
  let { from, to } = current;
  if (key === 'from') {
    from = value;
    if (to < from) to = from;
    if (spanDays(from, to) > ACTIVITY_MAX_DAYS) to = addDays(from, ACTIVITY_MAX_DAYS - 1);
  } else {
    to = value;
    if (from > to) from = to;
    if (spanDays(from, to) > ACTIVITY_MAX_DAYS) from = addDays(to, -(ACTIVITY_MAX_DAYS - 1));
  }
  return { ...filters, from, to };
}

export type ActivityPreset = 'today' | '7d' | '30d' | '90d';

export const ACTIVITY_PRESETS: readonly {
  readonly value: ActivityPreset;
  readonly label: string;
}[] = [
  { value: 'today', label: 'Hoy' },
  { value: '7d', label: '7 días' },
  { value: '30d', label: '30 días' },
  { value: '90d', label: '90 días' },
];

const PRESET_DAYS: Readonly<Record<ActivityPreset, number>> = {
  today: 1,
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

/** Los días de un atajo, en Bogotá como el API. */
export function presetRange(preset: ActivityPreset, now: Date): { from: string; to: string } {
  const to = todayIn(PLATFORM_TIME_ZONE, now);
  return { from: addDays(to, -(PRESET_DAYS[preset] - 1)), to };
}

export function withPreset(
  filters: ActivityFilters,
  preset: ActivityPreset,
  now: Date,
): ActivityFilters {
  // Los 7 días son lo de siempre: sin fechas, la URL queda limpia.
  if (preset === '7d') return { ...filters, from: null, to: null };
  return { ...filters, ...presetRange(preset, now) };
}

/** El atajo que coincide con las fechas que se miran, si alguno. */
export function activePreset(filters: ActivityFilters, now: Date): ActivityPreset | null {
  const period = effectivePeriod(filters, now);
  for (const { value } of ACTIVITY_PRESETS) {
    const range = presetRange(value, now);
    if (period.from === range.from && period.to === range.to) return value;
  }
  return null;
}

/** El correo como lo acepta el API (completo, en minúsculas), o `null` si todavía no lo es. */
export function actorEmailTerm(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  return email.length <= EMAIL_MAX && EMAIL.test(email) ? email : null;
}

/** ¿Hay algo filtrado además de lo de siempre? Para "Limpiar filtros" y el contador del teléfono. */
export function activeFilterCount(filters: ActivityFilters): number {
  return (
    (filters.category !== null ? 1 : 0) +
    (filters.from !== null || filters.to !== null ? 1 : 0) +
    (filters.tenantId !== null ? 1 : 0) +
    (actorEmailTerm(filters.actorEmail) !== null ? 1 : 0) +
    (filters.eventType !== null ? 1 : 0) +
    (filters.aggregateType !== null ? 1 : 0) +
    (filters.platformOnly ? 1 : 0)
  );
}

export function clearedFilters(): ActivityFilters {
  return DEFAULT_ACTIVITY_FILTERS;
}

// ───────────────────────────── La URL de la pantalla ─────────────────────────────

/** `?categoria=`: cómo va cada categoría en la URL. */
const CATEGORY_PARAM: Readonly<Record<ActivityCategory, string>> = {
  access: 'accesos',
  team: 'equipo',
  network: 'red',
  wallets: 'carteras',
  providers: 'proveedores',
  orders: 'reservas',
  system: 'sistema',
  superadmins: 'superadmins',
};

type SearchParamsLike =
  | URLSearchParams
  | Readonly<Record<string, string | readonly string[] | undefined>>;

function paramOf(params: SearchParamsLike, key: string): string | undefined {
  if (params instanceof URLSearchParams) return params.get(key) ?? undefined;
  const value = params[key];
  return typeof value === 'string' ? value : value?.[0];
}

function cleanAggregateId(value: string | undefined): string | null {
  const id = value?.trim();
  return id !== undefined && id !== '' && id.length <= AGGREGATE_ID_MAX && !/\p{Cc}/u.test(id)
    ? id
    : null;
}

/**
 * Los filtros de `?categoria=reservas&desde=AAAA-MM-DD&hasta=AAAA-MM-DD&nodo=<uuid>&tipo=<código>
 * &entidad=order&id=<id>`. Un valor que no se conoce se ignora: un enlace viejo o editado a mano
 * abre la actividad, no un error. Un período de más de 92 días se acorta desde "hasta".
 */
export function activityFiltersFromSearchParams(params: SearchParamsLike): ActivityFilters {
  const categoria = paramOf(params, 'categoria')?.trim().toLowerCase();
  const category =
    (Object.keys(CATEGORY_PARAM) as ActivityCategory[]).find(
      (c) => CATEGORY_PARAM[c] === categoria,
    ) ?? null;
  const desde = paramOf(params, 'desde');
  const hasta = paramOf(params, 'hasta');
  let from = isCalendarDay(desde) ? desde : null;
  let to = isCalendarDay(hasta) ? hasta : null;
  if (from !== null && to !== null) {
    if (from > to) [from, to] = [to, from];
    if (spanDays(from, to) > ACTIVITY_MAX_DAYS) from = addDays(to, -(ACTIVITY_MAX_DAYS - 1));
  } else if (from !== null || to !== null) {
    // Con un solo extremo no se sabe qué período se quería: el de siempre.
    from = null;
    to = null;
  }
  const nodo = paramOf(params, 'nodo');
  const tipo = paramOf(params, 'tipo')?.trim();
  const entidad = paramOf(params, 'entidad')?.trim();
  const aggregateType = entidad !== undefined && AGGREGATE_TYPE.test(entidad) ? entidad : null;
  const aggregateId = aggregateType === null ? null : cleanAggregateId(paramOf(params, 'id'));
  return {
    category,
    from,
    to,
    tenantId: isUuid(nodo) ? nodo.toLowerCase() : null,
    actorEmail: '',
    eventType: tipo !== undefined && EVENT_TYPE.test(tipo) ? tipo : null,
    aggregateType: aggregateId === null ? null : aggregateType,
    aggregateId,
    platformOnly: paramOf(params, 'solo')?.trim().toLowerCase() === 'superadmins',
  };
}

/**
 * La query de la pantalla: sólo lo que se aparta de lo de siempre. El correo de quien actuó NO va:
 * una URL queda en el historial, en los registros del servidor y en lo que se comparte (como la
 * búsqueda de Reservas de la red).
 */
export function activityFiltersToSearchParams(filters: ActivityFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.category !== null) params.set('categoria', CATEGORY_PARAM[filters.category]);
  if (filters.from !== null && filters.to !== null) {
    params.set('desde', filters.from);
    params.set('hasta', filters.to);
  }
  if (filters.tenantId !== null && isUuid(filters.tenantId)) {
    params.set('nodo', filters.tenantId.toLowerCase());
  }
  if (filters.eventType !== null) params.set('tipo', filters.eventType);
  if (filters.aggregateType !== null && filters.aggregateId !== null) {
    params.set('entidad', filters.aggregateType);
    params.set('id', filters.aggregateId);
  }
  if (filters.platformOnly) params.set('solo', 'superadmins');
  return params;
}

export function activityHref(filters: ActivityFilters): Route {
  const query = activityFiltersToSearchParams(filters).toString();
  return query === '' ? PLATFORM_ACTIVITY : `${PLATFORM_ACTIVITY}?${query}`;
}

/**
 * La actividad de una reserva, desde su ficha: la entidad y los 92 días desde que se creó (o hasta
 * hoy, si es más reciente).
 */
export function orderActivityHref(orderId: string, createdAt: string, now: Date): Route {
  const created = new Date(createdAt);
  const today = todayIn(PLATFORM_TIME_ZONE, now);
  const start = Number.isNaN(created.getTime()) ? today : todayIn(PLATFORM_TIME_ZONE, created);
  const end = addDays(start, ACTIVITY_MAX_DAYS - 1);
  return activityHref({
    ...DEFAULT_ACTIVITY_FILTERS,
    from: start <= today ? start : today,
    to: end < today ? end : today,
    aggregateType: 'order',
    aggregateId: orderId.toLowerCase(),
  });
}

/** La ficha de una reserva en Reservas de la red. */
export function orderSheetHref(orderId: string): Route {
  return `/admin/plataforma/reservas?orden=${encodeURIComponent(orderId.toLowerCase())}`;
}

// ───────────────────────────── El pedido al BFF ─────────────────────────────

/**
 * La query del BFF (`/api/admin/audit`, `/api/admin/audit/export`). Las fechas van siempre, ya
 * resueltas: la lista y su exportación miran el mismo período aunque se cruce la medianoche.
 */
export function activitySearch(
  filters: ActivityFilters,
  now: Date,
  cursor?: string | null,
  limit?: number,
): string {
  const params = new URLSearchParams();
  const period = effectivePeriod(filters, now);
  params.set('from', period.from);
  params.set('to', period.to);
  if (filters.category !== null) params.set('category', filters.category);
  if (filters.tenantId !== null && isUuid(filters.tenantId)) {
    params.set('tenantId', filters.tenantId.toLowerCase());
  }
  const email = actorEmailTerm(filters.actorEmail);
  if (email !== null) params.set('actorEmail', email);
  if (filters.eventType !== null) params.set('eventType', filters.eventType);
  if (filters.aggregateType !== null && filters.aggregateId !== null) {
    params.set('aggregateType', filters.aggregateType);
    params.set('aggregateId', filters.aggregateId);
  }
  if (filters.platformOnly) params.set('platformOnly', 'true');
  if (cursor !== undefined && cursor !== null && cursor !== '') params.set('cursor', cursor);
  if (limit !== undefined && Number.isInteger(limit) && limit >= 1) {
    params.set('limit', String(limit));
  }
  return params.toString();
}

// ───────────────────────────── La respuesta ─────────────────────────────

export interface ActivityMetaView {
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
}

/** Un evento como lo devuelve el API. */
export interface ActivityEventView {
  readonly id: string;
  readonly occurredAt: string;
  readonly eventType: string;
  /** `null`: un evento de la plataforma, sin nodo. */
  readonly tenantId: string | null;
  readonly tenantName: string | null;
  readonly actorEmail: string | null;
  /** Si quien actuó es superadmin hoy (pleno o supervisado) o lo fue. `null`: no. */
  readonly actorPlatformRole: ActivityActorPlatformRole | null;
  readonly targetEmail: string | null;
  readonly aggregateType: string | null;
  readonly aggregateId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly meta: ActivityMetaView;
}

export type ActivityActorPlatformRole = 'superadmin' | 'supervised' | 'former';

function actorPlatformRoleOf(value: unknown): ActivityActorPlatformRole | null {
  return value === 'superadmin' || value === 'supervised' || value === 'former' ? value : null;
}

export interface ActivityPage {
  readonly events: readonly ActivityEventView[];
  readonly nextCursor: string | null;
}

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : null;
}

function text(value: unknown, max = 300): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.slice(0, max) : null;
}

function parseEvent(value: unknown): ActivityEventView | undefined {
  const r = asRecord(value);
  const id = text(r?.['id'], 64);
  const eventType = text(r?.['eventType'], 80);
  const occurredAt = text(r?.['occurredAt'], 40);
  if (r === null || id === null || eventType === null || occurredAt === null) return undefined;
  if (Number.isNaN(Date.parse(occurredAt))) return undefined;
  const meta = asRecord(r['meta']);
  return {
    id,
    occurredAt,
    eventType,
    tenantId: text(r['tenantId'], 64),
    tenantName: text(r['tenantName']),
    actorEmail: text(r['actorEmail'], 254),
    actorPlatformRole: actorPlatformRoleOf(r['actorPlatformRole']),
    targetEmail: text(r['targetEmail'], 254),
    aggregateType: text(r['aggregateType'], 40),
    aggregateId: text(r['aggregateId'], AGGREGATE_ID_MAX),
    payload: asRecord(r['payload']) ?? {},
    meta: {
      ip: text(meta?.['ip'], 64),
      userAgent: text(meta?.['userAgent'], 512),
      requestId: text(meta?.['requestId'], 128),
    },
  };
}

/**
 * La página que mandó el API. Un evento que no se puede leer (sin id, tipo o fecha) se descarta; una
 * respuesta sin lista no es una página.
 */
export function parseActivityPage(raw: unknown): ActivityPage | undefined {
  const body = asRecord(raw);
  if (body === null || !Array.isArray(body['events'])) return undefined;
  const events: ActivityEventView[] = [];
  for (const item of body['events'] as unknown[]) {
    const event = parseEvent(item);
    if (event !== undefined) events.push(event);
  }
  return { events, nextCursor: text(body['nextCursor'], 400) };
}

/** Suma una página a la lista sin repetir eventos (una página que se pidió dos veces). */
export function appendEvents(
  current: readonly ActivityEventView[],
  next: readonly ActivityEventView[],
): ActivityEventView[] {
  const seen = new Set(current.map((e) => e.id));
  return [...current, ...next.filter((e) => !seen.has(e.id))];
}

// ───────────────────────────── Textos ─────────────────────────────

/** El nodo de un evento: el nombre, "Plataforma" si no tiene, o que ya no existe. */
export function activityNodeLabel(
  event: Pick<ActivityEventView, 'tenantId' | 'tenantName'>,
): string {
  if (event.tenantId === null) return 'Plataforma';
  return event.tenantName ?? 'Nodo eliminado';
}

/** Quién lo hizo: el correo o, sin persona, quién fue. */
export function activityActorLabel(
  event: Pick<ActivityEventView, 'actorEmail' | 'eventType'>,
): string {
  if (event.actorEmail !== null) return event.actorEmail;
  if (event.eventType.startsWith('db.')) return 'Directo en la base de datos';
  if (event.eventType.startsWith('system.')) return 'Proceso automático';
  if (event.eventType.startsWith('auth.')) return 'Sin sesión';
  return 'Sistema';
}

const DATE_TIME = new Intl.DateTimeFormat('es', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: PLATFORM_TIME_ZONE,
});

const FULL_DATE_TIME = new Intl.DateTimeFormat('es', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZone: PLATFORM_TIME_ZONE,
});

/** "13 oct 2026, 09:41", en hora de Bogotá como los filtros. */
export function formatActivityDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : DATE_TIME.format(date).replace(/\./g, '');
}

/** "13 de octubre de 2026, 09:41:12", para el detalle. */
export function formatActivityDateFull(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : FULL_DATE_TIME.format(date);
}

/** El payload legible para el detalle: JSON con sangría, o nada si viene vacío. */
export function prettyPayload(payload: Readonly<Record<string, unknown>>): string | null {
  return Object.keys(payload).length === 0 ? null : JSON.stringify(payload, null, 2);
}

export const ACTIVITY_EXPORT_NOTE = 'Se exportan hasta 5.000 eventos con estos filtros.';
export const ACTIVITY_EMPTY = 'Sin actividad para estos filtros.';

/** El mensaje de un pedido a la lista que falló. */
export function activityErrorMessage(status: number, apiMessage: string | undefined): string {
  if (status === 401) return 'Tu sesión venció. Vuelve a iniciar sesión.';
  if (status === 403) return 'Sólo el superadmin de la plataforma ve la actividad de toda la red.';
  const fromApi = apiMessage?.trim() ?? '';
  if (status === 404) return fromApi !== '' ? fromApi : 'Ese nodo no existe: mira toda la red.';
  if (status === 400) return fromApi !== '' ? fromApi : 'Revisa los filtros: alguno no es válido.';
  if (status === 0) {
    return 'No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.';
  }
  return 'No pudimos cargar la actividad. Reintenta en unos segundos.';
}

/** El mensaje de una exportación que falló. */
export function activityExportErrorMessage(status: number, apiMessage: string | undefined): string {
  const fromApi = apiMessage?.trim() ?? '';
  // 403 con el 2FA: el mensaje del API dice qué hacer (activarlo o confirmar el código).
  if (status === 403 && fromApi !== '') return fromApi;
  if (status === 401 || status === 403 || status === 400 || status === 404 || status === 0) {
    return activityErrorMessage(status, apiMessage);
  }
  return 'No pudimos exportar la actividad. Reintenta en unos segundos.';
}

/** "Exportamos 1.234 eventos." y si se cortó en el tope. */
export function exportDoneMessage(rows: number, truncated: boolean): string {
  if (rows === 0) return 'Exportamos el archivo: no hay eventos con estos filtros.';
  const count = rows === 1 ? '1 evento' : `${rows.toLocaleString('es-CO')} eventos`;
  return truncated
    ? `Exportamos ${count}: los más nuevos. Acota las fechas o los filtros para ver el resto.`
    : `Exportamos ${count}.`;
}

/** El nombre del archivo que mandó el API (`attachment; filename="…"`), limpio. */
export function exportFilename(disposition: string | null, period: { from: string; to: string }) {
  const name = /filename="([^"]+)"/.exec(disposition ?? '')?.[1];
  return name !== undefined && /^[A-Za-z0-9._-]{1,100}\.csv$/.test(name)
    ? name
    : `actividad-${period.from}-a-${period.to}.csv`;
}

// ───────────────────────────── Qué cambió, por qué y quién lo aprobó ─────────────────────────────

/** La marca de quien actuó en la lista y el detalle. */
export function actorPlatformRoleLabel(role: ActivityActorPlatformRole | null): string | null {
  switch (role) {
    case 'superadmin':
      return 'Superadmin';
    case 'supervised':
      return 'Superadmin supervisado';
    case 'former':
      return 'Ex superadmin';
    default:
      return null;
  }
}

/** Un campo que cambió: su nombre y el valor antes y después, ya en texto. */
export interface ActivityChangeRow {
  readonly field: string;
  readonly before: string;
  readonly after: string;
}

/** El valor de un campo en texto: "—" si no había, sí/no, o el JSON compacto. */
export function changeValueText(value: unknown): string {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'boolean') return value ? 'sí' : 'no';
  if (typeof value === 'string') return value === '' ? '(vacío)' : value;
  if (typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Los campos que cambiaron, de lo que trae el evento:
 *
 *   - `before` y `after` (lo que deja la API: gobierno, credenciales, superadmins, cuentas): cada
 *     campo de primer nivel que difiere; un objeto anidado (la `config` de una cuenta) se abre un
 *     nivel más, para que se vea justo la clave que cambió;
 *   - `changes` (un cambio directo en la base, `db.direct_change`): `{ campo: { before, after } }`;
 *   - `previousRole` / `newRole` (un cambio de rol).
 *
 * Sin nada de eso, ninguna fila: el detalle muestra los datos del evento tal cual.
 */
export function activityChanges(payload: Readonly<Record<string, unknown>>): ActivityChangeRow[] {
  const rows: ActivityChangeRow[] = [];
  const push = (field: string, before: unknown, after: unknown) => {
    if (sameValue(before, after)) return;
    const b = asRecord(before);
    const a = asRecord(after);
    if (b !== null && a !== null) {
      for (const key of [...new Set([...Object.keys(b), ...Object.keys(a)])].sort()) {
        if (!sameValue(b[key], a[key])) {
          rows.push({
            field: `${field}.${key}`,
            before: changeValueText(b[key]),
            after: changeValueText(a[key]),
          });
        }
      }
      return;
    }
    rows.push({ field, before: changeValueText(before), after: changeValueText(after) });
  };

  const changes = asRecord(payload['changes']);
  if (changes !== null) {
    for (const [field, value] of Object.entries(changes)) {
      const pair = asRecord(value);
      if (pair !== null) push(field, pair['before'], pair['after']);
    }
  }
  if ('before' in payload || 'after' in payload) {
    const before = asRecord(payload['before']);
    const after = asRecord(payload['after']);
    if (before !== null || after !== null) {
      const fields = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
      for (const field of fields) push(field, before?.[field], after?.[field]);
    } else {
      push('valor', payload['before'], payload['after']);
    }
  }
  if ('previousRole' in payload || 'newRole' in payload) {
    push('rol', payload['previousRole'], payload['newRole']);
  }
  return rows;
}

/** Lo secreto que cambió: sólo se dice que cambió, nunca el valor. */
export function activitySecretChanges(payload: Readonly<Record<string, unknown>>): string[] {
  const out: string[] = [];
  if (payload['credentialsChanged'] === true) out.push('credenciales');
  const listed = payload['secretColumnsChanged'];
  if (Array.isArray(listed)) {
    for (const column of listed) if (typeof column === 'string') out.push(column);
  }
  return out;
}

/** El porqué que dejó quien actuó (`reason`) o quien decidió (`note`). */
export function activityReason(payload: Readonly<Record<string, unknown>>): string | null {
  return text(payload['reason'], 500) ?? text(payload['note'], 500);
}

export interface ActivityApproval {
  readonly changeRequestId: string;
  readonly requestedBy: string;
  readonly approvedBy: string;
  readonly note: string | null;
}

/** Si el cambio se aplicó al aprobar la solicitud de un supervisado: quién pidió y quién aprobó. */
export function activityApproval(
  payload: Readonly<Record<string, unknown>>,
): ActivityApproval | null {
  const a = asRecord(payload['approval']);
  const changeRequestId = text(a?.['changeRequestId'], 64);
  const requestedBy = text(a?.['requestedBy'], 64);
  const approvedBy = text(a?.['approvedBy'], 64);
  if (changeRequestId === null || requestedBy === null || approvedBy === null) return null;
  return { changeRequestId, requestedBy, approvedBy, note: text(a?.['note'], 500) };
}

export interface ActivityDirectSource {
  readonly table: string | null;
  readonly dbUser: string | null;
  readonly application: string | null;
}

/** De dónde vino un cambio directo en la base: la tabla, el usuario de la base y el programa. */
export function activityDirectSource(
  event: Pick<ActivityEventView, 'eventType' | 'payload'>,
): ActivityDirectSource | null {
  if (!event.eventType.startsWith('db.')) return null;
  return {
    table: text(event.payload['table'], 64),
    dbUser: text(event.payload['dbUser'], 64),
    application: text(event.payload['application'], 128),
  };
}
