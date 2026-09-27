import { ShieldCheck, ShieldX } from 'lucide-react';
import { Card } from '../../../../../components/ui/card';
import type { HotelRoompack } from '../../actions';
import { cancelPolicyView } from './conditions-view';

/*
 * La política de cancelación del PreBook (U-10): la que el proveedor da por final, con cada tramo
 * en la hora local del hotel —el proveedor no dice la zona y convertirla sería mostrar una hora
 * que el hotel no usa— y lo que costaría cancelar en cada uno, estimado sobre el precio de venta.
 */

export function CancelPolicy({
  pack,
}: {
  pack: Pick<HotelRoompack, 'cancellation' | 'price' | 'pricing'>;
}) {
  const view = cancelPolicyView(pack);
  const Icon = view.refundable ? ShieldCheck : ShieldX;

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-[var(--color-border)] px-4 py-3">
        <h2 className="text-sm font-semibold tracking-tight text-[var(--color-fg)]">
          Política de cancelación
        </h2>
        <span className="rounded border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-1.5 py-px text-[11px] font-medium text-[var(--color-fg-muted)]">
          {view.final ? 'Confirmada por el proveedor' : 'Sujeta a confirmación'}
        </span>
      </div>
      <div className="space-y-3 px-4 py-3">
        <p className="flex items-start gap-1.5 text-sm font-medium text-[var(--color-fg)]">
          <Icon
            aria-hidden="true"
            className={
              view.refundable
                ? 'mt-0.5 size-4 shrink-0 text-[var(--color-success)]'
                : 'mt-0.5 size-4 shrink-0 text-[var(--color-fg-muted)]'
            }
          />
          {view.headline}
        </p>

        {view.tiers.length > 0 ? (
          <div>
            <h3 className="sr-only">Tramos de la penalidad</h3>
            <ol className="divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)] text-xs">
              {view.tiers.map((tier, i) => (
                <li
                  key={i}
                  className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
                >
                  <span className="text-[var(--color-fg-muted)]">{tier.when}</span>
                  <span className="text-[var(--color-fg)] sm:text-right">
                    <span className="font-medium tabular-nums">{tier.charge}</span>
                    {tier.approx ? (
                      <span className="block whitespace-nowrap text-[11px] tabular-nums text-[var(--color-fg-muted)]">
                        Penalidad estimada: {tier.approx}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ) : null}

        {view.hotelLocalTime || view.hasEstimates ? (
          <ul className="space-y-0.5 text-[11px] text-[var(--color-fg-muted)]">
            {view.hotelLocalTime ? <li>Fechas y horas en hora local del hotel.</li> : null}
            {view.hasEstimates ? (
              <li>
                La penalidad estimada se calcula sobre el precio de venta; el cargo lo define el
                proveedor al cancelar.
              </li>
            ) : null}
          </ul>
        ) : null}

        {view.notes ? (
          <p className="whitespace-pre-line break-words text-xs text-[var(--color-fg-muted)]">
            {view.notes}
          </p>
        ) : null}
      </div>
    </Card>
  );
}
