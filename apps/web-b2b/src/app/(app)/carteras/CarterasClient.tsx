'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import {
  Wallet,
  ArrowUpRight,
  ArrowDownLeft,
  Calendar,
  DollarSign,
  Clock,
  Check,
  X,
  Plus,
  AlertCircle,
  FileText,
  Search,
  Building2,
  Sparkles,
  Info,
} from 'lucide-react';

interface Portfolio {
  id: string;
  tenantId: string;
  creditLimitMinor: number;
  balanceMinor: number;
  currency: string;
  status: string;
}

interface PortfolioTransaction {
  id: string;
  portfolioId: string;
  amountMinor: number;
  transactionType: string;
  referenceId: string | null;
  notes: string | null;
  createdBy: string;
  createdAt: string;
}

interface Order {
  id: string;
  status: string;
  orderNumber: number;
  totalAmount: number;
  currency: string;
  provider: string;
  passengers: any;
  contactInfo: any;
  createdAt: string;
}

interface CarterasClientProps {
  initialPortfolio: Portfolio;
  initialTransactions: PortfolioTransaction[];
  initialOrders: Order[];
  role?: string;
}

export function CarterasClient({
  initialPortfolio,
  initialTransactions,
  initialOrders,
  role,
}: CarterasClientProps) {
  const [portfolio, setPortfolio] = useState<Portfolio>(initialPortfolio);
  const [transactions, setTransactions] = useState<PortfolioTransaction[]>(initialTransactions);
  const [orders, setOrders] = useState<Order[]>(initialOrders);

  // Modals and UI states
  const [isDepositModalOpen, setIsDepositModalOpen] = useState(false);
  const [depositAmount, setDepositAmount] = useState('');
  const [depositNotes, setDepositNotes] = useState('');

  const [isLimitModalOpen, setIsLimitModalOpen] = useState(false);
  const [creditLimitInput, setCreditLimitInput] = useState('');

  const [activeSubTab, setActiveSubTab] = useState<'transactions' | 'pending-approvals'>(
    'transactions',
  );

  const isAdmin = role === 'superadmin' || role === 'tenant_admin' || role === 'admin';

  // Format currency
  const formatCurrency = (minor: number, currency = 'COP') => {
    const amount = minor / 100;
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
    }).format(amount);
  };

  const handleDepositSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amountVal = parseFloat(depositAmount);
    if (isNaN(amountVal) || amountVal <= 0) {
      toast.error('Monto de recarga inválido');
      return;
    }

    const amountMinor = Math.round(amountVal * 100);

    const res = await fetch('/api/portfolios/deposit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountMinor, notes: depositNotes }),
    });

    if (res.ok) {
      const data = await res.json();
      setPortfolio(data.portfolio);
      setTransactions([data.transaction, ...transactions]);
      setIsDepositModalOpen(false);
      setDepositAmount('');
      setDepositNotes('');
    } else {
      toast.error('Error al realizar depósito');
    }
  };

  const handleLimitSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const limitVal = parseFloat(creditLimitInput);
    if (isNaN(limitVal) || limitVal < 0) {
      toast.error('Límite de crédito inválido');
      return;
    }

    const creditLimitMinor = Math.round(limitVal * 100);

    const res = await fetch('/api/portfolios', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creditLimitMinor }),
    });

    if (res.ok) {
      const data = await res.json();
      setPortfolio(data.portfolio);
      setIsLimitModalOpen(false);
      setCreditLimitInput('');
    } else {
      toast.error('Error al actualizar límite de crédito');
    }
  };

  const handleApproveOrder = async (orderId: string) => {
    if (
      !confirm(
        '¿Está seguro de aprobar esta reserva? El saldo retenido se debitará permanentemente.',
      )
    )
      return;

    const res = await fetch(`/api/portfolios/orders/${orderId}/approve`, {
      method: 'POST',
    });

    if (res.ok) {
      toast.success('Reserva aprobada y tiquete emitido correctamente.');
      // Refresh state
      const ordersRes = await fetch('/api/orders');
      if (ordersRes.ok) {
        const ordersData = await ordersRes.json();
        setOrders(ordersData.orders || []);
      }
      const portfolioRes = await fetch('/api/portfolios');
      if (portfolioRes.ok) {
        const portfolioData = await portfolioRes.json();
        setPortfolio(portfolioData.portfolio);
      }
      const txsRes = await fetch('/api/portfolios/transactions');
      if (txsRes.ok) {
        const txsData = await txsRes.json();
        setTransactions(txsData.transactions || []);
      }
    } else {
      const err = await res.json();
      toast.error(`Error al aprobar: ${err.error || 'Intente nuevamente'}`);
    }
  };

  const handleRejectOrder = async (orderId: string) => {
    if (
      !confirm(
        '¿Está seguro de rechazar esta reserva? El saldo retenido se devolverá a la cartera.',
      )
    )
      return;

    const res = await fetch(`/api/portfolios/orders/${orderId}/reject`, {
      method: 'POST',
    });

    if (res.ok) {
      toast.success('Reserva rechazada y saldo liberado correctamente.');
      // Refresh state
      const ordersRes = await fetch('/api/orders');
      if (ordersRes.ok) {
        const ordersData = await ordersRes.json();
        setOrders(ordersData.orders || []);
      }
      const portfolioRes = await fetch('/api/portfolios');
      if (portfolioRes.ok) {
        const portfolioData = await portfolioRes.json();
        setPortfolio(portfolioData.portfolio);
      }
      const txsRes = await fetch('/api/portfolios/transactions');
      if (txsRes.ok) {
        const txsData = await txsRes.json();
        setTransactions(txsData.transactions || []);
      }
    } else {
      const err = await res.json();
      toast.error(`Error al rechazar: ${err.error || 'Intente nuevamente'}`);
    }
  };

  const pendingApprovals = orders.filter((o) => o.status === 'pending');

  const getPassengersNames = (paxJSON: any) => {
    try {
      const paxs = typeof paxJSON === 'string' ? JSON.parse(paxJSON) : paxJSON;
      if (Array.isArray(paxs)) {
        return paxs.map((p) => `${p.firstName} ${p.lastName}`).join(', ');
      }
    } catch {
      // ignore
    }
    return 'Pasajeros';
  };

  const getTransactionBadge = (type: string) => {
    switch (type) {
      case 'DEPOSIT_PAYMENT':
        return 'bg-emerald-50 text-emerald-700 border-emerald-100';
      case 'BOOKING_CHARGE':
        return 'bg-red-50 text-red-700 border-red-100';
      case 'BOOKING_HOLD':
        return 'bg-amber-50 text-amber-700 border-amber-100';
      case 'BOOKING_REJECTED':
        return 'bg-slate-100 text-slate-600 border-slate-200';
      default:
        return 'bg-slate-50 text-slate-600 border-slate-100';
    }
  };

  const getTransactionLabel = (type: string) => {
    switch (type) {
      case 'DEPOSIT_PAYMENT':
        return 'Recarga de Saldo';
      case 'BOOKING_CHARGE':
        return 'Compra PNR';
      case 'BOOKING_HOLD':
        return 'Retención PNR';
      case 'BOOKING_REJECTED':
        return 'Retención Devuelta';
      default:
        return 'Ajuste de Cartera';
    }
  };

  return (
    <div className="mx-auto max-w-7xl px-6 py-8 lg:px-8 space-y-8 animate-fade-in">
      {/* Header */}
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-primary)]/10 px-2.5 py-0.5 text-[10px] font-bold text-[var(--color-primary)] uppercase tracking-wider">
            <Wallet className="size-3" />
            Carteras B2B
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-[var(--color-fg)] mt-1.5">
            Cartera & Líneas de Crédito
          </h1>
          <p className="text-xs text-[var(--color-fg-muted)]">
            Consulte su saldo disponible, realice recargas contables y apruebe reservas con
            retención preventiva.
          </p>
        </div>
        <div className="flex gap-2">
          {isAdmin && (
            <button
              onClick={() => {
                setCreditLimitInput((portfolio.creditLimitMinor / 100).toString());
                setIsLimitModalOpen(true);
              }}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-bold text-slate-700 shadow-sm hover:bg-slate-50 transition"
            >
              Configurar Crédito
            </button>
          )}
          <button
            onClick={() => setIsDepositModalOpen(true)}
            className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-[var(--color-primary)] to-[var(--color-accent)] px-4 py-2.5 text-xs font-bold text-white shadow-md hover:-translate-y-0.5 transition-all duration-200"
          >
            <Plus className="size-4" />
            Recargar Saldo
          </button>
        </div>
      </header>

      {/* Account Balance visual card details */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Main account balance card */}
        <div className="md:col-span-1 bg-gradient-to-br from-[var(--color-navy)] to-[var(--color-navy-dark)] text-white rounded-2xl p-6 shadow-lg border border-slate-800 flex flex-col justify-between min-h-[170px] relative overflow-hidden">
          <div className="absolute right-0 bottom-0 translate-x-4 translate-y-4 opacity-10 text-white pointer-events-none">
            <Wallet className="size-36" />
          </div>
          <div className="space-y-1">
            <span className="text-[9px] font-bold uppercase tracking-wider text-slate-300">
              Saldo Neto de Cartera
            </span>
            <p className="text-3xl font-extrabold tracking-tight font-mono">
              {formatCurrency(portfolio.balanceMinor, portfolio.currency)}
            </p>
          </div>
          <div className="flex justify-between items-center text-[10px] text-slate-300 pt-6 border-t border-white/10 mt-4">
            <span>Estado Cuenta:</span>
            <span className="inline-flex items-center gap-1.5 font-bold uppercase text-emerald-400">
              <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
              {portfolio.status}
            </span>
          </div>
        </div>

        {/* Credit limit card */}
        <div className="md:col-span-1 bg-white border border-[var(--color-border)]/45 rounded-2xl p-6 shadow-sm flex flex-col justify-between min-h-[170px]">
          <div className="space-y-1">
            <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400">
              Límite de Crédito Autorizado
            </span>
            <p className="text-3xl font-extrabold tracking-tight text-slate-800 font-mono">
              {formatCurrency(portfolio.creditLimitMinor, portfolio.currency)}
            </p>
          </div>
          <div className="flex justify-between items-center text-[10px] text-slate-400 pt-6 border-t border-slate-100 mt-4">
            <span>Respaldo B2B:</span>
            <span className="font-bold text-slate-600">Cupo Adicional</span>
          </div>
        </div>

        {/* Total available credit card */}
        <div className="md:col-span-1 bg-white border border-[var(--color-border)]/45 rounded-2xl p-6 shadow-sm flex flex-col justify-between min-h-[170px]">
          <div className="space-y-1">
            <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400">
              Poder de Compra (Crédito + Saldo)
            </span>
            <p className="text-3xl font-extrabold tracking-tight text-[var(--color-primary)] font-mono">
              {formatCurrency(
                portfolio.balanceMinor + portfolio.creditLimitMinor,
                portfolio.currency,
              )}
            </p>
          </div>
          <div className="flex justify-between items-center text-[10px] text-slate-400 pt-6 border-t border-slate-100 mt-4">
            <span>Capacidad Total:</span>
            <span className="font-bold text-slate-600">Disponibilidad Inmediata</span>
          </div>
        </div>
      </div>

      {/* Main Board */}
      <div className="space-y-4">
        {/* Navigation Tab */}
        <div className="flex border-b border-slate-200">
          <button
            onClick={() => setActiveSubTab('transactions')}
            className={`px-5 py-3 text-xs font-bold -mb-px border-b-2 transition-all ${
              activeSubTab === 'transactions'
                ? 'border-[var(--color-primary)] text-[var(--color-primary)] font-extrabold'
                : 'border-transparent text-slate-400 hover:text-slate-600'
            }`}
          >
            Historial de Transacciones
          </button>
          <button
            onClick={() => setActiveSubTab('pending-approvals')}
            className={`relative px-5 py-3 text-xs font-bold -mb-px border-b-2 transition-all ${
              activeSubTab === 'pending-approvals'
                ? 'border-[var(--color-primary)] text-[var(--color-primary)] font-extrabold'
                : 'border-transparent text-slate-400 hover:text-slate-600'
            }`}
          >
            Reservas por Aprobar (Cartera)
            {pendingApprovals.length > 0 && (
              <span className="absolute top-2 right-1 flex size-4 items-center justify-center rounded-full bg-amber-500 text-[8px] font-extrabold text-white animate-bounce">
                {pendingApprovals.length}
              </span>
            )}
          </button>
        </div>

        {/* Tab contents */}
        {activeSubTab === 'transactions' ? (
          <div className="bg-white border border-[var(--color-border)]/45 rounded-2xl overflow-hidden shadow-sm">
            {transactions.length === 0 ? (
              <div className="px-6 py-14 text-center">
                <Clock className="size-8 text-slate-300 mx-auto" />
                <p className="text-xs text-slate-400 font-medium mt-3">
                  No se registran transacciones contables en su cartera todavía.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto text-xs">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-[var(--color-border)]/55 bg-slate-50 text-[9px] uppercase tracking-widest font-bold text-slate-500">
                      <th className="px-6 py-3.5 font-bold">Fecha / Hora</th>
                      <th className="px-6 py-3.5 font-bold">Tipo Movimiento</th>
                      <th className="px-6 py-3.5 font-bold">Valor</th>
                      <th className="px-6 py-3.5 font-bold">Referencia / PNR</th>
                      <th className="px-6 py-3.5 font-bold">Notas / Detalle</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.map((tx) => {
                      const isNegative = tx.amountMinor < 0;
                      return (
                        <tr
                          key={tx.id}
                          className="border-b border-slate-100 last:border-0 hover:bg-slate-50/40 transition"
                        >
                          <td className="px-6 py-4 text-slate-500">
                            {new Date(tx.createdAt).toLocaleString('es-CO')}
                          </td>
                          <td className="px-6 py-4">
                            <span
                              className={`inline-flex items-center border rounded-md px-2 py-0.5 text-[9px] font-bold ${getTransactionBadge(
                                tx.transactionType,
                              )}`}
                            >
                              {getTransactionLabel(tx.transactionType)}
                            </span>
                          </td>
                          <td
                            className={`px-6 py-4 font-mono font-bold ${
                              isNegative ? 'text-red-600' : 'text-emerald-600'
                            }`}
                          >
                            {isNegative ? '-' : '+'}
                            {formatCurrency(Math.abs(tx.amountMinor), portfolio.currency)}
                          </td>
                          <td className="px-6 py-4 font-mono font-bold text-slate-700">
                            {tx.referenceId ? tx.referenceId.slice(0, 8).toUpperCase() : 'N/A'}
                          </td>
                          <td className="px-6 py-4 text-slate-600 italic">{tx.notes ?? '-'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {/* RLS message */}
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-xs text-blue-700 flex gap-3">
              <Info className="size-5 shrink-0" />
              <div>
                <p className="font-bold">Workflow Administrativo de Dos Pasos</p>
                <p className="mt-0.5 leading-relaxed">
                  Las reservas pagadas con cartera B2B quedan retenidas preventivamente. Como
                  administrador, puede **Aprobar** (emitiendo tiquete real en GDS y cobrando
                  cartera) o **Rechazar** (cancelando PNR y liberando saldo).
                </p>
              </div>
            </div>

            {pendingApprovals.length === 0 ? (
              <div className="bg-white border border-[var(--color-border)]/45 rounded-2xl py-14 text-center shadow-sm">
                <Check className="size-8 text-emerald-500 bg-emerald-50 p-1.5 rounded-full mx-auto" />
                <p className="text-xs text-slate-400 font-semibold mt-3">
                  No hay reservas pendientes de aprobación en este momento.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {pendingApprovals.map((o) => (
                  <div
                    key={o.id}
                    className="bg-white border border-[var(--color-border)]/45 rounded-2xl p-5 shadow-sm space-y-4 flex flex-col justify-between"
                  >
                    <div className="space-y-3">
                      <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
                        <span className="font-mono font-bold text-[10px] bg-slate-100 px-2 py-0.5 rounded text-slate-600">
                          Reserva #{o.orderNumber}
                        </span>
                        <span className="inline-flex items-center gap-1 bg-amber-50 text-amber-700 px-2.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider">
                          <Clock className="size-3" />
                          Por Aprobar
                        </span>
                      </div>

                      <div className="text-xs space-y-2 text-slate-600">
                        <div className="flex justify-between">
                          <span className="text-slate-400">Pasajeros:</span>
                          <span className="font-bold text-slate-800 text-right shrink-0">
                            {getPassengersNames(o.passengers)}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-400">Vertical / Proveedor:</span>
                          <span className="font-semibold text-slate-800 uppercase">
                            {o.provider === 'latam-ndc' ? 'Vuelos (LATAM NDC)' : o.provider}
                          </span>
                        </div>
                        <div className="flex justify-between items-center bg-slate-50 p-2.5 rounded-xl border border-slate-100 mt-2">
                          <span className="text-slate-400 font-semibold">Valor Hold:</span>
                          <span className="font-extrabold text-[var(--color-primary)] font-mono text-sm">
                            {formatCurrency(o.totalAmount, o.currency)}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2.5 pt-2">
                      <button
                        onClick={() => handleRejectOrder(o.id)}
                        className="flex-1 inline-flex items-center justify-center gap-1.5 border border-slate-200 text-slate-600 bg-white hover:bg-slate-50 rounded-xl py-2 text-xs font-bold shadow-sm transition"
                      >
                        <X className="size-3.5" />
                        Rechazar / Liberar
                      </button>
                      <button
                        onClick={() => handleApproveOrder(o.id)}
                        className="flex-1 inline-flex items-center justify-center gap-1.5 bg-gradient-to-r from-emerald-500 to-teal-500 text-white font-bold rounded-xl py-2 text-xs shadow-md hover:-translate-y-0.5 transition"
                      >
                        <Check className="size-3.5" />
                        Aprobar / Emitir
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Recarga de Saldo Modal */}
      {isDepositModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
          <div className="bg-white w-full max-w-md rounded-2xl border border-slate-200 overflow-hidden shadow-2xl animate-scale-up">
            <div className="bg-gradient-to-r from-[var(--color-navy)] to-[var(--color-navy-dark)] text-white px-6 py-4 flex items-center justify-between">
              <h2 className="text-xs font-bold uppercase tracking-wider text-white">
                Recargar Saldo
              </h2>
              <button
                onClick={() => setIsDepositModalOpen(false)}
                className="p-1 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition"
              >
                <X className="size-5" />
              </button>
            </div>
            <form onSubmit={handleDepositSubmit} className="p-6 space-y-4 text-xs">
              <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-3 text-emerald-800 flex gap-2">
                <Sparkles className="size-4 shrink-0" />
                <p className="text-[10px] leading-relaxed">
                  Ingrese el monto de la transferencia bancaria o recarga que ha sido validada. El
                  saldo se cargará inmediatamente.
                </p>
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                  Monto Recarga (COP)
                </label>
                <div className="relative mt-1.5">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 font-bold">
                    $
                  </span>
                  <input
                    type="number"
                    required
                    min="1000"
                    placeholder="Ej: 500000"
                    value={depositAmount}
                    onChange={(e) => setDepositAmount(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 pl-7 pr-3 py-2.5 rounded-xl text-xs font-bold text-slate-800 focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)] focus:bg-white font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                  Detalle / Comprobante / Notas
                </label>
                <textarea
                  value={depositNotes}
                  onChange={(e) => setDepositNotes(e.target.value)}
                  placeholder="Ej: Transferencia Bancolombia #54223"
                  className="w-full bg-slate-50 border border-slate-200 px-3 py-2.5 rounded-xl text-xs mt-1.5 h-20 focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)] focus:bg-white"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsDepositModalOpen(false)}
                  className="px-4 py-2.5 border border-slate-200 text-slate-500 font-bold hover:bg-slate-50 rounded-xl"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-5 py-2.5 bg-gradient-to-r from-[var(--color-primary)] to-[var(--color-accent)] text-white font-bold shadow-md hover:-translate-y-0.5 rounded-xl transition"
                >
                  Acreditar Saldo
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Configurar Crédito Modal */}
      {isLimitModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
          <div className="bg-white w-full max-w-md rounded-2xl border border-slate-200 overflow-hidden shadow-2xl animate-scale-up">
            <div className="bg-gradient-to-r from-[var(--color-navy)] to-[var(--color-navy-dark)] text-white px-6 py-4 flex items-center justify-between">
              <h2 className="text-xs font-bold uppercase tracking-wider text-white">
                Configurar Crédito
              </h2>
              <button
                onClick={() => setIsLimitModalOpen(false)}
                className="p-1 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition"
              >
                <X className="size-5" />
              </button>
            </div>
            <form onSubmit={handleLimitSubmit} className="p-6 space-y-4 text-xs">
              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                  Límite de Crédito Autorizado (COP)
                </label>
                <div className="relative mt-1.5">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 font-bold">
                    $
                  </span>
                  <input
                    type="number"
                    required
                    min="0"
                    placeholder="Ej: 2000000"
                    value={creditLimitInput}
                    onChange={(e) => setCreditLimitInput(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 pl-7 pr-3 py-2.5 rounded-xl text-xs font-bold text-slate-800 focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)] focus:bg-white font-mono"
                  />
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsLimitModalOpen(false)}
                  className="px-4 py-2.5 border border-slate-200 text-slate-500 font-bold hover:bg-slate-50 rounded-xl"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-5 py-2.5 bg-gradient-to-r from-[var(--color-primary)] to-[var(--color-accent)] text-white font-bold shadow-md hover:-translate-y-0.5 rounded-xl transition"
                >
                  Actualizar Cupo
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
