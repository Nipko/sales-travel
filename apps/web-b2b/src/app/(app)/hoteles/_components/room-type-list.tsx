'use client';

import { BedDouble, ChevronDown, Gift, Receipt, Wallet } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { cn } from '../../../../lib/cn';
import { perNightOf, stayShortLabel } from './hotel-card-summary';
import { formatMoney } from './hotel-format';
import {
  AtHotelCharges,
  ExpiredTag,
  OwnMarginLine,
  ProviderPill,
  RateExtras,
  RefundTag,
  UNAVAILABLE_FOR_AGENCY_NOTE,
  UnavailableForAgencyTag,
} from './hotel-rate-item';
import type { HotelRateRow } from './hotel-rate-view';
import { refundLine, type RateRefundability } from './rate-refundability';
import { type RoomSlot, type RoomTypeGroup } from './room-type-groups';

/*
 * Las habitaciones de un hotel por tipo, cada una con sus planes de tarifa: la misma lista en la
 * tarjeta del listado y en la ficha. Arriba de cada grupo, la habitación (nombre, camas, ocupación)
 * y su «desde»; debajo, sus planes con régimen, reembolso, precio por noche y total, y la acción.
 * La ficha suma por plan el detalle que sólo ella conoce (tramos de la política, precio por noche).
 */

/** Un plan de la lista: la fila de tarifa y su reembolso leído con la hora de la búsqueda. */
export interface RoomPlan {
  readonly row: HotelRateRow;
  readonly refund: RateRefundability;
}

/** Cuántos planes se ven de entrada en cada grupo. */
export const VISIBLE_PLANS = 3;

const CHIP =
  'inline-flex max-w-full items-start gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-1.5 py-px text-xs font-medium text-[var(--color-fg)]';

const FOCUS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]';

export interface RoomTypeListProps<T extends RoomPlan> {
  readonly groups: readonly RoomTypeGroup<T>[];
  /** Noches de la estadía: el precio por noche. Sin ellas, el total «por la estadía». */
  readonly nights: number | undefined;
  /** Habitaciones de la búsqueda, para la línea del total. */
  readonly roomsCount: number | undefined;
  /** En la tarjeta los grupos van bajo el nombre del hotel (h3); en la ficha, bajo «Tarifas» (h2). */
  readonly variant: 'card' | 'detail';
  /** Cuántos grupos pintar; sin tope, todos. */
  readonly maxGroups?: number;
  readonly isExpired: (plan: T) => boolean;
  /** No reembolsable con el permiso de la agencia bloqueado: se marca como no disponible. */
  readonly isUnavailable?: (plan: T) => boolean;
  /** La acción del plan (Reservar), a la derecha; en el teléfono, abajo y a lo ancho. */
  readonly planAction: (plan: T) => ReactNode;
  /** Lo que el plan tiene que decir a la vista, sin abrir nada (lo que se pierde al cancelar). */
  readonly planNotice?: (plan: T) => ReactNode;
  /** Lo que la ficha suma dentro de «Ver condiciones»; `null` si no tiene nada. */
  readonly planDetails?: (plan: T) => ReactNode;
  /** La foto del tipo de habitación; por defecto, el icono de una cama. */
  readonly photo?: (group: RoomTypeGroup<T>) => ReactNode;
}

export function RoomTypeList<T extends RoomPlan>({
  groups,
  maxGroups,
  ...rest
}: RoomTypeListProps<T>) {
  const shown = maxGroups === undefined ? groups : groups.slice(0, maxGroups);
  return (
    <div className="@container divide-y divide-[var(--color-border)]">
      {shown.map((group) => (
        <RoomTypeSection key={group.key} group={group} {...rest} />
      ))}
    </div>
  );
}

function RoomPhotoPlaceholder() {
  return (
    <div
      aria-hidden="true"
      className="flex h-12 w-16 shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)]"
    >
      <BedDouble className="size-5 text-[var(--color-fg-subtle)]" />
    </div>
  );
}

/** «Habitación 1: Doble estándar · 1 cama king · 2 adultos». */
function slotLine(slot: RoomSlot): string {
  const label = `Habitación ${slot.index + 1}`;
  const parts = [slot.name, slot.beds, slot.occupancyText].filter((p): p is string => !!p);
  return parts.length === 0 ? label : `${label}: ${parts.join(' · ')}`;
}

function SlotLines({ slots }: { slots: readonly RoomSlot[] }) {
  const [only] = slots;
  if (only === undefined) return null;
  if (slots.length === 1) {
    const parts = [only.beds, only.occupancyText].filter((p): p is string => !!p);
    if (parts.length === 0) return null;
    return <p className="text-xs text-[var(--color-fg-muted)]">{parts.join(' · ')}</p>;
  }
  return (
    <ul className="space-y-0.5 text-xs text-[var(--color-fg-muted)]">
      {slots.map((slot) => (
        <li key={slot.index}>{slotLine(slot)}</li>
      ))}
    </ul>
  );
}

type SectionProps<T extends RoomPlan> = Omit<RoomTypeListProps<T>, 'groups' | 'maxGroups'> & {
  readonly group: RoomTypeGroup<T>;
};

function RoomTypeSection<T extends RoomPlan>({
  group,
  nights,
  roomsCount,
  variant,
  isExpired,
  isUnavailable,
  planAction,
  planNotice,
  planDetails,
  photo,
}: SectionProps<T>) {
  const [expanded, setExpanded] = useState(false);
  const titleId = useId();
  const listId = useId();
  const Heading = variant === 'card' ? 'h4' : 'h3';
  const plans = expanded ? group.plans : group.plans.slice(0, VISIBLE_PLANS);
  const more = group.plans.length - VISIBLE_PLANS;
  const total = group.from.row.sale;
  const perNight = perNightOf(total, nights);
  const stay = stayShortLabel(nights, roomsCount);

  return (
    <section aria-labelledby={titleId} className="space-y-3 px-4 py-4">
      <div className="flex gap-3">
        {photo ? photo(group) : <RoomPhotoPlaceholder />}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 @lg:flex-row @lg:items-start @lg:justify-between @lg:gap-4">
          <div className="min-w-0 space-y-0.5">
            <Heading
              id={titleId}
              className="text-sm font-semibold leading-snug text-[var(--color-fg)]"
            >
              {group.title}
            </Heading>
            <SlotLines slots={group.slots} />
          </div>
          <div className="shrink-0 @lg:text-right">
            <p className="text-xs text-[var(--color-fg-muted)]">
              {group.plans.length > 1 ? 'desde ' : ''}
              <span
                className={cn(
                  'whitespace-nowrap text-sm font-semibold tabular-nums',
                  group.fromExpired
                    ? 'text-[var(--color-fg-muted)] line-through'
                    : 'text-[var(--color-fg)]',
                )}
              >
                {group.fromExpired ? <span className="sr-only">Precio vencido: </span> : null}
                {formatMoney(perNight ?? total)}
              </span>{' '}
              {perNight ? 'por noche' : 'por la estadía'}
            </p>
            {perNight ? (
              <p className="text-[11px] text-[var(--color-fg-muted)]">
                Total{stay ? ` ${stay}` : ''}:{' '}
                <span className="whitespace-nowrap font-medium tabular-nums text-[var(--color-fg)]">
                  {formatMoney(total)}
                </span>
              </p>
            ) : null}
          </div>
        </div>
      </div>

      <ul
        id={listId}
        aria-label={`Tarifas de ${group.title}`}
        className="divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)]"
      >
        {plans.map((plan) => (
          <PlanItem
            key={plan.row.key}
            plan={plan}
            nights={nights}
            expired={isExpired(plan)}
            unavailable={isUnavailable?.(plan) ?? false}
            action={planAction(plan)}
            notice={planNotice?.(plan)}
            details={planDetails?.(plan)}
          />
        ))}
      </ul>

      {more > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          aria-controls={listId}
          className={cn(
            'inline-flex items-center gap-1 rounded text-xs font-medium text-[var(--color-fg)] underline decoration-[var(--color-border-strong)] underline-offset-4 hover:decoration-[var(--color-fg)]',
            FOCUS,
          )}
        >
          {expanded
            ? 'Ver menos'
            : `Ver ${more} tarifa${more === 1 ? '' : 's'} más de ${group.slots.length > 1 ? 'estas habitaciones' : 'esta habitación'}`}
          <ChevronDown
            aria-hidden="true"
            className={cn('size-3.5 transition-transform', expanded && 'rotate-180')}
          />
          <span className="sr-only">: {group.title}</span>
        </button>
      ) : null}
    </section>
  );
}

function hasConditions(row: HotelRateRow): boolean {
  return (
    row.inclusion !== undefined ||
    row.transfers ||
    row.included.length > 0 ||
    row.atHotel.length > 0 ||
    row.extraGuest !== undefined ||
    row.commission !== undefined
  );
}

/** Lo que incluye el plan y lo que se paga aparte: siempre dentro de «Ver condiciones». */
function PlanConditions({ row }: { row: HotelRateRow }) {
  return (
    <>
      <RateExtras row={row} withPromotions={false} />
      <AtHotelCharges row={row} />
      {row.extraGuest ? (
        <p className="text-[11px] text-[var(--color-fg-muted)]">
          Cargo por huésped adicional: {formatMoney(row.extraGuest)}. Informativo, no está en el
          total.
        </p>
      ) : null}
      {row.commission ? (
        <p className="inline-flex items-center gap-1 text-[11px] text-[var(--color-fg-muted)]">
          <Wallet aria-hidden="true" className="size-3 text-[var(--color-success)]" />
          Comisión {formatMoney(row.commission.amount)}
          {row.commission.percentage ? ` (${row.commission.percentage}%)` : ''}
        </p>
      ) : null}
    </>
  );
}

function PlanItem<T extends RoomPlan>({
  plan,
  nights,
  expired,
  unavailable,
  action,
  notice,
  details,
}: {
  plan: T;
  nights: number | undefined;
  expired: boolean;
  unavailable: boolean;
  action: ReactNode;
  notice: ReactNode;
  details: ReactNode;
}) {
  const { row } = plan;
  const line = refundLine(plan.refund);
  const perNight = perNightOf(row.sale, nights);
  const withDetails = (details !== null && details !== undefined) || hasConditions(row);
  const hasAction = action !== null && action !== undefined;

  // En una grilla: régimen y precio arriba, a la misma altura (en el teléfono, el precio debajo de
  // los detalles quedaba lejos del plan que nombra); la acción, a la derecha del detalle cuando hay
  // ancho y abajo, a lo ancho, cuando no.
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_fit-content(50%)] gap-x-3 gap-y-2 px-3 py-3">
      <div className="col-start-1 row-start-1 flex min-w-0 flex-wrap items-center gap-1.5 self-start">
        <span className="rounded-md bg-[var(--color-primary)]/10 px-2 py-0.5 text-xs font-medium text-[var(--color-fg)]">
          {row.board}
        </span>
        <ProviderPill label={row.providerLabel} />
        {expired ? <ExpiredTag /> : null}
      </div>

      <div className="col-start-2 row-start-1 self-start text-right @lg:row-span-2">
        <p
          className={cn(
            'whitespace-nowrap text-sm font-bold tabular-nums',
            expired ? 'text-[var(--color-fg-muted)] line-through' : 'text-[var(--color-fg)]',
          )}
        >
          {expired ? <span className="sr-only">Precio vencido: </span> : null}
          {formatMoney(perNight ?? row.sale)}
        </p>
        <p className="whitespace-nowrap text-[11px] text-[var(--color-fg-muted)]">
          {perNight ? 'por noche' : 'por la estadía'}
        </p>
        {perNight ? (
          <p
            className={cn(
              'whitespace-nowrap text-[11px] tabular-nums text-[var(--color-fg-muted)]',
              expired && 'line-through',
            )}
          >
            Total {formatMoney(row.sale)}
          </p>
        ) : null}
        <OwnMarginLine row={row} />
      </div>

      <div className="col-span-2 row-start-2 min-w-0 space-y-1.5 @lg:col-span-1 @lg:row-span-2">
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-[var(--color-fg-muted)]">
          <RefundTag badge={line} className="max-w-full whitespace-normal" />
          {unavailable ? <UnavailableForAgencyTag /> : null}
          {line.note ? <span>{line.note}</span> : null}
        </p>
        {row.promotions.length > 0 || row.atHotel.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5">
            {row.promotions.map((p) => (
              <li key={p} className={CHIP}>
                <Gift
                  aria-hidden="true"
                  className="mt-px size-3.5 shrink-0 text-[var(--color-primary)]"
                />
                {p}
              </li>
            ))}
            {row.atHotel.length > 0 ? (
              <li className={CHIP}>
                <Receipt aria-hidden="true" className="mt-px size-3.5 shrink-0" />
                Cargos en el hotel
              </li>
            ) : null}
          </ul>
        ) : null}
        {unavailable ? (
          <p className="text-[11px] text-[var(--color-fg-muted)]">{UNAVAILABLE_FOR_AGENCY_NOTE}</p>
        ) : null}
        {notice}
        {withDetails ? (
          <details className="group/conditions">
            <summary
              className={cn(
                'inline-flex cursor-pointer list-none items-center gap-1 rounded text-[11px] font-medium text-[var(--color-fg)] underline-offset-2 hover:underline [&::-webkit-details-marker]:hidden',
                FOCUS,
              )}
            >
              Ver condiciones
              <span className="sr-only">
                : {row.board}, {formatMoney(row.sale)}
              </span>
              <ChevronDown
                aria-hidden="true"
                className="size-3 transition-transform group-open/conditions:rotate-180"
              />
            </summary>
            <div className="mt-1.5 space-y-1.5">
              {details}
              <PlanConditions row={row} />
            </div>
          </details>
        ) : null}
      </div>

      {hasAction ? (
        <div className="col-span-2 row-start-3 min-w-0 @lg:col-span-1 @lg:col-start-2 @lg:max-w-48 @lg:self-start @lg:text-right">
          {action}
        </div>
      ) : null}
    </li>
  );
}
