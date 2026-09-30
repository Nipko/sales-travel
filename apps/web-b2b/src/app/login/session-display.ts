import type { SeatsFull } from './login-state';

/**
 * Cómo se muestra una sesión conectada a quien tiene que elegir a quién desconectar: el
 * User-Agent crudo no le dice nada, "Chrome en Windows" sí.
 */

const BROWSERS: readonly (readonly [RegExp, string])[] = [
  // El orden importa: Edge, Opera y Samsung Internet también dicen "Chrome" y "Safari".
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\b(?:OPR|Opera)\//, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\b(?:Chrome|CriOS|Chromium)\//, 'Chrome'],
  [/\b(?:Firefox|FxiOS)\//, 'Firefox'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
];

const SYSTEMS: readonly (readonly [RegExp, string])[] = [
  [/\biPhone\b/, 'iPhone'],
  [/\biPad\b/, 'iPad'],
  [/\bAndroid\b/, 'Android'],
  [/\bWindows\b/, 'Windows'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bMac OS X\b|\bMacintosh\b/, 'Mac'],
  [/\bLinux\b/, 'Linux'],
];

function firstMatch(ua: string, table: readonly (readonly [RegExp, string])[]): string | null {
  for (const [pattern, label] of table) {
    if (pattern.test(ua)) return label;
  }
  return null;
}

export function describeDevice(userAgent: string | null | undefined): string {
  const ua = userAgent?.trim() ?? '';
  if (!ua) return 'Dispositivo desconocido';
  const browser = firstMatch(ua, BROWSERS);
  const system = firstMatch(ua, SYSTEMS);
  if (browser && system) return `${browser} en ${system}`;
  if (browser) return browser;
  if (system) return `Navegador en ${system}`;
  return 'Navegador desconocido';
}

/**
 * "Activo hace 3 min". Relativo y no la hora: lo que se decide es si esa persona sigue usando el
 * panel ahora mismo. `null` si la fecha no se puede leer.
 */
export function lastActivityLabel(iso: string | null | undefined, nowMs: number): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  // Un reloj un poco adelantado en el servidor no debe dar "hace -1 min".
  const seconds = Math.max(0, Math.floor((nowMs - at) / 1000));
  if (seconds < 60) return 'Activo ahora';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Activo hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Activo hace ${hours} h`;
  const days = Math.floor(hours / 24);
  return `Activo hace ${days} ${days === 1 ? 'día' : 'días'}`;
}

/** El nombre del nodo del cupo, o uno genérico si la API no lo mandó. */
export function seatsTenantLabel(seats: SeatsFull): string {
  return seats.tenantName ?? 'tu agencia';
}

/** "Los 5 puestos de Viajes Andinos están en uso." */
export function seatsHeadline(seats: SeatsFull): string {
  const tenant = seatsTenantLabel(seats);
  if (seats.limit === 1) return `El único puesto de ${tenant} está en uso.`;
  if (seats.limit !== null) return `Los ${seats.limit} puestos de ${tenant} están en uso.`;
  return `Todos los puestos de ${tenant} están en uso.`;
}

/** Lo que identifica a una persona en la lista: su nombre, o el email si no cargó nombre. */
export function sessionDisplayName(session: { name: string | null; email: string | null }): string {
  return session.name ?? session.email ?? 'Usuario sin nombre';
}
