'use client';

import { Mail, RefreshCw, XCircle } from 'lucide-react';
import { Button } from '../../../../../../components/ui/button';
import {
  platformOrderActionsOf,
  type PlatformOrderAction,
} from '../../../../../../lib/platform-order-actions';
import type { PlatformOrderDetail } from '../../../../../../lib/platform-orders';

/**
 * El pie de la ficha: la post-venta que el superadmin puede hacer sobre la reserva (FD-1 C).
 * Consultar al proveedor, reenviar la confirmación y cancelar en nombre de la agencia; reintentar
 * una cancelación fallida está en el historial de operaciones, junto al intento. Nada de vender.
 *
 * Cada botón abre su confirmación con el motivo (OrderActionDialog); el pedido no sale desde acá. Sin
 * ninguna acción posible no hay pie. Si la cancelación existe pero hoy no se ofrece (hay un intento
 * anterior que reintentar o conciliar), se dice por qué en vez de esconderlo.
 */
export function OrderActions({
  detail,
  onAction,
}: {
  detail: PlatformOrderDetail;
  onAction: (action: PlatformOrderAction) => void;
}) {
  const actions = platformOrderActionsOf(detail);
  const { sendConfirmation, retrieve, cancel } = actions;
  if (sendConfirmation === null && !retrieve && cancel === null) return null;

  return (
    <footer className="shrink-0 space-y-2 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
      {cancel?.blocked ? (
        <p className="text-[11px] leading-relaxed text-[var(--color-fg-muted)]">{cancel.blocked}</p>
      ) : null}
      <div role="group" aria-label="Acciones de post-venta" className="flex flex-wrap gap-2">
        {retrieve ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="flex-1 sm:flex-none"
            onClick={() => onAction({ kind: 'retrieve' })}
          >
            <RefreshCw aria-hidden="true" />
            Consultar al proveedor
          </Button>
        ) : null}
        {sendConfirmation !== null ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="flex-1 sm:flex-none"
            onClick={() => onAction({ kind: 'send-confirmation', to: sendConfirmation.to })}
          >
            <Mail aria-hidden="true" />
            Reenviar confirmación
          </Button>
        ) : null}
        {cancel !== null && cancel.blocked === null ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="flex-1 text-[var(--color-danger)] hover:text-[var(--color-danger)] sm:ml-auto sm:flex-none"
            onClick={() => onAction({ kind: 'cancel' })}
          >
            <XCircle aria-hidden="true" />
            Cancelar reserva
          </Button>
        ) : null}
      </div>
    </footer>
  );
}
