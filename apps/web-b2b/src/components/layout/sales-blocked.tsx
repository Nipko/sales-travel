import { Network, Store } from 'lucide-react';
import Link from 'next/link';
import { cn } from '../../lib/cn';
import { SUPERADMIN_CANNOT_SELL } from '../../lib/viewer';

/**
 * Lo que ve el superadmin en una pantalla de venta. No es un error: le dice por qué no está y a
 * dónde ir, con el mismo texto que el 403 del API.
 */
export function SalesBlockedNotice() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-5 sm:py-16">
      <section
        aria-labelledby="sales-blocked-title"
        className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-xs)] sm:p-8"
      >
        <div className="mb-4 flex size-10 items-center justify-center rounded-lg bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]">
          <Store aria-hidden="true" className="size-5" />
        </div>
        <h1
          id="sales-blocked-title"
          className="text-lg font-semibold tracking-tight text-[var(--color-fg)]"
        >
          {SUPERADMIN_CANNOT_SELL}
        </h1>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-[var(--color-fg-muted)]">
          Planetour vende por sus sucursales, cada una con sus vendedores. Con tu usuario armás y
          corregís la red: si todavía no hay una sucursal, creala desde Gestión de Agencias y sumale
          sus vendedores.
        </p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row">
          <Link
            href="/admin/tenants"
            className={cn(
              'inline-flex h-9 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium',
              'bg-[var(--color-primary)] text-[var(--color-primary-fg)] shadow-[var(--shadow-xs)] hover:bg-[var(--color-primary-hover)]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)]',
            )}
          >
            <Network aria-hidden="true" className="size-4" />
            Ir a Gestión de Agencias
          </Link>
          <Link
            href="/reservas"
            className={cn(
              'inline-flex h-9 items-center justify-center gap-2 rounded-md border border-[var(--color-border)] px-4 text-sm font-medium',
              'bg-[var(--color-surface)] text-[var(--color-fg)] shadow-[var(--shadow-xs)] hover:bg-[var(--color-surface-muted)]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)]',
            )}
          >
            Ver reservas hechas
          </Link>
        </div>
      </section>
    </div>
  );
}

/** El aviso dentro de una pantalla que el superadmin sí usa, pero sin sus acciones de venta. */
export function SalesBlockedBanner({ children }: { children?: React.ReactNode }) {
  return (
    <div
      role="note"
      className="mb-5 flex items-start gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-4 py-3"
    >
      <Store aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[var(--color-fg-muted)]" />
      <div className="text-xs leading-relaxed text-[var(--color-fg-muted)]">
        <p className="font-semibold text-[var(--color-fg)]">{SUPERADMIN_CANNOT_SELL}.</p>
        {children ? <p className="mt-0.5">{children}</p> : null}
      </div>
    </div>
  );
}
