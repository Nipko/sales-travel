'use client';

import { Check, Clock, Info, RefreshCw, Send, Wallet as WalletIcon, X } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { SectionTabPanel, SectionTabs, useTabsId } from '../../../components/wallets/section-tabs';
import { DepositReportDialog } from '../../../components/wallets/wallet-dialogs';
import {
  CurrencyFilter,
  DepositReportList,
  EmptyState,
  MovementList,
  ToneNotice,
  WalletCard,
} from '../../../components/wallets/wallet-ui';
import { Button } from '../../../components/ui/button';
import { useConfirm } from '../../../components/ui/dialog';
import { heldOrdersOf, type HeldOrder } from '../../../lib/held-orders';
import { orderProviderLabel } from '../../../lib/order-vertical';
import { PORTFOLIO_ISSUANCE, PORTFOLIO_REJECTION } from '../../../lib/portfolio-workflow';
import { readJson } from '../../../lib/read-json';
import { canReleaseHolds, canReportDeposits } from '../../../lib/wallet-access';
import {
  loadAgencyMovements,
  loadAgencyReports,
  loadAgencyWallets,
  submitDepositReport,
} from '../../../lib/wallet-client';
import { depositReportHelp, type DepositReportBody } from '../../../lib/wallet-forms';
import {
  formatMinor,
  movementsIn,
  sortDepositReports,
  walletCurrencies,
  walletEditable,
  type AgencyWallets,
  type DepositReport,
  type WalletMovement,
} from '../../../lib/wallets';

type Tab = 'movements' | 'reports' | 'holds';

interface CarterasClientProps {
  initialWallets: AgencyWallets | null;
  walletsError: string | null;
  initialMovements: WalletMovement[] | null;
  initialReports: DepositReport[] | null;
  initialHeldOrders: HeldOrder[];
  role?: string;
}

function errorText(value: unknown): string {
  if (typeof value !== 'object' || value === null) return 'Intentá de nuevo.';
  const body = value as Record<string, unknown>;
  const text = body['error'] ?? body['message'];
  return typeof text === 'string' && text.trim() !== '' ? text : 'Intentá de nuevo.';
}

/**
 * Cartera B2B, vista desde la agencia (decisión del founder del 2026-09-29, opción A): sus carteras
 * por moneda, sus movimientos y el estado de los depósitos que informó. No carga saldo ni cambia su
 * cupo: eso lo registra quien la financia. Sí informa depósitos (quedan pendientes) y libera las
 * reservas retenidas que cancela con el proveedor.
 */
export function CarterasClient({
  initialWallets,
  walletsError,
  initialMovements,
  initialReports,
  initialHeldOrders,
  role,
}: CarterasClientProps) {
  const [confirmAction, confirmDialog] = useConfirm();
  const [wallets, setWallets] = useState(initialWallets);
  const [movements, setMovements] = useState(initialMovements);
  const [reports, setReports] = useState(initialReports);
  const [heldOrders, setHeldOrders] = useState(initialHeldOrders);
  const [tab, setTab] = useState<Tab>('movements');
  const [currency, setCurrency] = useState('all');
  const [reporting, setReporting] = useState(false);
  const [releasingId, setReleasingId] = useState<string | null>(null);
  const tabsId = useTabsId();

  const portfolios = useMemo(() => wallets?.portfolios ?? [], [wallets]);
  const financierName = wallets?.financier?.name ?? null;
  const financier = financierName ?? 'Planetour';
  // Una cartera en una moneda retirada de ISO 4217 se muestra, pero ya no recibe depósitos.
  const reportable = useMemo(() => portfolios.filter(walletEditable), [portfolios]);
  const canReport = canReportDeposits(role) && reportable.length > 0;
  const canRelease = canReleaseHolds(role);

  const currencies = useMemo(() => walletCurrencies(portfolios), [portfolios]);
  const visibleMovements = useMemo(
    () => (movements === null ? [] : movementsIn(movements, currency)),
    [movements, currency],
  );
  const sortedReports = useMemo(
    () => (reports === null ? [] : sortDepositReports(reports)),
    [reports],
  );
  const pendingReports = sortedReports.filter((r) => r.status === 'pending').length;

  const reload = useCallback(async () => {
    const [w, m, r] = await Promise.all([
      loadAgencyWallets(),
      loadAgencyMovements(),
      loadAgencyReports(),
    ]);
    if (w.ok) setWallets(w.data);
    if (m.ok) setMovements(m.data);
    if (r.ok) setReports(r.data);
    return w.ok && m.ok && r.ok;
  }, []);

  const closeReport = useCallback(() => setReporting(false), []);

  async function sendReport(body: DepositReportBody, key: string): Promise<string | undefined> {
    const res = await submitDepositReport(body, key);
    if (!res.ok) return res.message;
    setReporting(false);
    setReports((current) =>
      current === null ? [res.data] : [res.data, ...current.filter((r) => r.id !== res.data.id)],
    );
    setTab('reports');
    toast.success('Depósito informado.', {
      description: `Queda pendiente hasta que ${financier} lo apruebe.`,
    });
    return undefined;
  }

  async function releaseHold(order: HeldOrder) {
    const ok = await confirmAction({
      title: 'Cancelar la reserva y liberar el saldo',
      description: PORTFOLIO_REJECTION.description,
      confirmLabel: PORTFOLIO_REJECTION.confirmLabel,
    });
    if (!ok) return;
    setReleasingId(order.id);
    try {
      const res = await fetch(`/api/portfolios/orders/${encodeURIComponent(order.id)}/reject`, {
        method: 'POST',
      });
      if (!res.ok) {
        const read = await readJson<unknown>(res);
        toast.error(`No se canceló la reserva: ${read.ok ? errorText(read.data) : read.message}`);
        return;
      }
      toast.success(PORTFOLIO_REJECTION.success);
      const ordersRes = await fetch('/api/orders', { cache: 'no-store' });
      const orders = await readJson<unknown>(ordersRes);
      if (ordersRes.ok && orders.ok) setHeldOrders(heldOrdersOf(orders.data));
      await reload();
    } catch {
      toast.error(
        'No pudimos confirmar la cancelación. Revisá la reserva en Mis Reservas antes de reintentar.',
      );
    } finally {
      setReleasingId(null);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-5 sm:py-8">
      {confirmDialog}

      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-fg)]">
            Cartera B2B
          </h1>
          <p className="mt-1 max-w-prose text-sm leading-relaxed text-[var(--color-fg-muted)]">
            Tus carteras, una por moneda. Cada reserva se retiene en la cartera de la moneda de su
            tarifa, con tu saldo más el cupo que te da {financier}. El cupo, los depósitos y los
            ajustes los registra {financier}; vos le informás tus depósitos desde acá.
          </p>
        </div>
        {canReport ? (
          <Button className="w-full sm:w-auto" onClick={() => setReporting(true)}>
            <Send aria-hidden="true" />
            Informar depósito
          </Button>
        ) : null}
      </header>

      {walletsError !== null && wallets === null ? (
        <div
          role="alert"
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-10 text-center"
        >
          <p className="text-sm font-medium text-[var(--color-fg)]">{walletsError}</p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-4"
            onClick={() =>
              void reload().then((ok) => {
                if (!ok) toast.error('Todavía no pudimos leer las carteras.');
              })
            }
          >
            <RefreshCw aria-hidden="true" />
            Reintentar
          </Button>
        </div>
      ) : portfolios.length === 0 ? (
        <EmptyState
          icon={<WalletIcon className="size-6" />}
          title="Tu agencia todavía no tiene carteras."
        >
          Sin una cartera no se puede reservar. Pedile a {financier} que te habilite la moneda en la
          que vendés (por ejemplo COP o USD) y el cupo que te corresponda.
        </EmptyState>
      ) : (
        <section aria-labelledby="agency-wallets-title" className="space-y-3">
          <h2 id="agency-wallets-title" className="sr-only">
            Carteras por moneda
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {portfolios.map((wallet) => (
              <WalletCard key={wallet.id} wallet={wallet} />
            ))}
          </div>
          <p className="flex items-start gap-1.5 text-xs text-[var(--color-fg-muted)]">
            <Info aria-hidden="true" className="mt-px size-3.5 shrink-0" />
            ¿Necesitás otra moneda o más cupo? Pedíselo a {financier}: sólo quien financia a tu
            agencia puede cambiarlos.
          </p>
        </section>
      )}

      <div className="mt-8">
        <SectionTabs<Tab>
          idPrefix={tabsId}
          label="Detalle de las carteras"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'movements', label: 'Movimientos' },
            {
              id: 'reports',
              label: 'Depósitos informados',
              shortLabel: 'Depósitos',
              count: pendingReports,
              countLabel: pendingReports === 1 ? 'pendiente' : 'pendientes',
            },
            {
              id: 'holds',
              label: 'Reservas retenidas',
              shortLabel: 'Retenidas',
              count: heldOrders.length,
              countLabel: heldOrders.length === 1 ? 'reserva retenida' : 'reservas retenidas',
            },
          ]}
        />

        <SectionTabPanel id="movements" idPrefix={tabsId} hidden={tab !== 'movements'}>
          <div className="space-y-3">
            <CurrencyFilter
              currencies={currencies}
              value={currency}
              onChange={setCurrency}
              legend="Moneda de los movimientos"
            />
            {movements === null ? (
              <ToneNotice tone="danger" role="alert">
                No pudimos cargar los movimientos. Recargá la página.
              </ToneNotice>
            ) : (
              <MovementList
                movements={visibleMovements}
                showCurrency={currency === 'all' && currencies.length > 1}
                emptyTitle="Sin movimientos todavía."
                emptyText="Los depósitos, los ajustes y las retenciones por reservas aparecen acá."
              />
            )}
          </div>
        </SectionTabPanel>

        <SectionTabPanel id="reports" idPrefix={tabsId} hidden={tab !== 'reports'}>
          {reports === null ? (
            <ToneNotice tone="danger" role="alert">
              No pudimos cargar los depósitos informados. Recargá la página.
            </ToneNotice>
          ) : (
            <DepositReportList
              reports={sortedReports}
              emptyTitle="No informaste depósitos."
              emptyText={
                canReport
                  ? `Cuando transfieras, informalo con "Informar depósito". ${depositReportHelp(financierName)}`
                  : depositReportHelp(financierName)
              }
            />
          )}
        </SectionTabPanel>

        <SectionTabPanel id="holds" idPrefix={tabsId} hidden={tab !== 'holds'}>
          <div className="space-y-3">
            <ToneNotice tone="neutral">
              {PORTFOLIO_ISSUANCE.description} {PORTFOLIO_REJECTION.description}
            </ToneNotice>
            {heldOrders.length === 0 ? (
              <EmptyState icon={<Check className="size-6" />} title="No hay reservas retenidas." />
            ) : (
              <ul className="grid gap-3 md:grid-cols-2">
                {heldOrders.map((o) => (
                  <li
                    key={o.id}
                    className="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-xs)]"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold text-[var(--color-fg)]">
                        {o.orderNumber !== null ? `Reserva #${o.orderNumber}` : 'Reserva'}
                      </h3>
                      <span className="inline-flex items-center gap-1 text-[11px] text-[var(--color-fg-muted)]">
                        <Clock aria-hidden="true" className="size-3" />
                        Retención pendiente de emisión
                      </span>
                    </div>
                    <dl className="space-y-1.5 text-xs">
                      <div className="flex justify-between gap-3">
                        <dt className="text-[var(--color-fg-muted)]">Pasajeros</dt>
                        <dd className="text-right text-[var(--color-fg)]">{o.passengerNames}</dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt className="text-[var(--color-fg-muted)]">Producto</dt>
                        <dd className="text-right text-[var(--color-fg)]">
                          {orderProviderLabel(o)}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt className="text-[var(--color-fg-muted)]">Retenido</dt>
                        <dd className="text-right font-semibold tabular-nums text-[var(--color-fg)]">
                          {formatMinor(o.totalAmountMinor, o.currency, 2)}
                        </dd>
                      </div>
                    </dl>
                    <div className="mt-auto flex flex-col gap-2 sm:flex-row">
                      {canRelease ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          className="flex-1"
                          disabled={releasingId === o.id}
                          onClick={() => void releaseHold(o)}
                        >
                          {releasingId === o.id ? (
                            <RefreshCw aria-hidden="true" className="animate-spin" />
                          ) : (
                            <X aria-hidden="true" />
                          )}
                          Cancelar y liberar
                        </Button>
                      ) : null}
                      <Button
                        variant="secondary"
                        size="sm"
                        className="flex-1"
                        disabled={!PORTFOLIO_ISSUANCE.enabled}
                        title={PORTFOLIO_ISSUANCE.description}
                      >
                        <Check aria-hidden="true" />
                        {PORTFOLIO_ISSUANCE.label}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </SectionTabPanel>
      </div>

      {reporting ? (
        <DepositReportDialog
          wallets={reportable}
          financierName={financierName}
          onSubmit={sendReport}
          onClose={closeReport}
        />
      ) : null}
    </div>
  );
}
