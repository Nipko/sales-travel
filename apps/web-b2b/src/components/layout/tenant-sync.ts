/**
 * Aviso entre pestañas de que se cambió de agencia.
 *
 * Las pestañas comparten las cookies: después del cambio, TODAS operan con la sesión nueva aunque
 * las otras sigan mostrando la agencia anterior en el encabezado. Una venta hecha desde esa pestaña
 * quedaría en otra agencia que la que se ve. Con este aviso las demás se refrescan en el acto.
 *
 * `BroadcastChannel` y, si no está (Safari viejo, algunos WebViews), el evento `storage`, como la
 * guardia de sesión (`session-sync.ts`). `localStorage` puede no estar o tirar: todo con try/catch.
 */

const CHANNEL = 'st-tenant';
const STORAGE_KEY = 'st:tenant-switch';

export interface TenantSwitchMessage {
  type: 'tenant-switched';
  tenantId: string;
  at: number;
}

export function parseTenantSwitchMessage(value: unknown): TenantSwitchMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const obj = value as Record<string, unknown>;
  return obj['type'] === 'tenant-switched' &&
    typeof obj['tenantId'] === 'string' &&
    typeof obj['at'] === 'number' &&
    Number.isFinite(obj['at'])
    ? { type: 'tenant-switched', tenantId: obj['tenantId'], at: obj['at'] }
    : null;
}

let channel: BroadcastChannel | null | undefined;

function sharedChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  try {
    channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;
  } catch {
    channel = null;
  }
  return channel;
}

/** Avisa a las otras pestañas. Ni el canal ni `storage` se entregan a la pestaña que publica. */
export function publishTenantSwitch(tenantId: string): void {
  const message: TenantSwitchMessage = { type: 'tenant-switched', tenantId, at: Date.now() };
  const bc = sharedChannel();
  if (bc) {
    try {
      bc.postMessage(message);
      return;
    } catch {
      // Canal cerrado: queda `storage`.
    }
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(message));
  } catch {
    // Sin almacenamiento: las otras pestañas se enteran en su próxima navegación.
  }
}

/** Escucha a las otras pestañas. Devuelve la función para dejar de escuchar. */
export function subscribeTenantSwitch(
  onMessage: (message: TenantSwitchMessage) => void,
): () => void {
  const bc = sharedChannel();
  if (bc) {
    const handler = (event: MessageEvent<unknown>) => {
      const message = parseTenantSwitchMessage(event.data);
      if (message) onMessage(message);
    };
    bc.addEventListener('message', handler);
    return () => bc.removeEventListener('message', handler);
  }

  const handler = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY || event.newValue === null) return;
    try {
      const message = parseTenantSwitchMessage(JSON.parse(event.newValue) as unknown);
      if (message) onMessage(message);
    } catch {
      // Valor ilegible: se ignora.
    }
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}
