import {
  ArrowRight,
  Calendar,
  DollarSign,
  Search,
  Ticket,
  Users,
  Sparkles,
  Building2,
} from 'lucide-react';
import Link from 'next/link';
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
  { label: 'Cotizaciones del mes', value: '0', delta: 'Listo para cotizar', icon: Ticket },
  { label: 'Reservas confirmadas', value: '0', delta: 'Sin emisiones pendientes', icon: Calendar },
  { label: 'Clientes activos', value: '0', delta: 'Cartera actualizada', icon: Users },
  { label: 'Ventas del mes', value: '$0', delta: 'Corte actual', icon: DollarSign },
];

export default async function DashboardPage() {
  const res = await api<Membership[]>('/me/memberships');
  const memberships = res.ok ? res.data : [];

  return (
    <div className="mx-auto max-w-7xl px-6 py-8 lg:px-8 space-y-8 animate-fade-in-up">
      {/* Header Sección */}
      <header className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-primary)]/10 px-2.5 py-0.5 text-[10px] font-bold text-[var(--color-primary)] uppercase tracking-wider">
            <Sparkles className="size-3" />
            Consolidador Activo
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-[var(--color-fg)] mt-1.5">
            Inicio
          </h1>
          <p className="text-xs text-[var(--color-fg-muted)]">
            Resumen de actividad comercial y accesos rápidos de la agencia.
          </p>
        </div>
      </header>

      {/* Acciones Rápidas Modernizadas */}
      <section className="grid grid-cols-1 sm:grid-cols-2 gap-5">
        <Link href="/cotizaciones" className="group">
          <Card className="border border-[var(--color-border)]/50 hover:border-[var(--color-primary)]/40 hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)] transition-all duration-200 h-full rounded-xl overflow-hidden">
            <CardContent className="p-6 flex items-center justify-between">
              <div className="flex items-center gap-4.5">
                <div className="flex size-11 items-center justify-center rounded-xl bg-gradient-to-tr from-[var(--color-primary)] to-[var(--color-accent)] text-white shadow-[var(--shadow-sm)] transition-transform duration-200 group-hover:scale-105">
                  <Search className="size-5" />
                </div>
                <div>
                  <h3 className="font-bold text-sm text-[var(--color-fg)] group-hover:text-[var(--color-primary)] transition-colors">
                    Buscar Vuelos
                  </h3>
                  <p className="text-xs text-[var(--color-fg-muted)] mt-0.5 leading-relaxed">
                    Inicie una nueva cotización de pasajes aéreos
                  </p>
                </div>
              </div>
              <ArrowRight className="size-5 text-[var(--color-fg-subtle)] group-hover:text-[var(--color-primary)] group-hover:translate-x-1 transition-all duration-200" />
            </CardContent>
          </Card>
        </Link>

        <Link href="/reservas" className="group">
          <Card className="border border-[var(--color-border)]/50 hover:border-[var(--color-primary)]/40 hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)] transition-all duration-200 h-full rounded-xl overflow-hidden">
            <CardContent className="p-6 flex items-center justify-between">
              <div className="flex items-center gap-4.5">
                <div className="flex size-11 items-center justify-center rounded-xl bg-gradient-to-tr from-[var(--color-navy-light)] to-[var(--color-navy)] text-white shadow-[var(--shadow-sm)] transition-transform duration-200 group-hover:scale-105">
                  <Calendar className="size-5" />
                </div>
                <div>
                  <h3 className="font-bold text-sm text-[var(--color-fg)] group-hover:text-[var(--color-primary)] transition-colors">
                    Mis Reservas
                  </h3>
                  <p className="text-xs text-[var(--color-fg-muted)] mt-0.5 leading-relaxed">
                    Gestione PNRs de clientes y emisiones pendientes
                  </p>
                </div>
              </div>
              <ArrowRight className="size-5 text-[var(--color-fg-subtle)] group-hover:text-[var(--color-primary)] group-hover:translate-x-1 transition-all duration-200" />
            </CardContent>
          </Card>
        </Link>
      </section>

      {/* Estadísticas Elevadas */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((s) => {
          const Icon = s.icon;
          return (
            <Card
              key={s.label}
              className="border border-[var(--color-border)]/40 shadow-[var(--shadow-sm)] hover:shadow-md transition-shadow rounded-xl"
            >
              <CardContent className="p-5 flex items-start justify-between">
                <div className="space-y-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-fg-subtle)]">
                    {s.label}
                  </p>
                  <p className="text-2xl font-bold tracking-tight text-[var(--color-fg)] tabular-nums font-mono">
                    {s.value}
                  </p>
                  {s.delta ? (
                    <div className="inline-flex items-center gap-1 rounded bg-[var(--color-surface-muted)] border border-[var(--color-border)]/50 px-2 py-0.5 text-[9px] font-semibold text-[var(--color-fg-muted)] leading-none">
                      <span className="inline-block size-1 rounded-full bg-[var(--color-fg-subtle)] animate-pulse" />
                      <span>{s.delta}</span>
                    </div>
                  ) : null}
                </div>
                <div className="flex size-9 items-center justify-center rounded-lg bg-[var(--color-surface-muted)] border border-[var(--color-border)]/40 text-[var(--color-fg-muted)] shadow-[var(--shadow-xs)]">
                  <Icon className="size-4.5" />
                </div>
              </CardContent>
            </Card>
          );
        })}
      </section>

      {/* Listado de Agencias Asignadas */}
      <section className="space-y-3.5">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-bold uppercase tracking-widest text-[var(--color-fg-subtle)] flex items-center gap-1.5">
            <Building2 className="size-4 text-[var(--color-primary)]" />
            Mis Agencias Asignadas
          </h2>
        </div>

        <Card className="overflow-hidden border border-[var(--color-border)]/50 shadow-[var(--shadow-sm)] rounded-xl">
          {memberships.length === 0 ? (
            <div className="px-6 py-14 text-center">
              <p className="text-xs text-[var(--color-fg-muted)] font-medium">
                {res.ok
                  ? 'No tiene agencias asignadas a su perfil todavía.'
                  : `Error de conexión: ${res.error.message}`}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left border-collapse">
                <thead>
                  <tr className="border-b border-[var(--color-border)]/65 bg-[var(--color-surface-muted)]/50 text-[9px] uppercase tracking-widest font-bold text-[var(--color-fg-muted)]">
                    <th className="px-6 py-3.5 font-bold">Agencia</th>
                    <th className="px-6 py-3.5 font-bold">Identificador (Slug)</th>
                    <th className="px-6 py-3.5 font-bold">Rol Asignado</th>
                    <th className="px-6 py-3.5 font-bold">Estado del Vínculo</th>
                  </tr>
                </thead>
                <tbody>
                  {memberships.map((m) => {
                    const isAdminRole =
                      m.role === 'superadmin' || m.role === 'tenant_admin' || m.role === 'admin';
                    return (
                      <tr
                        key={m.id}
                        className="border-b border-[var(--color-border)]/40 last:border-0 transition-colors hover:bg-[var(--color-surface-muted)]/40"
                      >
                        <td className="px-6 py-4.5 text-[var(--color-fg)] font-semibold">
                          {m.tenantName}
                        </td>
                        <td className="px-6 py-4.5 font-mono text-[10px] text-[var(--color-fg-muted)]">
                          {m.tenantSlug}
                        </td>
                        <td className="px-6 py-4.5">
                          <span
                            className={`inline-flex items-center rounded-lg border px-2.5 py-0.5 text-[10px] font-bold ${
                              isAdminRole
                                ? 'bg-[var(--color-primary)]/[0.06] text-[var(--color-primary)] border-[var(--color-primary)]/15'
                                : 'bg-slate-100 text-slate-700 border-slate-200'
                            }`}
                          >
                            {m.role === 'superadmin'
                              ? 'Super Admin'
                              : m.role === 'tenant_admin'
                                ? 'Administrador de Agencia'
                                : m.role === 'admin'
                                  ? 'Admin'
                                  : 'Vendedor / Agente'}
                          </span>
                        </td>
                        <td className="px-6 py-4.5">
                          <span
                            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-0.5 text-[10px] font-bold ${
                              m.status === 'active'
                                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                : 'bg-slate-100 text-slate-500 border-slate-200'
                            }`}
                          >
                            <span
                              className={`size-1.5 rounded-full ${
                                m.status === 'active'
                                  ? 'bg-emerald-500 animate-pulse'
                                  : 'bg-slate-400'
                              }`}
                            />
                            {m.status === 'active' ? 'Activo' : 'Inactivo'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </section>
    </div>
  );
}
