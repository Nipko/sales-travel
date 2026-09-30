'use client';

import { ArrowLeft, Info, Receipt, ShieldCheck, ShieldX, Wallet } from 'lucide-react';
import { useId } from 'react';
import { Button } from '../../../../../components/ui/button';
import { Card } from '../../../../../components/ui/card';
import { Checkbox } from '../../../../../components/ui/field';
import type { Money } from '../../actions';
import { formatMoney } from '../../_components/hotel-format';
import { OwnMarginLine, stayLabel } from '../../_components/hotel-rate-item';
import type { AtHotelCharge, HotelRateRow } from '../../_components/hotel-rate-view';
import type { BookGate } from './booking-view';
import { NonRefundableAck } from './non-refundable-notice';
import type { PrebookNonRefundable } from './non-refundable-view';

/*
 * El resumen del paso 2 y el único botón que reserva (U-13; RF-10). Los cargos que se pagan en el
 * hotel están acá, EN el paso de reserva y al lado del botón, cada uno con su importe y su moneda y
 * fuera del total; si los hay, el vendedor confirma que se los mostró al cliente antes de reservar
 * (el servidor rechaza el Book sin esa confirmación). Una tarifa no reembolsable lleva su casilla
 * OBLIGATORIA con el 100 % exacto y el recordatorio de revisar nombres y fechas (pedido del
 * 2026-09-29, punto c): sin ella el servidor tampoco reserva. Se paga con el saldo o el crédito de
 * la agencia: no hay campos de tarjeta en ninguna parte del checkout (D1).
 */

export function BookingConfirm({
  row,
  total,
  nights,
  cancellation,
  atHotel,
  acknowledged,
  onAcknowledgedChange,
  acknowledgeError,
  nonRefundable,
  nonRefundableAcknowledged,
  onNonRefundableAcknowledgedChange,
  nonRefundableError,
  gate,
  onConfirm,
  onBack,
}: {
  row: HotelRateRow;
  /** El precio de venta que se confirma: el aceptado, o el nuevo si subió y se aceptó. */
  total: Money;
  nights: number;
  cancellation: { readonly headline: string; readonly refundable: boolean };
  atHotel: readonly AtHotelCharge[];
  acknowledged: boolean;
  onAcknowledgedChange: (acknowledged: boolean) => void;
  acknowledgeError: string | undefined;
  /** La tarifa es no reembolsable en los hechos: se pide la casilla obligatoria. */
  nonRefundable: PrebookNonRefundable | undefined;
  nonRefundableAcknowledged: boolean;
  onNonRefundableAcknowledgedChange: (acknowledged: boolean) => void;
  nonRefundableError: string | undefined;
  gate: BookGate;
  onConfirm: () => void;
  onBack: () => void;
}) {
  const reasonId = useId();
  const ackId = useId();
  const ackErrorId = useId();
  const sameTotal =
    total.amountMinor === row.sale.amountMinor && total.currency === row.sale.currency;
  const Shield = cancellation.refundable ? ShieldCheck : ShieldX;

  return (
    <Card className="space-y-3 p-4">
      <div>
        <h2 className="text-sm font-semibold tracking-tight text-[var(--color-fg)]">
          Confirmar reserva
        </h2>
        <p className="text-[11px] text-[var(--color-fg-muted)]">
          {stayLabel(nights)} · precio de venta
        </p>
      </div>
      <div>
        <p className="text-xl font-semibold tabular-nums tracking-tight text-[var(--color-fg)]">
          {formatMoney(total)}
        </p>
        {/* Con un precio nuevo, el desglose de la tarifa ya no es el de este total. */}
        {sameTotal ? <OwnMarginLine row={row} /> : null}
      </div>
      <p className="flex items-start gap-1.5 text-[11px] text-[var(--color-fg-muted)]">
        <Shield
          aria-hidden="true"
          className={
            cancellation.refundable
              ? 'mt-px size-3 shrink-0 text-[var(--color-success)]'
              : 'mt-px size-3 shrink-0'
          }
        />
        {cancellation.headline}
      </p>

      {atHotel.length > 0 ? (
        <div className="space-y-2 rounded-md border border-[var(--color-warning)]/50 bg-[var(--color-warning)]/10 px-2.5 py-2 text-[11px] text-[var(--color-fg)]">
          <p className="flex items-center gap-1 font-medium">
            <Receipt aria-hidden="true" className="size-3 shrink-0" />A pagar en el hotel, aparte
            del total
          </p>
          <ul className="space-y-0.5">
            {atHotel.map((c, i) => (
              <li key={i}>
                {c.description}
                {c.room === undefined ? '' : ` (habitación ${c.room})`}:{' '}
                <span className="font-medium tabular-nums">{c.amount}</span>
              </li>
            ))}
          </ul>
          <div className="flex items-start gap-2 border-t border-[var(--color-warning)]/40 pt-2">
            <Checkbox
              id={ackId}
              checked={acknowledged}
              onChange={(e) => onAcknowledgedChange(e.target.checked)}
              aria-invalid={acknowledgeError ? true : undefined}
              aria-describedby={acknowledgeError ? ackErrorId : undefined}
              className="mt-px shrink-0 cursor-pointer focus-visible:ring-[var(--color-primary)]"
            />
            <label htmlFor={ackId} className="cursor-pointer text-xs font-medium">
              Le mostré al cliente estos cargos, que paga en el hotel.
            </label>
          </div>
          {acknowledgeError ? (
            <p id={ackErrorId} role="alert" className="text-xs text-[var(--color-danger)]">
              {acknowledgeError}
            </p>
          ) : null}
        </div>
      ) : null}

      {nonRefundable ? (
        <NonRefundableAck
          nonRefundable={nonRefundable}
          acknowledged={nonRefundableAcknowledged}
          onAcknowledgedChange={onNonRefundableAcknowledgedChange}
          error={nonRefundableError}
        />
      ) : null}

      <p className="flex items-start gap-1.5 text-[11px] text-[var(--color-fg-muted)]">
        <Wallet aria-hidden="true" className="mt-px size-3 shrink-0" />
        Se retiene de la cartera de la agencia en la moneda de la tarifa (su saldo más su cupo). No
        se piden datos de tarjeta.
      </p>

      <div className="space-y-2 border-t border-[var(--color-border)] pt-3">
        {gate.reason ? (
          <p id={reasonId} className="flex items-start gap-1.5 text-xs text-[var(--color-fg)]">
            <Info
              aria-hidden="true"
              className="mt-px size-3.5 shrink-0 text-[var(--color-fg-muted)]"
            />
            {gate.reason}
          </p>
        ) : null}
        <Button
          type="button"
          className="w-full"
          disabled={!gate.ok}
          aria-describedby={gate.reason ? reasonId : undefined}
          onClick={onConfirm}
        >
          Confirmar reserva
        </Button>
        <Button type="button" variant="ghost" size="sm" className="w-full" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          Volver a la tarifa
        </Button>
      </div>
    </Card>
  );
}
