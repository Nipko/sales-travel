import type { TenantAdminProxyPlan, TenantAdminProxyTarget } from './tenant-admin-proxy';

/**
 * Los anuncios de la plataforma (0079): la franja de avisos que ve cualquier usuario debajo de la
 * barra superior, y su gestión en Plataforma → Sistema › Anuncios (sólo superadmin).
 *
 * Todo es texto plano: se pinta como texto (React lo escapa), sin HTML ni enlaces automáticos, con
 * los saltos de línea del mensaje. Sin estado: lo usan la franja, el panel, las rutas del BFF y los
 * tests.
 */

export type AnnouncementSeverity = 'info' | 'warning' | 'critical';
export type AnnouncementStatus = 'scheduled' | 'active' | 'expired' | 'archived';

/** Lo que ve cualquier usuario en la franja. */
export interface ActiveAnnouncement {
  readonly id: string;
  readonly severity: AnnouncementSeverity;
  readonly title: string;
  readonly body: string;
}

/** Un anuncio en el panel del superadmin. */
export interface AdminAnnouncement extends ActiveAnnouncement {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly audience: {
    /** `null` = toda la red. */
    readonly rootTenantId: string | null;
    readonly rootTenantName: string | null;
    readonly adminsOnly: boolean;
  };
  readonly status: AnnouncementStatus;
  readonly archivedAt: string | null;
}

export const ANNOUNCEMENT_TITLE_MIN = 3;
export const ANNOUNCEMENT_TITLE_MAX = 120;
export const ANNOUNCEMENT_BODY_MAX = 600;
export const ANNOUNCEMENT_MAX_WINDOW_DAYS = 31;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const MAX_WINDOW_MS = ANNOUNCEMENT_MAX_WINDOW_DAYS * DAY_MS;

/** Cada cuánto la franja vuelve a preguntar. */
export const ANNOUNCEMENTS_POLL_MS = 5 * MINUTE_MS;

/** Cuántos entran en la franja: lo mismo que devuelve el API. */
export const ANNOUNCEMENTS_SHOWN_MAX = 3;

/** Dónde quedan los avisos que el usuario ocultó, en este navegador. */
export const DISMISSED_STORAGE_KEY = 'st.announcements.dismissed';

/** Los ocultos que se recuerdan: los más recientes. Los viejos ya vencieron. */
const DISMISSED_KEEP = 50;

const SEVERITIES: readonly AnnouncementSeverity[] = ['info', 'warning', 'critical'];
const STATUSES: readonly AnnouncementStatus[] = ['scheduled', 'active', 'expired', 'archived'];

/** La etiqueta de la franja, para que la gravedad no dependa sólo del color. */
export const SEVERITY_BANNER_LABEL: Readonly<Record<AnnouncementSeverity, string>> = {
  info: 'Aviso',
  warning: 'Importante',
  critical: 'Crítico',
};

/** Las opciones de "Gravedad" del formulario. */
export const SEVERITY_OPTIONS: readonly {
  readonly value: AnnouncementSeverity;
  readonly label: string;
  readonly detail: string;
}[] = [
  { value: 'info', label: 'Información', detail: 'Se puede ocultar.' },
  { value: 'warning', label: 'Advertencia', detail: 'Se puede ocultar.' },
  { value: 'critical', label: 'Crítico', detail: 'No se puede ocultar mientras esté vigente.' },
];

export const STATUS_LABEL: Readonly<Record<AnnouncementStatus, string>> = {
  scheduled: 'Programado',
  active: 'Vigente',
  expired: 'Vencido',
  archived: 'Archivado',
};

export type StatusTone = 'neutral' | 'success' | 'warning' | 'danger';

export const STATUS_TONE: Readonly<Record<AnnouncementStatus, StatusTone>> = {
  scheduled: 'warning',
  active: 'success',
  expired: 'neutral',
  archived: 'neutral',
};

/** Lo crítico no se oculta: si el aviso importa tanto, tiene que seguir a la vista. */
export function canDismiss(severity: AnnouncementSeverity): boolean {
  return severity !== 'critical';
}

// ───────────────────────────── Lectura ─────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAnnouncementId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function isSeverity(value: unknown): value is AnnouncementSeverity {
  return SEVERITIES.includes(value as AnnouncementSeverity);
}

function isStatus(value: unknown): value is AnnouncementStatus {
  return STATUSES.includes(value as AnnouncementStatus);
}

function isInstant(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function parseActive(value: unknown): ActiveAnnouncement | undefined {
  const r = asRecord(value);
  if (r === undefined) return undefined;
  const { id, severity, title, body } = r;
  if (!isAnnouncementId(id) || !isSeverity(severity) || typeof title !== 'string') return undefined;
  if (title.trim() === '') return undefined;
  return { id, severity, title, body: typeof body === 'string' ? body : '' };
}

/**
 * Los anuncios de `GET /api/announcements/active`. Lo que no se puede leer se descarta: la franja
 * nunca rompe la pantalla por un dato raro.
 */
export function parseActiveAnnouncements(raw: unknown): ActiveAnnouncement[] {
  const list = asRecord(raw)?.['announcements'];
  if (!Array.isArray(list)) return [];
  const out: ActiveAnnouncement[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const parsed = parseActive(item);
    if (parsed === undefined || seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    out.push(parsed);
  }
  return out;
}

export function parseAdminAnnouncement(raw: unknown): AdminAnnouncement | undefined {
  const base = parseActive(raw);
  const r = asRecord(raw);
  const audience = asRecord(r?.['audience']);
  if (base === undefined || r === undefined || audience === undefined) return undefined;
  const { startsAt, endsAt, status, archivedAt } = r;
  const rootTenantId = audience['rootTenantId'];
  const rootTenantName = audience['rootTenantName'];
  if (!isInstant(startsAt) || !isInstant(endsAt) || !isStatus(status)) return undefined;
  if (rootTenantId !== null && !isAnnouncementId(rootTenantId)) return undefined;
  if (typeof audience['adminsOnly'] !== 'boolean') return undefined;
  return {
    ...base,
    startsAt,
    endsAt,
    audience: {
      rootTenantId: rootTenantId === null ? null : rootTenantId.toLowerCase(),
      rootTenantName: typeof rootTenantName === 'string' ? rootTenantName : null,
      adminsOnly: audience['adminsOnly'],
    },
    status,
    archivedAt: isInstant(archivedAt) ? archivedAt : null,
  };
}

/** La lista del panel; `undefined` si la respuesta no se puede leer. */
export function parseAdminAnnouncements(raw: unknown): AdminAnnouncement[] | undefined {
  const list = asRecord(raw)?.['announcements'];
  if (!Array.isArray(list)) return undefined;
  return list.map(parseAdminAnnouncement).filter((a): a is AdminAnnouncement => a !== undefined);
}

// ───────────────────────────── Ocultos ─────────────────────────────

/** Lo que se usa del almacenamiento del navegador; en los tests, un doble. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * `localStorage`, si se puede: en una ventana privada, con los datos del sitio bloqueados o fuera
 * del navegador, `null` (o el acceso lanza). La franja funciona igual: lo oculto vuelve a verse al
 * recargar.
 */
export function browserStorage(): KeyValueStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** FNV-1a de 32 bits en hex. No protege nada: sólo distingue una versión del texto de otra. */
function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const DISMISS_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}$/;

/**
 * Cómo se recuerda que el usuario ocultó un aviso: su id y una huella de lo que dice (gravedad,
 * título y mensaje). Si el superadmin lo corrige —otra hora para el mantenimiento, más grave—, la
 * huella cambia y vuelve a verse: con el id solo, quien ocultó la primera versión nunca veía la
 * corrección. Cambiar sólo la vigencia no lo hace volver.
 */
export function dismissKey(
  a: Pick<ActiveAnnouncement, 'id' | 'severity' | 'title' | 'body'>,
): string {
  return `${a.id.toLowerCase()}:${fingerprint(`${a.severity}\u0000${a.title}\u0000${a.body}`)}`;
}

/** Las versiones de avisos ({@link dismissKey}) que el usuario ocultó en este navegador. Nunca lanza. */
export function readDismissed(storage: KeyValueStorage | null): ReadonlySet<string> {
  if (storage === null) return new Set();
  try {
    const raw = storage.getItem(DISMISSED_STORAGE_KEY);
    if (raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed
        .filter((v): v is string => typeof v === 'string')
        .map((v) => v.toLowerCase())
        .filter((v) => DISMISS_KEY.test(v)),
    );
  } catch {
    return new Set();
  }
}

/**
 * Oculta la versión `key` ({@link dismissKey}): la devuelve sumada a las ocultas y lo intenta
 * guardar. Si no se puede guardar, sigue oculta hasta recargar. Nunca lanza.
 */
export function rememberDismissed(
  storage: KeyValueStorage | null,
  current: ReadonlySet<string>,
  dismissed: string,
): ReadonlySet<string> {
  const key = dismissed.toLowerCase();
  const next = [...[...current].filter((x) => x !== key), key].slice(-DISMISSED_KEEP);
  if (storage !== null) {
    try {
      storage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Sin espacio o sin permiso: queda oculto en esta pantalla y nada más.
    }
  }
  return new Set(next);
}

/**
 * Lo que se pinta: sin las versiones ocultas (lo crítico, siempre), hasta
 * {@link ANNOUNCEMENTS_SHOWN_MAX}.
 */
export function visibleAnnouncements(
  list: readonly ActiveAnnouncement[],
  dismissed: ReadonlySet<string>,
): ActiveAnnouncement[] {
  return list
    .filter((a) => !canDismiss(a.severity) || !dismissed.has(dismissKey(a)))
    .slice(0, ANNOUNCEMENTS_SHOWN_MAX);
}

// ───────────────────────────── Texto ─────────────────────────────

/** Controles C0 (el salto de línea se trata aparte) y C1. Espejo del API (announcements.schemas). */
// eslint-disable-next-line no-control-regex -- la clase existe justamente para quitarlos.
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;
/** Ancho cero, marcas y controles de dirección y la marca de orden de bytes. */
const INVISIBLE = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/** El título como lo guarda el API: una línea, sin controles ni invisibles. */
export function cleanTitle(value: string): string {
  return value
    .replace(INVISIBLE, '')
    .replace(/\r\n?|\n/g, ' ')
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** El mensaje como lo guarda el API: con sus saltos de línea, como mucho una línea en blanco. */
export function cleanBody(value: string): string {
  return value
    .replace(INVISIBLE, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(CONTROL, '')
    .replace(/[ \u00A0]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Caracteres como los cuenta la base (puntos de código: un emoji es uno). */
export function charCount(value: string): number {
  return Array.from(value).length;
}

// ───────────────────────────── Fechas (hora Bogotá) ─────────────────────────────

/**
 * Las fechas del formulario son de Bogotá, como el resto de la consola de la plataforma. Colombia no
 * cambia la hora (UTC−5 todo el año): la conversión es un desplazamiento fijo.
 */
const BOGOTA_OFFSET_MS = -5 * 60 * MINUTE_MS;

const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** Un instante como valor de `<input type="datetime-local">` en hora de Bogotá. */
export function toBogotaInput(instant: string | Date): string {
  const ms = typeof instant === 'string' ? Date.parse(instant) : instant.getTime();
  if (Number.isNaN(ms)) return '';
  return new Date(ms + BOGOTA_OFFSET_MS).toISOString().slice(0, 16);
}

/** El valor de `datetime-local` (hora de Bogotá) como instante ISO; `undefined` si no se lee. */
export function fromBogotaInput(value: string): string | undefined {
  const m = LOCAL_INPUT.exec(value);
  if (m === null) return undefined;
  const [, y, mo, d, h, mi] = m.map(Number) as [number, number, number, number, number, number];
  const ms = Date.UTC(y, mo - 1, d, h, mi) - BOGOTA_OFFSET_MS;
  const check = new Date(ms + BOGOTA_OFFSET_MS);
  // 2026-02-30 no existe: Date.UTC lo corre al 2 de marzo.
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return undefined;
  return new Date(ms).toISOString();
}

const DATE_TIME = new Intl.DateTimeFormat('es', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'America/Bogota',
});

/** "17 oct, 02:00", en hora de Bogotá. */
export function formatAnnouncementDate(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  return DATE_TIME.format(new Date(ms)).replace(/\./g, '');
}

/** "Del 17 oct, 02:00 al 18 oct, 04:00 (hora Bogotá)". */
export function announcementWindowLabel(a: Pick<AdminAnnouncement, 'startsAt' | 'endsAt'>): string {
  return `Del ${formatAnnouncementDate(a.startsAt)} al ${formatAnnouncementDate(a.endsAt)} (hora Bogotá)`;
}

/** A quién va: "Toda la red", "Agencia Sur y su red"; con "· Solo administradores" si es el caso. */
export function audienceLabel(audience: AdminAnnouncement['audience']): string {
  const who =
    audience.rootTenantId === null
      ? 'Toda la red'
      : `${audience.rootTenantName ?? 'Un nodo'} y su red`;
  return audience.adminsOnly ? `${who} · Solo administradores` : who;
}

// ───────────────────────────── Formulario ─────────────────────────────

export type AudienceScope = 'network' | 'node';

export interface AnnouncementDraft {
  readonly severity: AnnouncementSeverity;
  readonly title: string;
  readonly body: string;
  readonly scope: AudienceScope;
  /** El nodo si `scope` es `node`; vacío si no se eligió. */
  readonly rootTenantId: string;
  readonly adminsOnly: boolean;
  /** `datetime-local` en hora de Bogotá. */
  readonly startsLocal: string;
  readonly endsLocal: string;
}

export const TITLE_PLACEHOLDER = 'TBO en mantenimiento el sábado de 02:00 a 04:00 (hora Bogotá)';

/** Un anuncio nuevo: información para toda la red, desde ahora y por un día. */
export function emptyDraft(now: Date): AnnouncementDraft {
  const start = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS;
  return {
    severity: 'info',
    title: '',
    body: '',
    scope: 'network',
    rootTenantId: '',
    adminsOnly: false,
    startsLocal: toBogotaInput(new Date(start)),
    endsLocal: toBogotaInput(new Date(start + DAY_MS)),
  };
}

export function draftFromAnnouncement(a: AdminAnnouncement): AnnouncementDraft {
  return {
    severity: a.severity,
    title: a.title,
    body: a.body,
    scope: a.audience.rootTenantId === null ? 'network' : 'node',
    rootTenantId: a.audience.rootTenantId ?? '',
    adminsOnly: a.audience.adminsOnly,
    startsLocal: toBogotaInput(a.startsAt),
    endsLocal: toBogotaInput(a.endsAt),
  };
}

export type DraftField = 'title' | 'body' | 'rootTenantId' | 'startsLocal' | 'endsLocal';
export type DraftErrors = Partial<Record<DraftField, string>>;

/**
 * Lo que el formulario revisa antes de mandar, con las reglas del API: título de 3 a 120, mensaje
 * hasta 600, un nodo si es para un nodo, y una vigencia de hasta 31 días que todavía no terminó.
 */
export function validateDraft(draft: AnnouncementDraft, now: Date): DraftErrors {
  const errors: DraftErrors = {};
  const title = charCount(cleanTitle(draft.title));
  if (title < ANNOUNCEMENT_TITLE_MIN) {
    errors.title = `Escribe un título de al menos ${ANNOUNCEMENT_TITLE_MIN} caracteres.`;
  } else if (title > ANNOUNCEMENT_TITLE_MAX) {
    errors.title = `El título no puede superar los ${ANNOUNCEMENT_TITLE_MAX} caracteres.`;
  }
  if (charCount(cleanBody(draft.body)) > ANNOUNCEMENT_BODY_MAX) {
    errors.body = `El mensaje no puede superar los ${ANNOUNCEMENT_BODY_MAX} caracteres.`;
  }
  if (draft.scope === 'node' && !isAnnouncementId(draft.rootTenantId)) {
    errors.rootTenantId = 'Elige el nodo que recibe el anuncio.';
  }
  const starts = fromBogotaInput(draft.startsLocal);
  const ends = fromBogotaInput(draft.endsLocal);
  if (starts === undefined) errors.startsLocal = 'Indica desde cuándo se muestra.';
  if (ends === undefined) {
    errors.endsLocal = 'Indica hasta cuándo se muestra.';
  } else if (starts !== undefined) {
    const span = Date.parse(ends) - Date.parse(starts);
    if (span <= 0) errors.endsLocal = 'Tiene que terminar después de empezar.';
    else if (span > MAX_WINDOW_MS) {
      errors.endsLocal = `Un anuncio dura como mucho ${ANNOUNCEMENT_MAX_WINDOW_DAYS} días.`;
    } else if (Date.parse(ends) <= now.getTime()) {
      errors.endsLocal = 'Ese final ya pasó: elige uno en el futuro.';
    }
  }
  return errors;
}

function audienceOf(draft: AnnouncementDraft): {
  rootTenantId: string | null;
  adminsOnly: boolean;
} {
  return {
    rootTenantId: draft.scope === 'node' ? draft.rootTenantId.toLowerCase() : null,
    adminsOnly: draft.adminsOnly,
  };
}

/** El cuerpo de `POST /api/admin/announcements`. Sólo con un borrador sin errores. */
export function draftToCreateBody(draft: AnnouncementDraft): Record<string, unknown> {
  return {
    severity: draft.severity,
    title: cleanTitle(draft.title),
    body: cleanBody(draft.body),
    audience: audienceOf(draft),
    startsAt: fromBogotaInput(draft.startsLocal),
    endsAt: fromBogotaInput(draft.endsLocal),
  };
}

/**
 * El cuerpo de `PATCH /api/admin/announcements/:id`: sólo lo que cambió respecto de como se abrió.
 * Las fechas van si cambió el minuto: el formulario no muestra segundos, y mandar la de siempre
 * redondeada contaría como un cambio que nadie hizo.
 */
export function draftToPatchBody(
  draft: AnnouncementDraft,
  base: AnnouncementDraft,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (draft.severity !== base.severity) out['severity'] = draft.severity;
  if (cleanTitle(draft.title) !== cleanTitle(base.title)) out['title'] = cleanTitle(draft.title);
  if (cleanBody(draft.body) !== cleanBody(base.body)) out['body'] = cleanBody(draft.body);
  const a = audienceOf(draft);
  const b = audienceOf(base);
  if (a.rootTenantId !== b.rootTenantId || a.adminsOnly !== b.adminsOnly) out['audience'] = a;
  if (draft.startsLocal !== base.startsLocal) out['startsAt'] = fromBogotaInput(draft.startsLocal);
  if (draft.endsLocal !== base.endsLocal) out['endsAt'] = fromBogotaInput(draft.endsLocal);
  return out;
}

export function isDraftDirty(draft: AnnouncementDraft, base: AnnouncementDraft): boolean {
  return Object.keys(draftToPatchBody(draft, base)).length > 0;
}

/** El anuncio como se verá en la franja, para la vista previa del formulario. */
export function previewOf(draft: AnnouncementDraft): ActiveAnnouncement {
  const title = cleanTitle(draft.title);
  return {
    id: '00000000-0000-4000-8000-000000000000',
    severity: draft.severity,
    title: title === '' ? 'Título del anuncio' : title,
    body: cleanBody(draft.body),
  };
}

// ───────────────────────────── BFF ─────────────────────────────

/**
 * Lo que las rutas del panel reenvían al API, rearmado campo por campo: nada que el API no espere
 * llega, y un id raro no compone otra ruta. Las reglas de fondo (largos, 31 días, quién puede) las
 * aplica el API.
 */

function audienceField(
  value: unknown,
): { rootTenantId: string | null; adminsOnly: boolean } | undefined {
  const r = asRecord(value);
  if (r === undefined) return undefined;
  const root = r['rootTenantId'];
  const adminsOnly = r['adminsOnly'];
  if (typeof adminsOnly !== 'boolean') return undefined;
  if (root !== null && !isAnnouncementId(root)) return undefined;
  return { rootTenantId: root === null ? null : root.toLowerCase(), adminsOnly };
}

type Rebuilt = Record<string, unknown>;

/** Cada campo que viene, validado por forma. `undefined` si alguno no la tiene. */
function rebuild(r: Record<string, unknown>): Rebuilt | undefined {
  const out: Rebuilt = {};
  if ('severity' in r) {
    if (!isSeverity(r['severity'])) return undefined;
    out['severity'] = r['severity'];
  }
  for (const key of ['title', 'body'] as const) {
    if (key in r) {
      if (typeof r[key] !== 'string') return undefined;
      out[key] = r[key];
    }
  }
  if ('audience' in r) {
    const audience = audienceField(r['audience']);
    if (audience === undefined) return undefined;
    out['audience'] = audience;
  }
  for (const key of ['startsAt', 'endsAt'] as const) {
    if (key in r && r[key] !== undefined) {
      if (!isInstant(r[key])) return undefined;
      out[key] = r[key];
    }
  }
  return out;
}

const INVALID_BODY =
  'El anuncio tiene que traer gravedad, título, a quién va y hasta cuándo se muestra.';

export function createAnnouncementPlan(raw: unknown): TenantAdminProxyPlan {
  const r = asRecord(raw);
  const body = r === undefined ? undefined : rebuild(r);
  if (
    body === undefined ||
    !('severity' in body) ||
    !('title' in body) ||
    !('audience' in body) ||
    !('endsAt' in body)
  ) {
    return { ok: false, error: INVALID_BODY };
  }
  return { ok: true, path: '/admin/announcements', body };
}

export function updateAnnouncementPlan(id: string, raw: unknown): TenantAdminProxyPlan {
  if (!isAnnouncementId(id)) return { ok: false, error: 'Anuncio inválido.' };
  const r = asRecord(raw);
  const body = r === undefined ? undefined : rebuild(r);
  if (body === undefined || Object.keys(body).length === 0) {
    return { ok: false, error: 'No hay nada que cambiar en el anuncio.' };
  }
  return { ok: true, path: `/admin/announcements/${id.toLowerCase()}`, body };
}

export function archiveAnnouncementTarget(id: string): TenantAdminProxyTarget {
  if (!isAnnouncementId(id)) return { ok: false, error: 'Anuncio inválido.' };
  return { ok: true, path: `/admin/announcements/${id.toLowerCase()}/archive` };
}

/** El mensaje para el panel de un error del API (ya en castellano) o de la red. */
export function announcementErrorMessage(status: number, error: string | undefined): string {
  if (error !== undefined && error.trim() !== '') return error;
  if (status === 403) return 'Sólo el superadmin gestiona los anuncios.';
  if (status === 404) return 'Ese anuncio ya no existe. Recarga la lista.';
  if (status === 409) return 'Ese anuncio ya está archivado.';
  if (status >= 500 || status === 0) {
    return 'No pudimos guardar el anuncio. Inténtalo de nuevo en unos minutos.';
  }
  return 'Revisa los datos del anuncio.';
}
