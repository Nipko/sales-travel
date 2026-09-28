'use client';

import { ArrowRight, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { useId } from 'react';
import { cn } from '../../../../../lib/cn';
import type { PriceChangeView } from './prebook-view';

/*
 * El aviso de cambio entre la búsqueda y la revalidación (U-09, RF-15 CA-3). Si subió el precio o
 * cambiaron las condiciones, se acepta explícitamente con una casilla antes de seguir; si bajó, se
 * avisa y se sigue (D-TBO-20 A).
 */

const TONE: Record<PriceChangeView['tone'], { box: string; icon: string }> = {
  warning: {
    box: 'border-[var(--color-warning)]/60 bg-[var(--color-warning)]/10',
    icon: 'text-[var(--color-fg)]',
  },
  success: {
    box: 'border-[var(--color-success)]/40 bg-[var(--color-success)]/10',
    icon: 'text-[var(--color-success)]',
  },
  info: {
    box: 'border-[var(--color-border)] bg-[var(--color-surface-muted)]',
    icon: 'text-[var(--color-fg-muted)]',
  },
};

export function PriceChangeNotice({
  change,
  accepted,
  onAcceptedChange,
}: {
  change: PriceChangeView;
  accepted: boolean;
  onAcceptedChange: (accepted: boolean) => void;
}) {
  const acceptId = useId();
  const tone = TONE[change.tone];
  const Icon =
    change.tone === 'warning' ? TriangleAlert : change.tone === 'success' ? CircleCheck : Info;

  return (
    <div
      role={change.requiresAcceptance ? 'alert' : 'status'}
      className={cn('rounded-lg border px-4 py-3 text-sm text-[var(--color-fg)]', tone.box)}
    >
      <div className="flex items-start gap-2.5">
        <Icon aria-hidden="true" className={cn('mt-0.5 size-4 shrink-0', tone.icon)} />
        <div className="min-w-0 space-y-1.5">
          <p className="font-semibold">{change.title}</p>
          {/* Antes y ahora en una línea que no se parte por la mitad de un importe. */}
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 tabular-nums">
            {change.before ? (
              <>
                <span className="whitespace-nowrap text-[var(--color-fg-muted)] line-through">
                  <span className="sr-only">Antes: </span>
                  {change.before}
                </span>
                <ArrowRight aria-hidden="true" className="size-3.5 text-[var(--color-fg-muted)]" />
              </>
            ) : null}
            <span className="whitespace-nowrap font-semibold">
              <span className="sr-only">Ahora: </span>
              {change.after}
            </span>
            {change.delta ? (
              <span className="whitespace-nowrap text-xs text-[var(--color-fg-muted)]">
                ({change.delta})
              </span>
            ) : null}
          </p>
          {change.changes ? (
            <p className="text-xs text-[var(--color-fg-muted)]">{change.changes}</p>
          ) : null}
          {change.requiresAcceptance && change.acceptLabel ? (
            <div className="flex items-start gap-2 pt-1">
              <input
                id={acceptId}
                type="checkbox"
                checked={accepted}
                onChange={(e) => onAcceptedChange(e.target.checked)}
                className="mt-0.5 size-4 shrink-0 cursor-pointer accent-[var(--color-primary)]"
              />
              <label htmlFor={acceptId} className="cursor-pointer text-sm font-medium">
                {change.acceptLabel}
              </label>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
