import Link from 'next/link';
import { Compass } from 'lucide-react';

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-[var(--color-bg)] px-6 text-center">
      <div className="flex size-12 items-center justify-center rounded-xl bg-[var(--color-primary)]">
        <Compass className="size-6 text-[var(--color-primary-fg)]" />
      </div>
      <h1 className="mt-5 text-2xl font-bold tracking-tight text-[var(--color-fg)]">
        Esta página no existe
      </h1>
      <p className="mt-2 max-w-sm text-sm text-[var(--color-fg-muted)]">
        Puede que el enlace esté mal escrito o que la sección se haya movido.
      </p>
      <Link
        href="/"
        className="mt-6 rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] transition-colors hover:bg-[var(--color-primary-hover)]"
      >
        Volver al panel
      </Link>
    </main>
  );
}
