import { Construction } from 'lucide-react';

interface ComingSoonProps {
  title: string;
  description: string;
}

export function ComingSoon({ title, description }: ComingSoonProps) {
  return (
    <div className="mx-auto max-w-7xl px-5 py-8 lg:px-8">
      <header className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight text-[var(--color-fg)]">{title}</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">{description}</p>
      </header>

      <div className="rounded-lg border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-6 py-16 text-center">
        <div className="mx-auto mb-4 flex size-10 items-center justify-center rounded-md bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]">
          <Construction className="size-5" />
        </div>
        <p className="text-sm font-medium text-[var(--color-fg)]">En construcción</p>
        <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
          Esta sección se habilita en sprints próximos.
        </p>
      </div>
    </div>
  );
}
