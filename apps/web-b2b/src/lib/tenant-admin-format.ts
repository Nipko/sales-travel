/**
 * Cómo se dicen en el panel de administración los datos crudos de una sesión: el navegador a
 * partir del user-agent, cuánto hace de algo y hasta cuándo dura un bloqueo. Sin I/O y con `now`
 * explícito, para probarlo sin reloj.
 *
 * Existe porque un admin que tiene que decidir a quién desconectar para liberar un puesto no puede
 * leer "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36…" ni una fecha ISO: necesita
 * "Chrome en Windows · hace 3 min" para reconocer a la persona que se fue a almorzar.
 */

const UNKNOWN_DEVICE = 'Dispositivo desconocido';

/** Un user-agent real tiene al menos un `producto/versión`; un texto sin eso ya viene legible. */
function looksLikeUserAgent(value: string): boolean {
  return /[A-Za-z]+\/\d/.test(value);
}

function browserOf(ua: string): string | undefined {
  // El orden importa: Edge, Opera y Samsung dicen también "Chrome", y Chrome dice "Safari".
  if (/Edg(e|A|iOS)?\//.test(ua)) return 'Edge';
  if (/OPR\/|Opera/.test(ua)) return 'Opera';
  if (/SamsungBrowser\//.test(ua)) return 'Samsung Internet';
  if (/Firefox\/|FxiOS\//.test(ua)) return 'Firefox';
  if (/Chrome\/|CriOS\/|Chromium\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return undefined;
}

function osOf(ua: string): string | undefined {
  // iOS antes que macOS ("like Mac OS X") y Android antes que Linux (su UA dice "Linux; Android").
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows';
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Mac OS X|Macintosh/.test(ua)) return 'macOS';
  if (/Linux/.test(ua)) return 'Linux';
  return undefined;
}

/**
 * "Chrome en Windows" a partir del user-agent, sin pretender exactitud forense: alcanza para que
 * el admin distinga la PC de la oficina del celular. Si lo que llega ya es texto legible (un API
 * que ya lo resumió), se muestra tal cual.
 */
export function deviceLabel(userAgent: string | null | undefined): string {
  const ua = userAgent?.trim() ?? '';
  if (ua === '') return UNKNOWN_DEVICE;
  if (!looksLikeUserAgent(ua)) return ua.length > 60 ? `${ua.slice(0, 57)}…` : ua;
  const browser = browserOf(ua);
  const os = osOf(ua);
  if (browser !== undefined && os !== undefined) return `${browser} en ${os}`;
  if (browser !== undefined) return browser;
  if (os !== undefined) return `Navegador en ${os}`;
  return UNKNOWN_DEVICE;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function parseTime(iso: string | null | undefined): number | undefined {
  if (typeof iso !== 'string' || iso === '') return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
}

const DATE_SAME_YEAR = new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'short' });
const DATE_OTHER_YEAR = new Intl.DateTimeFormat('es-CO', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const TIME_OF_DAY = new Intl.DateTimeFormat('es-CO', { hour: '2-digit', minute: '2-digit' });

function shortDate(t: number, now: number): string {
  const sameYear = new Date(t).getFullYear() === new Date(now).getFullYear();
  return (sameYear ? DATE_SAME_YEAR : DATE_OTHER_YEAR).format(t);
}

/**
 * Cuánto hace de algo: "hace un momento", "hace 5 min", "hace 3 h", "hace 2 días" y, pasado un
 * mes, la fecha. `undefined` si la fecha no se puede leer. Un instante apenas en el futuro (relojes
 * desfasados entre servidor y navegador) cuenta como "hace un momento", no como un error.
 */
export function relativeTime(iso: string | null | undefined, now: number): string | undefined {
  const t = parseTime(iso);
  if (t === undefined) return undefined;
  const diff = now - t;
  if (diff < 45_000) return 'hace un momento';
  if (diff < HOUR) return `hace ${Math.max(1, Math.round(diff / MINUTE))} min`;
  if (diff < DAY) return `hace ${Math.floor(diff / HOUR)} h`;
  const days = Math.floor(diff / DAY);
  if (days < 30) return `hace ${days} ${days === 1 ? 'día' : 'días'}`;
  return `el ${shortDate(t, now)}`;
}

/** El último acceso de un miembro. Sin fecha es que nunca completó un ingreso. */
export function lastAccessLabel(iso: string | null | undefined, now: number): string {
  if (iso === null || iso === undefined || iso === '') return 'Nunca ingresó';
  return relativeTime(iso, now) ?? '—';
}

/** La fecha y hora exactas, para el `title`/`dateTime` de un tiempo relativo. */
export function exactTime(iso: string | null | undefined): string | undefined {
  const t = parseTime(iso);
  if (t === undefined) return undefined;
  return new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short' }).format(t);
}

/**
 * "Bloqueado hasta las 14:35" (o con fecha si no es hoy), sólo mientras el bloqueo siga vigente:
 * uno vencido ya no le impide nada al usuario y mostrarlo asustaría al admin sin motivo.
 */
export function lockedUntilLabel(iso: string | null | undefined, now: number): string | undefined {
  const t = parseTime(iso);
  if (t === undefined || t <= now) return undefined;
  const sameDay = new Date(t).toDateString() === new Date(now).toDateString();
  const time = TIME_OF_DAY.format(t);
  return sameDay
    ? `Bloqueado hasta las ${time}`
    : `Bloqueado hasta el ${shortDate(t, now)}, ${time}`;
}
