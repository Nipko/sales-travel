import {
  currencyName,
  formatMinor,
  formatSignedMinor,
  type DepositReport,
  type Wallet,
} from './wallets';

/**
 * Los formularios de las carteras, sin React: qué se escribe, cómo se valida antes de mandarlo y
 * qué se confirma. Las reglas son las del API (apps/api/src/portfolios/portfolios.schemas.ts), que
 * vuelve a validar todo; acá se dicen antes y en el campo que corresponde.
 *
 * Los montos se escriben en la unidad de la moneda ("1500000" o "1500000,50") y viajan en unidades
 * menores. La cuenta se hace con el texto y no con decimales de coma flotante: 0,1 + 0,2 no da 0,3.
 */

/** Tope de cordura del API: frena un cero de más antes de que llegue a la base. */
export const MAX_WALLET_AMOUNT_MINOR = 1_000_000_000_000;
export const REASON_MIN_LENGTH = 3;
export const REASON_MAX_LENGTH = 500;
export const REFERENCE_MAX_LENGTH = 100;
export const NOTES_MAX_LENGTH = 500;

/**
 * Decimales de una cartera nueva: el API sólo habilita monedas con centésimos (las reservas se
 * cobran en centavos), así que toda moneda que se ofrece para habilitar tiene exponente 2.
 */
export const NEW_WALLET_EXPONENT = 2;

export type FieldErrors<K extends string> = Partial<Record<K, string>>;

export type Validated<T, K extends string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: FieldErrors<K> };

type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

// ───────────────────────────── Montos ─────────────────────────────

const AMOUNT_RE = /^(\d+)(?:[.,](\d+))?$/;

/**
 * Un monto escrito por una persona, en unidades menores. Acepta la coma o el punto para los
 * centavos, pero no separadores de miles: "1.500" sería mil quinientos o uno con cincuenta según a
 * quién se le pregunte, y en plata no se adivina.
 */
export function parseAmountInput(
  text: string,
  exponent: number,
  opts: { readonly allowZero?: boolean } = {},
): Parsed<number> {
  // `\s` incluye el espacio duro que dejan algunos teclados y el copiar y pegar de un extracto.
  const clean = text.replace(/\s/g, '').replace(/^\$/, '');
  if (clean === '') return { ok: false, error: 'Indicá el monto.' };
  if (clean.startsWith('-')) {
    return { ok: false, error: 'Escribí el monto sin signo.' };
  }
  const m = AMOUNT_RE.exec(clean);
  if (m === null) {
    return {
      ok: false,
      error:
        exponent > 0
          ? 'Escribí sólo números, sin separadores de miles (ej.: 1500000 o 1500000,50).'
          : 'Escribí sólo números, sin separadores de miles (ej.: 1500000).',
    };
  }
  const whole = m[1] ?? '';
  const fraction = m[2] ?? '';
  if (fraction.length > exponent) {
    return {
      ok: false,
      error:
        exponent === 0
          ? 'Esta moneda no tiene centavos: escribí el monto sin decimales ni separadores de miles.'
          : `Usá la coma sólo para los centavos (hasta ${exponent} decimales), sin separadores de miles.`,
    };
  }
  const digits = `${whole}${fraction.padEnd(exponent, '0')}`.replace(/^0+(?=\d)/, '');
  // Más dígitos que el tope no entran en un número exacto: se cortan antes de convertir.
  if (digits.length > String(MAX_WALLET_AMOUNT_MINOR).length) {
    return { ok: false, error: 'El monto supera el máximo que admite una cartera.' };
  }
  const minor = Number(digits);
  if (minor > MAX_WALLET_AMOUNT_MINOR) {
    return { ok: false, error: 'El monto supera el máximo que admite una cartera.' };
  }
  if (minor === 0 && opts.allowZero !== true) {
    return { ok: false, error: 'El monto tiene que ser mayor que cero.' };
  }
  return { ok: true, value: minor };
}

/** El monto en unidades menores, como se escribe en el campo ("1500000" o "1500000,50"). */
export function minorToInput(minor: number, exponent: number): string {
  const sign = minor < 0 ? '-' : '';
  const digits = String(Math.abs(minor)).padStart(exponent + 1, '0');
  if (exponent === 0) return `${sign}${digits}`;
  const whole = digits.slice(0, -exponent);
  const fraction = digits.slice(-exponent).replace(/0+$/, '');
  return fraction === '' ? `${sign}${whole}` : `${sign}${whole},${fraction}`;
}

// ───────────────────────────── Textos ─────────────────────────────

/** El motivo de quien financia: obligatorio en todo lo que mueve plata o crédito. */
export function reasonError(text: string): string | undefined {
  const t = text.trim();
  if (t.length < REASON_MIN_LENGTH) {
    return `Escribí el motivo (al menos ${REASON_MIN_LENGTH} caracteres): queda en la auditoría.`;
  }
  if (t.length > REASON_MAX_LENGTH) {
    return `El motivo admite hasta ${REASON_MAX_LENGTH} caracteres.`;
  }
  return undefined;
}

/** Un texto opcional: sólo se controla el largo. */
export function optionalTextError(text: string, max: number): string | undefined {
  return text.trim().length > max ? `Admite hasta ${max} caracteres.` : undefined;
}

export function referenceError(text: string): string | undefined {
  const t = text.trim();
  if (t === '') return 'Indicá la referencia del depósito (el número de la transferencia).';
  if (t.length > REFERENCE_MAX_LENGTH) {
    return `La referencia admite hasta ${REFERENCE_MAX_LENGTH} caracteres.`;
  }
  return undefined;
}

/** Hoy en la zona del navegador, `AAAA-MM-DD`: el tope del campo de fecha del depósito. */
export function todayLocal(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** La fecha del depósito: opcional, un día que exista y que no sea futuro. */
export function depositDateError(day: string, today: string): string | undefined {
  if (day === '') return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (m === null) return 'La fecha va como AAAA-MM-DD.';
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (date.toISOString().slice(0, 10) !== day) return 'La fecha no existe en el calendario.';
  if (day > today) return 'La fecha del depósito no puede ser futura.';
  return undefined;
}

// ───────────────────────────── Quien financia ─────────────────────────────

export interface EnableWalletDraft {
  readonly currency: string;
  readonly creditLimit: string;
  readonly reason: string;
}

export interface EnableWalletBody {
  readonly currency: string;
  readonly creditLimitMinor: number;
  readonly reason: string;
}

/**
 * Las monedas que se ofrecen primero al habilitar: la del nodo y las del mercado inicial (CO, PE,
 * BR) más el dólar. El API ofrece todas las de ISO 4217 con centésimos, en orden alfabético: sin
 * esto, la primera de la lista (AED) quedaba elegida y COP o USD había que buscarlas entre 150.
 */
const FEATURED_CURRENCIES: readonly string[] = ['USD', 'COP', 'PEN', 'BRL'];

export interface EnableCurrencyOptions {
  /** La moneda del nodo primero, después las frecuentes; sólo las que se pueden habilitar. */
  readonly featured: readonly string[];
  readonly others: readonly string[];
}

export function enableCurrencyOptions(
  available: readonly string[],
  defaultCurrency: string,
): EnableCurrencyOptions {
  const featured = [defaultCurrency, ...FEATURED_CURRENCIES].filter(
    (code, i, all) => code !== '' && available.includes(code) && all.indexOf(code) === i,
  );
  return { featured, others: available.filter((code) => !featured.includes(code)) };
}

/**
 * La moneda elegida al abrir el formulario: la del nodo si todavía no tiene cartera en ella; si no,
 * ninguna. Una cartera en la moneda equivocada no se borra, así que no se elige por descuido.
 */
export function initialEnableCurrency(
  available: readonly string[],
  defaultCurrency: string,
): string {
  return defaultCurrency !== '' && available.includes(defaultCurrency) ? defaultCurrency : '';
}

/** Habilitar una moneda: una de las que el nodo todavía no tiene, con su cupo inicial (0 si no). */
export function validateEnableWallet(
  draft: EnableWalletDraft,
  available: readonly string[],
): Validated<EnableWalletBody, keyof EnableWalletDraft> {
  const errors: FieldErrors<keyof EnableWalletDraft> = {};
  if (!available.includes(draft.currency)) errors.currency = 'Elegí la moneda que vas a habilitar.';
  const limit =
    draft.creditLimit.trim() === ''
      ? ({ ok: true, value: 0 } as const)
      : parseAmountInput(draft.creditLimit, NEW_WALLET_EXPONENT, { allowZero: true });
  if (!limit.ok) errors.creditLimit = limit.error;
  const reason = reasonError(draft.reason);
  if (reason !== undefined) errors.reason = reason;
  if (Object.keys(errors).length > 0 || !limit.ok) return { ok: false, errors };
  return {
    ok: true,
    value: { currency: draft.currency, creditLimitMinor: limit.value, reason: draft.reason.trim() },
  };
}

export interface CreditLimitDraft {
  readonly creditLimit: string;
  readonly reason: string;
}

export interface CreditLimitBody {
  readonly creditLimitMinor: number;
  readonly reason: string;
}

export function validateCreditLimit(
  draft: CreditLimitDraft,
  wallet: Pick<Wallet, 'exponent' | 'creditLimitMinor'>,
): Validated<CreditLimitBody, keyof CreditLimitDraft> {
  const errors: FieldErrors<keyof CreditLimitDraft> = {};
  const limit = parseAmountInput(draft.creditLimit, wallet.exponent ?? NEW_WALLET_EXPONENT, {
    allowZero: true,
  });
  if (!limit.ok) errors.creditLimit = limit.error;
  else if (limit.value === wallet.creditLimitMinor) {
    errors.creditLimit = 'Es el cupo que ya tiene: escribí el nuevo.';
  }
  const reason = reasonError(draft.reason);
  if (reason !== undefined) errors.reason = reason;
  if (Object.keys(errors).length > 0 || !limit.ok) return { ok: false, errors };
  return { ok: true, value: { creditLimitMinor: limit.value, reason: draft.reason.trim() } };
}

export type EntryKind = 'deposit' | 'adjustment';
export type EntryDirection = 'credit' | 'debit';

export interface EntryDraft {
  readonly direction: EntryDirection;
  readonly amount: string;
  readonly reason: string;
}

export interface EntryBody {
  /** Con signo: el depósito siempre suma; el ajuste suma o resta según la dirección. */
  readonly amountMinor: number;
  readonly reason: string;
}

/** Un depósito verificado (siempre acredita) o un ajuste con signo. */
export function validateEntry(
  kind: EntryKind,
  draft: EntryDraft,
  wallet: Pick<Wallet, 'exponent'>,
): Validated<EntryBody, keyof EntryDraft> {
  const errors: FieldErrors<keyof EntryDraft> = {};
  const amount = parseAmountInput(draft.amount, wallet.exponent ?? NEW_WALLET_EXPONENT);
  if (!amount.ok) errors.amount = amount.error;
  const reason = reasonError(draft.reason);
  if (reason !== undefined) errors.reason = reason;
  if (Object.keys(errors).length > 0 || !amount.ok) return { ok: false, errors };
  const debit = kind === 'adjustment' && draft.direction === 'debit';
  return {
    ok: true,
    value: { amountMinor: debit ? -amount.value : amount.value, reason: draft.reason.trim() },
  };
}

/** Un motivo obligatorio sin otros campos: rechazar un informe, suspender o reactivar. */
export function validateReason(reason: string): Validated<{ reason: string }, 'reason'> {
  const error = reasonError(reason);
  return error === undefined
    ? { ok: true, value: { reason: reason.trim() } }
    : { ok: false, errors: { reason: error } };
}

/** Aprobar admite un comentario, no lo exige: lo que se acredita ya lo dice el informe. */
export function validateApproveNote(note: string): Validated<{ reason: string | null }, 'reason'> {
  const error = optionalTextError(note, REASON_MAX_LENGTH);
  if (error !== undefined) return { ok: false, errors: { reason: error } };
  const t = note.trim();
  return { ok: true, value: { reason: t === '' ? null : t } };
}

// ───────────────────────────── La agencia ─────────────────────────────

export interface DepositReportDraft {
  readonly currency: string;
  readonly amount: string;
  readonly reference: string;
  readonly depositedOn: string;
  readonly notes: string;
}

export interface DepositReportBody {
  readonly currency: string;
  readonly amountMinor: number;
  readonly reference: string;
  readonly depositedOn: string | null;
  readonly notes: string | null;
}

/** El depósito que informa la agencia, sobre una de sus carteras. */
export function validateDepositReport(
  draft: DepositReportDraft,
  wallets: readonly Pick<Wallet, 'currency' | 'exponent'>[],
  today: string,
): Validated<DepositReportBody, keyof DepositReportDraft> {
  const errors: FieldErrors<keyof DepositReportDraft> = {};
  const wallet = wallets.find((w) => w.currency === draft.currency);
  if (wallet === undefined) errors.currency = 'Elegí la cartera en la que depositaste.';
  const amount = parseAmountInput(draft.amount, wallet?.exponent ?? NEW_WALLET_EXPONENT);
  if (!amount.ok) errors.amount = amount.error;
  const reference = referenceError(draft.reference);
  if (reference !== undefined) errors.reference = reference;
  const date = depositDateError(draft.depositedOn, today);
  if (date !== undefined) errors.depositedOn = date;
  const notes = optionalTextError(draft.notes, NOTES_MAX_LENGTH);
  if (notes !== undefined) errors.notes = notes;
  if (Object.keys(errors).length > 0 || !amount.ok) return { ok: false, errors };
  const n = draft.notes.trim();
  return {
    ok: true,
    value: {
      currency: draft.currency,
      amountMinor: amount.value,
      reference: draft.reference.trim(),
      depositedOn: draft.depositedOn === '' ? null : draft.depositedOn,
      notes: n === '' ? null : n,
    },
  };
}

// ───────────────────────────── Confirmaciones ─────────────────────────────

export interface SummaryLine {
  readonly label: string;
  readonly value: string;
}

export interface ActionSummary {
  readonly title: string;
  readonly description: string;
  readonly lines: readonly SummaryLine[];
  /** Lo que hay que leer antes de confirmar (un disponible negativo, una suspensión). */
  readonly warning?: string;
  /** Lo que el cambio le hace a la red del nodo, si financia a una (0060). */
  readonly network?: NetworkNote;
  readonly confirmLabel: string;
  readonly destructive: boolean;
}

/** Lo que un cambio en la cartera del nodo le hace a su red: la frena o la habilita. */
export interface NetworkNote {
  readonly text: string;
  readonly tone: 'warning' | 'neutral';
}

function money(wallet: Pick<Wallet, 'currency' | 'exponent'>, minor: number): string {
  return formatMinor(minor, wallet.currency, wallet.exponent);
}

/**
 * Desde 0060 la cartera de un nodo que financia a una red también retiene, al costo de su nivel,
 * cada reserva de esa red hecha con una cuenta de proveedor de un nivel superior. Suspenderla,
 * achicar su disponible o no tenerla frena también esas ventas, aunque el diálogo hable del nodo.
 * Condicional: una red que reserva con la cuenta propia del nodo no retiene en ella.
 */
export function networkNote(
  effect: 'stops' | 'limits' | 'enables',
  nodeName: string,
  currency: string | null,
): NetworkNote {
  const inCurrency = currency === null ? 'en esa moneda' : `en ${currency}`;
  switch (effect) {
    case 'stops':
      return {
        tone: 'warning',
        text: `También frena las reservas ${inCurrency} de la red de ${nodeName} que usan cuentas de proveedor de un nivel superior: esta cartera las retiene.`,
      };
    case 'limits':
      return {
        tone: 'warning',
        text: `El disponible de ${nodeName} ${inCurrency} también cubre las reservas de su red que usan cuentas de proveedor de un nivel superior: si no alcanza, esas reservas se rechazan.`,
      };
    case 'enables':
      return {
        tone: 'neutral',
        text: `También habilita, hasta su disponible, las reservas ${inCurrency} de la red de ${nodeName} que usan cuentas de proveedor de un nivel superior.`,
      };
  }
}

/** Lo que se confirma al registrar un depósito o un ajuste: el saldo antes y después. */
export function entrySummary(
  kind: EntryKind,
  wallet: Wallet,
  nodeName: string,
  amountMinor: number,
  financesNetwork = false,
): ActionSummary {
  const balanceAfter = wallet.balanceMinor + amountMinor;
  const availableAfter = balanceAfter + wallet.creditLimitMinor;
  const debit = amountMinor < 0;
  const verb = debit ? 'debitar' : 'acreditar';
  const amount = money(wallet, Math.abs(amountMinor));
  const lines: SummaryLine[] = [
    {
      label: kind === 'deposit' ? 'Depósito' : 'Ajuste',
      value: formatSignedMinor(amountMinor, wallet.currency, wallet.exponent),
    },
    {
      label: 'Saldo',
      value: `${money(wallet, wallet.balanceMinor)} → ${money(wallet, balanceAfter)}`,
    },
    { label: 'Disponible para reservar', value: money(wallet, availableAfter) },
  ];
  return {
    title: kind === 'deposit' ? 'Confirmá el depósito' : 'Confirmá el ajuste',
    description: `Vas a ${verb} ${amount} en la cartera ${wallet.currency} de ${nodeName}. El movimiento no se borra: si hay un error, se corrige con otro ajuste.`,
    lines,
    ...(availableAfter < 0
      ? {
          warning: `El disponible queda en ${money(wallet, availableAfter)}: ${nodeName} no podrá reservar en ${wallet.currency} hasta cubrirlo.`,
        }
      : {}),
    ...(financesNetwork && debit
      ? { network: networkNote('limits', nodeName, wallet.currency) }
      : {}),
    confirmLabel:
      kind === 'deposit' ? `Acreditar ${amount}` : `${debit ? 'Debitar' : 'Acreditar'} ${amount}`,
    destructive: debit,
  };
}

/** Lo que se confirma al fijar el cupo. */
export function creditLimitSummary(
  wallet: Wallet,
  nodeName: string,
  creditLimitMinor: number,
  financesNetwork = false,
): ActionSummary {
  const availableAfter = wallet.balanceMinor + creditLimitMinor;
  const lowers = creditLimitMinor < wallet.creditLimitMinor;
  return {
    title: 'Confirmá el cupo',
    description: `El cupo es el crédito que le das a ${nodeName} en ${wallet.currency}: puede reservar con su saldo más este cupo.`,
    lines: [
      {
        label: 'Cupo',
        value: `${money(wallet, wallet.creditLimitMinor)} → ${money(wallet, creditLimitMinor)}`,
      },
      { label: 'Disponible para reservar', value: money(wallet, availableAfter) },
    ],
    ...(availableAfter < 0
      ? {
          warning: `Con este cupo el disponible queda en ${money(wallet, availableAfter)}: ${nodeName} no podrá reservar en ${wallet.currency} hasta cubrirlo.`,
        }
      : {}),
    ...(financesNetwork ? { network: networkNote('limits', nodeName, wallet.currency) } : {}),
    confirmLabel: 'Fijar cupo',
    destructive: lowers && availableAfter < 0,
  };
}

/** Suspender o reactivar una cartera. */
export function walletStatusSummary(
  wallet: Wallet,
  nodeName: string,
  to: 'active' | 'suspended',
  financesNetwork = false,
): ActionSummary {
  if (to === 'suspended') {
    return {
      title: `Suspender la cartera ${wallet.currency}`,
      description: `Mientras esté suspendida, ${nodeName} no puede reservar en ${wallet.currency}. El saldo, el cupo y los movimientos se conservan, y las reservas ya retenidas siguen su curso.`,
      lines: [],
      ...(financesNetwork ? { network: networkNote('stops', nodeName, wallet.currency) } : {}),
      confirmLabel: 'Suspender cartera',
      destructive: true,
    };
  }
  return {
    title: `Reactivar la cartera ${wallet.currency}`,
    description: `${nodeName} vuelve a poder reservar en ${wallet.currency} con su saldo más su cupo.`,
    lines: [{ label: 'Disponible para reservar', value: money(wallet, wallet.availableMinor) }],
    ...(financesNetwork ? { network: networkNote('enables', nodeName, wallet.currency) } : {}),
    confirmLabel: 'Reactivar cartera',
    destructive: false,
  };
}

export function enableWalletSummary(
  nodeName: string,
  financesNetwork = false,
): Pick<ActionSummary, 'title' | 'description' | 'network'> {
  return {
    title: 'Habilitar una moneda',
    description: `Abre una cartera nueva para ${nodeName}: podrá reservar tarifas en esa moneda con el saldo que le deposites más el cupo que le des.`,
    ...(financesNetwork ? { network: networkNote('enables', nodeName, null) } : {}),
  };
}

function reportLines(report: DepositReport): SummaryLine[] {
  return [
    { label: 'Monto', value: formatMinor(report.amountMinor, report.currency, report.exponent) },
    { label: 'Referencia', value: report.reference },
  ];
}

/** Aprobar un depósito informado: acredita ese monto en esa cartera, una sola vez. */
export function approveReportSummary(report: DepositReport, nodeName: string): ActionSummary {
  const amount = formatMinor(report.amountMinor, report.currency, report.exponent);
  return {
    title: 'Aprobar el depósito informado',
    description: `Verificá que el dinero llegó a tu cuenta. Al aprobarlo se acreditan ${amount} en la cartera ${report.currency} de ${nodeName}.`,
    lines: reportLines(report),
    confirmLabel: `Aprobar y acreditar ${amount}`,
    destructive: false,
  };
}

/** Rechazar un depósito informado: no mueve el saldo, y la agencia ve el motivo. */
export function rejectReportSummary(report: DepositReport, nodeName: string): ActionSummary {
  return {
    title: 'Rechazar el depósito informado',
    description: `No se acredita nada. ${nodeName} ve el motivo y puede informarlo de nuevo con los datos correctos.`,
    lines: reportLines(report),
    confirmLabel: 'Rechazar depósito',
    destructive: true,
  };
}

export type FinancierAction =
  | 'enable'
  | 'limit'
  | 'suspend'
  | 'reactivate'
  | 'deposit'
  | 'adjustment'
  | 'approve'
  | 'reject';

/** El aviso de que el cambio de quien financia quedó guardado. */
export function savedMessage(action: FinancierAction, nodeName: string, currency: string): string {
  switch (action) {
    case 'enable':
      return `${nodeName} ya tiene cartera en ${currency}.`;
    case 'limit':
      return `Cupo en ${currency} actualizado para ${nodeName}.`;
    case 'suspend':
      return `La cartera ${currency} de ${nodeName} quedó suspendida.`;
    case 'reactivate':
      return `La cartera ${currency} de ${nodeName} quedó activa.`;
    case 'deposit':
      return `Depósito acreditado en la cartera ${currency} de ${nodeName}.`;
    case 'adjustment':
      return `Ajuste registrado en la cartera ${currency} de ${nodeName}.`;
    case 'approve':
      return `Depósito aprobado y acreditado en la cartera ${currency} de ${nodeName}.`;
    case 'reject':
      return `Depósito rechazado: ${nodeName} ve el motivo.`;
  }
}

/** El texto de ayuda de la agencia al informar un depósito. */
export function depositReportHelp(financierName: string | null): string {
  const who = financierName ?? 'Planetour';
  return `Queda pendiente hasta que ${who} lo verifique y lo apruebe: recién ahí suma a tu saldo.`;
}

/** "Dólar estadounidense (USD)", para los selectores de moneda. */
export function currencyOptionLabel(code: string): string {
  const name = currencyName(code);
  return name === code ? code : `${name} (${code})`;
}
