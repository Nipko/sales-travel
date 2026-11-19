import { ArrowRight, CheckCircle2 } from 'lucide-react';
import Link from 'next/link';
import { cn } from '../../lib/cn';
import type { TodayItem } from '../../lib/agency-today';
import type { Tone } from '../../lib/wallets';

const STRIPE: Record<Tone, string> = {
  danger: 'bg-[var(--color-danger)]',
  warning: 'bg-[var(--color-warning)]',
  success: 'bg-[var(--color-success)]',
  neutral: 'bg-[var(--color-fg-subtle)]',
};

/**
 * Inicio → Hoy: lo que la agencia tiene que atender, de lo más urgente a lo menos. Va arriba del
 * Inicio porque es lo primero que tiene que ver un vendedor al entrar, también en el móvil. Sin
 * pendientes, una línea que lo dice: un bloque vacío haría pensar que no cargó.
 *
 * `unavailable`: no se pudo leer lo de las reservas. Se dice, en vez de mostrar «todo en orden».
 */
export function TodayPanel({
  items,
  unavailable,
}: {
  items: readonly TodayItem[];
  unavailable: boolean;
}) {
  return (
    <section aria-labelledby="hoy-title" className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="hoy-title" className="text-base font-semibold text-[var(--color-fg)]">
          Hoy
        </h2>
        {items.length > 0 ? (
          <p className="text-xs text-[var(--color-fg-muted)]">
            {items.length === 1
              ? '1 cosa por atender'
              : `${String(items.length)} cosas por atender`}
          </p>
        ) : null}
      </div>

      {unavailable ? (
        <p
          role="alert"
          className="rounded-xl border border-[var(--color-warning)]/45 bg-[var(--color-warning)]/12 px-4 py-3 text-sm text-[var(--color-fg)]"
        >
          No pudimos leer el estado de tus reservas. Revísalas en Mis Reservas.
        </p>
      ) : null}

      {items.length === 0 && !unavailable ? (
        <p className="flex items-center gap-2 rounded-xl border border-[var(--color-success)]/35 bg-[var(--color-success)]/10 px-4 py-3 text-sm text-[var(--color-fg)]">
          <CheckCircle2
            className="size-4 shrink-0 text-[var(--color-success)]"
            aria-hidden="true"
          />
          Nada pendiente: sin plazos por vencer, reservas trabadas ni cotizaciones por expirar.
        </p>
      ) : null}

      {items.length > 0 ? (
        <ul className="divide-y divide-[var(--color-border)] overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          {items.map((item) => (
            <li
              key={item.id}
              className="relative flex flex-col gap-2 py-3 pl-5 pr-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
            >
              <span
                aria-hidden="true"
                className={cn('absolute inset-y-0 left-0 w-1', STRIPE[item.tone])}
              />
              <div className="min-w-0">
                <p className="text-sm font-medium text-[var(--color-fg)]">{item.title}</p>
                <p className="text-xs leading-relaxed text-[var(--color-fg-muted)]">
                  {item.detail}
                </p>
              </div>
              {item.href !== null && item.cta !== '' ? (
                <Link
                  href={item.href}
                  className="inline-flex shrink-0 items-center gap-1 self-start rounded text-xs font-medium text-[var(--color-primary)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)] sm:self-center"
                >
                  {item.cta}
                  <ArrowRight className="size-3.5" aria-hidden="true" />
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
