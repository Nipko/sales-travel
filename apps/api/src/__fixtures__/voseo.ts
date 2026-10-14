/**
 * Formas del voseo que no van en ningún texto que vea una persona: la decisión del founder es "tú"
 * neutro ("puedes", "elige", "vuelve a ingresar"). Es una lista explícita y no una regla general
 * porque un "-á" final también es un futuro ("podrá") y "-ás" una segunda persona de tú ("estás").
 *
 * La usan el guarda de voseo y los tests de plantillas de correo ("el correo sale en tú"). El panel
 * tiene su espejo en `apps/web-b2b/src/lib/voseo.ts`: si se suma una forma, va en las dos.
 */
export const VOSEO_WORDS: readonly string[] = [
  // Las del pedido original del guarda.
  'podés',
  'tenés',
  'querés',
  'hacé',
  'elegí',
  'probá',
  'volvé',
  'invitá',
  'hacelo',
  'recargá',
  'aceptá',
  'ignorá',
  'restablecé',
  'verificá',
  'confirmá',
  'copiá',
  'pegá',
  'asigná',
  'indicá',
  'usá',
  'administrás',
  'pedíselo',
  'activala',
  'vos',
  // Las que aparecieron en el resto del acceso, Equipo y la seguridad de la cuenta.
  'ingresá',
  'revisá',
  'esperá',
  'intentá',
  'pedí',
  'pedile',
  'empezá',
  'activá',
  'cerrá',
  'cerrala',
  'entrá',
  'entrás',
  'perdés',
  'generá',
  'generás',
  'cambiá',
  'cambiás',
  'necesitás',
  'escaneá',
  'poné',
  'seleccioná',
  'copiala',
  'copialos',
  'descargalos',
  'abrí',
  'abrilo',
  'tocá',
  'apuntá',
  'guardá',
  'guardalos',
  'marcá',
  'gestioná',
  'conectate',
  'desmarcalo',
  'seguís',
  'crealo',
  'creala',
  'sumale',
  'bajala',
  'armás',
  'corregís',
  'sabés',
  'decís',
  'mirá',
  'fijate',
  'escribí',
  'completá',
  'agregá',
  'buscá',
  'avisá',
  'contactá',
  // Las que quedaban en Carteras, Mi Red, las cuentas de proveedor y los mensajes del API.
  'cargá',
  'contá',
  'reintentá',
  'reemplazá',
  'desactivá',
  'informá',
  'informás',
  'vendés',
  'escribís',
  'borrás',
  'informalo',
  'guardala',
  'habilitale',
  'dejalo',
  'promovela',
  'quitale',
];

/**
 * Una palabra entera de la lista, sin importar mayúsculas. Los bordes son "no letra" y no `\b`, que
 * en JavaScript sólo conoce ASCII y no vería el final de "probá".
 */
const VOSEO_PATTERN = new RegExp(`(?<!\\p{L})(?:${VOSEO_WORDS.join('|')})(?!\\p{L})`, 'giu');

/** Las formas del voseo que hay en `text`, en orden de aparición. Vacío si está en tú. */
export function voseoIn(text: string): string[] {
  return [...text.matchAll(VOSEO_PATTERN)].map((m) => m[0]);
}
