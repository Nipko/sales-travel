/**
 * Cuánto le queda a una invitación, dicho como lo lee un admin: "vence en 7 días", "vence hoy",
 * "venció". Sin I/O ni reloj propio: `now` lo pasa quien pinta.
 *
 * Una invitación vencida sigue en la lista de pendientes (el API no la borra) y se reenvía desde ahí,
 * así que "venció" tiene que distinguirse de "vence en unos días".
 */

const DAY_MS = 24 * 60 * 60_000;

export interface InvitationExpiry {
  readonly label: string;
  readonly expired: boolean;
}

/** `undefined` si la fecha no se puede leer: la fila se pinta sin vencimiento en vez de mentirlo. */
export function invitationExpiry(expiresAt: string, now: Date): InvitationExpiry | undefined {
  const end = Date.parse(expiresAt);
  if (Number.isNaN(end)) return undefined;
  const left = end - now.getTime();
  if (left <= 0) return { label: 'venció', expired: true };
  const days = Math.floor(left / DAY_MS);
  if (days === 0) return { label: 'vence hoy', expired: false };
  if (days === 1) return { label: 'vence mañana', expired: false };
  return { label: `vence en ${days} días`, expired: false };
}
