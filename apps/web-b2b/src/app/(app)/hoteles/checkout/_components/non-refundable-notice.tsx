'use client';

import { ShieldAlert } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { Checkbox } from '../../../../../components/ui/field';
import { cn } from '../../../../../lib/cn';
import {
  NON_REFUNDABLE_REVIEW_REMINDER,
  nonRefundableAckLabel,
  nonRefundableNoticeView,
  type PrebookNonRefundable,
} from './non-refundable-view';

/*
 * Tarifas no reembolsables (pedido del founder del 2026-09-29, puntos b y c). El importe es el
 * protagonista: lo que se pierde es el 100 % del precio de venta, en su moneda, y se lee de un
 * vistazo antes que cualquier explicación. Mismo color de advertencia que la etiqueta "No
 * reembolsable" de los resultados: no es un error, es una condición que el vendedor acepta.
 */

const BOX = 'rounded-lg border border-[var(--color-warning)]/70 bg-[var(--color-warning)]/10';

/** El aviso grande: en el paso 1 del checkout y en el detalle de una orden. */
export function NonRefundableNotice({
  nonRefundable,
  headingLevel = 2,
  children,
}: {
  nonRefundable: PrebookNonRefundable;
  headingLevel?: 2 | 3;
  /** Lo que el contexto suma debajo: quién lo aceptó y cuándo, en una orden. */
  children?: ReactNode;
}) {
  const titleId = useId();
  const view = nonRefundableNoticeView(nonRefundable);
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section
      aria-labelledby={titleId}
      className={cn(BOX, 'px-4 py-3.5 text-sm text-[var(--color-fg)]')}
    >
      <div className="flex items-start gap-2.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[var(--color-warning)]/25">
          <ShieldAlert aria-hidden="true" className="size-4" />
        </span>
        <div className="min-w-0 space-y-2">
          <div>
            <Heading id={titleId} className="font-semibold tracking-tight">
              {view.title}
            </Heading>
            <p className="mt-0.5 text-xs">{view.lead}</p>
            <p className="mt-0.5 text-xl font-semibold tabular-nums tracking-tight">
              {view.amount}
            </p>
          </div>
          <ul className="space-y-1 text-xs">
            {view.points.map((point) => (
              <li key={point} className="flex items-start gap-1.5">
                <span
                  aria-hidden="true"
                  className="mt-[0.45rem] size-1 shrink-0 rounded-full bg-[var(--color-fg)]"
                />
                {point}
              </li>
            ))}
          </ul>
          {view.since ? <p className="text-xs text-[var(--color-fg-muted)]">{view.since}</p> : null}
          {children}
        </div>
      </div>
    </section>
  );
}

/**
 * La casilla OBLIGATORIA del paso 2, al lado del botón que reserva. El servidor rechaza el Book de
 * una no reembolsable sin ella (`NON_REFUNDABLE_NOT_ACKNOWLEDGED`).
 */
export function NonRefundableAck({
  nonRefundable,
  acknowledged,
  onAcknowledgedChange,
  error,
}: {
  nonRefundable: PrebookNonRefundable;
  acknowledged: boolean;
  onAcknowledgedChange: (acknowledged: boolean) => void;
  error: string | undefined;
}) {
  const ackId = useId();
  const errorId = useId();
  const reminderId = useId();
  return (
    <div className={cn(BOX, 'space-y-2 px-2.5 py-2 text-[11px] text-[var(--color-fg)]')}>
      <p className="flex items-center gap-1 font-semibold">
        <ShieldAlert aria-hidden="true" className="size-3.5 shrink-0" />
        Tarifa no reembolsable
      </p>
      <p id={reminderId}>{NON_REFUNDABLE_REVIEW_REMINDER}</p>
      <div className="flex items-start gap-2 border-t border-[var(--color-warning)]/40 pt-2">
        <Checkbox
          id={ackId}
          name="nonRefundableAcknowledged"
          checked={acknowledged}
          onChange={(e) => onAcknowledgedChange(e.target.checked)}
          aria-required="true"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${reminderId} ${errorId}` : reminderId}
          className="mt-px shrink-0 cursor-pointer focus-visible:ring-[var(--color-primary)]"
        />
        <label htmlFor={ackId} className="cursor-pointer text-xs font-medium">
          {nonRefundableAckLabel(nonRefundable)}
        </label>
      </div>
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
