import { api } from '../../../lib/api';
import { ClientesClient } from './ClientesClient';

export default async function ClientesPage() {
  const res = await api<{ customers: any[] }>('/customers');
  const initialCustomers = res.ok ? res.data.customers : [];

  return <ClientesClient initialCustomers={initialCustomers} />;
}
