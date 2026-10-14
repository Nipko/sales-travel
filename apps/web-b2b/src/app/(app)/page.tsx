import {
  ArrowRight,
  Calendar,
  DollarSign,
  Search,
  Ticket,
  Users,
  Sparkles,
  Building2,
  Network,
} from 'lucide-react';
import type { Route } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Card, CardContent } from '../../components/ui/card';
import { parseMemberships, resolveActiveMembership } from '../../lib/agencies';
import { api } from '../../lib/api';
import { cn } from '../../lib/cn';
import { PLATFORM_HOME, shouldLandOnPlatformOverview } from '../../lib/platform-overview';
import {
  parseDashboardKpis,
  salesThisMonthLines,
  type DashboardKpis,
} from '../../lib/sales-reports';
import { getActiveTenant } from '../../lib/session';
import { canSell, viewerOf, type Viewer } from '../../lib/viewer';

interface QuickAction {
  href: Route;
  title: string;
  description: string;
  icon: typeof Calendar;
}

/**
 * El primer acceso rápido. El superadmin no vende: en lugar de Buscar Vuelos, que le daría el aviso
 * de que no vende, va a donde sí trabaja, que es armar la red.
 */
function primaryAction(viewer: Viewer): QuickAction {
  if (canSell(viewer)) {
    return {
      href: '/cotizaciones',
      title: 'Buscar Vuelos',
      description: 'Inicia una nueva cotización de pasajes aéreos',
      icon: Search,
    };
  }
  return viewer.superadmin
    ? {
        href: '/admin/tenants',
        title: 'Gestión de Agencias',
        description: 'Arma y corrige la red: sucursales, agencias y consolidadores',
        icon: Network,
      }
    : {
        href: '/red',
        title: 'Mi Red',
        description: 'Nodos, credenciales y reglas de tu red',
        icon: Network,
      };
}

interface Stat {
  label: string;
  /** Una línea, o una por moneda en las ventas del mes. */
  values: readonly string[];
  delta?: string;
  icon: typeof Calendar;
}

/**
 * Antes eran cuatro ceros HARDCODEADOS con leyendas del tipo "Cartera actualizada",
 * indistinguibles de métricas reales: una agencia que sí vendió veía cero y podía
 * concluir que la plataforma no registró sus ventas. Las ventas van una línea por
 * moneda: sumar pesos y dólares daría un número que no es de nadie.
 */
function buildStats(k: DashboardKpis | null): Stat[] {
  if (!k) {
    return [
      { label: 'Cotizaciones del mes', values: ['—'], delta: 'Sin datos', icon: Ticket },
      { label: 'Reservas confirmadas', values: ['—'], delta: 'Sin datos', icon: Calendar },
      { label: 'Clientes activos', values: ['—'], delta: 'Sin datos', icon: Users },
      { label: 'Ventas del mes', values: ['—'], delta: 'Sin datos', icon: DollarSign },
    ];
  }
  const sales = salesThisMonthLines(k.salesThisMonth);
  return [
    {
      label: 'Cotizaciones del mes',
      values: [String(k.quotationsThisMonth)],
      delta: k.quotationsThisMonth === 0 ? 'Listo para cotizar' : 'Mes en curso',
      icon: Ticket,
    },
    {
      label: 'Reservas confirmadas',
      values: [String(k.confirmedThisMonth)],
      delta: k.confirmedThisMonth === 0 ? 'Sin emisiones aún' : 'Mes en curso',
      icon: Calendar,
    },
    {
      label: 'Clientes activos',
      values: [String(k.activeCustomers)],
      delta: 'En la cartera',
      icon: Users,
    },
    {
      label: 'Ventas del mes',
      values: sales.length === 0 ? ['—'] : sales,
      delta: sales.length === 0 ? 'Sin ventas este mes' : 'Confirmadas y emitidas',
      icon: DollarSign,
    },
  ];
}

export default async function DashboardPage() {
  const [res, kpiRes, activeTenantId] = await Promise.all([
    api<unknown>('/me/memberships'),
    api<unknown>('/reports/dashboard').catch(() => null),
    getActiveTenant(),
  ]);
  const memberships = res.ok ? parseMemberships(res.data) : [];
  const viewer = viewerOf(memberships);
  // El superadmin entra a su Resumen, con el mismo criterio con que `/admin/plataforma` lo deja
  // pasar: sin bucle de redirecciones. `redirect` lanza, así que va fuera de cualquier try/catch.
  if (
    shouldLandOnPlatformOverview(resolveActiveMembership(memberships, activeTenantId)?.role, viewer)
  ) {
    redirect(PLATFORM_HOME);
  }
  // Sin KPIs se muestran guiones, no ceros: un cero es un dato, y sería falso.
  const stats = buildStats(kpiRes?.ok ? (parseDashboardKpis(kpiRes.data) ?? null) : null);
  const primary = primaryAction(viewer);
  const PrimaryIcon = primary.icon;

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
        <Link href={primary.href} className="group">
          <Card className="border border-[var(--color-border)]/50 hover:border-[var(--color-primary)]/40 hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)] transition-all duration-200 h-full rounded-xl overflow-hidden">
            <CardContent className="p-6 flex items-center justify-between">
              <div className="flex items-center gap-4.5">
                <div className="flex size-11 items-center justify-center rounded-xl bg-gradient-to-tr from-[var(--color-primary)] to-[var(--color-accent)] text-white shadow-[var(--shadow-sm)] transition-transform duration-200 group-hover:scale-105">
                  <PrimaryIcon className="size-5" />
                </div>
                <div>
                  <h3 className="font-bold text-sm text-[var(--color-fg)] group-hover:text-[var(--color-primary)] transition-colors">
                    {primary.title}
                  </h3>
                  <p className="text-xs text-[var(--color-fg-muted)] mt-0.5 leading-relaxed">
                    {primary.description}
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
                    Gestiona PNRs de clientes y emisiones pendientes
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
                  <p
                    className={cn(
                      'font-bold tracking-tight text-[var(--color-fg)] tabular-nums font-mono',
                      s.values.length > 1 ? 'text-lg leading-snug' : 'text-2xl',
                    )}
                  >
                    {s.values.map((line) => (
                      <span key={line} className="block">
                        {line}
                      </span>
                    ))}
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
                  ? 'No tienes agencias asignadas a tu perfil todavía.'
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
                                : 'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)] border-[var(--color-border)]'
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
                                : 'bg-[var(--color-surface-muted)] text-[var(--color-fg-subtle)] border-[var(--color-border)]'
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
