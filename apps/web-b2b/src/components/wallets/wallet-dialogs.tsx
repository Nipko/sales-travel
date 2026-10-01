'use client';

import { RefreshCw } from 'lucide-react';
import { useCallback, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { Field, Select, TextInput, Textarea } from '../ui/field';
import { cn } from '../../lib/cn';
import {
  NOTES_MAX_LENGTH,
  REASON_MAX_LENGTH,
  REFERENCE_MAX_LENGTH,
  approveReportSummary,
  creditLimitSummary,
  currencyOptionLabel,
  depositReportHelp,
  enableCurrencyOptions,
  enableWalletSummary,
  entrySummary,
  initialEnableCurrency,
  minorToInput,
  rejectReportSummary,
  todayLocal,
  validateApproveNote,
  validateCreditLimit,
  validateDepositReport,
  validateEnableWallet,
  validateEntry,
  validateReason,
  walletStatusSummary,
  type ActionSummary,
  type CreditLimitBody,
  type DepositReportBody,
  type DepositReportDraft,
  type EnableWalletBody,
  type EnableWalletDraft,
  type EntryBody,
  type EntryDirection,
  type EntryKind,
  type FieldErrors,
} from '../../lib/wallet-forms';
import { formatMinor, type DepositReport, type Wallet } from '../../lib/wallets';
import { ToneNotice } from './wallet-ui';

/*
 * Los formularios de las carteras. Cada uno valida con las funciones de lib/wallet-forms.ts, que
 * dicen el error en el campo que corresponde, y llama a `onSubmit`: si devuelve un mensaje, el
 * diálogo queda abierto y lo muestra; si no, el padre lo cierra.
 *
 * Los que mueven plata (depósito, ajuste, cupo) se confirman en un segundo paso que muestra el
 * saldo antes y después. Los que llevan Idempotency-Key la conservan mientras los datos no cambien:
 * si la respuesta se perdió, reintentar no registra dos veces.
 */

type Submit<T> = (value: T) => Promise<string | undefined>;

const DIALOG = 'max-w-lg';

/**
 * El marco común: título, formulario, error y botones. Mientras guarda no se cierra (ni con
 * Escape): una escritura a medias con el diálogo cerrado deja al usuario sin saber qué pasó.
 */
function FormDialog({
  title,
  description,
  onClose,
  onSubmit,
  busy,
  error,
  submitLabel,
  destructive = false,
  back,
  children,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  onSubmit: () => void;
  busy: boolean;
  error: string;
  submitLabel: string;
  destructive?: boolean;
  /** En el paso de confirmación, vuelve al formulario en vez de cancelar. */
  back?: () => void;
  children: ReactNode;
}) {
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Una sola función durante toda la vida del diálogo: `useModalBehavior` mueve el foco cada vez
  // que cambia la identidad de `onClose`.
  const close = useCallback(() => {
    if (!busyRef.current) onCloseRef.current();
  }, []);
  const formId = useId();

  return (
    <Dialog
      open
      onClose={close}
      title={title}
      description={description}
      className={DIALOG}
      footer={
        <div className="space-y-3">
          {error !== '' ? (
            <p
              role="alert"
              className="rounded-lg border border-[var(--color-danger)]/35 bg-[var(--color-danger)]/6 px-3 py-2 text-xs text-[var(--color-fg)]"
            >
              {error}
            </p>
          ) : null}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" onClick={back ?? close} disabled={busy}>
              {back !== undefined ? 'Volver' : 'Cancelar'}
            </Button>
            <Button
              form={formId}
              type="submit"
              variant={destructive ? 'danger' : 'primary'}
              disabled={busy}
            >
              {busy ? <RefreshCw aria-hidden="true" className="animate-spin" /> : null}
              {busy ? 'Guardando…' : submitLabel}
            </Button>
          </div>
        </div>
      }
    >
      <form
        id={formId}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!busyRef.current) onSubmit();
        }}
        className="space-y-4"
      >
        {children}
      </form>
    </Dialog>
  );
}

function SummaryList({
  summary,
}: {
  summary: Pick<ActionSummary, 'lines' | 'warning' | 'network'>;
}) {
  return (
    <div className="space-y-3">
      {summary.lines.length > 0 ? (
        <dl className="divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)] text-sm">
          {summary.lines.map((line) => (
            <div key={line.label} className="flex items-baseline justify-between gap-4 px-3 py-2">
              <dt className="text-xs text-[var(--color-fg-muted)]">{line.label}</dt>
              <dd className="text-right font-medium tabular-nums text-[var(--color-fg)]">
                {line.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {summary.warning !== undefined ? (
        <ToneNotice tone="warning">{summary.warning}</ToneNotice>
      ) : null}
      {summary.network !== undefined ? (
        <ToneNotice tone={summary.network.tone}>{summary.network.text}</ToneNotice>
      ) : null}
    </div>
  );
}

function ReasonField({
  value,
  onChange,
  error,
  optional = false,
  placeholder,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  error: string | undefined;
  optional?: boolean;
  placeholder: string;
  label?: string;
}) {
  return (
    <Field
      label={label ?? (optional ? 'Comentario (opcional)' : 'Motivo')}
      required={!optional}
      error={error}
      hint="Queda en la auditoría junto con quién lo hizo y cuándo."
    >
      {(a11y) => (
        <Textarea
          {...a11y}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={REASON_MAX_LENGTH}
          rows={3}
          placeholder={placeholder}
        />
      )}
    </Field>
  );
}

function AmountField({
  label,
  currency,
  value,
  onChange,
  error,
  hint,
  required = true,
}: {
  label: string;
  currency: string;
  value: string;
  onChange: (value: string) => void;
  error: string | undefined;
  hint?: string;
  required?: boolean;
}) {
  return (
    <Field
      label={`${label} (${currency})`}
      required={required}
      error={error}
      hint={hint ?? 'Sin separadores de miles; los centavos, con coma.'}
    >
      {(a11y) => (
        <TextInput
          {...a11y}
          inputMode="decimal"
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="0"
          className="tabular-nums"
        />
      )}
    </Field>
  );
}

/** Estado común de un diálogo que guarda: ocupado y el error del API. */
function useSaving() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = useCallback(async (action: () => Promise<string | undefined>) => {
    setBusy(true);
    setError('');
    const failure = await action();
    // Si salió bien, el padre ya desmontó el diálogo: no hay estado que tocar.
    if (failure !== undefined) {
      setBusy(false);
      setError(failure);
    }
  }, []);
  return { busy, error, run, setError };
}

// ───────────────────────────── Quien financia ─────────────────────────────

export function EnableWalletDialog({
  nodeName,
  financesNetwork = false,
  available,
  defaultCurrency,
  onSubmit,
  onClose,
}: {
  nodeName: string;
  /** El nodo financia a una red: su cartera también retiene las reservas de ella (0060). */
  financesNetwork?: boolean;
  available: readonly string[];
  /** La moneda por defecto del nodo: se ofrece primero y, si no tiene cartera en ella, elegida. */
  defaultCurrency: string;
  onSubmit: Submit<EnableWalletBody>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<EnableWalletDraft>(() => ({
    currency: initialEnableCurrency(available, defaultCurrency),
    creditLimit: '',
    reason: '',
  }));
  const [errors, setErrors] = useState<FieldErrors<keyof EnableWalletDraft>>({});
  const { busy, error, run } = useSaving();
  const copy = enableWalletSummary(nodeName, financesNetwork);
  const options = enableCurrencyOptions(available, defaultCurrency);
  const set = (patch: Partial<EnableWalletDraft>) => setDraft((d) => ({ ...d, ...patch }));

  function submit() {
    const checked = validateEnableWallet(draft, available);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    void run(() => onSubmit(checked.value));
  }

  return (
    <FormDialog
      title={copy.title}
      description={copy.description}
      onClose={onClose}
      onSubmit={submit}
      busy={busy}
      error={error}
      submitLabel={draft.currency === '' ? 'Habilitar' : `Habilitar ${draft.currency}`}
    >
      <Field label="Moneda" required error={errors.currency}>
        {(a11y) => (
          <Select
            {...a11y}
            value={draft.currency}
            onChange={(e) => set({ currency: e.target.value })}
          >
            {draft.currency === '' ? (
              <option value="" disabled>
                Elegí la moneda
              </option>
            ) : null}
            {options.featured.length > 0 ? (
              <optgroup label="Frecuentes">
                {options.featured.map((code) => (
                  <option key={code} value={code}>
                    {currencyOptionLabel(code)}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {options.others.length > 0 ? (
              <optgroup label={options.featured.length > 0 ? 'Otras' : 'Monedas'}>
                {options.others.map((code) => (
                  <option key={code} value={code}>
                    {currencyOptionLabel(code)}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </Select>
        )}
      </Field>
      <AmountField
        label="Cupo inicial"
        currency={draft.currency || '—'}
        value={draft.creditLimit}
        onChange={(creditLimit) => set({ creditLimit })}
        error={errors.creditLimit}
        required={false}
        hint="Opcional: sin cupo, sólo reserva con el saldo que le deposites. Sin separadores de miles."
      />
      <ReasonField
        value={draft.reason}
        onChange={(reason) => set({ reason })}
        error={errors.reason}
        placeholder="Ej.: empieza a vender hoteles en USD según el contrato del 29/09."
      />
      {copy.network !== undefined ? (
        <ToneNotice tone={copy.network.tone}>{copy.network.text}</ToneNotice>
      ) : null}
    </FormDialog>
  );
}

export function CreditLimitDialog({
  wallet,
  nodeName,
  financesNetwork = false,
  onSubmit,
  onClose,
}: {
  wallet: Wallet;
  nodeName: string;
  financesNetwork?: boolean;
  onSubmit: Submit<CreditLimitBody>;
  onClose: () => void;
}) {
  const exponent = wallet.exponent ?? 2;
  const [creditLimit, setCreditLimit] = useState(minorToInput(wallet.creditLimitMinor, exponent));
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<FieldErrors<'creditLimit' | 'reason'>>({});
  const [confirming, setConfirming] = useState<CreditLimitBody | null>(null);
  const { busy, error, run, setError } = useSaving();

  if (confirming !== null) {
    const summary = creditLimitSummary(
      wallet,
      nodeName,
      confirming.creditLimitMinor,
      financesNetwork,
    );
    return (
      <FormDialog
        title={summary.title}
        description={summary.description}
        onClose={onClose}
        onSubmit={() => void run(() => onSubmit(confirming))}
        busy={busy}
        error={error}
        submitLabel={summary.confirmLabel}
        destructive={summary.destructive}
        back={() => {
          setError('');
          setConfirming(null);
        }}
      >
        <SummaryList summary={summary} />
        <p className="text-xs text-[var(--color-fg-muted)]">Motivo: {confirming.reason}</p>
      </FormDialog>
    );
  }

  function next() {
    const checked = validateCreditLimit({ creditLimit, reason }, wallet);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    setConfirming(checked.value);
  }

  return (
    <FormDialog
      title={`Cupo de la cartera ${wallet.currency}`}
      description={`El crédito que le das a ${nodeName}: puede reservar con su saldo más este cupo. Hoy es ${formatMinor(wallet.creditLimitMinor, wallet.currency, wallet.exponent)}.`}
      onClose={onClose}
      onSubmit={next}
      busy={false}
      error=""
      submitLabel="Revisar"
    >
      <AmountField
        label="Nuevo cupo"
        currency={wallet.currency}
        value={creditLimit}
        onChange={setCreditLimit}
        error={errors.creditLimit}
        hint="0 para que reserve sólo con su saldo. Sin separadores de miles."
      />
      <ReasonField
        value={reason}
        onChange={setReason}
        error={errors.reason}
        placeholder="Ej.: aumento aprobado por el comité de crédito del 29/09."
      />
    </FormDialog>
  );
}

export function WalletStatusDialog({
  wallet,
  nodeName,
  financesNetwork = false,
  to,
  onSubmit,
  onClose,
}: {
  wallet: Wallet;
  nodeName: string;
  financesNetwork?: boolean;
  to: 'active' | 'suspended';
  onSubmit: Submit<{ status: 'active' | 'suspended'; reason: string }>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | undefined>();
  const { busy, error, run } = useSaving();
  const summary = walletStatusSummary(wallet, nodeName, to, financesNetwork);

  function submit() {
    const checked = validateReason(reason);
    if (!checked.ok) {
      setReasonError(checked.errors.reason);
      return;
    }
    setReasonError(undefined);
    void run(() => onSubmit({ status: to, reason: checked.value.reason }));
  }

  return (
    <FormDialog
      title={summary.title}
      description={summary.description}
      onClose={onClose}
      onSubmit={submit}
      busy={busy}
      error={error}
      submitLabel={summary.confirmLabel}
      destructive={summary.destructive}
    >
      <SummaryList summary={summary} />
      <ReasonField
        value={reason}
        onChange={setReason}
        error={reasonError}
        placeholder={
          to === 'suspended'
            ? 'Ej.: deuda vencida desde el 15/09.'
            : 'Ej.: pagó la deuda pendiente el 29/09.'
        }
      />
    </FormDialog>
  );
}

const ENTRY_COPY: Readonly<
  Record<EntryKind, { title: string; description: string; reason: string }>
> = {
  deposit: {
    title: 'Registrar depósito',
    description:
      'Un pago que ya verificaste en tu cuenta (transferencia, consignación). Se acredita en el saldo al confirmar.',
    reason: 'Ej.: transferencia Bancolombia #54223 del 29/09, verificada.',
  },
  adjustment: {
    title: 'Registrar ajuste',
    description:
      'Una corrección, un reintegro o un cargo acordado. Acredita o debita el saldo; no toca el cupo.',
    reason: 'Ej.: reintegro por la reserva 1042 cancelada fuera de plazo.',
  },
};

export function EntryDialog({
  kind,
  wallet,
  nodeName,
  financesNetwork = false,
  onSubmit,
  onClose,
}: {
  kind: EntryKind;
  wallet: Wallet;
  nodeName: string;
  financesNetwork?: boolean;
  onSubmit: (body: EntryBody, idempotencyKey: string) => Promise<string | undefined>;
  onClose: () => void;
}) {
  const [direction, setDirection] = useState<EntryDirection>('credit');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<FieldErrors<'amount' | 'reason' | 'direction'>>({});
  const [confirming, setConfirming] = useState<EntryBody | null>(null);
  const { busy, error, run, setError } = useSaving();
  // La clave es del movimiento: cambia si cambian los datos, y se conserva si se reintenta igual.
  const key = useRef<string | null>(null);
  const copy = ENTRY_COPY[kind];
  const change =
    <T,>(setter: (v: T) => void) =>
    (v: T) => {
      key.current = null;
      setter(v);
    };

  if (confirming !== null) {
    const summary = entrySummary(kind, wallet, nodeName, confirming.amountMinor, financesNetwork);
    return (
      <FormDialog
        title={summary.title}
        description={summary.description}
        onClose={onClose}
        onSubmit={() => {
          key.current ??= crypto.randomUUID();
          const requestKey = key.current;
          void run(() => onSubmit(confirming, requestKey));
        }}
        busy={busy}
        error={error}
        submitLabel={summary.confirmLabel}
        destructive={summary.destructive}
        back={() => {
          setError('');
          setConfirming(null);
        }}
      >
        <SummaryList summary={summary} />
        <p className="break-words text-xs text-[var(--color-fg-muted)]">
          Motivo: {confirming.reason}
        </p>
      </FormDialog>
    );
  }

  function next() {
    const checked = validateEntry(kind, { direction, amount, reason }, wallet);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    setConfirming(checked.value);
  }

  return (
    <FormDialog
      title={`${copy.title} en ${wallet.currency}`}
      description={copy.description}
      onClose={onClose}
      onSubmit={next}
      busy={false}
      error=""
      submitLabel="Revisar"
    >
      {kind === 'adjustment' ? (
        <fieldset className="space-y-1.5">
          <legend className="text-xs font-semibold text-[var(--color-fg)]">Tipo de ajuste</legend>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ['credit', 'Acreditar', 'Suma al saldo'],
                ['debit', 'Debitar', 'Resta del saldo'],
              ] as const
            ).map(([value, label, hint]) => (
              <label
                key={value}
                className={cn(
                  'flex cursor-pointer flex-col rounded-lg border px-3 py-2 text-sm transition-colors focus-within:ring-2 focus-within:ring-[var(--color-primary)]/40',
                  direction === value
                    ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/6'
                    : 'border-[var(--color-border)] hover:border-[var(--color-border-strong)]',
                )}
              >
                <input
                  type="radio"
                  name="adjustment-direction"
                  value={value}
                  checked={direction === value}
                  onChange={() => change(setDirection)(value)}
                  className="sr-only"
                />
                <span className="font-medium text-[var(--color-fg)]">{label}</span>
                <span className="text-[11px] text-[var(--color-fg-muted)]">{hint}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      <AmountField
        label="Monto"
        currency={wallet.currency}
        value={amount}
        onChange={change(setAmount)}
        error={errors.amount}
      />
      <ReasonField
        value={reason}
        onChange={change(setReason)}
        error={errors.reason}
        placeholder={copy.reason}
      />
    </FormDialog>
  );
}

export function ApproveReportDialog({
  report,
  nodeName,
  onSubmit,
  onClose,
}: {
  report: DepositReport;
  nodeName: string;
  onSubmit: Submit<{ reason: string | null }>;
  onClose: () => void;
}) {
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | undefined>();
  const { busy, error, run } = useSaving();
  const summary = approveReportSummary(report, nodeName);

  function submit() {
    const checked = validateApproveNote(note);
    if (!checked.ok) {
      setNoteError(checked.errors.reason);
      return;
    }
    setNoteError(undefined);
    void run(() => onSubmit(checked.value));
  }

  return (
    <FormDialog
      title={summary.title}
      description={summary.description}
      onClose={onClose}
      onSubmit={submit}
      busy={busy}
      error={error}
      submitLabel={summary.confirmLabel}
    >
      <SummaryList summary={summary} />
      <ReasonField
        optional
        value={note}
        onChange={setNote}
        error={noteError}
        placeholder="Ej.: verificado en el extracto del 29/09."
      />
    </FormDialog>
  );
}

export function RejectReportDialog({
  report,
  nodeName,
  onSubmit,
  onClose,
}: {
  report: DepositReport;
  nodeName: string;
  onSubmit: Submit<{ reason: string }>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | undefined>();
  const { busy, error, run } = useSaving();
  const summary = rejectReportSummary(report, nodeName);

  function submit() {
    const checked = validateReason(reason);
    if (!checked.ok) {
      setReasonError(checked.errors.reason);
      return;
    }
    setReasonError(undefined);
    void run(() => onSubmit(checked.value));
  }

  return (
    <FormDialog
      title={summary.title}
      description={summary.description}
      onClose={onClose}
      onSubmit={submit}
      busy={busy}
      error={error}
      submitLabel={summary.confirmLabel}
      destructive
    >
      <SummaryList summary={summary} />
      <ReasonField
        value={reason}
        onChange={setReason}
        error={reasonError}
        label="Motivo del rechazo"
        placeholder="Ej.: no encontramos esa referencia en el extracto; revisá el número."
      />
    </FormDialog>
  );
}

// ───────────────────────────── La agencia ─────────────────────────────

export function DepositReportDialog({
  wallets,
  financierName,
  onSubmit,
  onClose,
}: {
  wallets: readonly Wallet[];
  financierName: string | null;
  onSubmit: (body: DepositReportBody, idempotencyKey: string) => Promise<string | undefined>;
  onClose: () => void;
}) {
  const today = todayLocal();
  const [draft, setDraft] = useState<DepositReportDraft>({
    currency: wallets[0]?.currency ?? '',
    amount: '',
    reference: '',
    depositedOn: today,
    notes: '',
  });
  const [errors, setErrors] = useState<FieldErrors<keyof DepositReportDraft>>({});
  const { busy, error, run } = useSaving();
  const key = useRef<string | null>(null);
  const set = (patch: Partial<DepositReportDraft>) => {
    key.current = null;
    setDraft((d) => ({ ...d, ...patch }));
  };

  function submit() {
    const checked = validateDepositReport(draft, wallets, today);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    key.current ??= crypto.randomUUID();
    const requestKey = key.current;
    void run(() => onSubmit(checked.value, requestKey));
  }

  return (
    <FormDialog
      title="Informar un depósito"
      description={depositReportHelp(financierName)}
      onClose={onClose}
      onSubmit={submit}
      busy={busy}
      error={error}
      submitLabel="Informar depósito"
    >
      {wallets.length > 1 ? (
        <Field label="Cartera" required error={errors.currency}>
          {(a11y) => (
            <Select
              {...a11y}
              value={draft.currency}
              onChange={(e) => set({ currency: e.target.value })}
            >
              {wallets.map((w) => (
                <option key={w.id} value={w.currency}>
                  {currencyOptionLabel(w.currency)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}
      <AmountField
        label="Monto depositado"
        currency={draft.currency || '—'}
        value={draft.amount}
        onChange={(amount) => set({ amount })}
        error={errors.amount}
      />
      <Field
        label="Referencia"
        required
        error={errors.reference}
        hint="El número de la transferencia o de la consignación: con él lo encuentran en el banco."
      >
        {(a11y) => (
          <TextInput
            {...a11y}
            value={draft.reference}
            onChange={(e) => set({ reference: e.target.value })}
            maxLength={REFERENCE_MAX_LENGTH}
            autoComplete="off"
            placeholder="Ej.: 54223"
          />
        )}
      </Field>
      <Field label="Fecha del depósito" error={errors.depositedOn}>
        {(a11y) => (
          <TextInput
            {...a11y}
            type="date"
            max={today}
            value={draft.depositedOn}
            onChange={(e) => set({ depositedOn: e.target.value })}
          />
        )}
      </Field>
      <Field label="Nota (opcional)" error={errors.notes}>
        {(a11y) => (
          <Textarea
            {...a11y}
            value={draft.notes}
            onChange={(e) => set({ notes: e.target.value })}
            maxLength={NOTES_MAX_LENGTH}
            rows={2}
            placeholder="Ej.: Bancolombia, cuenta corriente terminada en 4412."
          />
        )}
      </Field>
    </FormDialog>
  );
}

// ───────────────────────────── Tarifas no reembolsables ─────────────────────────────

/**
 * Permitir o bloquear las tarifas no reembolsables de un nodo (pedido del founder del 2026-09-29,
 * punto e), con motivo, como todo lo que fija quien financia. Bloquear es la acción que corta
 * ventas: va en rojo y dice qué pasa con lo ya reservado (nada).
 */
export function NonRefundableRatesDialog({
  nodeName,
  to,
  inheritedBlock,
  onSubmit,
  onClose,
}: {
  nodeName: string;
  to: 'allowed' | 'blocked';
  /** Un nivel de arriba ya las bloquea: permitirlas acá no las habilita. */
  inheritedBlock: boolean;
  onSubmit: Submit<{ nonRefundableRates: 'allowed' | 'blocked'; reason: string }>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | undefined>();
  const { busy, error, run } = useSaving();
  const blocking = to === 'blocked';

  function submit() {
    const checked = validateReason(reason);
    if (!checked.ok) {
      setReasonError(checked.errors.reason);
      return;
    }
    setReasonError(undefined);
    void run(() => onSubmit({ nonRefundableRates: to, reason: checked.value.reason }));
  }

  return (
    <FormDialog
      title={blocking ? 'Bloquear tarifas no reembolsables' : 'Permitir tarifas no reembolsables'}
      description={
        blocking
          ? `${nodeName} no va a poder reservar tarifas no reembolsables: las ve marcadas como no disponibles y la reserva se rechaza. Lo mismo rige para lo que cuelga de ${nodeName}. Las reservas ya hechas no cambian.`
          : `${nodeName} va a poder reservarlas, siempre con la confirmación obligatoria de que se cobra el 100 % si se cancela, se modifica o el pasajero no se presenta, y sale de su cartera o su crédito.`
      }
      onClose={onClose}
      onSubmit={submit}
      busy={busy}
      error={error}
      submitLabel={blocking ? 'Bloquear' : 'Permitir'}
      destructive={blocking}
    >
      {!blocking && inheritedBlock ? (
        <ToneNotice tone="warning">
          Un nivel de arriba de la red las tiene bloqueadas: aunque lo permitas acá, {nodeName} no
          va a poder reservarlas hasta que lo habiliten ahí.
        </ToneNotice>
      ) : null}
      <ReasonField
        value={reason}
        onChange={setReason}
        error={reasonError}
        placeholder={
          blocking
            ? 'Ej.: dos no presentaciones sin cubrir este mes.'
            : 'Ej.: cartera al día y cupo aprobado.'
        }
      />
    </FormDialog>
  );
}
