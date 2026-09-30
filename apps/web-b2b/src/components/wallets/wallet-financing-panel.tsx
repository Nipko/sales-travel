'use client';

import {
  ArrowLeft,
  Ban,
  CirclePlay,
  Gauge,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Wallet as WalletIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { NodeKindBadge } from '../network/node-kind';
import { BookingPermissionsSection } from './booking-permissions-section';
import { Button } from '../ui/button';
import {
  approveDepositReport,
  enableWallet,
  loadFinancedMovements,
  loadFinancedReports,
  loadFinancedWallets,
  recordEntry,
  refreshAfterFailure,
  rejectDepositReport,
  updateWallet,
  type WalletResult,
} from '../../lib/wallet-client';
import { savedMessage, type EntryKind } from '../../lib/wallet-forms';
import {
  movementsIn,
  pendingReportsLabel,
  sortDepositReports,
  walletCurrencies,
  walletEditable,
  type DepositReport,
  type FinancedWallets,
  type Wallet,
  type WalletMovement,
} from '../../lib/wallets';
import {
  ApproveReportDialog,
  CreditLimitDialog,
  EnableWalletDialog,
  EntryDialog,
  RejectReportDialog,
  WalletStatusDialog,
} from './wallet-dialogs';
import {
  CurrencyFilter,
  DepositReportList,
  EmptyState,
  MovementList,
  ToneNotice,
  WalletCard,
  WalletsSkeleton,
} from './wallet-ui';

type Loadable<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string; readonly reason?: string }
  | { readonly status: 'ready'; readonly data: T };

type Dialog =
  | { readonly kind: 'enable' }
  | { readonly kind: 'limit'; readonly wallet: Wallet }
  | { readonly kind: 'status'; readonly wallet: Wallet; readonly to: 'active' | 'suspended' }
  | { readonly kind: 'entry'; readonly entry: EntryKind; readonly wallet: Wallet }
  | { readonly kind: 'approve'; readonly report: DepositReport }
  | { readonly kind: 'reject'; readonly report: DepositReport };

function loaded<T>(res: WalletResult<T>): Loadable<T> {
  return res.ok
    ? { status: 'ready', data: res.data }
    : {
        status: 'error',
        message: res.message,
        ...(res.reason === undefined ? {} : { reason: res.reason }),
      };
}

/**
 * Las carteras de UN nodo, gestionadas por quien lo financia (decisión del founder del 2026-09-29,
 * opción A): el superadmin desde Gestión de Agencias → nodo → Carteras, y un consolidador o una
 * agencia desde Mi Red → agencia → Carteras. Habilitar monedas, fijar el cupo, suspender o
 * reactivar, registrar depósitos y ajustes con motivo y confirmación, aprobar o rechazar los
 * depósitos que el nodo informó y decidir si puede reservar tarifas no reembolsables (pedido del
 * 2026-09-29, punto e). Si quien mira financia a ese nodo lo decide el API.
 */
export function WalletFinancingPanel({
  tenantId,
  back,
  sectionNav,
}: {
  tenantId: string;
  back: { readonly href: string; readonly label: string };
  /** Las pestañas del nodo en Gestión de Agencias (Proveedores, Carteras). */
  sectionNav?: ReactNode;
}) {
  const [overview, setOverview] = useState<Loadable<FinancedWallets>>({ status: 'loading' });
  const [movements, setMovements] = useState<Loadable<WalletMovement[]>>({ status: 'loading' });
  const [reports, setReports] = useState<Loadable<DepositReport[]>>({ status: 'loading' });
  const [currency, setCurrency] = useState('all');
  const [dialog, setDialog] = useState<Dialog | null>(null);

  /**
   * Relee todo. En la carga inicial (o al reintentar) pinta el esqueleto; después de un cambio
   * relee en silencio y, si falla, conserva lo que se veía y avisa. `'refresh'` relee en silencio
   * sin avisar: es la relectura tras una escritura que no se pudo confirmar.
   */
  const load = useCallback(
    async (mode: 'initial' | 'saved' | 'refresh') => {
      const quiet = mode !== 'initial';
      if (!quiet) {
        setOverview({ status: 'loading' });
        setMovements({ status: 'loading' });
        setReports({ status: 'loading' });
      }
      const [o, m, r] = await Promise.all([
        loadFinancedWallets(tenantId),
        loadFinancedMovements(tenantId),
        loadFinancedReports(tenantId),
      ]);
      if (mode === 'saved' && !(o.ok && m.ok && r.ok)) {
        toast.error(
          'El cambio se guardó, pero no pudimos recargar las carteras. Recargá la página.',
        );
      }
      if (!quiet || o.ok) setOverview(loaded(o));
      if (!quiet || m.ok) setMovements(loaded(m));
      if (!quiet || r.ok) setReports(loaded(r));
    },
    [tenantId],
  );

  useEffect(() => {
    void load('initial');
  }, [load]);

  const closeDialog = useCallback(() => setDialog(null), []);

  const view = overview.status === 'ready' ? overview.data : undefined;
  const nodeName = view?.tenant.name ?? 'el nodo';

  /**
   * Corre una escritura; si sale bien, cierra el diálogo, avisa y relee. Si falla por un conflicto
   * (otro financiador ya resolvió ese depósito, la cartera cambió) o sin saber si llegó, relee
   * detrás del diálogo: la pantalla deja de ofrecer lo que ya no aplica y muestra si el movimiento
   * quedó registrado antes de que alguien lo reintente con otros datos.
   */
  async function write<T>(
    action: () => Promise<WalletResult<T>>,
    success: string,
  ): Promise<string | undefined> {
    const res = await action();
    if (!res.ok) {
      if (refreshAfterFailure(res)) void load('refresh');
      return res.message;
    }
    setDialog(null);
    toast.success(success);
    await load('saved');
    return undefined;
  }

  const reportList = useMemo(
    () => (reports.status === 'ready' ? sortDepositReports(reports.data) : []),
    [reports],
  );
  const currencies = useMemo(() => walletCurrencies(view?.portfolios ?? []), [view]);
  const visibleMovements = useMemo(
    () => (movements.status === 'ready' ? movementsIn(movements.data, currency) : []),
    [movements, currency],
  );

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-5 sm:py-8">
      <Link
        href={back.href}
        className="mb-4 inline-flex items-center gap-1 rounded text-xs font-medium text-[var(--color-fg-muted)] underline-offset-4 hover:text-[var(--color-fg)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
      >
        <ArrowLeft aria-hidden="true" className="size-3.5" />
        {back.label}
      </Link>

      <header className="mb-6 space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-fg)]">
            {view?.tenant.name ?? 'Carteras'}
          </h1>
          {view !== undefined ? <NodeKindBadge node={view.tenant} /> : null}
        </div>
        <p className="max-w-prose text-sm leading-relaxed text-[var(--color-fg-muted)]">
          En qué monedas opera, con cuánto cupo, qué depósitos le acreditaste y si puede reservar
          tarifas no reembolsables. Reserva en la cartera de la moneda de cada tarifa, con su saldo
          más su cupo. Todo cambio pide un motivo y queda en la auditoría.
        </p>
      </header>

      {sectionNav}

      {overview.status === 'loading' ? (
        <WalletsSkeleton label="Cargando las carteras…" />
      ) : overview.status === 'error' ? (
        <div
          role="alert"
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-10 text-center"
        >
          <p className="mx-auto max-w-md text-sm font-medium text-[var(--color-fg)]">
            {overview.message}
          </p>
          {overview.reason === 'PORTFOLIO_FINANCIER_REQUIRED' ? (
            <Button asChild variant="secondary" size="sm" className="mt-4">
              <Link href={back.href}>
                <ArrowLeft aria-hidden="true" />
                Volver a {back.label}
              </Link>
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              className="mt-4"
              onClick={() => void load('initial')}
            >
              <RefreshCw aria-hidden="true" />
              Reintentar
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-8">
          <section aria-labelledby="wallets-title" className="space-y-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <h2 id="wallets-title" className="text-sm font-semibold text-[var(--color-fg)]">
                Carteras por moneda
              </h2>
              <Button
                size="sm"
                className="w-full sm:w-auto"
                disabled={overview.data.availableCurrencies.length === 0}
                onClick={() => setDialog({ kind: 'enable' })}
              >
                <Plus aria-hidden="true" />
                Habilitar moneda
              </Button>
            </div>

            {overview.data.pendingDepositReports > 0 ? (
              <ToneNotice tone="warning" role="status">
                {pendingReportsLabel(overview.data.pendingDepositReports)}{' '}
                <a
                  href="#deposit-reports-title"
                  className="font-medium underline underline-offset-2"
                >
                  Revisarlos
                </a>
              </ToneNotice>
            ) : null}

            {overview.data.portfolios.length === 0 ? (
              <EmptyState
                icon={<WalletIcon className="size-6" />}
                title="Todavía no tiene carteras."
              >
                Sin una cartera, {overview.data.tenant.name} no puede reservar: habilitale la moneda
                en la que vende (por ejemplo {overview.data.tenant.defaultCurrency || 'COP'} o USD).
              </EmptyState>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {overview.data.portfolios.map((wallet) => (
                  <WalletCard
                    key={wallet.id}
                    wallet={wallet}
                    actions={
                      walletEditable(wallet) ? (
                        <WalletActions wallet={wallet} onOpen={setDialog} />
                      ) : undefined
                    }
                  />
                ))}
              </div>
            )}
          </section>

          <BookingPermissionsSection tenantId={tenantId} />

          <section aria-labelledby="deposit-reports-title" className="scroll-mt-6 space-y-3">
            <h2 id="deposit-reports-title" className="text-sm font-semibold text-[var(--color-fg)]">
              Depósitos informados
            </h2>
            {reports.status === 'loading' ? (
              <div className="h-20 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]" />
            ) : reports.status === 'error' ? (
              <ToneNotice tone="danger" role="alert">
                {reports.message}
              </ToneNotice>
            ) : (
              <DepositReportList
                reports={reportList}
                emptyTitle="No informó depósitos."
                emptyText={`Cuando ${overview.data.tenant.name} informe una transferencia, aparece acá para que la verifiques y la apruebes.`}
                actions={(report) => (
                  <>
                    <Button size="sm" onClick={() => setDialog({ kind: 'approve', report })}>
                      Aprobar
                      <span className="sr-only">
                        {' '}
                        el depósito con referencia {report.reference}
                      </span>
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setDialog({ kind: 'reject', report })}
                    >
                      Rechazar
                      <span className="sr-only">
                        {' '}
                        el depósito con referencia {report.reference}
                      </span>
                    </Button>
                  </>
                )}
              />
            )}
          </section>

          <section aria-labelledby="movements-title" className="space-y-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <h2 id="movements-title" className="text-sm font-semibold text-[var(--color-fg)]">
                Movimientos
              </h2>
              <CurrencyFilter
                currencies={currencies}
                value={currency}
                onChange={setCurrency}
                legend="Moneda de los movimientos"
              />
            </div>
            {movements.status === 'loading' ? (
              <div className="h-24 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]" />
            ) : movements.status === 'error' ? (
              <ToneNotice tone="danger" role="alert">
                {movements.message}
              </ToneNotice>
            ) : (
              <MovementList
                movements={visibleMovements}
                showCurrency={currency === 'all' && currencies.length > 1}
                emptyTitle="Sin movimientos."
                emptyText="Los depósitos, ajustes y retenciones por reservas aparecen acá."
              />
            )}
          </section>
        </div>
      )}

      {view !== undefined && dialog !== null ? (
        <FinancingDialog
          dialog={dialog}
          view={view}
          nodeName={nodeName}
          tenantId={tenantId}
          write={write}
          onClose={closeDialog}
        />
      ) : null}
    </div>
  );
}

function WalletActions({ wallet, onOpen }: { wallet: Wallet; onOpen: (d: Dialog) => void }) {
  const suspends = wallet.status === 'active';
  const sr = <span className="sr-only"> en {wallet.currency}</span>;
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => onOpen({ kind: 'entry', entry: 'deposit', wallet })}
      >
        <Plus aria-hidden="true" />
        Depósito
        {sr}
      </Button>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => onOpen({ kind: 'entry', entry: 'adjustment', wallet })}
      >
        <SlidersHorizontal aria-hidden="true" />
        Ajuste
        {sr}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => onOpen({ kind: 'limit', wallet })}>
        <Gauge aria-hidden="true" />
        Cupo
        {sr}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className={suspends ? 'text-[var(--color-danger)] hover:text-[var(--color-danger)]' : ''}
        onClick={() => onOpen({ kind: 'status', wallet, to: suspends ? 'suspended' : 'active' })}
      >
        {suspends ? <Ban aria-hidden="true" /> : <CirclePlay aria-hidden="true" />}
        {suspends ? 'Suspender' : 'Reactivar'}
        {sr}
      </Button>
    </>
  );
}

function FinancingDialog({
  dialog,
  view,
  nodeName,
  tenantId,
  write,
  onClose,
}: {
  dialog: Dialog;
  view: FinancedWallets;
  nodeName: string;
  tenantId: string;
  write: <T>(
    action: () => Promise<WalletResult<T>>,
    success: string,
  ) => Promise<string | undefined>;
  onClose: () => void;
}) {
  switch (dialog.kind) {
    case 'enable':
      return (
        <EnableWalletDialog
          nodeName={nodeName}
          available={view.availableCurrencies}
          defaultCurrency={view.tenant.defaultCurrency}
          onClose={onClose}
          onSubmit={(body) =>
            write(
              () => enableWallet(tenantId, body),
              savedMessage('enable', nodeName, body.currency),
            )
          }
        />
      );
    case 'limit':
      return (
        <CreditLimitDialog
          wallet={dialog.wallet}
          nodeName={nodeName}
          onClose={onClose}
          onSubmit={(body) =>
            write(
              () => updateWallet(tenantId, dialog.wallet.id, body),
              savedMessage('limit', nodeName, dialog.wallet.currency),
            )
          }
        />
      );
    case 'status':
      return (
        <WalletStatusDialog
          wallet={dialog.wallet}
          nodeName={nodeName}
          to={dialog.to}
          onClose={onClose}
          onSubmit={(body) =>
            write(
              () => updateWallet(tenantId, dialog.wallet.id, body),
              savedMessage(
                dialog.to === 'suspended' ? 'suspend' : 'reactivate',
                nodeName,
                dialog.wallet.currency,
              ),
            )
          }
        />
      );
    case 'entry':
      return (
        <EntryDialog
          kind={dialog.entry}
          wallet={dialog.wallet}
          nodeName={nodeName}
          onClose={onClose}
          onSubmit={(body, key) =>
            write(
              () => recordEntry(tenantId, dialog.wallet.id, dialog.entry, body, key),
              savedMessage(dialog.entry, nodeName, dialog.wallet.currency),
            )
          }
        />
      );
    case 'approve':
      return (
        <ApproveReportDialog
          report={dialog.report}
          nodeName={nodeName}
          onClose={onClose}
          onSubmit={(body) =>
            write(
              () => approveDepositReport(tenantId, dialog.report.id, body),
              savedMessage('approve', nodeName, dialog.report.currency),
            )
          }
        />
      );
    case 'reject':
      return (
        <RejectReportDialog
          report={dialog.report}
          nodeName={nodeName}
          onClose={onClose}
          onSubmit={(body) =>
            write(
              () => rejectDepositReport(tenantId, dialog.report.id, body),
              savedMessage('reject', nodeName, dialog.report.currency),
            )
          }
        />
      );
  }
}
