'use client';

import { AlertCircle, Check, ClipboardCopy, Plane, UserPlus, Wallet } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../../components/ui/button';
import { Card, CardContent } from '../../../../components/ui/card';
import { Label } from '../../../../components/ui/label';
import { PaymentForm, type PaymentData } from './payment-form';
import { cn } from '../../../../lib/cn';
import { splitFullName } from '../../../../lib/full-name';
import {
  birthdateIssue,
  formatBirthdateInput,
  formatBirthdateValue,
  parseBirthdate,
} from '../../../../lib/birthdate';

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
    /** Opcional: una cédula no vence, y mandar `''` tumbaba la reserva entera. */
    expiryDate?: string;
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

/**
 * Fecha de nacimiento en UN campo que se teclea.
 *
 * Antes eran tres `<select>`. El motivo original era bueno —el date-picker nativo obliga a
 * recorrer décadas para llegar a 1978— y la solución arrastraba el mismo coste por otro lado:
 * cargar un pasajero eran tres aperturas de desplegable y tres búsquedas visuales en listas de
 * 31, 12 y 101 elementos. Con cuatro pasajeros, doce interacciones donde bastan ocho teclas.
 *
 * Acá se teclea `09071978` de corrido, sin soltar el teclado, y las barras las pone el campo.
 * La lógica vive en `lib/birthdate.ts` —parsear fechas escritas por humanos falla por los bordes
 * (`31/02`, `29/02/1900`, futuras) y eso se fija con tests, no mirando la pantalla—.
 */
function DobField({
  value,
  onChange,
  invalid,
}: {
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
}) {
  // El texto visible es estado propio: mientras se escribe hay estados que todavía no son una
  // fecha, y el valor de fuera sólo acepta fechas completas.
  const [texto, setTexto] = useState(() => formatBirthdateValue(value));
  const hoy = new Date().toISOString().slice(0, 10);
  const problema = birthdateIssue(texto, hoy);

  function handle(raw: string) {
    const formateado = formatBirthdateInput(raw);
    setTexto(formateado);
    // Emite '' mientras no sea usable: el formulario ya sabe tratar el vacío como «falta».
    onChange(parseBirthdate(formateado, hoy) ?? '');
  }

  return (
    <div className="space-y-1">
      <input
        type="text"
        inputMode="numeric"
        autoComplete="bday"
        placeholder="DD/MM/AAAA"
        aria-label="Fecha de nacimiento"
        aria-invalid={invalid === true || problema !== null ? true : undefined}
        value={texto}
        onChange={(e) => handle(e.target.value)}
        className={cn(inputClass, (invalid === true || problema !== null) && errClass)}
      />
      {problema !== null && <p className="text-[11px] text-red-600">{problema}</p>}
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
  const [copiedHint, setCopiedHint] = useState(false);

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

  /**
   * El pasajero 1 arranca con los datos del cliente, sin tener que pedirlo.
   *
   * Había un botón «Usar datos del cliente», y existir no era suficiente: es una pastilla de
   * 10 px que hay que descubrir, así que en la práctica el vendedor escribía el mismo nombre dos
   * veces —una en «Cliente y contacto» y otra en «Pasajero 1»— en la reserva de un solo pax, que
   * es la mayoría.
   *
   * Se copia UNA vez y sólo sobre un pasajero 1 en blanco: si ya hay algo escrito, es del
   * vendedor y no se pisa. Los campos siguen siendo editables —el reparto nombre/apellido es una
   * heurística, no un dogma— y el botón se queda para volver a copiar tras cambiar el cliente.
   */
  const autorellenado = useRef(false);
  useEffect(() => {
    if (autorellenado.current) return;
    const full = (customerName ?? '').trim();
    if (!full) return;
    const primero = passengers[0];
    if (primero === undefined || primero.givenName.trim() || primero.surname.trim()) return;

    autorellenado.current = true;
    setPassengers((prev) => prev.map((p, i) => (i === 0 ? { ...p, ...splitFullName(full) } : p)));
  }, [customerName, passengers]);

  /**
   * Copia el nombre del cliente al pasajero 1.
   *
   * El reparto nombre/apellido vive en `lib/full-name` y NO es «la última palabra»: en LATAM dos
   * apellidos es la norma, y esa regla partía «Juan Carlos Pérez Gómez» dejando «Pérez» dentro
   * del nombre de pila. Un nombre que no coincide con el documento puede costar el embarque.
   */
  function copyCustomerToPax(idx: number) {
    const full = (customerName ?? '').trim();
    if (!full) return;
    updatePax(idx, splitFullName(full));
    setCopiedHint(true);
    setTimeout(() => setCopiedHint(false), 1800);
  }

  /**
   * Quita del pasajero los opcionales que quedaron en blanco.
   *
   * El estado del formulario los arranca en `''` porque un `<input>` controlado no admite
   * `undefined`, y eso está bien DENTRO del formulario. Lo que no puede es salir: un `''` no
   * significa «vacío», significa «no lo rellené», y para el proveedor son cosas distintas. La
   * reserva con cédula fallaba entera con `expiryDate:invalid_string` — y la cédula no vence, así
   * que el campo no se rellenaba nunca.
   */
  function sinCamposEnBlanco(p: Passenger): Passenger {
    const { expiryDate, issueDate, ...doc } = p.identityDoc;
    return {
      ...p,
      identityDoc: {
        ...doc,
        ...(expiryDate?.trim() ? { expiryDate } : {}),
        ...(issueDate?.trim() ? { issueDate } : {}),
      },
    };
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
        passengers.map(sinCamposEnBlanco),
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
      <CardContent className="relative p-5">
        {submitting && <BookingOverlay payNow={paymentMode === 'pay_now'} />}
        <fieldset
          disabled={submitting}
          className={cn('m-0 min-w-0 border-0 p-0', submitting && 'opacity-60')}
        >
          <div className="mb-1 flex items-center gap-2">
            <UserPlus className="size-4 text-[var(--color-primary)]" />
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">
              Pasajeros de la reserva
            </h2>
          </div>
          <p className="mb-4 text-xs text-[var(--color-fg-muted)]">
            Datos de quienes viajan. El contacto de la reserva es el del cliente (arriba). Los
            campos con <span className="text-red-500">*</span> son obligatorios; el resto es
            opcional.
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
                        className={cn(
                          'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium transition-colors',
                          copiedHint
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                            : 'border-[var(--color-border)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]',
                        )}
                      >
                        {copiedHint ? (
                          <>
                            <Check className="size-3" />
                            Datos copiados
                          </>
                        ) : (
                          <>
                            <ClipboardCopy className="size-3" />
                            Usar datos del cliente
                          </>
                        )}
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
                      <DobField
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
                          value={pax.identityDoc.expiryDate ?? ''}
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
                          onChange={(e) =>
                            updateDoc(idx, { issueDate: e.target.value || undefined })
                          }
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
                <p className="mt-0.5 text-[10px] text-[var(--color-fg-muted)]">
                  Tarjeta de crédito
                </p>
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
        </fieldset>
      </CardContent>
    </Card>
  );
}

/** Overlay que bloquea el formulario mientras se crea la reserva (no editar a mitad del proceso). */
function BookingOverlay({ payNow }: { payNow: boolean }) {
  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 rounded-xl bg-[var(--color-surface)]/80 backdrop-blur-sm">
      <div className="relative flex size-14 items-center justify-center">
        <span className="absolute size-14 animate-ping rounded-full bg-[var(--color-primary)]/20" />
        <span className="absolute size-11 animate-spin rounded-full border-2 border-[var(--color-primary)]/30 border-t-[var(--color-primary)]" />
        <Plane className="size-5 text-[var(--color-primary)]" />
      </div>
      <p className="text-sm font-semibold text-[var(--color-fg)]">
        {payNow ? 'Procesando pago y reserva…' : 'Creando tu reserva…'}
      </p>
      <p className="text-xs text-[var(--color-fg-muted)]">
        Confirmando con la aerolínea. No cierres ni recargues esta ventana.
      </p>
    </div>
  );
}
