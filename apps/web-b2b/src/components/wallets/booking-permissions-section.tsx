'use client';

import { RefreshCw, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import { cn } from '../../lib/cn';
import {
  loadBookingPermissions,
  updateBookingPermissions,
  type BookingPermissionsView,
  type NonRefundableRatesSetting,
} from '../../lib/booking-permissions';
import { NonRefundableRatesDialog } from './wallet-dialogs';
import { ToneNotice } from './wallet-ui';

/*
 * "Puede reservar tarifas no reembolsables" de un nodo, al lado de sus carteras (pedido del founder
 * del 2026-09-29, punto e): lo fija quien lo financia, con el mismo modelo que las carteras —el
 * superadmin desde Gestión de Agencias, un consolidador o una agencia desde Mi Red—, y el API lo
 * vuelve a decidir en cada llamada. Permitido es lo de siempre (con la confirmación obligatoria del
 * checkout); bloqueado, el nodo no puede reservarlas. Un bloqueo de un nivel de arriba rige igual y
 * se dice.
 */

type State =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string; readonly reason?: string }
  | { readonly status: 'ready'; readonly data: BookingPermissionsView };

function updatedLine(view: BookingPermissionsView['nonRefundableRates']): string | undefined {
  if (view.updatedAt === null) return undefined;
  const when = new Intl.DateTimeFormat('es', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
    .format(new Date(view.updatedAt))
    .replace(/\./g, '');
  return `Lo fijó ${view.updatedByName ?? 'quien financia al nodo'} el ${when}.`;
}

export function BookingPermissionsSection({ tenantId }: { tenantId: string }) {
  const titleId = useId();
  const labelId = useId();
  const helpId = useId();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [dialog, setDialog] = useState<NonRefundableRatesSetting | null>(null);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    const res = await loadBookingPermissions(tenantId);
    setState(
      res.ok
        ? { status: 'ready', data: res.data }
        : {
            status: 'error',
            message: res.message,
            ...(res.reason === undefined ? {} : { reason: res.reason }),
          },
    );
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const closeDialog = useCallback(() => setDialog(null), []);

  // Sin permiso para gestionarlo, la sección no aparece: el panel ya dice por qué.
  if (state.status === 'error' && state.reason === 'BOOKING_PERMISSIONS_FINANCIER_REQUIRED') {
    return null;
  }

  const view = state.status === 'ready' ? state.data : undefined;
  const nr = view?.nonRefundableRates;
  const allowed = nr?.setting === 'allowed';
  const nodeName = view?.tenant.name ?? 'el nodo';

  return (
    <section aria-labelledby={titleId} className="space-y-3">
      <h2 id={titleId} className="text-sm font-semibold text-[var(--color-fg)]">
        Tarifas no reembolsables
      </h2>

      {state.status === 'loading' ? (
        <div
          aria-busy="true"
          className="h-24 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]"
        >
          <span className="sr-only">Cargando el permiso…</span>
        </div>
      ) : state.status === 'error' ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <ToneNotice tone="danger" role="alert">
            {state.message}
          </ToneNotice>
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            <RefreshCw aria-hidden="true" />
            Reintentar
          </Button>
        </div>
      ) : nr ? (
        <div className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 space-y-1">
              <p id={labelId} className="text-sm font-medium text-[var(--color-fg)]">
                Puede reservar tarifas no reembolsables
              </p>
              <p
                id={helpId}
                className="max-w-prose text-xs leading-relaxed text-[var(--color-fg-muted)]"
              >
                Si se cancela, se modifica o el pasajero no se presenta, se cobra el 100 % y sale de
                su cartera o de su crédito. Permitido, las reserva con una confirmación obligatoria;
                bloqueado, las ve como no disponibles.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={allowed}
              aria-labelledby={labelId}
              aria-describedby={helpId}
              onClick={() => setDialog(allowed ? 'blocked' : 'allowed')}
              className={cn(
                'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)]',
                allowed
                  ? 'border-[var(--color-primary)] bg-[var(--color-primary)]'
                  : 'border-[var(--color-border-strong)] bg-[var(--color-surface-muted)]',
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'inline-block size-4 rounded-full bg-[var(--color-surface)] shadow-[var(--shadow-xs)] transition-transform',
                  allowed ? 'translate-x-6' : 'translate-x-1',
                )}
              />
            </button>
          </div>

          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--color-fg-muted)]">
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-md border px-1.5 py-px font-medium text-[var(--color-fg)]',
                nr.effective === 'allowed'
                  ? 'border-[var(--color-success)]/40 bg-[var(--color-success)]/10'
                  : 'border-[var(--color-danger)]/40 bg-[var(--color-danger)]/5',
              )}
            >
              {nr.effective === 'allowed' ? 'Permitidas' : 'Bloqueadas'}
            </span>
            {updatedLine(nr) ?? 'Sin cambios: rige lo de por defecto (permitidas).'}
          </p>

          {nr.inheritedBlock ? (
            <p className="flex items-start gap-1.5 rounded-md border border-[var(--color-warning)]/60 bg-[var(--color-warning)]/10 px-3 py-2 text-xs text-[var(--color-fg)]">
              <ShieldAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
              Un nivel de arriba de la red las tiene bloqueadas: {nodeName} no puede reservarlas
              aunque acá estén permitidas.
            </p>
          ) : null}
        </div>
      ) : null}

      {dialog !== null && nr ? (
        <NonRefundableRatesDialog
          nodeName={nodeName}
          to={dialog}
          inheritedBlock={nr.inheritedBlock}
          onClose={closeDialog}
          onSubmit={async (body) => {
            const res = await updateBookingPermissions(tenantId, body);
            if (!res.ok) return res.message;
            setDialog(null);
            setState({ status: 'ready', data: res.data });
            toast.success(
              body.nonRefundableRates === 'blocked'
                ? `${nodeName} ya no puede reservar tarifas no reembolsables.`
                : `${nodeName} puede reservar tarifas no reembolsables.`,
            );
            return undefined;
          }}
        />
      ) : null}
    </section>
  );
}
