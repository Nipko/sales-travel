'use client';

import { AlertTriangle, CheckCircle2, FlaskConical, Info, Luggage, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../../../components/ui/button';
import { useConfirm } from '../../../../components/ui/dialog';
import { Sheet } from '../../../../components/ui/form-sheet';
import { cn } from '../../../../lib/cn';
import { readJson } from '../../../../lib/read-json';
import { formatMoney } from '../../hoteles/_components/hotel-format';
import {
  CATEGORY_LABELS,
  LINE_STATUS_LABELS,
  SERVICES_UI,
  addServicesBody,
  parseServicesCatalog,
  passengerLabel,
  removalSet,
  removeServicesBody,
  segmentsLabel,
  selectionKey,
  selectionTotal,
  servicesByPassenger,
  servicesChangeReplyOf,
  type ServiceLineView,
  type ServicesCatalogView,
} from '../services-view';

/*
 * Maletas y servicios adicionales de una reserva confirmada, antes de emitir (SAB-20). Por pasajero:
 * lo ya agregado (con «Quitar») y lo que la aerolínea ofrece, por tramo, con su precio. Se marca lo
 * que se quiere, se ve cuánto suma y el total nuevo de la reserva, y se confirma.
 *
 * Cada cambio va UNA vez y se espera el desenlace: el API lo guarda, ajusta la retención de cartera
 * y dice en qué quedó. Después se relee el catálogo, que es la fuente de lo agregado.
 */

export interface ServicesSheetPassenger {
  readonly givenName?: string;
  readonly surname?: string;
  readonly paxType?: string;
}

export interface ServicesSheetOrder {
  readonly id: string;
  readonly orderNumber: number;
  readonly passengers: readonly ServicesSheetPassenger[];
}

export type ServicesSheetPhase =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'ready'; readonly catalog: ServicesCatalogView };

interface Notice {
  readonly tone: 'ok' | 'warn' | 'error';
  readonly message: string;
}

async function loadCatalog(orderId: string): Promise<ServicesSheetPhase> {
  try {
    const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/services`, {
      method: 'POST',
    });
    const read = await readJson<unknown>(res);
    if (!read.ok) return { kind: 'failed', message: read.message };
    if (!res.ok) {
      const message = (read.data as { error?: unknown; message?: unknown } | null) ?? null;
      const text =
        typeof message?.error === 'string'
          ? message.error
          : typeof message?.message === 'string'
            ? message.message
            : SERVICES_UI.loadFailed;
      return { kind: 'failed', message: text };
    }
    const catalog = parseServicesCatalog(read.data);
    return catalog === null
      ? { kind: 'failed', message: SERVICES_UI.loadFailed }
      : { kind: 'ready', catalog };
  } catch {
    return { kind: 'failed', message: SERVICES_UI.loadFailed };
  }
}

async function send(orderId: string, change: 'add' | 'remove', body: unknown): Promise<Notice> {
  try {
    const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/services/${change}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const read = await readJson<unknown>(res);
    if (!read.ok) return { tone: 'error', message: read.message };
    const reply = servicesChangeReplyOf(res.status, read.data);
    if (!reply.ok) return { tone: 'error', message: reply.message };
    return { tone: reply.done ? 'ok' : 'warn', message: reply.message };
  } catch {
    return { tone: 'error', message: SERVICES_UI.sendFailed };
  }
}

export function AddServicesSheet({
  order,
  onClose,
  onChanged,
}: {
  order: ServicesSheetOrder;
  onClose: () => void;
  /** Algo cambió en la reserva (total, retención): la lista se relee. */
  onChanged: () => void;
}) {
  const [phase, setPhase] = useState<ServicesSheetPhase>({ kind: 'loading' });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  /** Qué pedido está en vuelo: `'add'`, o el id de la línea que se quita. */
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const busyRef = useRef(false);
  const [confirm, confirmElement] = useConfirm();

  const reload = useCallback(async () => {
    const next = await loadCatalog(order.id);
    setPhase(next);
    setSelected(new Set());
  }, [order.id]);

  useEffect(() => {
    let alive = true;
    void loadCatalog(order.id).then((next) => {
      if (alive) setPhase(next);
    });
    return () => {
      alive = false;
    };
  }, [order.id]);

  // Con un pedido en vuelo no se cierra: el vendedor no sabría si salió.
  const close = useCallback(() => {
    if (!busyRef.current) onClose();
  }, [onClose]);

  const catalog = phase.kind === 'ready' ? phase.catalog : null;
  const total = catalog === null ? 0 : selectionTotal(catalog, selected);

  async function run(change: 'add' | 'remove', key: string, body: unknown): Promise<void> {
    busyRef.current = true;
    setBusy(key);
    setNotice(null);
    const result = await send(order.id, change, body);
    busyRef.current = false;
    setBusy(null);
    setNotice(result);
    // Aun rechazado, se relee: el catálogo y lo agregado dicen cómo quedó la reserva.
    await reload();
    onChanged();
  }

  async function add(): Promise<void> {
    if (catalog === null || selected.size === 0 || busyRef.current) return;
    const body = addServicesBody(catalog, selected);
    const ok = await confirm({
      title: SERVICES_UI.confirmAddTitle,
      description: `${SERVICES_UI.paymentNote} Suman ${formatMoney({ amountMinor: body.expectedTotalMinor, currency: catalog.currency })}; el total de la reserva pasa a ${formatMoney({ amountMinor: catalog.orderTotalMinor + body.expectedTotalMinor, currency: catalog.currency })}.`,
      confirmLabel: SERVICES_UI.addButton,
      destructive: false,
    });
    if (!ok) return;
    await run('add', 'add', body);
  }

  async function remove(line: ServiceLineView): Promise<void> {
    if (catalog === null || busyRef.current) return;
    const lines = removalSet(catalog, line.id);
    if (lines.length === 0) return;
    const body = removeServicesBody(catalog, lines);
    const names = lines
      .map(
        (l) =>
          `${l.name} (${passengerLabel(l.passengerIndex, order.passengers[l.passengerIndex])})`,
      )
      .join(', ');
    const ok = await confirm({
      title: SERVICES_UI.confirmRemoveTitle,
      description: `${lines.length > 1 ? 'Se agregaron juntos y se quitan juntos: ' : 'Se quita '}${names}. Se descuentan ${formatMoney({ amountMinor: body.expectedTotalMinor, currency: catalog.currency })} del total de la reserva.`,
      confirmLabel: SERVICES_UI.removeButton,
    });
    if (!ok) return;
    await run('remove', line.id, body);
  }

  const toggle = useCallback((key: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const canAdd = catalog !== null && catalog.blocked === null && selected.size > 0 && busy === null;

  return (
    <>
      <Sheet
        title={`${SERVICES_UI.title} · Reserva #${order.orderNumber}`}
        subtitle={SERVICES_UI.subtitle}
        icon={<Luggage />}
        busy={busy !== null}
        onClose={close}
        initialFocus="[data-services-close]"
        footer={
          <div className="space-y-3">
            {catalog !== null ? (
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <dt className="text-[var(--color-fg-muted)]">{SERVICES_UI.total}</dt>
                <dd className="text-right font-semibold tabular-nums text-[var(--color-fg)]">
                  {formatMoney({ amountMinor: total, currency: catalog.currency })}
                </dd>
                <dt className="text-[var(--color-fg-muted)]">{SERVICES_UI.newTotal}</dt>
                <dd className="text-right tabular-nums text-[var(--color-fg)]">
                  {formatMoney({
                    amountMinor: catalog.orderTotalMinor + total,
                    currency: catalog.currency,
                  })}
                </dd>
              </dl>
            ) : null}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                variant="secondary"
                data-services-close
                disabled={busy !== null}
                onClick={close}
              >
                Cerrar
              </Button>
              <Button
                variant="primary"
                className="gap-1.5"
                disabled={!canAdd}
                onClick={() => void add()}
              >
                <Luggage aria-hidden="true" />
                {busy === 'add' ? SERVICES_UI.adding : SERVICES_UI.addButton}
              </Button>
            </div>
          </div>
        }
      >
        <ServicesSheetBody
          phase={phase}
          passengers={order.passengers}
          selected={selected}
          busy={busy}
          notice={notice}
          onToggle={toggle}
          onRemove={(line) => void remove(line)}
        />
      </Sheet>
      {confirmElement}
    </>
  );
}

/** El cuerpo del panel, sin estado: lo que se ve con un catálogo y unas casillas marcadas. */
export function ServicesSheetBody({
  phase,
  passengers,
  selected,
  busy,
  notice,
  onToggle,
  onRemove,
}: {
  phase: ServicesSheetPhase;
  passengers: readonly ServicesSheetPassenger[];
  selected: ReadonlySet<string>;
  busy: string | null;
  notice: Notice | null;
  onToggle: (key: string, on: boolean) => void;
  onRemove: (line: ServiceLineView) => void;
}) {
  const catalog = phase.kind === 'ready' ? phase.catalog : null;
  const byPassenger = useMemo(
    () => (catalog === null ? [] : servicesByPassenger(catalog, passengers.length)),
    [catalog, passengers.length],
  );
  const locked = catalog?.blocked != null || busy !== null;

  return (
    <div
      className="space-y-4 pt-3 text-sm"
      aria-busy={phase.kind === 'loading' ? 'true' : undefined}
    >
      <div aria-live="polite" className="space-y-2">
        {notice !== null ? (
          <p
            role={notice.tone === 'error' ? 'alert' : 'status'}
            className={cn(
              'flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs text-[var(--color-fg)]',
              notice.tone === 'ok'
                ? 'border-[var(--color-success)]/40 bg-[var(--color-success)]/10'
                : notice.tone === 'warn'
                  ? 'border-[var(--color-warning)]/60 bg-[var(--color-warning)]/10'
                  : 'border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5',
            )}
          >
            {notice.tone === 'ok' ? (
              <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            ) : (
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            )}
            <span>{notice.message}</span>
          </p>
        ) : null}
      </div>

      {phase.kind === 'loading' ? (
        <p role="status" className="text-xs text-[var(--color-fg-subtle)]">
          {SERVICES_UI.loading}
        </p>
      ) : null}

      {phase.kind === 'failed' ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 px-3 py-2.5 text-xs text-[var(--color-fg)]"
        >
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{phase.message}</span>
        </p>
      ) : null}

      {catalog !== null ? (
        <>
          <p className="flex items-start gap-2 text-xs leading-relaxed text-[var(--color-fg-muted)]">
            <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>{SERVICES_UI.paymentNote}</span>
          </p>
          {catalog.testContent ? (
            <p className="flex items-start gap-2 rounded-lg border border-[var(--color-warning)]/60 bg-[var(--color-warning)]/10 px-3 py-2 text-xs text-[var(--color-fg)]">
              <FlaskConical aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span>{SERVICES_UI.testNote}</span>
            </p>
          ) : null}
          {catalog.blocked !== null ? (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-[var(--color-warning)]/60 bg-[var(--color-warning)]/10 px-3 py-2.5 text-xs text-[var(--color-fg)]"
            >
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span>{catalog.blocked}</span>
            </p>
          ) : null}
          {catalog.warnings.includes('ancillary-partial-unauthorized') ? (
            <p className="text-xs text-[var(--color-fg-muted)]">{SERVICES_UI.partialCatalog}</p>
          ) : null}
          {catalog.offers.length === 0 && catalog.added.length === 0 ? (
            <p className="text-xs text-[var(--color-fg-muted)]">{SERVICES_UI.empty}</p>
          ) : null}

          {byPassenger.map((group) => (
            <section
              key={group.passengerIndex}
              aria-labelledby={`pax-${group.passengerIndex}`}
              className="space-y-3 rounded-lg border border-[var(--color-border)] p-3"
            >
              <h3
                id={`pax-${group.passengerIndex}`}
                className="text-sm font-semibold text-[var(--color-fg)]"
              >
                {passengerLabel(group.passengerIndex, passengers[group.passengerIndex])}
              </h3>

              {group.added.length > 0 ? (
                <div className="space-y-1.5">
                  <h4 className="text-xs font-medium text-[var(--color-fg-muted)]">
                    {SERVICES_UI.added}
                  </h4>
                  <ul className="space-y-1.5">
                    {group.added.map((line) => (
                      <li
                        key={line.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-[var(--color-surface-muted)] px-3 py-2 text-xs"
                      >
                        <div className="min-w-0">
                          <p className="font-medium text-[var(--color-fg)] [overflow-wrap:anywhere]">
                            {line.name}
                          </p>
                          <p className="text-[var(--color-fg-muted)]">
                            {CATEGORY_LABELS[line.category] ?? line.category}
                            {line.segments.length > 0 ? ` · ${segmentsLabel(line.segments)}` : ''}
                            {' · '}
                            {LINE_STATUS_LABELS[line.status] ?? line.status}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="tabular-nums text-[var(--color-fg)]">
                            {formatMoney({
                              amountMinor: line.amountMinor,
                              currency: line.currency,
                            })}
                          </span>
                          {line.removable ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="gap-1 text-[var(--color-danger)]"
                              disabled={locked}
                              onClick={() => onRemove(line)}
                              aria-label={`${SERVICES_UI.removeButton} ${line.name}`}
                            >
                              <Trash2 aria-hidden="true" />
                              {busy === line.id ? SERVICES_UI.removing : SERVICES_UI.removeButton}
                            </Button>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {group.groups.length === 0 ? (
                <p className="text-xs text-[var(--color-fg-subtle)]">
                  {SERVICES_UI.noneForPassenger}
                </p>
              ) : (
                group.groups.map((segment) => (
                  <fieldset key={segment.label} className="space-y-1.5">
                    <legend className="text-xs font-medium text-[var(--color-fg-muted)]">
                      {SERVICES_UI.available}
                      {segment.label ? ` · ${segment.label}` : ''}
                    </legend>
                    {segment.offers.map(({ offer, amountMinor, included }) => {
                      const key = selectionKey(offer.serviceOfferItemId, group.passengerIndex);
                      const disabled = !offer.addable || locked;
                      const weight = offer.weights.map((w) => `${w.value} ${w.unit}`).join(' / ');
                      return (
                        <label
                          key={key}
                          className={cn(
                            'flex min-h-11 items-center gap-2.5 rounded-lg border px-3 py-2 text-xs transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--color-primary)]/40',
                            disabled
                              ? 'cursor-not-allowed border-[var(--color-border)] text-[var(--color-fg-subtle)]'
                              : selected.has(key)
                                ? 'cursor-pointer border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-fg)]'
                                : 'cursor-pointer border-[var(--color-border)] text-[var(--color-fg)] hover:border-[var(--color-border-strong)]',
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={selected.has(key)}
                            disabled={disabled}
                            onChange={(e) => onToggle(key, e.target.checked)}
                            className="size-4 shrink-0 accent-[var(--color-primary)]"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block font-medium [overflow-wrap:anywhere]">
                              {offer.name}
                            </span>
                            <span className="block text-[var(--color-fg-muted)]">
                              {CATEGORY_LABELS[offer.category] ?? offer.category}
                              {weight ? ` · ${weight}` : ''}
                              {offer.notAddableText ? ` · ${offer.notAddableText}` : ''}
                            </span>
                          </span>
                          <span className="shrink-0 tabular-nums">
                            {included
                              ? SERVICES_UI.included
                              : amountMinor === null
                                ? SERVICES_UI.notInformed
                                : formatMoney({ amountMinor, currency: catalog.currency })}
                          </span>
                        </label>
                      );
                    })}
                  </fieldset>
                ))
              )}
            </section>
          ))}
        </>
      ) : null}
    </div>
  );
}
