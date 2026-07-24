import { api } from '../../../lib/api';
import { ClientesClient } from './ClientesClient';

export default async function ClientesPage() {
  const [customersRes, opportunitiesRes] = await Promise.all([
    api<{ customers: any[] }>('/customers').catch(() => null),
    api<{ opportunities: any[] }>('/crm/opportunities').catch(() => null),
  ]);

  const initialCustomers = customersRes?.ok ? customersRes.data.customers : [];
  const initialOpportunities = opportunitiesRes?.ok ? opportunitiesRes.data.opportunities : [];

  return (
    <ClientesClient
      initialCustomers={initialCustomers}
      initialOpportunities={initialOpportunities}
    />
  );
}
