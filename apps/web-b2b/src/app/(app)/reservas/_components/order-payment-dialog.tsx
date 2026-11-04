'use client';

import { AlertTriangle, CheckCircle2, CreditCard, Mail } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../../../components/ui/button';
import { Dialog } from '../../../../components/ui/dialog';
import { cn } from '../../../../lib/cn';
import {
  PAYMENT_MESSAGES,
  accountPaymentBody,
  choiceKind,
  choiceLabel,
  defaultPaymentMethod,
  linkSentMessage,
  normalizeEmail,
  parsePaymentOptions,
  paymentLinkBody,
  paymentLinkOutcomeOf,
  payOutcomeOf,
  type OrderPaymentMethod,
  type OrderPaymentOptions,
  type PaymentOutcome,
} from '../../../../lib/order-payment';
import { humanizeProviderError } from '../../../../lib/provider-errors';
import { readJson } from '../../../../lib/read-json';
import { formatMoney } from '../../hoteles/_components/hotel-format';
import { PaymentForm, type PaymentData } from '../../cotizaciones/[id]/payment-form';

/*
 * Pagar una reserva sin pagar con las formas de pago que el superadmin habilitó para la red (0089).
 * Al abrir se piden las opciones de ESTA orden y sólo se ofrecen ésas: enlace de pago del proveedor,
 * efectivo/BSP, GOV o tarjeta digitada. Sin ninguna, se dice a quién pedirlas y no hay botón.
 */

export interface OrderPaymentOrder {
  readonly id: string;
  readonly orderNumber: number;
  readonly totalAmount: number;
  readonly currency: string;
  readonly contactInfo?: { readonly email?: string };
  readonly searchCriteria?: { readonly origin?: string; readonly destination?: string };
}

type Options =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'ready'; readonly methods: readonly OrderPaymentMethod[] };

async function loadOptions(orderId: string): Promise<OrderPaymentOptions | null> {
  try {
    const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/payment-options`, {
      cache: 'no-store',
    });
    const read = await readJson<unknown>(res);
    if (!read.ok || !res.ok) return null;
    return parsePaymentOptions(read.data);
  } catch {
    return null;
  }
}

async function post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const read = await readJson<unknown>(res);
  if (!read.ok) return { status: res.status, body: { message: read.message } };
  return { status: res.status, body: read.data };
}

const inputClass =
  'h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20';

export function OrderPaymentDialog({
  order,
  onClose,
  onPaid,
  onLinkSent,
  initialOptions,
}: {
  order: OrderPaymentOrder;
  onClose: () => void;
  /** El proveedor aceptó el pago: el estado nuevo de la orden, si vino. */
  onPaid: (status: string | undefined) => void;
  /** El proveedor envió el enlace: el mensaje para dejar en la fila. */
  onLinkSent: (message: string) => void;
  /** Opciones ya leídas (pruebas): no se piden al API. */
  initialOptions?: OrderPaymentOptions;
}) {
  const [options, setOptions] = useState<Options>(
    initialOptions ? { kind: 'ready', methods: initialOptions.methods } : { kind: 'loading' },
  );
  const [selected, setSelected] = useState<string | null>(
    initialOptions ? defaultPaymentMethod(initialOptions.methods) : null,
  );
  const [email, setEmail] = useState(order.contactInfo?.email?.trim() ?? '');
  const [card, setCard] = useState<PaymentData | null>(null);
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sendingRef = useRef(false);
  const groupName = useId();
  const emailId = useId();

  useEffect(() => {
    if (initialOptions) return;
    let alive = true;
    void loadOptions(order.id).then((loaded) => {
      if (!alive) return;
      if (loaded === null) {
        setOptions({ kind: 'failed' });
        return;
      }
      setOptions({ kind: 'ready', methods: loaded.methods });
      setSelected(defaultPaymentMethod(loaded.methods));
    });
    return () => {
      alive = false;
    };
  }, [order.id, initialOptions]);

  // Con el pedido en vuelo no se cierra: el vendedor no sabría si salió.
  const close = useCallback(() => {
    if (!sendingRef.current) onClose();
  }, [onClose]);

  const methods = options.kind === 'ready' ? options.methods : [];
  const method = methods.find((m) => m.code === selected) ?? null;
  const kind = method ? choiceKind(method) : null;

  const ready =
    !sending &&
    sentTo === null &&
    method !== null &&
    (kind === 'link'
      ? normalizeEmail(email) !== null
      : kind === 'card'
        ? card !== null
        : accountPaymentBody(method.code, order) !== null);

  async function submit() {
    if (sendingRef.current || !ready || method === null) return;
    let path: string;
    let body: unknown;
    if (kind === 'link') {
      const linkBody = paymentLinkBody(email);
      if (linkBody === null) {
        setError(PAYMENT_MESSAGES.invalidEmail);
        return;
      }
      path = `/api/orders/${encodeURIComponent(order.id)}/payment-link`;
      body = linkBody;
    } else {
      const payment = kind === 'card' ? card : accountPaymentBody(method.code, order)?.payment;
      if (!payment) return;
      path = `/api/orders/${encodeURIComponent(order.id)}/pay`;
      body = { payment };
    }

    sendingRef.current = true;
    setSending(true);
    setError(null);
    let outcome: PaymentOutcome;
    try {
      const res = await post(path, body);
      outcome =
        kind === 'link'
          ? paymentLinkOutcomeOf(res.status, res.body)
          : payOutcomeOf(res.status, res.body);
    } catch {
      outcome = {
        ok: false,
        message: kind === 'link' ? PAYMENT_MESSAGES.sendFailed : 'Error de conexión',
      };
    }
    sendingRef.current = false;
    setSending(false);

    if (!outcome.ok) {
      setError(kind === 'link' ? outcome.message : humanizeProviderError(outcome.message));
      return;
    }
    if (kind === 'link') {
      const to = (body as { email: string }).email;
      setSentTo(to);
      onLinkSent(linkSentMessage(to));
      return;
    }
    onPaid(outcome.status);
  }

  const route =
    order.searchCriteria?.origin || order.searchCriteria?.destination
      ? `${order.searchCriteria?.origin ?? '—'} → ${order.searchCriteria?.destination ?? '—'}`
      : null;

  const showSubmit = options.kind === 'ready' && methods.length > 0 && sentTo === null;

  return (
    <Dialog
      open
      onClose={close}
      title={`Pagar reserva #${order.orderNumber}`}
      className="max-w-lg"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" disabled={sending} onClick={close}>
            {sentTo === null ? 'Cancelar' : 'Cerrar'}
          </Button>
          {showSubmit ? (
            <Button
              variant="primary"
              className="gap-1.5"
              disabled={!ready}
              onClick={() => void submit()}
            >
              {kind === 'link' ? <Mail aria-hidden="true" /> : <CreditCard aria-hidden="true" />}
              {sending ? 'Procesando…' : kind === 'link' ? 'Enviar enlace' : 'Confirmar pago'}
            </Button>
          ) : null}
        </div>
      }
    >
      <div
        className="space-y-4 text-xs"
        aria-busy={options.kind === 'loading' ? 'true' : undefined}
      >
        <dl className="flex items-baseline justify-between gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-3">
          <dt className="text-[var(--color-fg-muted)]">{route ?? 'Total'}</dt>
          <dd className="text-lg font-semibold tabular-nums tracking-tight text-[var(--color-fg)]">
            {formatMoney({ amountMinor: order.totalAmount, currency: order.currency })}
          </dd>
        </dl>

        {options.kind === 'loading' ? (
          <p role="status" className="text-[var(--color-fg-subtle)]">
            {PAYMENT_MESSAGES.loading}
          </p>
        ) : null}

        {options.kind === 'failed' ? (
          <p role="alert" className="text-[var(--color-fg)]">
            {PAYMENT_MESSAGES.loadFailed}
          </p>
        ) : null}

        {options.kind === 'ready' && methods.length === 0 ? (
          <p className="rounded-lg border border-[var(--color-border)] px-3 py-2.5 leading-relaxed text-[var(--color-fg)]">
            {PAYMENT_MESSAGES.none}
          </p>
        ) : null}

        {sentTo !== null ? (
          <p
            role="status"
            className="flex items-start gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2.5 text-green-800"
          >
            <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>{linkSentMessage(sentTo)}</span>
          </p>
        ) : null}

        {methods.length > 0 && sentTo === null ? (
          <fieldset className="space-y-2" disabled={sending}>
            <legend className="mb-2 font-medium text-[var(--color-fg)]">Forma de pago</legend>
            {methods.map((m) => {
              const checked = m.code === selected;
              return (
                <label
                  key={m.code}
                  className={cn(
                    'flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors',
                    checked
                      ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5'
                      : 'border-[var(--color-border)] hover:bg-[var(--color-surface-muted)]',
                  )}
                >
                  <input
                    type="radio"
                    name={groupName}
                    value={m.code}
                    checked={checked}
                    onChange={() => {
                      setSelected(m.code);
                      setError(null);
                    }}
                    className="mt-0.5 accent-[var(--color-primary)]"
                  />
                  <span className="space-y-0.5">
                    <span className="block text-sm font-medium text-[var(--color-fg)]">
                      {choiceLabel(m)}
                    </span>
                    {m.description ? (
                      <span className="block text-[var(--color-fg-muted)]">{m.description}</span>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </fieldset>
        ) : null}

        {sentTo === null && kind === 'link' ? (
          <div className="space-y-1.5">
            <label htmlFor={emailId} className="block font-medium text-[var(--color-fg)]">
              Correo del pagador
            </label>
            <input
              id={emailId}
              type="email"
              autoComplete="email"
              value={email}
              disabled={sending}
              onChange={(e) => {
                setEmail(e.target.value);
                setError(null);
              }}
              placeholder="cliente@correo.com"
              className={inputClass}
            />
            <p className="leading-relaxed text-[var(--color-fg-muted)]">
              {PAYMENT_MESSAGES.linkExplain}
            </p>
          </div>
        ) : null}

        {sentTo === null && kind === 'account' ? (
          <p className="leading-relaxed text-[var(--color-fg-muted)]">
            {PAYMENT_MESSAGES.accountNote}
          </p>
        ) : null}

        {sentTo === null && kind === 'card' ? (
          <div className="space-y-2">
            {method?.pci === 'out-of-scope' ? (
              <p className="flex items-start gap-2 text-[var(--color-fg-muted)]">
                <AlertTriangle
                  aria-hidden="true"
                  className="mt-0.5 size-3.5 shrink-0 text-[var(--color-warning)]"
                />
                <span>{PAYMENT_MESSAGES.cardOutOfScope}</span>
              </p>
            ) : null}
            <PaymentForm
              totalAmountMinor={order.totalAmount}
              currency={order.currency}
              onPaymentChange={setCard}
            />
          </div>
        ) : null}

        {error !== null ? (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 px-3 py-2.5 text-[var(--color-fg)]"
          >
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
