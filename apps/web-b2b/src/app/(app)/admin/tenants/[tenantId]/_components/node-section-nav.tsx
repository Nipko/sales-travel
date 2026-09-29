import { Plug, Wallet } from 'lucide-react';
import Link from 'next/link';
import { cn } from '../../../../../../lib/cn';

export type NodeSection = 'providers' | 'wallets';

const SECTIONS: readonly {
  readonly id: NodeSection;
  readonly label: string;
  readonly icon: typeof Plug;
  readonly href: (tenantId: string) => string;
}[] = [
  { id: 'providers', label: 'Proveedores', icon: Plug, href: (id) => `/admin/tenants/${id}` },
  { id: 'wallets', label: 'Carteras', icon: Wallet, href: (id) => `/admin/tenants/${id}/carteras` },
];

/** Las secciones de un nodo en Gestión de Agencias: sus proveedores y sus carteras. */
export function NodeSectionNav({ tenantId, current }: { tenantId: string; current: NodeSection }) {
  return (
    <nav aria-label="Secciones del nodo" className="mb-6 border-b border-[var(--color-border)]">
      <ul className="-mb-px flex gap-4">
        {SECTIONS.map(({ id, label, icon: Icon, href }) => {
          const active = id === current;
          return (
            <li key={id}>
              <Link
                href={href(tenantId)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'inline-flex items-center gap-1.5 border-b-2 px-0.5 pb-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]',
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
  );
}
