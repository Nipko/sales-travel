'use client';

import { useState } from 'react';
import {
  BarChart3,
  TrendingUp,
  Percent,
  Download,
  DollarSign,
  Calendar,
  Layers,
  Award,
  Plane,
  Hotel,
  Shield,
  FileSpreadsheet,
  ArrowUpRight,
  TrendingDown,
  Clock,
} from 'lucide-react';

interface SalesVerticalMetric {
  vertical: string;
  totalAmountMinor: number;
  count: number;
}

interface SalesMonthlyTrend {
  month: string;
  amountMinor: number;
  count: number;
}

interface CommissionMetric {
  vertical: string;
  commissionMinor: number;
  markupMinor: number;
  totalSalesMinor: number;
}

interface TopPerformer {
  name: string;
  salesMinor: number;
}

interface ReportesClientProps {
  salesMetrics: {
    byVertical: SalesVerticalMetric[];
    monthlyTrend: SalesMonthlyTrend[];
    topPerformers: TopPerformer[];
  };
  commissions: {
    byVertical: CommissionMetric[];
    summary: {
      totalSalesMinor: number;
      totalCommissionsMinor: number;
      totalMarkupsMinor: number;
      netEarningsMinor: number;
    };
  };
}

export function ReportesClient({ salesMetrics, commissions }: ReportesClientProps) {
  const [activeVerticalFilter, setActiveVerticalFilter] = useState<string>('ALL');
  const [selectedTimeframe, setSelectedTimeframe] = useState<string>('2026');

  // Format currency
  const formatCurrency = (minor: number, currency = 'COP') => {
    const amount = minor / 100;
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
    }).format(amount);
  };

  const getVerticalIcon = (verticalName: string) => {
    switch (verticalName.toLowerCase()) {
      case 'vuelos':
        return <Plane className="size-4" />;
      case 'hoteles':
        return <Hotel className="size-4" />;
      case 'asistencias':
        return <Shield className="size-4" />;
      default:
        return <Layers className="size-4" />;
    }
  };

  const getVerticalColorClass = (verticalName: string) => {
    switch (verticalName.toLowerCase()) {
      case 'vuelos':
        return {
          bg: 'bg-sky-50 text-sky-600 border-sky-100',
          fill: 'fill-sky-500',
          stroke: 'stroke-sky-500',
          text: 'text-sky-600',
        };
      case 'hoteles':
        return {
          bg: 'bg-amber-50 text-amber-600 border-amber-100',
          fill: 'fill-amber-500',
          stroke: 'stroke-amber-500',
          text: 'text-amber-600',
        };
      case 'asistencias':
        return {
          bg: 'bg-emerald-50 text-emerald-600 border-emerald-100',
          fill: 'fill-emerald-500',
          stroke: 'stroke-emerald-500',
          text: 'text-emerald-600',
        };
      default:
        return {
          bg: 'bg-slate-50 text-slate-600 border-slate-100',
          fill: 'fill-slate-500',
          stroke: 'stroke-slate-500',
          text: 'text-slate-600',
        };
    }
  };

  // CSV Exporter
  const handleExportCSV = () => {
    const headers = [
      'Vertical',
      'Total Ventas',
      'Comisiones Devengadas',
      'Markup Retenido',
      'Utilidad Neta',
    ];
    const rows = commissions.byVertical.map((item) => [
      item.vertical,
      (item.totalSalesMinor / 100).toFixed(0),
      (item.commissionMinor / 100).toFixed(0),
      (item.markupMinor / 100).toFixed(0),
      ((item.commissionMinor + item.markupMinor) / 100).toFixed(0),
    ]);

    // Summary row
    rows.push([
      'TOTAL GENERAL',
      (commissions.summary.totalSalesMinor / 100).toFixed(0),
      (commissions.summary.totalCommissionsMinor / 100).toFixed(0),
      (commissions.summary.totalMarkupsMinor / 100).toFixed(0),
      (commissions.summary.netEarningsMinor / 100).toFixed(0),
    ]);

    const csvContent =
      'data:text/csv;charset=utf-8,\uFEFF' +
      [headers.join(','), ...rows.map((e) => e.join(','))].join('\n');

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `reporte_ventas_${selectedTimeframe}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Calculate SVG line points for trends
  const trendMax = Math.max(...salesMetrics.monthlyTrend.map((t) => t.amountMinor));
  const trendMin = 0;
  const svgWidth = 600;
  const svgHeight = 200;
  const padding = 35;
  const graphWidth = svgWidth - padding * 2;
  const graphHeight = svgHeight - padding * 2;

  const points = salesMetrics.monthlyTrend.map((t, idx) => {
    const x = padding + (idx / (salesMetrics.monthlyTrend.length - 1)) * graphWidth;
    const y =
      svgHeight - padding - ((t.amountMinor - trendMin) / (trendMax - trendMin)) * graphHeight;
    return { x, y, label: t.month, value: t.amountMinor };
  });

  const polylinePointsStr = points.map((p) => `${p.x},${p.y}`).join(' ');

  // SVG Area path
  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  const areaPointsStr =
    firstPoint && lastPoint
      ? `${firstPoint.x},${svgHeight - padding} ` +
        polylinePointsStr +
        ` ${lastPoint.x},${svgHeight - padding}`
      : '';

  return (
    <div className="mx-auto max-w-7xl px-6 py-8 lg:px-8 space-y-8 animate-fade-in">
      {/* Header */}
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-primary)]/10 px-2.5 py-0.5 text-[10px] font-bold text-[var(--color-primary)] uppercase tracking-wider">
            <BarChart3 className="size-3" />
            Consola Analítica
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-[var(--color-fg)] mt-1.5">
            Métricas de Negocio & Reportes
          </h1>
          <p className="text-xs text-[var(--color-fg-muted)]">
            Audite ventas consolidadas, comisiones de proveedores GDS y márgenes de markup en tiempo
            real.
          </p>
        </div>
        <div className="flex gap-2">
          <select
            value={selectedTimeframe}
            onChange={(e) => setSelectedTimeframe(e.target.value)}
            className="bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-700 focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)] shadow-sm"
          >
            <option value="2026">Año 2026 (Proyectado)</option>
            <option value="current-month">Mes Actual</option>
          </select>
          <button
            onClick={handleExportCSV}
            className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-[var(--color-primary)] to-[var(--color-accent)] px-4 py-2.5 text-xs font-bold text-white shadow-md hover:-translate-y-0.5 transition-all duration-200"
          >
            <Download className="size-4" />
            Exportar CSV
          </button>
        </div>
      </header>

      {/* Visual Analytics Summary Cards */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        {/* Total Sales */}
        <div className="rounded-2xl border border-[var(--color-border)]/45 bg-white p-5 flex flex-col justify-between shadow-sm relative overflow-hidden">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
              Ventas Totales
            </span>
            <div className="size-8 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center">
              <DollarSign className="size-4.5" />
            </div>
          </div>
          <div className="mt-4">
            <h3 className="text-2xl font-black text-slate-800 tracking-tight font-mono">
              {formatCurrency(commissions.summary.totalSalesMinor)}
            </h3>
            <div className="flex items-center gap-1 text-[10px] font-bold text-emerald-600 mt-1">
              <TrendingUp className="size-3.5" />
              <span>+18.4% vs mes anterior</span>
            </div>
          </div>
        </div>

        {/* Earned Commissions */}
        <div className="rounded-2xl border border-[var(--color-border)]/45 bg-white p-5 flex flex-col justify-between shadow-sm relative overflow-hidden">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
              Comisiones Recibidas
            </span>
            <div className="size-8 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center">
              <Percent className="size-4.5" />
            </div>
          </div>
          <div className="mt-4">
            <h3 className="text-2xl font-black text-slate-800 tracking-tight font-mono">
              {formatCurrency(commissions.summary.totalCommissionsMinor)}
            </h3>
            <div className="flex items-center gap-1 text-[10px] font-bold text-emerald-600 mt-1">
              <TrendingUp className="size-3.5" />
              <span>+12.1% vs mes anterior</span>
            </div>
          </div>
        </div>

        {/* Retained Markups */}
        <div className="rounded-2xl border border-[var(--color-border)]/45 bg-white p-5 flex flex-col justify-between shadow-sm relative overflow-hidden">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
              Markup Propietario
            </span>
            <div className="size-8 rounded-xl bg-sky-50 text-sky-600 flex items-center justify-center">
              <ArrowUpRight className="size-4.5" />
            </div>
          </div>
          <div className="mt-4">
            <h3 className="text-2xl font-black text-slate-800 tracking-tight font-mono">
              {formatCurrency(commissions.summary.totalMarkupsMinor)}
            </h3>
            <div className="flex items-center gap-1 text-[10px] font-bold text-emerald-600 mt-1">
              <TrendingUp className="size-3.5" />
              <span>+24.7% vs mes anterior</span>
            </div>
          </div>
        </div>

        {/* Net Profits */}
        <div className="rounded-2xl border border-[var(--color-border)]/45 bg-gradient-to-br from-[var(--color-navy)] to-[var(--color-navy-dark)] text-white p-5 flex flex-col justify-between shadow-lg relative overflow-hidden">
          <div className="absolute right-0 bottom-0 translate-x-3 translate-y-3 opacity-5 text-white">
            <TrendingUp className="size-28" />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-300">
              Ingresos Netos (Comisión+Markup)
            </span>
            <div className="size-8 rounded-xl bg-white/10 text-emerald-400 flex items-center justify-center">
              <TrendingUp className="size-4.5" />
            </div>
          </div>
          <div className="mt-4">
            <h3 className="text-2xl font-black text-white tracking-tight font-mono">
              {formatCurrency(commissions.summary.netEarningsMinor)}
            </h3>
            <div className="flex items-center gap-1 text-[10px] font-bold text-emerald-400 mt-1">
              <TrendingUp className="size-3.5" />
              <span>+15.2% eficiencia global</span>
            </div>
          </div>
        </div>
      </section>

      {/* Trend Graph and Breakdown Panel */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left 2 Columns: SVG Trend Chart */}
        <div className="lg:col-span-2 space-y-4">
          <div className="bg-white border border-[var(--color-border)]/45 rounded-2xl p-5 shadow-sm space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-xs font-bold text-slate-800">
                  Tendencia Mensual de Ventas ({selectedTimeframe})
                </h3>
                <p className="text-[10px] text-slate-400 mt-0.5">
                  Visualización histórica de ventas brutas consolidadas acumuladas.
                </p>
              </div>
              <div className="flex items-center gap-4 text-[10px] text-slate-400 font-semibold">
                <span className="flex items-center gap-1">
                  <span className="size-2 rounded-full bg-[var(--color-primary)]" />
                  Monto de Ventas
                </span>
              </div>
            </div>

            {/* SVG Line Chart */}
            <div className="w-full overflow-hidden">
              <svg viewBox={`0 0 ${svgWidth} ${svgHeight}`} className="w-full h-auto text-xs">
                <defs>
                  <linearGradient id="gradientArea" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.18" />
                    <stop offset="100%" stopColor="var(--color-primary)" stopOpacity="0.0" />
                  </linearGradient>
                </defs>

                {/* Grid Lines */}
                {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
                  const y = padding + ratio * graphHeight;
                  const labelVal = trendMax - ratio * (trendMax - trendMin);
                  return (
                    <g key={ratio}>
                      <line
                        x1={padding}
                        y1={y}
                        x2={svgWidth - padding}
                        y2={y}
                        stroke="#f1f5f9"
                        strokeWidth="1"
                        strokeDasharray="4"
                      />
                      <text
                        x={padding - 6}
                        y={y + 4}
                        textAnchor="end"
                        className="fill-slate-400 font-mono text-[8px]"
                      >
                        {formatCurrency(labelVal).slice(0, 4)}M
                      </text>
                    </g>
                  );
                })}

                {/* Filled Area */}
                {areaPointsStr && <path d={areaPointsStr} fill="url(#gradientArea)" />}

                {/* Trend line */}
                {polylinePointsStr && (
                  <polyline
                    fill="none"
                    stroke="var(--color-primary)"
                    strokeWidth="2.5"
                    points={polylinePointsStr}
                  />
                )}

                {/* Data Points */}
                {points.map((p, idx) => (
                  <g key={idx} className="group">
                    <circle
                      cx={p.x}
                      cy={p.y}
                      r="4"
                      className="fill-white stroke-[var(--color-primary)] stroke-2 cursor-pointer hover:r-6 transition-all duration-200"
                    />
                    {/* Tooltip on Hover */}
                    <rect
                      x={p.x - 35}
                      y={p.y - 25}
                      width="70"
                      height="16"
                      rx="4"
                      className="fill-slate-800 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
                    />
                    <text
                      x={p.x}
                      y={p.y - 14}
                      textAnchor="middle"
                      className="fill-white font-mono text-[7px] font-bold opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
                    >
                      {formatCurrency(p.value).slice(0, 5)}
                    </text>

                    {/* Month Label */}
                    <text
                      x={p.x}
                      y={svgHeight - 12}
                      textAnchor="middle"
                      className="fill-slate-400 font-bold text-[8px]"
                    >
                      {p.label.split('-')[1] ?? p.label}
                    </text>
                  </g>
                ))}
              </svg>
            </div>
          </div>

          {/* Breakdown Table */}
          <div className="bg-white border border-[var(--color-border)]/45 rounded-2xl overflow-hidden shadow-sm">
            <div className="p-5 border-b border-slate-100">
              <h3 className="text-xs font-bold text-slate-800">
                Desglose por Línea de Producto (Vertical)
              </h3>
              <p className="text-[10px] text-slate-400 mt-0.5">
                Volumen y márgenes de ingresos desglosados detalladamente por vertical.
              </p>
            </div>

            <div className="overflow-x-auto text-xs">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50 text-[9px] uppercase tracking-widest font-bold text-slate-500">
                    <th className="px-6 py-3 font-bold">Vertical</th>
                    <th className="px-6 py-3 font-bold text-right">Volumen Ventas</th>
                    <th className="px-6 py-3 font-bold text-right">Comisión Devengada</th>
                    <th className="px-6 py-3 font-bold text-right">Markup Retenido</th>
                    <th className="px-6 py-3 font-bold text-right">Utilidad Neta</th>
                  </tr>
                </thead>
                <tbody>
                  {commissions.byVertical.map((item, idx) => {
                    const cInfo = getVerticalColorClass(item.vertical);
                    const netEarnings = item.commissionMinor + item.markupMinor;
                    return (
                      <tr
                        key={idx}
                        className="border-b border-slate-100 last:border-0 hover:bg-slate-50/40 transition"
                      >
                        <td className="px-6 py-4 font-bold text-slate-700 flex items-center gap-2">
                          <span className={`p-1.5 rounded-lg border ${cInfo.bg}`}>
                            {getVerticalIcon(item.vertical)}
                          </span>
                          {item.vertical}
                        </td>
                        <td className="px-6 py-4 font-mono font-bold text-slate-800 text-right">
                          {formatCurrency(item.totalSalesMinor)}
                        </td>
                        <td className="px-6 py-4 font-mono text-slate-600 text-right">
                          {formatCurrency(item.commissionMinor)}
                        </td>
                        <td className="px-6 py-4 font-mono text-slate-600 text-right">
                          {formatCurrency(item.markupMinor)}
                        </td>
                        <td className="px-6 py-4 font-mono font-bold text-[var(--color-primary)] text-right">
                          {formatCurrency(netEarnings)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Right Column: Performance Indicators */}
        <div className="lg:col-span-1 space-y-6">
          {/* Top Performers */}
          <div className="bg-white border border-[var(--color-border)]/45 rounded-2xl p-5 shadow-sm space-y-4">
            <div>
              <h3 className="text-xs font-bold text-slate-800">Top Vendedores del Mes</h3>
              <p className="text-[10px] text-slate-400 mt-0.5">
                Clasificación de agentes por volumen de ventas emitidas en firme.
              </p>
            </div>

            <div className="space-y-3.5 text-xs">
              {salesMetrics.topPerformers.map((agent, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between p-3 rounded-xl border border-slate-100 bg-slate-50/50 hover:bg-slate-50 transition"
                >
                  <div className="flex items-center gap-3">
                    <div className="size-8 rounded-full bg-slate-100 flex items-center justify-center font-bold text-slate-600 uppercase border border-slate-200">
                      {agent.name[0]}
                      {agent.name.split(' ')[1]?.[0] ?? ''}
                    </div>
                    <div>
                      <h4 className="font-bold text-slate-800">{agent.name}</h4>
                      <p className="text-[9px] text-slate-400 uppercase font-semibold">
                        Agente de Viajes
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="font-mono font-black text-slate-800">
                      {formatCurrency(agent.salesMinor)}
                    </p>
                    <span className="inline-flex items-center gap-0.5 text-[8px] font-bold text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded-full mt-0.5">
                      <Award className="size-2.5" />
                      Rank #{idx + 1}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Efficiency indicators card */}
          <div className="bg-white border border-[var(--color-border)]/45 rounded-2xl p-5 shadow-sm space-y-4">
            <div>
              <h3 className="text-xs font-bold text-slate-800">Distribución de Ingresos</h3>
              <p className="text-[10px] text-slate-400 mt-0.5">
                Proporción de ingresos generados por cada canal de producto.
              </p>
            </div>

            <div className="space-y-4">
              {salesMetrics.byVertical.map((item, idx) => {
                const total = salesMetrics.byVertical.reduce(
                  (sum, v) => sum + v.totalAmountMinor,
                  0,
                );
                const percent = total > 0 ? (item.totalAmountMinor / total) * 100 : 0;
                const cInfo = getVerticalColorClass(item.vertical);

                return (
                  <div key={idx} className="space-y-1.5 text-xs">
                    <div className="flex justify-between items-center">
                      <span className="font-bold text-slate-700 flex items-center gap-1.5">
                        <span className={`p-1 rounded-md border ${cInfo.bg}`}>
                          {getVerticalIcon(item.vertical)}
                        </span>
                        {item.vertical}
                      </span>
                      <span className="font-mono font-bold text-slate-600">
                        {percent.toFixed(1)}%
                      </span>
                    </div>
                    {/* Visual Bar */}
                    <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500`}
                        style={{
                          width: `${percent}%`,
                          backgroundColor:
                            item.vertical.toLowerCase() === 'vuelos'
                              ? 'rgb(56, 189, 248)'
                              : item.vertical.toLowerCase() === 'hoteles'
                                ? 'rgb(251, 191, 36)'
                                : 'rgb(52, 211, 153)',
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
