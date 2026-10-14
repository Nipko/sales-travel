import { Activity, Megaphone } from 'lucide-react';
import type { Route } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '../../../../../../lib/cn';
import { PLATFORM_SISTEMA, PLATFORM_SISTEMA_ANUNCIOS } from '../../../../../../lib/platform-system';

/** Las secciones de Sistema: cada una es su propia página. */
export type SystemSection = 'procesos' | 'anuncios';

const SECTIONS: readonly {
  readonly id: SystemSection;
  readonly label: string;
  readonly icon: typeof Activity;
  readonly href: Route;
  readonly subtitle: string;
}[] = [
  {
    id: 'procesos',
    label: 'Procesos',
    icon: Activity,
    href: PLATFORM_SISTEMA,
    subtitle: 'Lo que corre solo: barridos, conciliaciones y sincronizaciones.',
  },
  {
    id: 'anuncios',
    label: 'Anuncios',
    icon: Megaphone,
    href: PLATFORM_SISTEMA_ANUNCIOS,
    subtitle:
      'Los avisos que ve la red dentro del panel: un mantenimiento, un proveedor caído o un cambio de política.',
  },
];

/**
 * Plataforma → Sistema (sólo superadmin; la guarda es el layout de `/admin/plataforma`): lo que la
 * plataforma hace sola y los avisos que le da a la red. El título, la barra de secciones (enlaces,
 * con la actual marcada) y la sección.
 */
export function SystemConsole({
  current,
  children,
}: {
  current: SystemSection;
  children: ReactNode;
}) {
  const section = SECTIONS.find((s) => s.id === current) ?? SECTIONS[0]!;
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-5 sm:py-8">
      <header className="mb-5">
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-fg)]">Sistema</h1>
        <p className="mt-1 max-w-prose text-sm leading-relaxed text-[var(--color-fg-muted)]">
          {section.subtitle}
        </p>
      </header>
      <nav aria-label="Secciones de Sistema" className="mb-6 border-b border-[var(--color-border)]">
        <ul className="-mb-px flex gap-4 overflow-x-auto">
          {SECTIONS.map(({ id, label, icon: Icon, href }) => {
            const active = id === current;
            return (
              <li key={id}>
                <Link
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-0.5 pb-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]',
                    active
                      ? 'border-[var(--color-primary)] text-[var(--color-fg)]'
                      : 'border-transparent text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]',
                  )}
                >
                  <Icon aria-hidden="true" className="size-4" />
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      {children}
    </div>
  );
}
