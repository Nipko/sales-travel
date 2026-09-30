import { notFound } from 'next/navigation';
import { isUuid } from '../../../../../../lib/wallets';
import { SeatsSettingsPanel } from '../_components/seats-settings-panel';

/**
 * Gestión de Agencias → nodo → Puestos y sesión: el superadmin fija cuántas sesiones simultáneas
 * admite el nodo y a los cuántos minutos sin actividad se cierran (el layout de /admin/tenants ya
 * exige superadmin; el API lo vuelve a decidir en cada llamada).
 */
export default async function AdminTenantSeatsPage({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;
  if (!isUuid(tenantId)) notFound();
  return <SeatsSettingsPanel tenantId={tenantId.toLowerCase()} />;
}
