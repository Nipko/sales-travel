import { api } from '../../../lib/api';
import { heldOrdersOf } from '../../../lib/held-orders';
import { getActiveTenant } from '../../../lib/session';
import { canViewNetworkHolds } from '../../../lib/wallet-access';
import {
  combineNetworkHolds,
  hasNetworkHolds,
  nodeFinancesNetwork,
  parseAgencyWallets,
  parseDepositReports,
  parseMovements,
  parseNetworkHolds,
  type AgencyWallets,
  type NetworkHolds,
} from '../../../lib/wallets';
import { CarterasClient } from './CarterasClient';

interface Membership {
  tenantId: string;
  role: string;
}

const UNREADABLE = 'No pudimos leer las carteras de tu agencia. Recargá la página.';

/**
 * Cartera B2B: lo que la agencia ve de sus carteras (una por moneda), sus movimientos, los depósitos
 * que informó y las reservas con saldo retenido. Sólo lectura, salvo informar un depósito y liberar
 * una retención: el cupo, los depósitos y los ajustes los registra quien la financia. Si la agencia
 * financia a una red (un consolidador o una agencia con sub-agencias), su admin ve además lo que las
 * reservas de esa red retienen en sus carteras (0060).
 */
export default async function CarterasPage() {
  const [walletsRes, movementsRes, reportsRes, ordersRes, membershipsRes] = await Promise.all([
    api<unknown>('/portfolios'),
    api<unknown>('/portfolios/transactions'),
    api<unknown>('/portfolios/deposit-reports'),
    api<unknown>('/orders'),
    api<Membership[]>('/me/memberships'),
  ]);

  // Sin carteras legibles se dice que no se pudieron leer: nunca una cartera en cero inventada.
  let wallets: AgencyWallets | null = null;
  let walletsError: string | null = null;
  if (walletsRes.ok) {
    wallets = parseAgencyWallets(walletsRes.data) ?? null;
    if (wallets === null) walletsError = UNREADABLE;
  } else {
    walletsError = walletsRes.error.message || UNREADABLE;
  }

  const movements = movementsRes.ok ? (parseMovements(movementsRes.data) ?? null) : null;
  const reports = reportsRes.ok ? (parseDepositReports(reportsRes.data) ?? null) : null;
  const heldOrders = ordersRes.ok ? heldOrdersOf(ordersRes.data) : [];

  const memberships = membershipsRes.ok ? membershipsRes.data : [];
  const activeTenantId = await getActiveTenant();
  const active = activeTenantId
    ? (memberships.find((m) => m.tenantId === activeTenantId) ?? memberships[0])
    : memberships[0];

  // Las reservas de la red sólo para quien administra el nodo: al vendedor el API le respondería
  // 403, así que ni se pregunta. Las lecturas van juntas. La pestaña sale si el nodo tiene nodos
  // colgando de él o si ya hay algo de su red en sus carteras: una agencia sin sub-agencias no la ve.
  let financesNetwork = false;
  let networkHolds: NetworkHolds | null = null;
  if (active !== undefined && canViewNetworkHolds(active.role)) {
    const [networkRes, recentRes, heldRes, conflictRes] = await Promise.all([
      api<unknown>('/tenants/network'),
      api<unknown>('/portfolios/network-holds'),
      api<unknown>('/portfolios/network-holds?status=held'),
      api<unknown>('/portfolios/network-holds?status=conflict'),
    ]);
    const recent = recentRes.ok ? parseNetworkHolds(recentRes.data) : undefined;
    const held = heldRes.ok ? parseNetworkHolds(heldRes.data) : undefined;
    const conflict = conflictRes.ok ? parseNetworkHolds(conflictRes.data) : undefined;
    networkHolds =
      recent === undefined || held === undefined || conflict === undefined
        ? null
        : combineNetworkHolds(recent, [held, conflict]);
    financesNetwork =
      (networkRes.ok && nodeFinancesNetwork(networkRes.data, active.tenantId)) ||
      hasNetworkHolds(networkHolds);
  }

  return (
    <CarterasClient
      initialWallets={wallets}
      walletsError={walletsError}
      initialMovements={movements}
      initialReports={reports}
      initialHeldOrders={heldOrders}
      role={active?.role}
      financesNetwork={financesNetwork}
      initialNetworkHolds={networkHolds}
    />
  );
}
