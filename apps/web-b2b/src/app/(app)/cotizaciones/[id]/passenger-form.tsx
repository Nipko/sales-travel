'use client';

import { AlertCircle, ClipboardCopy, Plane, UserPlus, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../../../components/ui/button';
import { Card, CardContent } from '../../../../components/ui/card';
import { Label } from '../../../../components/ui/label';
import { PaymentForm, type PaymentData } from './payment-form';
import { cn } from '../../../../lib/cn';

interface PaxCount {
  adults: number;
  children: number;
  infants: number;
}

interface Passenger {
  paxId: string;
  paxType: 'ADT' | 'CHD' | 'INF';
  title: 'Mr' | 'Mrs' | 'Miss' | 'Dr';
  givenName: string;
  surname: string;
  birthdate: string;
  gender: 'M' | 'F';
  citizenshipCountryCode: string;
  identityDoc: {
    type: 'P' | 'DNI' | 'CC' | 'CE';
    number: string;
    issuingCountryCode: string;
    issueDate?: string;
    expiryDate: string;
  };
}

interface ContactInfo {
  email: string;
  phone: string;
  countryDialingCode: string;
  areaCode: string;
}

type PaymentMode = 'bnpl' | 'pay_now';

interface PassengerFormProps {
  paxCount: PaxCount;
  totalAmountMinor: number;
  currency: string;
  /** Cliente/contacto único (vive en la página). Se usa como contacto de la reserva. */
  customerName?: string;
  contactEmail?: string;
  contactPhone?: string;
  onSubmit: (
    passengers: Passenger[],
    contactInfo: ContactInfo,
    payment?: PaymentData,
  ) => Promise<void>;
}

function buildEmptyPassengers(paxCount: PaxCount): Passenger[] {
  const make = (type: 'ADT' | 'CHD' | 'INF', i: number): Passenger => ({
    paxId: `${type}_${i}`,
    paxType: type,
    title: 'Mr',
    givenName: '',
    surname: '',
    birthdate: '',
    gender: 'M',
    citizenshipCountryCode: 'CO',
    identityDoc: { type: 'CC', number: '', issuingCountryCode: 'CO', expiryDate: '' },
  });
  const pax: Passenger[] = [];
  for (let i = 1; i <= paxCount.adults; i++) pax.push(make('ADT', i));
  for (let i = 1; i <= paxCount.children; i++) pax.push(make('CHD', i));
  for (let i = 1; i <= paxCount.infants; i++) pax.push(make('INF', i));
  return pax;
}

const PAX_TYPE_LABELS: Record<string, string> = {
  ADT: 'Adulto',
  CHD: 'Niño',
  INF: 'Infante',
};

const TITLE_OPTIONS = [
  { value: 'Mr', label: 'Sr (Mr)' },
  { value: 'Mrs', label: 'Sra (Mrs)' },
  { value: 'Miss', label: 'Srta (Miss)' },
  { value: 'Dr', label: 'Dr' },
];

const DOC_TYPE_OPTIONS = [
  { value: 'CC', label: 'Cédula (CC)' },
  { value: 'CE', label: 'Cédula Extranjería (CE)' },
  { value: 'P', label: 'Pasaporte' },
  { value: 'DNI', label: 'DNI' },
];

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const inputClass =
  'h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20';

const selectClass =
  'h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-fg)] focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20';

const MONTH_OPTIONS = [
  { v: '01', l: 'Ene' },
  { v: '02', l: 'Feb' },
  { v: '03', l: 'Mar' },
  { v: '04', l: 'Abr' },
  { v: '05', l: 'May' },
  { v: '06', l: 'Jun' },
  { v: '07', l: 'Jul' },
  { v: '08', l: 'Ago' },
  { v: '09', l: 'Sep' },
  { v: '10', l: 'Oct' },
  { v: '11', l: 'Nov' },
  { v: '12', l: 'Dic' },
];

/**
 * Selector de fecha de nacimiento con día/mes/año en selects: elegir el año es instantáneo
 * (no hay que recorrer décadas como en el date-picker nativo). Emite 'YYYY-MM-DD'.
 */
function DobPicker({
  value,
  onChange,
  invalid,
}: {
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
}) {
  const init = value ? value.split('-') : [];
  const [y, setY] = useState(init[0] ?? '');
  const [m, setM] = useState(init[1] ?? '');
  const [d, setD] = useState(init[2] ?? '');
  const currentYear = new Date().getFullYear();
  const years: string[] = [];
  for (let yr = currentYear; yr >= currentYear - 100; yr--) years.push(String(yr));
  const days: string[] = [];
  for (let dd = 1; dd <= 31; dd++) days.push(String(dd).padStart(2, '0'));

  // Mantiene las selecciones parciales en estado y sólo emite la fecha cuando están los 3 campos.
  function commit(nd: string, nm: string, ny: string) {
    onChange(nd && nm && ny ? `${ny}-${nm}-${nd}` : '');
  }
  const cls = cn(selectClass, invalid && errClass);

  return (
    <div className="grid grid-cols-3 gap-2">
      <select
        aria-label="Día"
        value={d}
        onChange={(e) => {
          setD(e.target.value);
          commit(e.target.value, m, y);
        }}
        className={cls}
      >
        <option value="">Día</option>
        {days.map((dd) => (
          <option key={dd} value={dd}>
            {Number(dd)}
          </option>
        ))}
      </select>
      <select
        aria-label="Mes"
        value={m}
        onChange={(e) => {
          setM(e.target.value);
          commit(d, e.target.value, y);
        }}
        className={cls}
      >
        <option value="">Mes</option>
        {MONTH_OPTIONS.map((mo) => (
          <option key={mo.v} value={mo.v}>
            {mo.l}
          </option>
        ))}
      </select>
      <select
        aria-label="Año"
        value={y}
        onChange={(e) => {
          setY(e.target.value);
          commit(d, m, e.target.value);
        }}
        className={cls}
      >
        <option value="">Año</option>
        {years.map((yr) => (
          <option key={yr} value={yr}>
            {yr}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Borde rojo para campos obligatorios sin completar (sólo tras intentar reservar). */
const errClass = 'border-red-400 focus-visible:border-red-500 focus-visible:ring-red-500/20';

/** Marca de campo obligatorio. */
function Req() {
  return <span className="text-red-500"> *</span>;
}

/** Etiqueta "(opcional)" sutil. */
function Opt() {
  return <span className="font-normal text-[var(--color-fg-subtle)]"> (opcional)</span>;
}

function passengerLabel(pax: Passenger): string {
  return `${PAX_TYPE_LABELS[pax.paxType] ?? pax.paxType} ${pax.paxId.split('_')[1] ?? ''}`.trim();
}

export function PassengerForm({
  paxCount,
  totalAmountMinor,
  currency,
  customerName,
  contactEmail,
  contactPhone,
  onSubmit,
}: PassengerFormProps) {
  const [passengers, setPassengers] = useState<Passenger[]>(() => buildEmptyPassengers(paxCount));
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('bnpl');
  const [paymentData, setPaymentData] = useState<PaymentData | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // `attempted` activa el marcado de errores recién cuando el usuario intenta reservar.
  const [attempted, setAttempted] = useState(false);

  const email = (contactEmail ?? '').trim();
  const phone = (contactPhone ?? '').trim();

  function updatePax(idx: number, patch: Partial<Passenger>) {
    setPassengers((prev) => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  }

  function updateDoc(idx: number, patch: Partial<Passenger['identityDoc']>) {
    setPassengers((prev) =>
      prev.map((p, i) => (i === idx ? { ...p, identityDoc: { ...p.identityDoc, ...patch } } : p)),
    );
  }

  /** Copia el nombre del cliente al pasajero 1 (separa nombre/apellido por el último espacio). */
  function copyCustomerToPax(idx: number) {
    const full = (customerName ?? '').trim();
    if (!full) return;
    const parts = full.split(/\s+/);
    const surname = parts.length > 1 ? parts[parts.length - 1]! : '';
    const givenName = parts.length > 1 ? parts.slice(0, -1).join(' ') : full;
    updatePax(idx, { givenName, surname });
  }

  // ---- Validación: campos realmente obligatorios para emitir la reserva ----
  function paxIssues(p: Passenger): string[] {
    const out: string[] = [];
    if (!p.givenName.trim()) out.push('nombre');
    if (!p.surname.trim()) out.push('apellido');
    if (!p.birthdate) out.push('fecha de nacimiento');
    if (!p.identityDoc.number.trim()) out.push('número de documento');
    if (p.identityDoc.type === 'P' && !p.identityDoc.expiryDate)
      out.push('vencimiento del pasaporte');
    return out;
  }

  function validationMessages(): string[] {
    const m: string[] = [];
    if (!email || !EMAIL_RE.test(email)) {
      m.push('Email de contacto válido (en "Cliente y contacto").');
    }
    if (!phone) m.push('Teléfono de contacto (en "Cliente y contacto").');
    for (const p of passengers) {
      const issues = paxIssues(p);
      if (issues.length) m.push(`${passengerLabel(p)}: completá ${issues.join(', ')}.`);
    }
    if (paymentMode === 'pay_now' && !paymentData) m.push('Completá los datos de pago.');
    return m;
  }

  const problems = validationMessages();
  const canSubmit = problems.length === 0;

  async function handleSubmit() {
    setAttempted(true);
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const contactInfo: ContactInfo = {
        email,
        phone,
        countryDialingCode: '57',
        areaCode: '1',
      };
      await onSubmit(
        passengers,
        contactInfo,
        paymentMode === 'pay_now' ? (paymentData ?? undefined) : undefined,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al crear la reserva');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardContent className="p-5">
        <div className="mb-1 flex items-center gap-2">
          <UserPlus className="size-4 text-[var(--color-primary)]" />
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">Pasajeros de la reserva</h2>
        </div>
        <p className="mb-4 text-xs text-[var(--color-fg-muted)]">
          Datos de quienes viajan. El contacto de la reserva es el del cliente (arriba). Los campos
          con <span className="text-red-500">*</span> son obligatorios; el resto es opcional.
        </p>

        {/* Passengers */}
        <div className="space-y-4">
          {passengers.map((pax, idx) => {
            const issues = attempted ? paxIssues(pax) : [];
            const bad = (field: string) => issues.includes(field);
            return (
              <div key={pax.paxId} className="rounded-lg border border-[var(--color-border)] p-4">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Plane className="size-3.5 text-[var(--color-fg-subtle)]" />
                    <span className="text-xs font-medium text-[var(--color-fg)]">
                      {passengerLabel(pax)}
                    </span>
                    <span className="rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 text-[9px] font-medium text-[var(--color-fg-muted)]">
                      {pax.paxType}
                    </span>
                  </div>
                  {idx === 0 && (customerName ?? '').trim() && (
                    <button
                      type="button"
                      onClick={() => copyCustomerToPax(idx)}
                      className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2 py-1 text-[10px] font-medium text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]"
                    >
                      <ClipboardCopy className="size-3" />
                      Usar datos del cliente
                    </button>
                  )}
                </div>

                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <div className="space-y-1">
                    <Label>
                      Nombre(s)
                      <Req />
                    </Label>
                    <input
                      type="text"
                      value={pax.givenName}
                      onChange={(e) => updatePax(idx, { givenName: e.target.value })}
                      placeholder="OLIVER"
                      className={cn(inputClass, bad('nombre') && errClass)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>
                      Apellido(s)
                      <Req />
                    </Label>
                    <input
                      type="text"
                      value={pax.surname}
                      onChange={(e) => updatePax(idx, { surname: e.target.value })}
                      placeholder="JACKSON"
                      className={cn(inputClass, bad('apellido') && errClass)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>
                      Fecha de nacimiento
                      <Req />
                    </Label>
                    <DobPicker
                      value={pax.birthdate}
                      onChange={(v) => updatePax(idx, { birthdate: v })}
                      invalid={bad('fecha de nacimiento')}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>
                      Tipo de documento
                      <Req />
                    </Label>
                    <select
                      value={pax.identityDoc.type}
                      onChange={(e) =>
                        updateDoc(idx, { type: e.target.value as 'P' | 'DNI' | 'CC' | 'CE' })
                      }
                      className={selectClass}
                    >
                      {DOC_TYPE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <Label>
                      Número de documento
                      <Req />
                    </Label>
                    <input
                      type="text"
                      value={pax.identityDoc.number}
                      onChange={(e) => updateDoc(idx, { number: e.target.value })}
                      placeholder="1234567890"
                      className={cn(inputClass, bad('número de documento') && errClass)}
                    />
                  </div>
                  {pax.identityDoc.type === 'P' && (
                    <div className="space-y-1">
                      <Label>
                        Vencimiento pasaporte
                        <Req />
                      </Label>
                      <input
                        type="date"
                        value={pax.identityDoc.expiryDate}
                        onChange={(e) => updateDoc(idx, { expiryDate: e.target.value })}
                        className={cn(inputClass, bad('vencimiento del pasaporte') && errClass)}
                      />
                    </div>
                  )}
                  <div className="space-y-1">
                    <Label>
                      Tratamiento
                      <Opt />
                    </Label>
                    <select
                      value={pax.title}
                      onChange={(e) =>
                        updatePax(idx, { title: e.target.value as 'Mr' | 'Mrs' | 'Miss' | 'Dr' })
                      }
                      className={selectClass}
                    >
                      {TITLE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <Label>Género</Label>
                    <select
                      value={pax.gender}
                      onChange={(e) => updatePax(idx, { gender: e.target.value as 'M' | 'F' })}
                      className={selectClass}
                    >
                      <option value="M">Masculino</option>
                      <option value="F">Femenino</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <Label>Nacionalidad</Label>
                    <input
                      type="text"
                      value={pax.citizenshipCountryCode}
                      onChange={(e) =>
                        updatePax(idx, { citizenshipCountryCode: e.target.value.toUpperCase() })
                      }
                      placeholder="CO"
                      maxLength={2}
                      className={inputClass}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>País emisor doc.</Label>
                    <input
                      type="text"
                      value={pax.identityDoc.issuingCountryCode}
                      onChange={(e) =>
                        updateDoc(idx, { issuingCountryCode: e.target.value.toUpperCase() })
                      }
                      placeholder="CO"
                      maxLength={2}
                      className={inputClass}
                    />
                  </div>
                  {pax.identityDoc.type === 'P' && (
                    <div className="space-y-1">
                      <Label>
                        Emisión pasaporte
                        <Opt />
                      </Label>
                      <input
                        type="date"
                        value={pax.identityDoc.issueDate ?? ''}
                        onChange={(e) => updateDoc(idx, { issueDate: e.target.value || undefined })}
                        className={inputClass}
                      />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Payment mode selector */}
        <div className="mt-6 border-t border-[var(--color-border)] pt-5">
          <div className="mb-4 flex items-center gap-2">
            <Wallet className="size-4 text-[var(--color-primary)]" />
            <h3 className="text-sm font-semibold text-[var(--color-fg)]">Método de pago</h3>
          </div>

          <div className="mb-4 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => {
                setPaymentMode('bnpl');
                setPaymentData(null);
              }}
              className={cn(
                'rounded-lg border px-4 py-3 text-left transition-all',
                paymentMode === 'bnpl'
                  ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 ring-2 ring-[var(--color-primary)]/20'
                  : 'border-[var(--color-border)] hover:border-[var(--color-border-strong)]',
              )}
            >
              <p className="text-xs font-medium text-[var(--color-fg)]">Reservar sin pago</p>
              <p className="mt-0.5 text-[10px] text-[var(--color-fg-muted)]">
                Genera PNR, pagar después
              </p>
            </button>
            <button
              type="button"
              onClick={() => setPaymentMode('pay_now')}
              className={cn(
                'rounded-lg border px-4 py-3 text-left transition-all',
                paymentMode === 'pay_now'
                  ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 ring-2 ring-[var(--color-primary)]/20'
                  : 'border-[var(--color-border)] hover:border-[var(--color-border-strong)]',
              )}
            >
              <p className="text-xs font-medium text-[var(--color-fg)]">Pagar ahora</p>
              <p className="mt-0.5 text-[10px] text-[var(--color-fg-muted)]">Tarjeta de crédito</p>
            </button>
          </div>

          {paymentMode === 'pay_now' && (
            <PaymentForm
              totalAmountMinor={totalAmountMinor}
              currency={currency}
              onPaymentChange={setPaymentData}
            />
          )}
        </div>

        {/* Resumen de validación: qué falta, en claro */}
        {attempted && problems.length > 0 && (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900">
            <div className="mb-1 flex items-center gap-1.5 font-medium">
              <AlertCircle className="size-3.5" />
              Faltan datos para crear la reserva
            </div>
            <ul className="ml-5 list-disc space-y-0.5">
              {problems.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
            {error}
          </div>
        )}

        <div className="mt-5 flex justify-end">
          <Button
            variant="primary"
            size="sm"
            disabled={submitting}
            onClick={() => void handleSubmit()}
            className="gap-2"
          >
            <Plane className="size-4" />
            {submitting
              ? 'Creando reserva…'
              : paymentMode === 'pay_now'
                ? 'Pagar y crear reserva'
                : 'Crear reserva (BNPL)'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
