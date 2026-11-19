import { unstable_isUnrecognizedActionError } from 'next/navigation';

/**
 * ¿El error viene de que la pestaña quedó con el JavaScript de un deploy anterior?
 *
 * Next 15 recalcula los IDs de las server actions en cada build: una pestaña abierta antes del
 * deploy (la ficha de un hotel que el vendedor dejó abierta, el checkout a medio llenar) llama a un
 * ID que el servidor nuevo ya no conoce y Next lanza `UnrecognizedActionError`. Lo mismo pasa con
 * los chunks de JS que ya no existen (`ChunkLoadError`). Reintentar no sirve: hay que recargar.
 * Producción lo registra como «Failed to find Server Action "…"» en el log de web-b2b.
 */
export function isStaleDeployError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  try {
    if (unstable_isUnrecognizedActionError(error)) return true;
  } catch {
    // Fuera del cliente de Next (tests) la función puede no existir; se sigue con el texto.
  }
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === 'UnrecognizedActionError' || name === 'ChunkLoadError') return true;
  if (typeof message !== 'string') return false;
  return (
    /Server Action "[^"]*" was not found on the server/.test(message) ||
    message.includes('Failed to find Server Action') ||
    /Loading chunk [^ ]+ failed/.test(message)
  );
}

export const STALE_DEPLOY_TITLE = 'Hay una versión nueva del panel';
export const STALE_DEPLOY_TEXT =
  'Actualizamos Sales-Travel mientras tenías esta pestaña abierta. Recárgala para seguir; lo que ya está guardado no se pierde.';
