import { api } from '../../../lib/api';
import { getActiveTenant } from '../../../lib/session';
import { CarterasClient } from './CarterasClient';

interface Membership {
  tenantId: string;
  role: string;
}

export default async function CarterasPage() {
  const [portfolioRes, transactionsRes, ordersRes, membershipsRes] = await Promise.all([
    api<{ portfolio: any }>('/portfolios'),
    api<{ transactions: any[] }>('/portfolios/transactions'),
    api<{ orders: any[] }>('/orders'),
    api<Membership[]>('/me/memberships'),
  ]);

  const portfolio = portfolioRes.ok ? portfolioRes.data.portfolio : {
    id: '',
    tenantId: '',
    creditLimitMinor: 0,
    balanceMinor: 0,
    currency: 'COP',
    status: 'active'
  };

  const transactions = transactionsRes.ok ? transactionsRes.data.transactions : [];
  const orders = ordersRes.ok ? ordersRes.data.orders : [];
  const memberships = membershipsRes.ok ? membershipsRes.data : [];

  const activeTenantId = await getActiveTenant();
  const activeTenant = activeTenantId
    ? (memberships.find((m) => m.tenantId === activeTenantId) ?? memberships[0])
    : memberships[0];

  const role = activeTenant?.role;

  return (
    <CarterasClient
      initialPortfolio={portfolio}
      initialTransactions={transactions}
      initialOrders={orders}
      role={role}
    />
  );
}
