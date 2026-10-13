'use client';

import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '../../../../lib/cn';
import { TicketingDeadlineBadge } from '../../cotizaciones/_components/ticketing-deadline-badge';
import {
  DOCUMENT_STATUS_LABEL,
  copyLocatorLabel,
  documentKindLabel,
  documentPassengerLabel,
  documentStatusTone,
  locatorChipLabel,
  orderTicketingDeadline,
  parseFlightTracking,
  type FlightTrackingLocator,
} from '../flight-order-view';

/*
 * Lo que una reserva de vuelo tiene guardado de su última lectura al proveedor, en el detalle de
 * Mis Reservas: el localizador de cada aerolínea (lo que el pasajero usa para el check-in), los
 * tiquetes con su estado y hasta cuándo se puede emitir. Todo sale de `flightTracking`, sin volver
 * a consultar al proveedor.
 */

/** Lo que estos componentes leen de una orden de `GET /orders`. */
export interface FlightTrackingOrder {
  readonly status: string;
  readonly flightTracking?: unknown;
  readonly passengers?: readonly { readonly givenName?: unknown; readonly surname?: unknown }[];
  readonly selectedOffer?: { readonly provider?: { readonly raw?: Record<string, unknown> } };
}

const HEADING =
  'mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-fg-subtle)]';

const TONE_CLASS = {
  ok: 'bg-green-50 text-green-700',
  muted: 'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]',
  warning: 'bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200',
} as const;

/** Un localizador con su botón «Copiar». El aviso de copiado también se anuncia. */
function LocatorChip({ locator }: { locator: FlightTrackingLocator }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(locator.locator);
      setCopied(true);
    } catch {
      // Sin permiso de portapapeles el código sigue a la vista para copiarlo a mano.
      setCopied(false);
    }
  }

  return (
    <li className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] py-0.5 pl-3 pr-1">
      <span className="font-mono text-xs font-semibold text-[var(--color-fg)]">
        {locatorChipLabel(locator)}
      </span>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={copyLocatorLabel(locator)}
        className="inline-flex min-h-7 items-center gap-1 rounded-full px-2 text-[11px] font-medium text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-primary)]"
      >
        {copied ? (
          <Check aria-hidden="true" className="size-3" />
        ) : (
          <Copy aria-hidden="true" className="size-3" />
        )}
        {copied ? 'Copiado' : 'Copiar'}
      </button>
      <span className="sr-only" aria-live="polite">
        {copied ? `Localizador ${locator.locator} copiado` : ''}
      </span>
    </li>
  );
}

/**
 * Las secciones del detalle: «Localizadores de la aerolínea», «Tiquetes» y el plazo de emisión.
 * Una reserva confirmada o emitida sin localizador lo dice: el hueco se ve, no se calla.
 */
export function FlightOrderTracking({ order }: { order: FlightTrackingOrder }) {
  const tracking = parseFlightTracking(order.flightTracking);
  const locators = tracking?.airlineLocators ?? [];
  const documents = tracking?.documents ?? [];
  const live = order.status === 'confirmed' || order.status === 'ticketed';
  const deadline = order.status === 'confirmed' ? orderTicketingDeadline(order) : null;

  if (locators.length === 0 && documents.length === 0 && deadline === null && !live) return null;

  return (
    <>
      {(locators.length > 0 || live) && (
        <section>
          <h3 className={HEADING}>Localizadores de la aerolínea</h3>
          {locators.length > 0 ? (
            <>
              <ul className="flex flex-wrap gap-2">
                {locators.map((locator) => (
                  <LocatorChip
                    key={`${locator.carrierCode}|${locator.locator}`}
                    locator={locator}
                  />
                ))}
              </ul>
              <p className="mt-1.5 text-[11px] text-[var(--color-fg-muted)]">
                Con este código el pasajero hace el check-in en la web de la aerolínea.
              </p>
            </>
          ) : tracking === null ? (
            <p className="text-xs text-[var(--color-fg-muted)]">
              La aerolínea todavía no informó su localizador. Usa «Consultar estado» para traerlo.
            </p>
          ) : (
            // Ya hubo una lectura guardada y no trajo ninguno: volver a consultar no lo arregla
            // (una aerolínea que vende directo no siempre lo da aparte del código de la reserva).
            <p className="text-xs text-[var(--color-fg-muted)]">
              La aerolínea no informó su localizador en la última consulta.
            </p>
          )}
        </section>
      )}

      {(documents.length > 0 || order.status === 'ticketed') && (
        <section>
          <h3 className={HEADING}>Tiquetes</h3>
          {documents.length > 0 ? (
            <ul className="space-y-1.5">
              {documents.map((document) => {
                const tone = documentStatusTone(document.status);
                return (
                  <li
                    key={document.number}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs"
                  >
                    <div className="min-w-0">
                      <span className="font-mono font-medium text-[var(--color-fg)]">
                        {document.number}
                      </span>
                      <span className="text-[var(--color-fg-muted)]">
                        {' · '}
                        {documentKindLabel(document.kind)}
                        {' · '}
                        {documentPassengerLabel(document, order.passengers)}
                      </span>
                    </div>
                    <span
                      className={cn(
                        'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium',
                        TONE_CLASS[tone],
                      )}
                    >
                      {DOCUMENT_STATUS_LABEL[document.status]}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : tracking === null ? (
            <p className="text-xs text-[var(--color-fg-muted)]">
              Todavía no tenemos los números de tiquete. Usa «Consultar estado» para traerlos.
            </p>
          ) : (
            <p className="text-xs text-[var(--color-fg-muted)]">
              La última consulta no trajo números de tiquete.
            </p>
          )}
        </section>
      )}

      {deadline !== null && (
        <section>
          <h3 className={HEADING}>Plazo de emisión</h3>
          <TicketingDeadlineBadge
            deadline={deadline.deadline}
            clock={deadline.clock}
            fromOrder={deadline.fromOrder}
          />
        </section>
      )}
    </>
  );
}

/**
 * El plazo en la fila de la lista, para una reserva confirmada: el que la reserva tiene en el
 * proveedor o, si todavía no se leyó, el de la tarifa.
 */
export function FlightDeadlineBadge({
  order,
  className,
}: {
  order: FlightTrackingOrder;
  className?: string;
}) {
  const deadline = orderTicketingDeadline(order);
  if (deadline === null) return null;
  return (
    <TicketingDeadlineBadge
      deadline={deadline.deadline}
      clock={deadline.clock}
      fromOrder={deadline.fromOrder}
      {...(className === undefined ? {} : { className })}
    />
  );
}
