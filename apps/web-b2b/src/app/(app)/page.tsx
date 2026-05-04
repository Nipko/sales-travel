import { ArrowUpRight, Calendar, DollarSign, Ticket, Users } from 'lucide-react';
import { Card, CardContent } from '../../components/ui/card';
import { api } from '../../lib/api';

interface Membership {
  id: string;
  role: string;
  status: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
}

interface Stat {
  label: string;
  value: string;
  delta?: string;
  icon: typeof Calendar;
}

const stats: Stat[] = [
  { label: 'Cotizaciones del mes', value: '0', delta: 'sin actividad', icon: Ticket },
  { label: 'Reservas confirmadas', value: '0', delta: 'sin actividad', icon: Calendar },
  { label: 'Clientes activos', value: '0', delta: 'sin actividad', icon: Users },
  { label: 'Ventas del mes', value: '$0', delta: 'sin actividad', icon: DollarSign },
];

export default async function DashboardPage() {
  const res = await api<Membership[]>('/me/memberships');
  const memberships = res.ok ? res.data : [];

  return (
    <div className="mx-auto max-w-7xl px-5 py-8 lg:px-8">
      <header className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight text-[var(--color-fg)]">Inicio</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Resumen de tu actividad. Sprint 0 — esto se llena cuando empieces a operar.
        </p>
      </header>

      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {stats.map((s) => {
          const Icon = s.icon;
          return (
            <Card key={s.label}>
              <CardContent className="p-5">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-xs font-medium text-[var(--color-fg-muted)]">{s.label}</p>
                    <p className="mt-2 text-2xl font-semibold tracking-tight text-[var(--color-fg)] tabular-nums font-mono">
                      {s.value}
                    </p>
                    {s.delta ? (
                      <p className="mt-1 text-[11px] text-[var(--color-fg-subtle)]">{s.delta}</p>
                    ) : null}
                  </div>
                  <div className="flex size-8 items-center justify-center rounded-md bg-[var(--color-primary)]/8 text-[var(--color-primary)]">
                    <Icon className="size-4" />
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">Tus tenants</h2>
          <a
            href="#"
            className="inline-flex items-center gap-1 text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
          >
            Ver todos <ArrowUpRight className="size-3" />
          </a>
        </div>

        <Card className="overflow-hidden">
          {memberships.length === 0 ? (
            <div className="px-5 py-12 text-center">
              <p className="text-sm text-[var(--color-fg-muted)]">
                {res.ok ? 'Sin membresías todavía.' : `Error: ${res.error.message}`}
              </p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[10px] uppercase tracking-wider text-[var(--color-fg-muted)]">
                  <th className="px-5 py-2.5 text-left font-medium">Tenant</th>
                  <th className="px-5 py-2.5 text-left font-medium">Slug</th>
                  <th className="px-5 py-2.5 text-left font-medium">Rol</th>
                  <th className="px-5 py-2.5 text-left font-medium">Estado</th>
                </tr>
              </thead>
              <tbody>
                {memberships.map((m) => (
                  <tr
                    key={m.id}
                    className="border-b border-[var(--color-border)] last:border-0 transition-colors hover:bg-[var(--color-surface-muted)]"
                  >
                    <td className="px-5 py-3 text-[var(--color-fg)]">{m.tenantName}</td>
                    <td className="px-5 py-3 font-mono text-[11px] text-[var(--color-fg-muted)]">
                      {m.tenantSlug}
                    </td>
                    <td className="px-5 py-3">
                      <span className="inline-flex items-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-fg)]">
                        {m.role}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--color-fg-muted)]">
                        <span
                          className={
                            m.status === 'active'
                              ? 'size-1.5 rounded-full bg-[var(--color-success)]'
                              : 'size-1.5 rounded-full bg-[var(--color-fg-subtle)]'
                          }
                        />
                        {m.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </section>
    </div>
  );
}
