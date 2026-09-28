'use client';

import { ArrowRight, Info, Receipt } from 'lucide-react';
import { useId } from 'react';
import { Button } from '../../../../../components/ui/button';
import { Card } from '../../../../../components/ui/card';
import { formatMoney } from '../../_components/hotel-format';
import { OwnMarginLine, RateItem, stayLabel } from '../../_components/hotel-rate-item';
import type { HotelRateRow } from '../../_components/hotel-rate-view';
import type { ContinueGate } from './prebook-view';

/*
 * La tarifa revalidada (U-09): la misma fila que el listado y el detalle —misma pastilla de
 * proveedor con la misma regla (RF-40), mismo precio de VENTA y mismos cargos en el hotel—, ahora
 * con las políticas que el PreBook da por finales. Y el total con el paso siguiente.
 */

export function PrebookSummary({ row, expired }: { row: HotelRateRow; expired: boolean }) {
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-[var(--color-border)] px-4 py-3">
        <h2 className="text-sm font-semibold tracking-tight text-[var(--color-fg)]">
          Tarifa revalidada
        </h2>
        <p className="text-[11px] text-[var(--color-fg-muted)]">
          Precio, disponibilidad y condiciones confirmados con el proveedor.
        </p>
      </div>
      <ul>
        <RateItem row={row} expired={expired} />
      </ul>
    </Card>
  );
}

export function PrebookTotal({
  row,
  nights,
  gate,
  onContinue,
}: {
  row: HotelRateRow;
  nights: number;
  gate: ContinueGate;
  onContinue: () => void;
}) {
  const reasonId = useId();
  return (
    <Card className="space-y-3 p-4">
      <div>
        <h2 className="text-sm font-semibold tracking-tight text-[var(--color-fg)]">Total</h2>
        <p className="text-[11px] text-[var(--color-fg-muted)]">
          {stayLabel(nights)} · precio de venta
        </p>
      </div>
      <div>
        <p className="text-xl font-semibold tabular-nums tracking-tight text-[var(--color-fg)]">
          {formatMoney(row.sale)}
        </p>
        <OwnMarginLine row={row} />
      </div>
      {row.atHotel.length > 0 ? (
        <p className="flex items-start gap-1.5 text-[11px] text-[var(--color-fg-muted)]">
          <Receipt aria-hidden="true" className="mt-px size-3 shrink-0" />
          Más cargos a pagar en el hotel, aparte de este total: están en el detalle de la tarifa.
        </p>
      ) : null}
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
          onClick={onContinue}
        >
          Continuar con los huéspedes
          <ArrowRight aria-hidden="true" />
        </Button>
      </div>
    </Card>
  );
}
