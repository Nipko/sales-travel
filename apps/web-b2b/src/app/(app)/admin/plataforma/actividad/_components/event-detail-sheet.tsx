'use client';

import { ExternalLink, Filter, X } from 'lucide-react';
import Link from 'next/link';
import { useId, type ReactNode } from 'react';
import { ModalPortal, useModalBehavior } from '../../../../../../components/ui/dialog';
import { eventDetail, eventLabel } from '../../../../../../lib/audit-format';
import {
  activityActorLabel,
  activityCategoryLabel,
  activityCategoryOf,
  activityNodeLabel,
  formatActivityDateFull,
  orderSheetHref,
  prettyPayload,
  type ActivityEventView,
} from '../../../../../../lib/platform-audit';
import { isUuid } from '../../../../../../lib/wallets';

/** Lo que se puede filtrar desde el detalle: este tipo, o todo lo de esta entidad. */
export type EventDetailFilter =
  | { readonly kind: 'type'; readonly eventType: string }
  | { readonly kind: 'entity'; readonly aggregateType: string; readonly aggregateId: string };

/**
 * El detalle de un evento de la Actividad: panel a la derecha en el escritorio, pantalla completa en
 * el teléfono. Se cierra con la X, Escape o el fondo. No vuelve a pedir nada: muestra lo que trajo
 * la lista (el payload ya sin claves sensibles; de dónde vino, sin el id de la sesión).
 */
export function EventDetailSheet({
  event,
  onClose,
  onFilter,
}: {
  event: ActivityEventView;
  onClose: () => void;
  onFilter: (filter: EventDetailFilter) => void;
}) {
  const panelRef = useModalBehavior(true, onClose);
  const titleId = useId();
  const label = eventLabel(event.eventType, event.payload);

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-50 flex justify-end">
        <div
          className="absolute inset-0 bg-black/50 animate-fade-in"
          onClick={onClose}
          aria-hidden
        />
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className="relative flex w-full flex-col bg-[var(--color-surface)] shadow-[var(--shadow-xl)] motion-safe:animate-fade-in-up sm:max-w-[560px] sm:border-l sm:border-[var(--color-border)] motion-safe:sm:animate-sheet-in"
        >
          <header className="flex shrink-0 items-start gap-3 border-b border-[var(--color-border)] px-5 pb-4 pt-[max(1rem,env(safe-area-inset-top))]">
            <div className="min-w-0 flex-1 pt-0.5">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-fg-muted)]">
                Detalle del evento
              </p>
              <h2
                id={titleId}
                className="mt-1 text-base font-semibold leading-snug text-[var(--color-fg)] [overflow-wrap:anywhere]"
              >
                {label.text}
              </h2>
              {!label.raw ? (
                <code className="mt-0.5 block font-mono text-[11px] text-[var(--color-fg-muted)] [overflow-wrap:anywhere]">
                  {event.eventType}
                </code>
              ) : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Cerrar el detalle"
              className="-mr-2 -mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </header>

          <div className="scroll-panel relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-4">
              <EventDetailContent event={event} onFilter={onFilter} />
            </div>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}

/** Lo que se ve dentro del detalle. Sin estado: se prueba renderizándolo. */
export function EventDetailContent({
  event,
  onFilter,
}: {
  event: ActivityEventView;
  onFilter: (filter: EventDetailFilter) => void;
}) {
  const detail = eventDetail(event);
  const payload = prettyPayload(event.payload);
  const category = activityCategoryOf(event.eventType);
  const entity =
    event.aggregateType !== null && event.aggregateId !== null
      ? { aggregateType: event.aggregateType, aggregateId: event.aggregateId }
      : null;
  const order =
    event.aggregateType === 'order' && isUuid(event.aggregateId) ? event.aggregateId : null;

  return (
    <div className="space-y-6">
      {detail !== '' ? (
        <p className="text-sm leading-relaxed text-[var(--color-fg)] [overflow-wrap:anywhere]">
          {detail}
        </p>
      ) : null}

      <Section title="Qué, dónde y cuándo">
        <dl className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
          <Fact label="Fecha (hora de Bogotá)">
            <time dateTime={event.occurredAt}>{formatActivityDateFull(event.occurredAt)}</time>
          </Fact>
          <Fact label="Categoría">{activityCategoryLabel(category)}</Fact>
          <Fact label="Nodo">{activityNodeLabel(event)}</Fact>
          <Fact label="Quién">{activityActorLabel(event)}</Fact>
          {event.targetEmail !== null ? <Fact label="Sobre quién">{event.targetEmail}</Fact> : null}
          {entity !== null ? (
            <Fact label="Entidad">
              <span className="text-[var(--color-fg-muted)]">{entity.aggregateType}</span>{' '}
              <code className="font-mono text-xs">{entity.aggregateId}</code>
            </Fact>
          ) : null}
        </dl>
        {order !== null ? (
          <Link
            href={orderSheetHref(order)}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--color-primary)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
          >
            Ver la reserva
            <ExternalLink aria-hidden="true" className="size-3.5" />
          </Link>
        ) : null}
      </Section>

      <Section title="Datos del evento">
        {payload === null ? (
          <p className="text-xs text-[var(--color-fg-muted)]">Este evento no trae datos.</p>
        ) : (
          <pre
            tabIndex={0}
            aria-label="Datos del evento en JSON"
            className="max-h-80 overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3 font-mono text-[11px] leading-relaxed text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
          >
            {payload}
          </pre>
        )}
        <p className="text-[11px] text-[var(--color-fg-muted)]">
          Los datos sensibles (claves, tokens, tarjetas, ids de sesión) nunca se muestran.
        </p>
      </Section>

      <Section title="De dónde vino">
        <dl className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
          <Fact label="IP">
            <Mono value={event.meta.ip} />
          </Fact>
          <Fact label="Id del pedido">
            <Mono value={event.meta.requestId} />
          </Fact>
          <div className="sm:col-span-2">
            <Fact label="Navegador">{event.meta.userAgent ?? <Missing />}</Fact>
          </div>
        </dl>
      </Section>

      <Section title="Seguir investigando">
        <div className="flex flex-wrap gap-2">
          <FilterButton onClick={() => onFilter({ kind: 'type', eventType: event.eventType })}>
            Sólo este tipo de evento
          </FilterButton>
          {entity !== null ? (
            <FilterButton onClick={() => onFilter({ kind: 'entity', ...entity })}>
              Toda la actividad de esta entidad
            </FilterButton>
          ) : null}
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-2.5">
      <h3
        id={id}
        className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-fg-muted)]"
      >
        {title}
      </h3>
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-[var(--color-fg-muted)]">{label}</dt>
      <dd className="mt-0.5 min-w-0 text-sm text-[var(--color-fg)] [overflow-wrap:anywhere]">
        {children}
      </dd>
    </div>
  );
}

function Missing() {
  return <span className="text-[var(--color-fg-subtle)]">No quedó registrado</span>;
}

function Mono({ value }: { value: string | null }) {
  return value === null ? <Missing /> : <code className="font-mono text-xs">{value}</code>;
}

function FilterButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs font-medium text-[var(--color-fg)] transition-colors hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
    >
      <Filter aria-hidden="true" className="size-3.5 text-[var(--color-fg-muted)]" />
      {children}
    </button>
  );
}
