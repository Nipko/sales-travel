import { Clock, Inbox } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import {
  currencyName,
  formatDateTime,
  formatDay,
  formatMinor,
  formatSignedMinor,
  movementLabel,
  movementTone,
  reportStatus,
  walletNotice,
  walletStatus,
  type DepositReport,
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
          m.createdByName,
          showCurrency ? m.currency : null,
        ].filter((part): part is string => part !== null && part !== '');
        return (
          <li
            key={m.id}
            className="flex flex-col gap-1.5 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
          >
            <div className="min-w-0 space-y-1">
              <ToneBadge tone={tone}>{movementLabel(m.transactionType)}</ToneBadge>
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
