/**
 * El "hoy" más temprano que está corriendo en algún lugar del mundo, en 'YYYY-MM-DD': la fecha
 * en UTC−12. Es el piso de las fechas que el servidor acepta en una búsqueda.
 *
 * El servidor no sabe en qué huso está el vendedor, y su reloj va en UTC: con la fecha del
 * servidor, entre las 19:00 y la medianoche de Bogotá o Lima (21:00 en São Paulo) "hoy" ya era
 * mañana, y una entrada de hotel o una recogida para esa misma noche —que el calendario del
 * vendedor sí ofrece— volvía rechazada. Con este piso nunca se rechaza un día que todavía es hoy
 * en algún lado. Lo que es ayer para el vendedor lo frena su propio calendario (fecha local), y el
 * proveedor revalida la disponibilidad.
 */
export function earliestTodayIso(now: Date = new Date()): string {
  const behind = new Date(now.getTime() - 12 * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${behind.getUTCFullYear()}-${pad(behind.getUTCMonth() + 1)}-${pad(behind.getUTCDate())}`;
}
