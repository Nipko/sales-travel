import { api } from '../lib/api';
import { logoutAction } from './login/actions';

interface Membership {
  id: string;
  role: string;
  status: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
}

export default async function DashboardPage() {
  const res = await api<Membership[]>('/me/memberships');
  const memberships = res.ok ? res.data : [];

  return (
    <main className="min-h-screen bg-neutral-50">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <h1 className="text-sm font-semibold tracking-tight text-neutral-900">Sales-Travel</h1>
          <form action={logoutAction}>
            <button
              type="submit"
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 transition hover:bg-neutral-100"
            >
              Salir
            </button>
          </form>
        </div>
      </header>

      <section className="mx-auto max-w-5xl px-6 py-10">
        <h2 className="text-lg font-semibold tracking-tight text-neutral-900">Tus tenants</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Membresías activas de tu cuenta. Sprint 0 — solo lectura.
        </p>

        <div className="mt-6 overflow-hidden rounded-lg border border-neutral-200 bg-white">
          {memberships.length === 0 ? (
            <p className="px-6 py-8 text-sm text-neutral-500">
              {res.ok ? 'Sin membresías todavía.' : `Error: ${res.error.message}`}
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-neutral-200 bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Tenant</th>
                  <th className="px-4 py-2 text-left font-medium">Slug</th>
                  <th className="px-4 py-2 text-left font-medium">Rol</th>
                  <th className="px-4 py-2 text-left font-medium">Estado</th>
                </tr>
              </thead>
              <tbody>
                {memberships.map((m) => (
                  <tr key={m.id} className="border-t border-neutral-100">
                    <td className="px-4 py-2 text-neutral-900">{m.tenantName}</td>
                    <td className="px-4 py-2 font-mono text-xs text-neutral-600">{m.tenantSlug}</td>
                    <td className="px-4 py-2 text-neutral-700">{m.role}</td>
                    <td className="px-4 py-2 text-neutral-700">{m.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </main>
  );
}
