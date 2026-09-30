import { parseMemberships, resolveActiveMembership } from '../../../lib/agencies';
import { api } from '../../../lib/api';
import { heldOrdersOf } from '../../../lib/held-orders';
import { getActiveTenant } from '../../../lib/session';
import {
  parseAgencyWallets,
  parseDepositReports,
  parseMovements,
  type AgencyWallets,
} from '../../../lib/wallets';
import { CarterasClient } from './CarterasClient';

const UNREADABLE = 'No pudimos leer las carteras de tu agencia. Recargá la página.';

/**
 * Cartera B2B: lo que la agencia ve de sus carteras (una por moneda), sus movimientos, los depósitos
 * que informó y las reservas con saldo retenido. Sólo lectura, salvo informar un depósito y liberar
 * una retención: el cupo, los depósitos y los ajustes los registra quien la financia.
 */
export default async function CarterasPage() {
  const [walletsRes, movementsRes, reportsRes, ordersRes, membershipsRes] = await Promise.all([
    api<unknown>('/portfolios'),
    api<unknown>('/portfolios/transactions'),
    api<unknown>('/portfolios/deposit-reports'),
    api<unknown>('/orders'),
    api<unknown>('/me/memberships'),
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

  const memberships = membershipsRes.ok ? parseMemberships(membershipsRes.data) : [];
  const active = resolveActiveMembership(memberships, await getActiveTenant());

  return (
    <CarterasClient
      initialWallets={wallets}
      walletsError={walletsError}
      initialMovements={movements}
      initialReports={reports}
      initialHeldOrders={heldOrders}
      role={active?.role}
    />
  );
}
