import { ArrowRight, Calendar, Package, Plus, Users } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '../../../../components/ui/button';
import { cn } from '../../../../lib/cn';
import { formatMoney } from '../../../../lib/flight-format';
import { listPackagesAction } from '../actions';
import { formatShortDate, quoteRefOf, shownStatus } from '../_components/package-quote';

export const metadata: Metadata = { title: 'Paquetes guardados' };

const STATUS: Record<string, { label: string; className: string }> = {
  draft: {
    label: 'Borrador',
    className: 'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]',
  },
  sent: { label: 'Enviada', className: 'bg-[var(--color-primary)]/10 text-[var(--color-primary)]' },
  accepted: {
    label: 'Aceptada',
    className: 'bg-[var(--color-success)]/15 text-[var(--color-success)]',
  },
  expired: {
    label: 'Vencida',
    className: 'bg-[var(--color-surface-muted)] text-[var(--color-fg-subtle)]',
  },
};

export default async function SavedPackagesPage() {
  const res = await listPackagesAction();
  const now = Date.now();

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 px-5 py-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-[var(--color-fg)]">
            Paquetes guardados
          </h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Las cotizaciones de paquete de tu agencia, de la más reciente a la más antigua.
          </p>
        </div>
        <Button asChild size="sm">
          <Link href="/paquetes">
            <Plus /> Nuevo paquete
          </Link>
        </Button>
      </header>

      {!res.ok ? (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {res.error}
        </p>
      ) : res.data.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--color-border-strong)] p-10 text-center">
          <Package className="mx-auto size-8 text-[var(--color-fg-subtle)]" />
          <p className="mt-3 text-sm font-medium text-[var(--color-fg)]">Todavía no hay paquetes</p>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Busca vuelo, hotel y auto juntos y crea tu primera cotización.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {res.data.map((p) => {
            const status = STATUS[shownStatus(p, now)] ?? STATUS.draft!;
            const c = p.searchCriteria;
            const pax = c?.rooms.reduce((n, r) => n + r.adults + r.childrenAges.length, 0);
            return (
              <li key={p.id}>
                <Link
                  href={`/paquetes/${p.id}`}
                  className="group flex items-center gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 shadow-[var(--shadow-xs)] transition-colors hover:border-[var(--color-border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40"
                >
                  <span className="hidden size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary)]/10 text-[var(--color-primary)] sm:flex">
                    <Package className="size-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-[var(--color-fg)]">{p.title}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-[var(--color-fg-subtle)]">
                      <span>{quoteRefOf(p.id)}</span>
                      {c ? (
                        <span className="inline-flex items-center gap-1">
                          <Calendar className="size-3" /> {formatShortDate(c.departureDate)} –{' '}
                          {formatShortDate(c.returnDate)}
                        </span>
                      ) : null}
                      {pax ? (
                        <span className="inline-flex items-center gap-1">
                          <Users className="size-3" /> {pax}
                        </span>
                      ) : null}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold tabular-nums text-[var(--color-fg)]">
                      {formatMoney(p.totalAmountMinor, p.currency)}
                    </p>
                    <span
                      className={cn(
                        'mt-1 inline-block rounded-full px-2 py-0.5 text-[11px] font-medium',
                        status.className,
                      )}
                    >
                      {status.label}
                    </span>
                  </div>
                  <ArrowRight className="size-4 shrink-0 text-[var(--color-fg-subtle)] transition-transform group-hover:translate-x-0.5" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
