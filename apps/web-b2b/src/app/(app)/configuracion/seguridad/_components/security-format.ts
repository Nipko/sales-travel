/**
 * Textos de la pantalla de Seguridad que no dependen de React: dispositivo, tiempos relativos, la
 * clave manual en bloques y el archivo de códigos de recuperación. Puro, para probarlo solo.
 */

/**
 * "Chrome en Windows" a partir del user-agent, sin pretender exactitud forense.
 *
 * El orden importa: el user-agent de un iPhone dice "like Mac OS X" y el de Android dice "Linux",
 * así que iOS y Android se miran antes que macOS y Linux. Lo mismo con los navegadores: Edge y
 * Opera dicen "Chrome", y Chrome dice "Safari".
 */
export function describeDevice(ua: string | null | undefined): string {
  if (!ua) return 'Dispositivo desconocido';
  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /SamsungBrowser\//.test(ua)
        ? 'Samsung Internet'
        : /Firefox\/|FxiOS\//.test(ua)
          ? 'Firefox'
          : /Chrome\/|CriOS\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : 'Navegador';
  const os = /iPhone|iPod/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'macOS'
            : /CrOS/.test(ua)
              ? 'ChromeOS'
              : /Linux/.test(ua)
                ? 'Linux'
                : '';
  return os ? `${browser} en ${os}` : browser;
}

/** Si el user-agent es de un teléfono o tableta (para el ícono). */
export function isMobileDevice(ua: string | null | undefined): boolean {
  return !!ua && /iPhone|iPad|iPod|Android|Mobile/.test(ua);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * "hace 5 min", "en 29 días". Relativo y calculado contra un `now` que viene del servidor: una
 * fecha absoluta depende de la zona horaria, y el servidor (UTC) y el navegador pintarían textos
 * distintos para el mismo instante (error de hidratación y un horario equivocado).
 */
export function formatRelative(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 'fecha desconocida';
  const diff = then - nowMs;
  const future = diff > 0;
  const abs = Math.abs(diff);

  let amount: string;
  if (abs < MINUTE) return future ? 'en menos de un minuto' : 'recién';
  if (abs < HOUR) amount = `${Math.floor(abs / MINUTE)} min`;
  else if (abs < DAY) amount = `${Math.floor(abs / HOUR)} h`;
  else if (abs < 30 * DAY) amount = plural(Math.floor(abs / DAY), 'día', 'días');
  else if (abs < 365 * DAY) amount = plural(Math.floor(abs / (30 * DAY)), 'mes', 'meses');
  else amount = plural(Math.floor(abs / (365 * DAY)), 'año', 'años');

  return future ? `en ${amount}` : `hace ${amount}`;
}

/** Activa en los últimos 5 minutos: probablemente alguien la está usando ahora. */
export function isActiveNow(iso: string, nowMs: number): boolean {
  const then = Date.parse(iso);
  return Number.isFinite(then) && nowMs - then < 5 * MINUTE;
}

/**
 * La clave base32 en bloques de 4 ("JBSW Y3DP EHPK …"): así se dicta y se compara a ojo sin
 * perderse en 32 caracteres seguidos. Las apps de autenticación ignoran los espacios, pero el
 * botón Copiar copia la clave sin ellos, por las dudas.
 */
export function secretBlocks(secret: string): string[] {
  const clean = secret.replace(/[\s-]/g, '').toUpperCase();
  return clean.match(/.{1,4}/g) ?? [];
}

export function compactSecret(secret: string): string {
  return secret.replace(/[\s-]/g, '').toUpperCase();
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** "2026-09-29 14:05", en la hora local de quien descarga (se arma en el navegador). */
export function localTimestamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** El contenido del .txt (y de la hoja impresa) con los códigos de recuperación. */
export function recoveryCodesText(
  codes: readonly string[],
  options: { email?: string; generatedAt: Date },
): string {
  const lines = [
    'Códigos de recuperación — verificación en dos pasos',
    ...(options.email ? [`Cuenta: ${options.email}`] : []),
    `Generados: ${localTimestamp(options.generatedAt)}`,
    '',
    'Cada código sirve una sola vez para entrar si no tenés tu teléfono.',
    'Guardalos en un lugar seguro, como un gestor de contraseñas o impresos.',
    'Si generás códigos nuevos, estos dejan de servir.',
    '',
    ...codes.map((code, i) => `${String(i + 1).padStart(2, ' ')}. ${code}`),
    '',
  ];
  return lines.join('\n');
}

/**
 * Nombre del archivo. Lleva el email para distinguir cuentas si alguien guarda varios, sin la
 * marca: el panel es white-label.
 */
export function recoveryCodesFilename(email?: string): string {
  const slug = (email ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9@._-]+/g, '-')
    .replace(/@/g, '-at-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug ? `codigos-recuperacion-${slug}.txt` : 'codigos-recuperacion.txt';
}
