import { Lock } from 'lucide-react';
import Link from 'next/link';

/**
 * Una pantalla que el rol en la agencia activa no puede usar (QA-H-06, QA-H-09). Antes la abría
 * igual: se veía vacía o fallaba recién al guardar. La API sigue siendo la que autoriza; esto sólo
 * evita mostrar un formulario que no va a funcionar.
 */
export function NoAccess({ title, reason }: { title: string; reason: string }) {
  return (
    <div className="mx-auto max-w-xl px-5 py-12">
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center shadow-[var(--shadow-xs)]">
        <Lock className="mx-auto mb-3 size-6 text-[var(--color-fg-subtle)]" aria-hidden />
        <h1 className="text-base font-semibold text-[var(--color-fg)]">{title}</h1>
        <p className="mt-2 text-sm text-[var(--color-fg-muted)]">{reason}</p>
        <Link
          href="/"
          className="mt-5 inline-block rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]"
        >
          Volver al inicio
        </Link>
      </div>
    </div>
  );
}
