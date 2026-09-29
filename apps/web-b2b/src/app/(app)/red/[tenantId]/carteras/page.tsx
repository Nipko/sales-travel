import { notFound } from 'next/navigation';
import { WalletFinancingPanel } from '../../../../../components/wallets/wallet-financing-panel';
import { isUuid } from '../../../../../lib/wallets';

/**
 * Mi Red → agencia → Carteras: el consolidador gestiona las carteras de sus agencias, y una agencia
 * las de sus sub-agencias. Si quien mira financia a ese nodo lo decide el API (403 con motivo si
 * no).
 */
export default async function NetworkWalletsPage({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;
  if (!isUuid(tenantId)) notFound();
  return (
    <WalletFinancingPanel
      tenantId={tenantId.toLowerCase()}
      back={{ href: '/red', label: 'Mi Red' }}
    />
  );
}
