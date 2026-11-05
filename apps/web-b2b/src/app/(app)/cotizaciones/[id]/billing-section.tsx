'use client';

import { CheckCircle2, Link2Off, Receipt } from 'lucide-react';
import { Button } from '../../../../components/ui/button';
import { Label } from '../../../../components/ui/label';
import { cn } from '../../../../lib/cn';
import {
  BILLING_DOC_TYPES,
  billingDraftFromCustomer,
  billingIdentity,
  passengerBillingLabel,
  type BillingDraft,
  type BillingField,
  type BillingPassenger,
} from '../../../../lib/billing';
import { documentTypeLabel } from '../../../../lib/customer-search';
import { CustomerSearchCombobox } from './customer-search-combobox';

const inputClass =
  'h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20';

const errClass = 'border-red-400 focus-visible:border-red-500 focus-visible:ring-red-500/20';

function Req() {
  return <span className="text-red-500"> *</span>;
}

function Opt() {
  return <span className="font-normal text-[var(--color-fg-subtle)]"> (opcional)</span>;
}

/** Una opción de radio con aspecto de tarjeta: área táctil grande y foco visible. */
function RadioCard({
  name,
  checked,
  onSelect,
  children,
}: {
  name: string;
  checked: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <label
      className={cn(
        'flex min-h-11 flex-1 cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--color-primary)]/30',
        checked
          ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-fg)]'
          : 'border-[var(--color-border)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]',
      )}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onSelect}
        className="size-4 accent-[var(--color-primary)]"
      />
      <span className="min-w-0 truncate">{children}</span>
    </label>
  );
}

export interface BillingSectionProps {
  readonly draft: BillingDraft;
  readonly onChange: (draft: BillingDraft) => void;
  readonly passenger1: BillingPassenger | undefined;
  /** Campos que faltan; sólo se marcan si `showErrors`. */
  readonly missing: readonly BillingField[];
  readonly showErrors: boolean;
  readonly notes: string;
  readonly onNotesChange: (notes: string) => void;
  readonly onSave: () => void;
  readonly saving: boolean;
  /** Texto tras guardar: «Guardado» o qué faltó para guardar la facturación. */
  readonly saveInfo: string | null;
  readonly saveError: string | null;
}

/**
 * «Facturación»: a nombre de quién sale la factura, debajo de los pasajeros. Por defecto, el
 * pasajero 1; si no, otra persona o una empresa, buscada en Clientes o escrita a mano.
 */
export function BillingSection({
  draft,
  onChange,
  passenger1,
  missing,
  showErrors,
  notes,
  onNotesChange,
  onSave,
  saving,
  saveInfo,
  saveError,
}: BillingSectionProps) {
  const set = (patch: Partial<BillingDraft>) => onChange({ ...draft, ...patch });
  const bad = (field: BillingField) => showErrors && missing.includes(field);
  const fromPassenger = draft.mode === 'passenger';
  const identity = billingIdentity(draft, passenger1);
  const company = draft.customerType === 'company';

  return (
    <section aria-labelledby="facturacion-titulo">
      <div className="mb-1 flex items-center gap-2">
        <Receipt aria-hidden="true" className="size-4 text-[var(--color-primary)]" />
        <h3 id="facturacion-titulo" className="text-sm font-semibold text-[var(--color-fg)]">
          Facturación
        </h3>
      </div>
      <p className="mb-4 text-xs text-[var(--color-fg-muted)]">
        A nombre de quién sale la factura. Su email y teléfono son el contacto de la reserva y a
        donde se envía la cotización.
      </p>

      <fieldset className="m-0 min-w-0 border-0 p-0">
        <legend className="mb-2 text-xs font-medium text-[var(--color-fg)]">Facturar a</legend>
        <div className="flex flex-col gap-2 sm:flex-row">
          <RadioCard
            name="billing-mode"
            checked={fromPassenger}
            onSelect={() => set({ mode: 'passenger' })}
          >
            {passengerBillingLabel(passenger1)}
          </RadioCard>
          <RadioCard
            name="billing-mode"
            checked={!fromPassenger}
            onSelect={() => set({ mode: 'other' })}
          >
            Otra persona o empresa
          </RadioCard>
        </div>
      </fieldset>

      {fromPassenger ? (
        <p className="mt-3 rounded-md bg-[var(--color-surface-muted)] px-3 py-2 text-xs text-[var(--color-fg-muted)]">
          {identity.name || identity.documentNumber ? (
            <>
              Nombre y documento del pasajero 1:{' '}
              <span className="font-medium text-[var(--color-fg)]">
                {identity.name || 'sin nombre'}
                {identity.documentNumber
                  ? ` · ${documentTypeLabel(identity.documentType)} ${identity.documentNumber}`
                  : ''}
              </span>
            </>
          ) : (
            'El nombre y el documento se toman del pasajero 1.'
          )}
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          <CustomerSearchCombobox
            id="billing"
            label="Buscar cliente registrado (persona o empresa)"
            onPick={(c) => onChange(billingDraftFromCustomer(draft, c))}
          />
          {draft.customerId ? (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--color-fg-muted)]">
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-800">
                <CheckCircle2 aria-hidden="true" className="size-3" /> Cliente registrado
              </span>
              <button
                type="button"
                onClick={() => set({ customerId: null })}
                className="inline-flex min-h-8 items-center gap-1 font-medium text-[var(--color-primary)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40"
              >
                <Link2Off aria-hidden="true" className="size-3" /> Desvincular
              </button>
            </p>
          ) : null}
          <fieldset className="m-0 min-w-0 border-0 p-0">
            <legend className="mb-2 text-xs font-medium text-[var(--color-fg)]">Tipo</legend>
            <div className="flex gap-2">
              <RadioCard
                name="billing-type"
                checked={!company}
                onSelect={() => set({ customerType: 'person', customerId: null })}
              >
                Persona
              </RadioCard>
              <RadioCard
                name="billing-type"
                checked={company}
                onSelect={() =>
                  set({
                    customerType: 'company',
                    customerId: null,
                    documentType: draft.documentType === 'CC' ? 'NIT' : draft.documentType,
                  })
                }
              >
                Empresa
              </RadioCard>
            </div>
          </fieldset>
        </div>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {!fromPassenger && (
          <>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="billing-name">
                {company ? 'Razón social' : 'Nombre completo'}
                <Req />
              </Label>
              <input
                id="billing-name"
                type="text"
                autoComplete={company ? 'organization' : 'name'}
                value={draft.name}
                onChange={(e) => set({ name: e.target.value })}
                placeholder={company ? 'Viajes Andinos S.A.S.' : 'Juan Pérez Gómez'}
                aria-invalid={bad('name') || undefined}
                className={cn(inputClass, bad('name') && errClass)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="billing-doc-type">
                Tipo de documento
                <Req />
              </Label>
              <select
                id="billing-doc-type"
                value={draft.documentType}
                onChange={(e) => set({ documentType: e.target.value, customerId: null })}
                className={inputClass}
              >
                {BILLING_DOC_TYPES.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
                {!BILLING_DOC_TYPES.some((opt) => opt.value === draft.documentType) && (
                  <option value={draft.documentType}>{draft.documentType}</option>
                )}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="billing-doc-number">
                Número de documento
                <Req />
              </Label>
              <input
                id="billing-doc-number"
                type="text"
                autoComplete="off"
                value={draft.documentNumber}
                onChange={(e) => set({ documentNumber: e.target.value, customerId: null })}
                placeholder={company ? '900123456-7' : '1234567890'}
                aria-invalid={bad('documentNumber') || undefined}
                className={cn(inputClass, bad('documentNumber') && errClass)}
              />
            </div>
          </>
        )}
        <div className="space-y-1">
          <Label htmlFor="billing-email">
            Email
            <Req />
          </Label>
          <input
            id="billing-email"
            type="email"
            autoComplete="email"
            value={draft.email}
            onChange={(e) => set({ email: e.target.value })}
            placeholder="juan@example.com"
            aria-invalid={bad('email') || undefined}
            className={cn(inputClass, bad('email') && errClass)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="billing-phone">
            Teléfono
            <Req />
          </Label>
          <input
            id="billing-phone"
            type="tel"
            autoComplete="tel"
            value={draft.phone}
            onChange={(e) => set({ phone: e.target.value })}
            placeholder="3001234567"
            aria-invalid={bad('phone') || undefined}
            className={cn(inputClass, bad('phone') && errClass)}
          />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="billing-address">
            Dirección
            <Opt />
          </Label>
          <input
            id="billing-address"
            type="text"
            autoComplete="street-address"
            value={draft.address}
            onChange={(e) => set({ address: e.target.value })}
            placeholder="Calle 100 # 15-20"
            className={inputClass}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="billing-city">
            Ciudad
            <Opt />
          </Label>
          <input
            id="billing-city"
            type="text"
            autoComplete="address-level2"
            value={draft.city}
            onChange={(e) => set({ city: e.target.value })}
            placeholder="Bogotá"
            className={inputClass}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="billing-country">
            País
            <Opt />
          </Label>
          <input
            id="billing-country"
            type="text"
            autoComplete="country"
            value={draft.countryCode}
            onChange={(e) => set({ countryCode: e.target.value.toUpperCase() })}
            placeholder={fromPassenger ? passenger1?.identityDoc.issuingCountryCode || 'CO' : 'CO'}
            maxLength={2}
            aria-invalid={bad('countryCode') || undefined}
            className={cn(inputClass, bad('countryCode') && errClass)}
          />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="notes">
            Notas de la cotización
            <Opt />
          </Label>
          <input
            id="notes"
            type="text"
            value={notes}
            onChange={(e) => onNotesChange(e.target.value)}
            placeholder="Preferencias, observaciones..."
            className={inputClass}
          />
        </div>
      </div>

      <div className="mt-4 flex flex-col-reverse items-stretch gap-2 sm:flex-row sm:items-center sm:justify-end sm:gap-3">
        <div role="status" aria-live="polite" className="text-xs">
          {saveError ? (
            <span className="font-medium text-red-700">{saveError}</span>
          ) : saveInfo ? (
            <span className="flex items-center gap-1 font-medium text-emerald-700">
              <CheckCircle2 aria-hidden="true" className="size-3.5 shrink-0" /> {saveInfo}
            </span>
          ) : null}
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={saving}
          onClick={onSave}
          className="h-10 sm:h-9"
        >
          {saving ? 'Guardando…' : 'Guardar facturación'}
        </Button>
      </div>
    </section>
  );
}
