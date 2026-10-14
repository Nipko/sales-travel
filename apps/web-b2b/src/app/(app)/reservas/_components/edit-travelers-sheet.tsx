'use client';

import { AlertTriangle, CheckCircle2, FlaskConical, IdCard, Info } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../../../components/ui/button';
import { Checkbox, Field, Select, TextInput } from '../../../../components/ui/field';
import { Sheet } from '../../../../components/ui/form-sheet';
import { cn } from '../../../../lib/cn';
import { readJson } from '../../../../lib/read-json';
import {
  DOCUMENT_TYPE_LABELS,
  SPECIAL_SERVICES,
  TRAVELERS_UI,
  buildModifyBody,
  documentLine,
  errorKey,
  initialForm,
  parseTravelersView,
  travelerLabel,
  travelersChangeReplyOf,
  type FormErrors,
  type SpecialServiceCode,
  type TravelerDocumentType,
  type TravelerForm,
  type TravelerView,
  type TravelersView,
} from '../travelers-view';

/*
 * «Datos de pasajeros» de una reserva confirmada o emitida (SAB-25): por pasajero, el documento de
 * viaje, el viajero frecuente y los servicios especiales, como los tiene la aerolínea ahora —los
 * números enmascarados—, y un formulario que guarda en bloque con «Guardar cambios».
 *
 * Un solo pedido por vez y se espera el desenlace: el API lo cambia en la reserva, lo verifica y
 * dice en qué quedó. Después se relee la reserva, que es la fuente.
 */

export interface TravelersSheetOrder {
  readonly id: string;
  readonly orderNumber: number;
}

export type TravelersSheetPhase =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'ready'; readonly view: TravelersView };

export interface TravelersNotice {
  readonly tone: 'ok' | 'warn' | 'error';
  readonly message: string;
}

async function loadView(orderId: string): Promise<TravelersSheetPhase> {
  try {
    const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/travelers`);
    const read = await readJson<unknown>(res);
    if (!read.ok) return { kind: 'failed', message: read.message };
    if (!res.ok) {
      const body = (read.data as { error?: unknown; message?: unknown } | null) ?? null;
      const message =
        typeof body?.message === 'string'
          ? body.message
          : typeof body?.error === 'string'
            ? body.error
            : TRAVELERS_UI.loadFailed;
      return { kind: 'failed', message };
    }
    const view = parseTravelersView(read.data);
    return view === null
      ? { kind: 'failed', message: TRAVELERS_UI.loadFailed }
      : { kind: 'ready', view };
  } catch {
    return { kind: 'failed', message: TRAVELERS_UI.loadFailed };
  }
}

async function send(orderId: string, body: unknown): Promise<TravelersNotice> {
  try {
    const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/travelers`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const read = await readJson<unknown>(res);
    if (!read.ok) return { tone: 'error', message: read.message };
    const reply = travelersChangeReplyOf(res.status, read.data);
    if (!reply.ok) return { tone: 'error', message: reply.message };
    return { tone: reply.done ? 'ok' : 'warn', message: reply.message };
  } catch {
    return { tone: 'error', message: TRAVELERS_UI.sendFailed };
  }
}

function formsOf(view: TravelersView): Record<number, TravelerForm> {
  const forms: Record<number, TravelerForm> = {};
  for (const traveler of view.travelers) forms[traveler.index] = initialForm(traveler);
  return forms;
}

export function EditTravelersSheet({
  order,
  onClose,
  onChanged,
}: {
  order: TravelersSheetOrder;
  onClose: () => void;
  /** La reserva cambió (el documento de la orden): la lista se relee. */
  onChanged: () => void;
}) {
  const [phase, setPhase] = useState<TravelersSheetPhase>({ kind: 'loading' });
  const [forms, setForms] = useState<Record<number, TravelerForm>>({});
  const [errors, setErrors] = useState<FormErrors>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<TravelersNotice | null>(null);
  const busyRef = useRef(false);

  const apply = useCallback((next: TravelersSheetPhase) => {
    setPhase(next);
    if (next.kind === 'ready') setForms(formsOf(next.view));
    setErrors({});
  }, []);

  useEffect(() => {
    let alive = true;
    void loadView(order.id).then((next) => {
      if (alive) apply(next);
    });
    return () => {
      alive = false;
    };
  }, [order.id, apply]);

  // Con un pedido en vuelo no se cierra: el vendedor no sabría si quedó.
  const close = useCallback(() => {
    if (!busyRef.current) onClose();
  }, [onClose]);

  const update = useCallback((index: number, patch: Partial<TravelerForm>) => {
    setForms((prev) => {
      const current = prev[index];
      return current === undefined ? prev : { ...prev, [index]: { ...current, ...patch } };
    });
  }, []);

  const view = phase.kind === 'ready' ? phase.view : null;

  async function save(): Promise<void> {
    if (view === null || busyRef.current) return;
    const built = buildModifyBody(view, forms);
    setErrors(built.errors);
    if (Object.keys(built.errors).length > 0) {
      setNotice({ tone: 'error', message: TRAVELERS_UI.fixErrors });
      return;
    }
    if (built.body === null) {
      setNotice({ tone: 'warn', message: TRAVELERS_UI.noChanges });
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    const result = await send(order.id, built.body);
    busyRef.current = false;
    setBusy(false);
    setNotice(result);
    // Aun rechazado, se relee: la reserva dice cómo quedó.
    apply(await loadView(order.id));
    onChanged();
  }

  const canSave = view !== null && view.blocked === null && !busy;

  return (
    <Sheet
      title={`${TRAVELERS_UI.title} · Reserva #${order.orderNumber}`}
      subtitle={TRAVELERS_UI.subtitle}
      icon={<IdCard />}
      busy={busy}
      onClose={close}
      initialFocus="[data-travelers-close]"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" data-travelers-close disabled={busy} onClick={close}>
            {TRAVELERS_UI.close}
          </Button>
          <Button variant="primary" disabled={!canSave} onClick={() => void save()}>
            {busy ? TRAVELERS_UI.saving : TRAVELERS_UI.save}
          </Button>
        </div>
      }
    >
      <TravelersSheetBody
        phase={phase}
        forms={forms}
        errors={errors}
        busy={busy}
        notice={notice}
        onChange={update}
      />
    </Sheet>
  );
}

/** El cuerpo del panel, sin estado: lo que se ve con una reserva leída y un formulario. */
export function TravelersSheetBody({
  phase,
  forms,
  errors,
  busy,
  notice,
  onChange,
}: {
  phase: TravelersSheetPhase;
  forms: Readonly<Record<number, TravelerForm>>;
  errors: FormErrors;
  busy: boolean;
  notice: TravelersNotice | null;
  onChange: (index: number, patch: Partial<TravelerForm>) => void;
}) {
  const view = phase.kind === 'ready' ? phase.view : null;
  const locked = busy || view?.blocked != null;

  return (
    <div
      className="space-y-4 pt-3 text-sm"
      aria-busy={phase.kind === 'loading' ? 'true' : undefined}
    >
      <div aria-live="polite">
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
          {TRAVELERS_UI.loading}
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

      {view !== null ? (
        <>
          {view.testContent ? (
            <p className="flex items-start gap-2 rounded-lg border border-[var(--color-warning)]/60 bg-[var(--color-warning)]/10 px-3 py-2 text-xs text-[var(--color-fg)]">
              <FlaskConical aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span>{TRAVELERS_UI.testNote}</span>
            </p>
          ) : null}
          {view.blocked !== null ? (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-[var(--color-warning)]/60 bg-[var(--color-warning)]/10 px-3 py-2.5 text-xs text-[var(--color-fg)]"
            >
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span>{view.blocked}</span>
            </p>
          ) : null}
          {view.travelers.map((traveler) => {
            const form = forms[traveler.index];
            return form === undefined ? null : (
              <TravelerSection
                key={traveler.index}
                traveler={traveler}
                form={form}
                supported={view.supported}
                errors={errors}
                locked={locked}
                onChange={(patch) => onChange(traveler.index, patch)}
              />
            );
          })}
        </>
      ) : null}
    </div>
  );
}

function TravelerSection({
  traveler,
  form,
  supported,
  errors,
  locked,
  onChange,
}: {
  traveler: TravelerView;
  form: TravelerForm;
  supported: TravelersView['supported'];
  errors: FormErrors;
  locked: boolean;
  onChange: (patch: Partial<TravelerForm>) => void;
}) {
  const i = traveler.index;
  const infant = traveler.paxType === 'INF';
  const headingId = `traveler-${String(i)}`;
  const error = (field: keyof TravelerForm) => errors[errorKey(i, field)];

  return (
    <section
      aria-labelledby={headingId}
      className="space-y-4 rounded-lg border border-[var(--color-border)] p-3"
    >
      <h3 id={headingId} className="text-sm font-semibold text-[var(--color-fg)]">
        {travelerLabel(traveler)}
      </h3>

      {supported.includes('identityDocuments') ? (
        <fieldset className="space-y-3" disabled={locked}>
          <legend className="text-xs font-medium text-[var(--color-fg-muted)]">
            {TRAVELERS_UI.documentLegend}
          </legend>
          <p className="text-xs text-[var(--color-fg-muted)]">
            {traveler.documents.length > 0
              ? `${TRAVELERS_UI.documentCurrent}: ${traveler.documents.map(documentLine).join(' / ')}`
              : TRAVELERS_UI.documentNone}
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={TRAVELERS_UI.documentType}>
              {(props) => (
                <Select
                  {...props}
                  value={form.documentType}
                  onChange={(e) =>
                    onChange({ documentType: e.target.value as TravelerDocumentType })
                  }
                >
                  {(Object.keys(DOCUMENT_TYPE_LABELS) as TravelerDocumentType[]).map((type) => (
                    <option key={type} value={type}>
                      {DOCUMENT_TYPE_LABELS[type]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              label={TRAVELERS_UI.documentNumber}
              hint={TRAVELERS_UI.documentHint}
              error={error('documentNumber')}
            >
              {(props) => (
                <TextInput
                  {...props}
                  value={form.documentNumber}
                  onChange={(e) => onChange({ documentNumber: e.target.value })}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  maxLength={30}
                />
              )}
            </Field>
            <Field
              label={TRAVELERS_UI.issuingCountry}
              hint={TRAVELERS_UI.countryHint}
              error={error('issuingCountry')}
            >
              {(props) => (
                <TextInput
                  {...props}
                  value={form.issuingCountry}
                  onChange={(e) => onChange({ issuingCountry: e.target.value.toUpperCase() })}
                  autoComplete="off"
                  autoCapitalize="characters"
                  maxLength={2}
                />
              )}
            </Field>
            <Field
              label={TRAVELERS_UI.nationality}
              hint={TRAVELERS_UI.countryHint}
              error={error('nationality')}
            >
              {(props) => (
                <TextInput
                  {...props}
                  value={form.nationality}
                  onChange={(e) => onChange({ nationality: e.target.value.toUpperCase() })}
                  autoComplete="off"
                  autoCapitalize="characters"
                  maxLength={2}
                />
              )}
            </Field>
            <Field label={TRAVELERS_UI.expiryDate} error={error('expiryDate')}>
              {(props) => (
                <TextInput
                  {...props}
                  type="date"
                  value={form.expiryDate}
                  onChange={(e) => onChange({ expiryDate: e.target.value })}
                />
              )}
            </Field>
          </div>
        </fieldset>
      ) : null}

      {infant ? (
        <p className="flex items-start gap-2 text-xs text-[var(--color-fg-muted)]">
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{TRAVELERS_UI.infantNote}</span>
        </p>
      ) : (
        <>
          {supported.includes('loyalty') ? (
            <fieldset className="space-y-3" disabled={locked}>
              <legend className="text-xs font-medium text-[var(--color-fg-muted)]">
                {TRAVELERS_UI.loyaltyLegend}
              </legend>
              <p className="text-xs text-[var(--color-fg-muted)]">
                {traveler.loyalty.length > 0
                  ? traveler.loyalty.map((l) => `${l.carrierCode} ••••${l.numberLast4}`).join(' / ')
                  : TRAVELERS_UI.loyaltyNone}
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[8rem_1fr]">
                <Field
                  label={TRAVELERS_UI.loyaltyCarrier}
                  hint={TRAVELERS_UI.loyaltyCarrierHint}
                  error={error('loyaltyCarrier')}
                >
                  {(props) => (
                    <TextInput
                      {...props}
                      value={form.loyaltyCarrier}
                      onChange={(e) => onChange({ loyaltyCarrier: e.target.value.toUpperCase() })}
                      autoComplete="off"
                      autoCapitalize="characters"
                      maxLength={2}
                    />
                  )}
                </Field>
                <Field label={TRAVELERS_UI.loyaltyNumber} error={error('loyaltyNumber')}>
                  {(props) => (
                    <TextInput
                      {...props}
                      value={form.loyaltyNumber}
                      onChange={(e) => onChange({ loyaltyNumber: e.target.value })}
                      autoComplete="off"
                      autoCapitalize="characters"
                      spellCheck={false}
                      maxLength={30}
                    />
                  )}
                </Field>
              </div>
            </fieldset>
          ) : null}

          {supported.includes('specialServices') ? (
            <fieldset className="space-y-2" disabled={locked}>
              <legend className="text-xs font-medium text-[var(--color-fg-muted)]">
                {TRAVELERS_UI.specialLegend}
              </legend>
              <p className="text-xs text-[var(--color-fg-subtle)]">{TRAVELERS_UI.specialHint}</p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {SPECIAL_SERVICES.map((service) => {
                  const checked = form.specialServices.includes(service.code);
                  return (
                    <label
                      key={service.code}
                      className={cn(
                        'flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-xs transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--color-primary)]/40',
                        checked
                          ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-fg)]'
                          : 'border-[var(--color-border)] text-[var(--color-fg)] hover:border-[var(--color-border-strong)]',
                      )}
                    >
                      <Checkbox
                        checked={checked}
                        onChange={(e) =>
                          onChange({
                            specialServices: toggled(
                              form.specialServices,
                              service.code,
                              e.target.checked,
                            ),
                          })
                        }
                      />
                      <span>{service.label}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ) : (
            <p className="text-xs text-[var(--color-fg-muted)]">
              {TRAVELERS_UI.specialNotSupported}
            </p>
          )}
        </>
      )}
    </section>
  );
}

function toggled(
  current: readonly SpecialServiceCode[],
  code: SpecialServiceCode,
  on: boolean,
): SpecialServiceCode[] {
  const next = current.filter((c) => c !== code);
  return on ? [...next, code] : next;
}
