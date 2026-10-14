import { Armchair, LayoutDashboard, Plug, Users, Wallet } from 'lucide-react';
import Link from 'next/link';
import { cn } from '../../../../../../lib/cn';
import { nodeTabHref, type NodeTab } from '../../../../../../lib/platform-node-summary';
import { teamHrefFor } from '../../../../../../lib/tenant-admin-team';

/** Las secciones que se pintan con esta barra. Usuarios no: lleva a Equipo, abierto en el nodo. */
export type NodeSection = NodeTab;

const SECTIONS: readonly {
  readonly id: NodeSection | 'users';
  readonly label: string;
  readonly icon: typeof Plug;
  readonly href: (tenantId: string) => string;
}[] = [
  {
    id: 'summary',
    label: 'Resumen',
    icon: LayoutDashboard,
    href: (id) => nodeTabHref(id, 'summary'),
  },
  { id: 'providers', label: 'Proveedores', icon: Plug, href: (id) => nodeTabHref(id, 'providers') },
  { id: 'wallets', label: 'Carteras', icon: Wallet, href: (id) => nodeTabHref(id, 'wallets') },
  {
    id: 'seats',
    label: 'Puestos y sesión',
    icon: Armchair,
    href: (id) => nodeTabHref(id, 'seats'),
  },
  { id: 'users', label: 'Usuarios', icon: Users, href: teamHrefFor },
];

/**
 * Las secciones de un nodo en Gestión de Agencias: su resumen (la primera), proveedores, carteras,
 * puestos y sesión, y sus usuarios (en Equipo).
 */
export function NodeSectionNav({ tenantId, current }: { tenantId: string; current: NodeSection }) {
  return (
    <nav aria-label="Secciones del nodo" className="mb-6 border-b border-[var(--color-border)]">
      <ul className="-mb-px flex gap-4 overflow-x-auto">
        {SECTIONS.map(({ id, label, icon: Icon, href }) => {
          const active = id === current;
          return (
            <li key={id}>
              <Link
                href={href(tenantId)}
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
  );
}
