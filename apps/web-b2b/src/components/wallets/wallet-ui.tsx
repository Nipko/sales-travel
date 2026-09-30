import { Clock, Inbox, Info, Network } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import {
  NETWORK_HOLDS_PAGE,
  currencyName,
  formatDateTime,
  formatDay,
  formatMinor,
  formatSignedMinor,
  isNetworkMovement,
  movementLabel,
  movementTone,
  networkHoldStatus,
  networkOriginLabel,
  reportStatus,
  walletNotice,
  walletStatus,
  type DepositReport,
  type NetworkHold,
  type NetworkHolds,
  type NetworkHoldTotal,
  type Tone,
  type Wallet,
  type WalletMovement,
} from '../../lib/wallets';

/*
 * Las piezas de las carteras que comparten Cartera B2B (la agencia, sólo lectura) y la gestión de
 * quien financia (Gestión de Agencias y Mi Red). Sin estado: las acciones llegan por props.
 *
 * El color nunca es la única señal: cada estado va escrito y cada monto lleva su signo. El texto va
 * en --color-fg sobre un fondo tenue del tono, que da AA en claro y en oscuro.
 */

const TONE_SURFACE: Readonly<Record<Tone, string>> = {
  neutral: 'border-[var(--color-border)] bg-[var(--color-surface-muted)]',
  success: 'border-[var(--color-success)]/35 bg-[var(--color-success)]/10',
  warning: 'border-[var(--color-warning)]/45 bg-[var(--color-warning)]/12',
  danger: 'border-[var(--color-danger)]/35 bg-[var(--color-danger)]/8',
};

const TONE_DOT: Readonly<Record<Tone, string>> = {
  neutral: 'bg-[var(--color-fg-subtle)]',
  success: 'bg-[var(--color-success)]',
  warning: 'bg-[var(--color-warning)]',
  danger: 'bg-[var(--color-danger)]',
};

export function ToneBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium text-[var(--color-fg)]',
        TONE_SURFACE[tone],
      )}
    >
      <span aria-hidden="true" className={cn('size-1.5 rounded-full', TONE_DOT[tone])} />
      {children}
    </span>
  );
}

export function ToneNotice({
  tone,
  children,
  role,
}: {
  tone: Tone;
  children: ReactNode;
  role?: 'alert' | 'status';
}) {
  return (
    <p
      role={role}
      className={cn(
        'rounded-md border px-3 py-2 text-xs leading-relaxed text-[var(--color-fg)]',
        TONE_SURFACE[tone],
      )}
    >
      {children}
    </p>
  );
}

/** Una cartera: lo que puede reservar (saldo más cupo) arriba, y de qué se compone debajo. */
export function WalletCard({
  wallet,
  headingLevel = 3,
  actions,
}: {
  wallet: Wallet;
  headingLevel?: 2 | 3 | 4;
  actions?: ReactNode;
}) {
  const status = walletStatus(wallet.status);
  const notice = walletNotice(wallet);
  const Heading = `h${headingLevel}` as const;
  const name = currencyName(wallet.currency);
  const money = (minor: number) => formatMinor(minor, wallet.currency, wallet.exponent);
  return (
    <article
      aria-label={`Cartera ${wallet.currency}`}
      className="flex flex-col gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-xs)] sm:p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Heading className="text-sm font-semibold text-[var(--color-fg)]">
            {wallet.currency}
          </Heading>
          {name !== wallet.currency ? (
            <p className="truncate text-xs text-[var(--color-fg-muted)]">{name}</p>
          ) : null}
        </div>
        <ToneBadge tone={status.tone}>{status.label}</ToneBadge>
      </div>

      <div>
        <p className="text-xs text-[var(--color-fg-muted)]">Disponible para reservar</p>
        <p className="mt-0.5 text-2xl font-semibold tracking-tight tabular-nums text-[var(--color-fg)]">
          {money(wallet.availableMinor)}
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-3 border-t border-[var(--color-border)] pt-3 text-xs">
        <div>
          <dt className="text-[var(--color-fg-muted)]">Saldo</dt>
          <dd className="mt-0.5 font-medium tabular-nums text-[var(--color-fg)]">
            {money(wallet.balanceMinor)}
          </dd>
        </div>
        <div>
          <dt className="text-[var(--color-fg-muted)]">Cupo</dt>
          <dd className="mt-0.5 font-medium tabular-nums text-[var(--color-fg)]">
            {money(wallet.creditLimitMinor)}
          </dd>
        </div>
      </dl>

      {notice !== undefined ? <ToneNotice tone={notice.tone}>{notice.text}</ToneNotice> : null}
      {wallet.exponent === null ? (
        <ToneNotice tone="warning">
          {wallet.currency} ya no es una moneda vigente: la cartera se conserva sólo para consulta.
        </ToneNotice>
      ) : null}

      {actions !== undefined ? (
        <div className="mt-auto flex flex-wrap gap-2 border-t border-[var(--color-border)] pt-3">
          {actions}
        </div>
      ) : null}
    </article>
  );
}

export function EmptyState({
  icon,
  title,
  children,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-6 py-10 text-center">
      <span
        aria-hidden="true"
        className="mx-auto mb-2 flex justify-center text-[var(--color-fg-subtle)]"
      >
        {icon ?? <Inbox className="size-6" />}
      </span>
      <p className="text-sm font-medium text-[var(--color-fg)]">{title}</p>
      {children !== undefined ? (
        <div className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-[var(--color-fg-muted)]">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Filtro por moneda: un grupo de radios con aspecto de control segmentado. Con una sola moneda no
 * hay nada que filtrar y no se muestra.
 */
export function CurrencyFilter({
  currencies,
  value,
  onChange,
  legend,
}: {
  currencies: readonly string[];
  value: string;
  onChange: (value: string) => void;
  legend: string;
}) {
  if (currencies.length < 2) return null;
  const options = ['all', ...currencies];
  return (
    <fieldset className="flex flex-wrap items-center gap-2">
      <legend className="sr-only">{legend}</legend>
      <div className="inline-flex flex-wrap rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5">
        {options.map((option) => {
          const checked = value === option;
          return (
            <label
              key={option}
              className={cn(
                'relative cursor-pointer rounded px-2.5 py-1 text-xs font-medium transition-colors focus-within:ring-2 focus-within:ring-[var(--color-primary)]',
                checked
                  ? 'bg-[var(--color-surface-muted)] text-[var(--color-fg)]'
                  : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]',
              )}
            >
              <input
                type="radio"
                name={legend}
                value={option}
                checked={checked}
                onChange={() => onChange(option)}
                className="sr-only"
              />
              {option === 'all' ? 'Todas' : option}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/**
 * Quién o qué explica un movimiento, debajo de su nota. Un asiento de la red dice de qué agencia y
 * qué reserva viene, y nunca quién la vendió: es un vendedor de otro nodo.
 */
function movementSource(m: WalletMovement): string | null {
  if (!isNetworkMovement(m)) return m.createdByName;
  return m.network === null ? null : networkOriginLabel(m.network);
}

/** Los movimientos, del más nuevo al más viejo. Una lista y no una tabla: se lee igual en el móvil. */
export function MovementList({
  movements,
  showCurrency,
  emptyTitle,
  emptyText,
}: {
  movements: readonly WalletMovement[];
  showCurrency: boolean;
  emptyTitle: string;
  emptyText?: string;
}) {
  if (movements.length === 0) {
    return (
      <EmptyState icon={<Clock className="size-6" />} title={emptyTitle}>
        {emptyText}
      </EmptyState>
    );
  }
  return (
    <ul className="divide-y divide-[var(--color-border)] overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)]">
      {movements.map((m) => {
        const tone = movementTone(m);
        const meta = [
          formatDateTime(m.createdAt),
          movementSource(m),
          showCurrency ? m.currency : null,
        ].filter((part): part is string => part !== null && part !== '');
        // Dónde quedó la retención de la red ahora (cobrada, liberada…): el asiento es del momento
        // en que se retuvo. En la liberación no suma nada, siempre diría "Liberada".
        const networkStatus =
          m.transactionType === 'NETWORK_HOLD' && m.network !== null
            ? networkHoldStatus(m.network.status)
            : undefined;
        return (
          <li
            key={m.id}
            className="flex flex-col gap-1.5 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
          >
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <ToneBadge tone={tone}>{movementLabel(m.transactionType)}</ToneBadge>
                {networkStatus !== undefined ? (
                  <ToneBadge tone={networkStatus.tone}>
                    <span className="sr-only">Estado de la reserva de tu red: </span>
                    {networkStatus.label}
                  </ToneBadge>
                ) : null}
              </div>
              {m.notes !== null ? (
                <p className="break-words text-sm text-[var(--color-fg)]">{m.notes}</p>
              ) : null}
              <p className="text-[11px] text-[var(--color-fg-muted)]">{meta.join(' · ')}</p>
            </div>
            <p className="shrink-0 text-sm font-semibold tabular-nums text-[var(--color-fg)] sm:text-right">
              {formatSignedMinor(m.amountMinor, m.currency, m.exponent)}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Lo que la red tiene tomado de las carteras del nodo, una tarjeta por moneda. Lo retenido (con lo
 * que está en revisión, que tampoco volvió) va en grande, como el disponible de la cartera: es lo
 * que hoy le resta saldo para reservar; lo cobrado ya salió y va al lado, más chico. En una fila y
 * no apilado: en el móvil las tarjetas van una debajo de otra y no pueden empujar la lista fuera
 * de la pantalla.
 */
export function NetworkHoldTotals({
  totals,
  headingLevel = 3,
}: {
  totals: readonly NetworkHoldTotal[];
  headingLevel?: 3 | 4;
}) {
  if (totals.length === 0) return null;
  const Heading = `h${headingLevel}` as const;
  return (
    <ul aria-label="Totales por moneda" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {totals.map((t) => {
        const money = (minor: number) => formatMinor(minor, t.currency, t.exponent);
        return (
          <li
            key={t.currency}
            className="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-xs)]"
          >
            <Heading className="text-sm font-semibold text-[var(--color-fg)]">
              {t.currency}
              <span className="sr-only"> · reservas de la red</span>
            </Heading>
            <dl className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 text-xs">
              <div className="min-w-0">
                <dt className="text-[var(--color-fg-muted)]">Retenido o en revisión</dt>
                <dd className="mt-0.5 break-words text-xl font-semibold tracking-tight tabular-nums text-[var(--color-fg)]">
                  {money(t.heldMinor)}
                </dd>
              </div>
              <div className="min-w-0 text-right">
                <dt className="text-[var(--color-fg-muted)]">Cobrado</dt>
                <dd className="mt-0.5 break-words font-medium tabular-nums text-[var(--color-fg)]">
                  {money(t.chargedMinor)}
                </dd>
              </div>
            </dl>
          </li>
        );
      })}
    </ul>
  );
}

/** Aviso de que la lista de la red no tiene todas las reservas que suman los totales. */
export function NetworkHoldsTruncated({ holds }: { holds: Pick<NetworkHolds, 'truncated'> }) {
  if (holds.truncated !== true) return null;
  return (
    <p className="flex items-start gap-1.5 text-xs text-[var(--color-fg-muted)]">
      <Info aria-hidden="true" className="mt-px size-3.5 shrink-0" />
      La lista muestra las {NETWORK_HOLDS_PAGE} reservas más recientes y las que siguen retenidas o
      en revisión; los totales suman todas.
    </p>
  );
}

/**
 * Las reservas de la red en las carteras del nodo, en el orden que llegan: primero las que piden
 * atención (ver `combineNetworkHolds`). Cada una dice de qué agencia y qué reserva viene, cuánto
 * retuvo la cartera (el costo de este nivel, nunca el precio de venta) y en qué quedó. Nunca quién
 * la vendió ni sus pasajeros: son de otra agencia.
 */
export function NetworkHoldList({
  holds,
  showCurrency,
  emptyTitle,
  emptyText,
  headingLevel = 3,
}: {
  holds: readonly NetworkHold[];
  showCurrency: boolean;
  emptyTitle: string;
  emptyText?: string;
  headingLevel?: 3 | 4;
}) {
  if (holds.length === 0) {
    return (
      <EmptyState icon={<Network className="size-6" />} title={emptyTitle}>
        {emptyText}
      </EmptyState>
    );
  }
  const Heading = `h${headingLevel}` as const;
  return (
    <ul className="divide-y divide-[var(--color-border)] overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)]">
      {holds.map((h) => {
        const status = networkHoldStatus(h.status);
        const meta = [
          h.orderNumber !== null ? `Reserva #${h.orderNumber}` : null,
          formatDateTime(h.createdAt),
          showCurrency ? h.currency : null,
        ].filter((part): part is string => part !== null && part !== '');
        return (
          <li
            key={h.levelId}
            className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
          >
            <div className="min-w-0 space-y-1">
              <Heading className="break-words text-sm font-medium text-[var(--color-fg)]">
                {h.originTenantName ?? 'Una agencia de tu red'}
              </Heading>
              <p className="text-[11px] text-[var(--color-fg-muted)]">{meta.join(' · ')}</p>
            </div>
            <div className="flex items-center justify-between gap-3 sm:flex-col sm:items-end sm:gap-1.5">
              <p
                className={cn(
                  'text-sm font-semibold tabular-nums',
                  // Liberada ya no ocupa saldo: el monto queda de registro, en segundo plano.
                  h.status === 'released'
                    ? 'text-[var(--color-fg-muted)]'
                    : 'text-[var(--color-fg)]',
                )}
              >
                {formatMinor(h.amountMinor, h.currency, h.exponent)}
              </p>
              <ToneBadge tone={status.tone}>{status.label}</ToneBadge>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Quién informó el depósito y quién lo resolvió, con sus fechas. */
function reportTrail(report: DepositReport): string[] {
  const lines: string[] = [];
  const reported = [
    report.depositedOn !== null ? `Depositado el ${formatDay(report.depositedOn)}` : null,
    `Informado ${report.reportedByName !== null ? `por ${report.reportedByName} ` : ''}el ${formatDateTime(report.reportedAt)}`,
  ].filter((p): p is string => p !== null);
  lines.push(reported.join(' · '));
  if (report.status !== 'pending') {
    const who = report.resolvedByName !== null ? ` por ${report.resolvedByName}` : '';
    const when = report.resolvedAt !== null ? ` el ${formatDateTime(report.resolvedAt)}` : '';
    lines.push(`${report.status === 'approved' ? 'Aprobado' : 'Rechazado'}${who}${when}`);
  }
  return lines;
}

export function DepositReportList({
  reports,
  emptyTitle,
  emptyText,
  actions,
  headingLevel = 3,
}: {
  reports: readonly DepositReport[];
  emptyTitle: string;
  emptyText?: string;
  actions?: (report: DepositReport) => ReactNode;
  headingLevel?: 3 | 4;
}) {
  if (reports.length === 0) {
    return <EmptyState title={emptyTitle}>{emptyText}</EmptyState>;
  }
  const Heading = `h${headingLevel}` as const;
  return (
    <ul className="divide-y divide-[var(--color-border)] overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)]">
      {reports.map((r) => {
        const status = reportStatus(r.status);
        const action = r.status === 'pending' ? actions?.(r) : undefined;
        return (
          <li key={r.id} className="space-y-2 px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <Heading className="text-sm font-semibold tabular-nums text-[var(--color-fg)]">
                {formatMinor(r.amountMinor, r.currency, r.exponent)}
                <span className="ml-1.5 font-normal text-[var(--color-fg-muted)]">
                  · Ref. {r.reference}
                </span>
              </Heading>
              <ToneBadge tone={status.tone}>{status.label}</ToneBadge>
            </div>
            {reportTrail(r).map((line) => (
              <p key={line} className="text-[11px] text-[var(--color-fg-muted)]">
                {line}
              </p>
            ))}
            {r.notes !== null ? (
              <p className="break-words text-xs text-[var(--color-fg)]">
                <span className="text-[var(--color-fg-muted)]">Nota de la agencia: </span>
                {r.notes}
              </p>
            ) : null}
            {r.resolutionReason !== null ? (
              <p className="break-words text-xs text-[var(--color-fg)]">
                <span className="text-[var(--color-fg-muted)]">
                  {r.status === 'rejected' ? 'Motivo del rechazo: ' : 'Comentario: '}
                </span>
                {r.resolutionReason}
              </p>
            ) : null}
            {action !== undefined ? (
              <div className="flex flex-wrap gap-2 pt-1">{action}</div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Esqueleto de carga de las carteras. */
export function WalletsSkeleton({ label }: { label: string }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div className="grid gap-3 sm:grid-cols-2">
        {[1, 2].map((i) => (
          <div
            key={i}
            className="h-44 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]"
          />
        ))}
      </div>
      <div className="h-24 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]" />
    </div>
  );
}
