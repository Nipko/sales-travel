'use client';

import { AlertTriangle, Clock } from 'lucide-react';
import { cn } from '../../../../lib/cn';
import {
  describeTicketingDeadline,
  ticketingDeadline,
  ticketingState,
} from '../../../../lib/ticketing-deadline';

/**
 * El plazo de emisión de una oferta o reserva. Una BASIC reservada hoy puede vencer esta misma
 * noche: el vendedor lo tiene que ver junto al precio y en la lista de reservas, no descubrirlo
 * con la reserva caída. El estado va escrito en el texto y en el icono, no sólo en el color.
 */
export function TicketingDeadlineBadge({
  raw,
  fromOrder = false,
  className,
}: {
  raw: Readonly<Record<string, unknown>> | undefined;
  fromOrder?: boolean;
  className?: string;
}) {
  const deadline = ticketingDeadline(raw);
  if (deadline === null) return null;
  const now = new Date();
  const state = ticketingState(deadline, now);
  const Icon = state === 'ok' ? Clock : AlertTriangle;
  return (
    <p
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium',
        state === 'expired'
          ? 'bg-[var(--color-danger)]/10 text-[var(--color-fg)]'
          : state === 'urgent'
            ? 'bg-[var(--color-warning)]/15 text-[var(--color-fg)]'
            : 'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]',
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-3 shrink-0" />
      {describeTicketingDeadline(deadline, now, { fromOrder })}
    </p>
  );
}
