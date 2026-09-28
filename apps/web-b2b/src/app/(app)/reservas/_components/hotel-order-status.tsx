import { Ban, CircleHelp, Hourglass, Info } from 'lucide-react';
import { cn } from '../../../../lib/cn';
import type { HotelOrderStateView, HotelOrderTone } from '../hotel-order-view';

/*
 * El estado de una orden de hotel a la vista: el rótulo con los mismos colores que el resto de
 * Mis Reservas, y la explicación cuando el rótulo solo no alcanza ("Verificando", "Cancelación en
 * curso"; D-TBO-25 A).
 */

const TONE_CLASS: Readonly<Record<HotelOrderTone, string>> = {
  pending: 'bg-amber-50 text-amber-700',
  progress: 'bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200',
  review: 'bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200',
  confirmed: 'bg-blue-50 text-blue-700',
  cancelled: 'bg-red-50 text-red-700',
  failed: 'bg-red-50 text-red-700',
};

export function HotelOrderStatusChip({
  state,
  className,
}: {
  state: HotelOrderStateView;
  className?: string;
}) {
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1', className)}>
      <span
        className={cn('rounded-full px-2.5 py-1 text-[10px] font-medium', TONE_CLASS[state.tone])}
      >
        {state.label}
      </span>
      {state.flag ? (
        <span className="rounded-full bg-[var(--color-surface-muted)] px-2 py-1 text-[10px] font-medium text-[var(--color-fg-muted)] ring-1 ring-inset ring-[var(--color-border)]">
          {state.flag}
        </span>
      ) : null}
    </span>
  );
}

/** La explicación del estado, arriba del detalle. */
export function HotelOrderNoticeBox({ state }: { state: HotelOrderStateView }) {
  const notice = state.notice;
  if (!notice) return null;
  const danger = state.tone === 'failed';
  const quiet = state.tone === 'cancelled' || state.tone === 'confirmed';
  const Icon = danger ? Ban : state.tone === 'review' ? CircleHelp : quiet ? Info : Hourglass;
  return (
    <div
      className={cn(
        'flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-xs text-[var(--color-fg)]',
        danger
          ? 'border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5'
          : quiet
            ? 'border-[var(--color-border)] bg-[var(--color-surface-muted)]'
            : 'border-[var(--color-warning)]/60 bg-[var(--color-warning)]/10',
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          'mt-0.5 size-4 shrink-0',
          danger ? 'text-[var(--color-danger)]' : 'text-[var(--color-fg-muted)]',
        )}
      />
      <p className="leading-relaxed">
        <strong className="font-semibold">{notice.title}.</strong> {notice.detail}
      </p>
    </div>
  );
}
