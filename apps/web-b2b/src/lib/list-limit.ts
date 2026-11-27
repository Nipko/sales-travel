/**
 * El tamaño de un listado de Reservas o de Cotizaciones guardadas (QA-H-15): 100 de entrada y
 * «Ver más» suma otras 100, hasta 1000. Un tope y no un cursor: la pantalla relee la lista después
 * de cada acción y así conserva lo que ya había cargado.
 */
export const LIST_PAGE = 100;
export const LIST_MAX = 1000;

/** `?limit=` del panel → el que se le pide a la API, o `null` si no es válido. */
export function listLimitOf(search: URLSearchParams): number | null {
  const raw = search.get('limit');
  if (raw === null || raw === '') return LIST_PAGE;
  if (!/^\d{1,4}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= LIST_MAX ? n : null;
}

/** El siguiente tamaño al pedir «Ver más». */
export function nextListLimit(current: number): number {
  return Math.min(current + LIST_PAGE, LIST_MAX);
}
