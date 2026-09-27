/**
 * `BookingDetail.HotelConfirmationNumber`: ¿trae el número que dio el hotel, o un relleno?
 * (docs/tbo/04 §8 y PV-05; 08 RF-27). Función pura.
 *
 * El PDF declara el campo String y no lo muestra en el ejemplo (p. 45, 49), así que no dice qué
 * llega mientras el hotel no lo dio. Vacío o sólo espacios ya es "todavía sin HCN" (lo resuelve
 * el esquema). Pero los sistemas de hotelería suelen rellenar el campo con un marcador (`NA`,
 * `Pending`, `0`), y tomarlo por el número haría tres daños: cortaría el seguimiento del HCN antes
 * de tiempo, cerraría la tarea de operaciones que lo está buscando y lo imprimiría en el voucher
 * como algo que el huésped puede presentar en recepción. Un relleno también es "todavía sin HCN".
 *
 * Qué es relleno. Se compara el valor ENTERO en mayúsculas y sin espacios ni signos (`n/a`,
 * `N.A.` y ` N A ` son `NA`):
 *
 * - **sin letras ni dígitos**: `-`, `--`, `.`, `/`, `*`, `?`, `#`;
 * - **sólo ceros**: `0`, `00`, `000000`;
 * - **una de las palabras de {@link TBO_HCN_PLACEHOLDERS}**: "no aplica", "no disponible",
 *   "pendiente", "a confirmar", con sus siglas.
 *
 * Un número real que contiene una de esas palabras (`NA-4711`, `PENDING7`) no se toca.
 *
 * La lista es nuestra, no de TBO (INFERIDO): lo pregunta Q-47
 * (`docs/tbo/10-preguntas-para-tbo.md#q-47`). Cada relleno se cuenta
 * (`tbo.booking_detail.hcn_placeholder`) para ver si TBO manda otros; uno nuevo se agrega aquí.
 */

/** Los rellenos con palabras, ya normalizados (mayúsculas, sin espacios ni signos). */
export const TBO_HCN_PLACEHOLDERS: ReadonlySet<string> = new Set([
  // "No aplica", "no hay".
  'NA',
  'NIL',
  'NULL',
  'NONE',
  'UNDEFINED',
  'UNKNOWN',
  'NOTAPPLICABLE',
  // "No disponible todavía".
  'NOTAVAILABLE',
  'NOTASSIGNED',
  'NOTCONFIRMED',
  'UNCONFIRMED',
  // "Pendiente".
  'PENDING',
  'PENDINGCONFIRMATION',
  'AWAITED',
  'AWAITING',
  'AWAITINGCONFIRMATION',
  'ONREQUEST',
  'REQUESTED',
  // "A confirmar".
  'TBA',
  'TBC',
  'TBD',
  'TOBEADVISED',
  'TOBECONFIRMED',
]);

/** Letras y dígitos de cualquier alfabeto: un HCN de un hotel en otro alfabeto no es relleno. */
const NOT_ALPHANUMERIC = /[^\p{L}\p{N}]/gu;
const ONLY_ZEROS = /^0+$/;

/** `true` si el valor no es un número del hotel sino un marcador de "todavía no hay". */
export function isTboHcnPlaceholder(value: string): boolean {
  const normalized = value.toUpperCase().replace(NOT_ALPHANUMERIC, '');
  return (
    normalized.length === 0 || ONLY_ZEROS.test(normalized) || TBO_HCN_PLACEHOLDERS.has(normalized)
  );
}
