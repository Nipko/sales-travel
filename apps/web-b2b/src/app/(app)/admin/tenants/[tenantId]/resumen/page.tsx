import { notFound } from 'next/navigation';
import { isUuid } from '../../../../../../lib/wallets';
import { NodeSummary } from './_components/node-summary';

/**
 * Gestión de Agencias → nodo → Resumen: cómo va el nodo en una pantalla, con el camino a cada
 * pestaña. Sólo superadmin: el layout de /admin/tenants lo exige y el API lo vuelve a decidir en cada
 * lectura. Proveedores sigue en /admin/tenants/:id para no romper los enlaces que ya circulan.
 */
export default async function AdminTenantSummaryPage({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;
  if (!isUuid(tenantId)) notFound();
  return <NodeSummary tenantId={tenantId.toLowerCase()} />;
}
