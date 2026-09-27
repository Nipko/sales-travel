'use client';

import { Ban, ChevronDown, ScrollText, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useId, useState } from 'react';
import { Card } from '../../../../../components/ui/card';
import { cn } from '../../../../../lib/cn';
import type { HotelDetailLink } from '../../_components/hotel-search-handoff';
import { conditionGroups } from './conditions-view';
import type { HotelPrebookCondition, SignalsView } from './prebook-view';

/*
 * Las condiciones del hotel que devuelve el PreBook (U-11, RF-16). El API ya las convirtió a
 * texto plano; acá se pintan como texto de React, con sus saltos de línea, y NUNCA como HTML: el
 * texto es del proveedor y puede traer marcado escapado que no tiene que volver a ser marcado.
 * Las señales críticas van aparte y arriba, fuera del colapsable (docs/tbo/03 §2.4).
 */

export function RateSignalsNotice({
  view,
  hotelLink,
}: {
  view: SignalsView;
  hotelLink: HotelDetailLink;
}) {
  if (view.notices.length === 0) return null;
  return (
    <div className="space-y-2">
      {view.notices.map((notice) => {
        const danger = notice.tone === 'danger';
        const Icon = danger ? Ban : TriangleAlert;
        return (
          <div
            key={notice.code}
            role={danger ? 'alert' : undefined}
            className={cn(
              'flex flex-col gap-3 rounded-lg border px-4 py-3 text-sm text-[var(--color-fg)] sm:flex-row sm:items-center sm:justify-between',
              danger
                ? 'border-[var(--color-danger)]/35 bg-[var(--color-danger)]/5'
                : 'border-[var(--color-warning)]/60 bg-[var(--color-warning)]/10',
            )}
          >
            <div className="flex items-start gap-2.5">
              <Icon
                aria-hidden="true"
                className={cn(
                  'mt-0.5 size-4 shrink-0',
                  danger ? 'text-[var(--color-danger)]' : 'text-[var(--color-fg)]',
                )}
              />
              <p>
                <strong className="font-semibold">{notice.title}</strong> {notice.detail}
              </p>
            </div>
            {danger ? (
              <Link
                href={hotelLink}
                className="inline-flex h-9 shrink-0 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs font-medium text-[var(--color-fg)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
              >
                Elegir otra tarifa
              </Link>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function RateConditions({
  conditions,
  defaultOpen = true,
}: {
  conditions: readonly HotelPrebookCondition[];
  /** En una reserva ya hecha van plegadas: se consultan, no se aceptan. */
  defaultOpen?: boolean;
}) {
  const groups = conditionGroups(conditions);
  const count = groups.reduce((n, g) => n + g.items.length, 0);
  // Abierto de entrada: son finales para la reserva (TBO, KP-3) y el vendedor las tiene que poder
  // leer completas antes de seguir; el que ya las leyó las pliega.
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();

  return (
    <Card className="overflow-hidden">
      {/* El botón va DENTRO del título y no al revés: un `summary` con un `h2` adentro es un botón
          para el lector de pantalla, y el título deja de estar en la lista de títulos. */}
      <h2 className="text-sm font-semibold tracking-tight text-[var(--color-fg)]">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
          className="flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-primary)]"
        >
          <span className="flex items-center gap-2">
            <ScrollText aria-hidden="true" className="size-4 text-[var(--color-fg-subtle)]" />
            Condiciones del hotel
            {count > 0 ? (
              <span className="text-xs font-normal text-[var(--color-fg-muted)]">({count})</span>
            ) : null}
          </span>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'size-4 shrink-0 text-[var(--color-fg-muted)] transition-transform',
              open && 'rotate-180',
            )}
          />
        </button>
      </h2>
      <div id={bodyId} hidden={!open}>
        <div className="space-y-4 border-t border-[var(--color-border)] px-4 py-3">
          {count === 0 ? (
            <p className="text-xs text-[var(--color-fg-muted)]">
              El proveedor no informó condiciones para esta tarifa.
            </p>
          ) : (
            <>
              <p className="text-[11px] text-[var(--color-fg-muted)]">
                Las define el hotel y valen para esta reserva. Van como las envía el proveedor, en
                su idioma.
              </p>
              {groups.map((group) => (
                <section key={group.category} className="space-y-1">
                  <h3 className="text-xs font-medium text-[var(--color-fg)]">{group.label}</h3>
                  <ul className="space-y-1.5">
                    {group.items.map((text, i) => (
                      <li
                        key={i}
                        className="whitespace-pre-line break-words text-xs leading-relaxed text-[var(--color-fg-muted)]"
                      >
                        {text}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </>
          )}
        </div>
      </div>
    </Card>
  );
}
