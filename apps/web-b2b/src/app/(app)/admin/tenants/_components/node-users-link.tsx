import Link from 'next/link';
import type { AdminNetworkNode } from '../../../../../lib/tenant-admin-client';
import { teamHrefFor } from '../../../../../lib/tenant-admin-team';

/**
 * "3 usuarios" en la fila de un nodo de Gestión de Agencias: lleva a Equipo abierto en ese nodo,
 * donde se invita, se cambia el rol o se da soporte. Con cero también, que es cuando hace falta
 * invitar. El nombre accesible repite el texto visible para que el control por voz lo encuentre.
 */
export function NodeUsersLink({
  node,
}: {
  node: Pick<AdminNetworkNode, 'id' | 'name' | 'userCount'>;
}) {
  const users = `${node.userCount} ${node.userCount === 1 ? 'usuario' : 'usuarios'}`;
  return (
    <Link
      href={teamHrefFor(node.id)}
      aria-label={`Ver ${users} de ${node.name}`}
      className="-my-1.5 rounded py-1.5 tabular-nums underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--color-fg)] hover:decoration-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
    >
      {users}
    </Link>
  );
}
