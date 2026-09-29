import { notFound } from 'next/navigation';
import { WalletFinancingPanel } from '../../../../../../components/wallets/wallet-financing-panel';
import { isUuid } from '../../../../../../lib/wallets';
import { NodeSectionNav } from '../_components/node-section-nav';

/**
 * Gestión de Agencias → nodo → Carteras: el superadmin gestiona las carteras de cualquier nodo de
 * la red, Planetour incluida (el layout de /admin/tenants ya exige superadmin; el API lo vuelve a
 * decidir en cada llamada).
 */
export default async function AdminTenantWalletsPage({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;
  if (!isUuid(tenantId)) notFound();
  const id = tenantId.toLowerCase();
  return (
    <WalletFinancingPanel
      tenantId={id}
      back={{ href: '/admin/tenants', label: 'Agencias' }}
      sectionNav={<NodeSectionNav tenantId={id} current="wallets" />}
    />
  );
}
