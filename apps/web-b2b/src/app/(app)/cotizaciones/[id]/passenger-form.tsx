'use client';

import { Plane, UserPlus, Wallet } from 'lucide-react';
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
  givenName: string;
  surname: string;
  birthdate: string;
  gender: 'M' | 'F';
  citizenshipCountryCode: string;
  identityDoc: {
    type: 'P' | 'DNI' | 'CC' | 'CE';
    number: string;
    issuingCountryCode: string;
    expiryDate: string;
  };
}

interface ContactInfo {
  email: string;
  phone: string;
}

type PaymentMode = 'bnpl' | 'pay_now';

interface PassengerFormProps {
  paxCount: PaxCount;
  totalAmountMinor: number;
  currency: string;
  defaultEmail?: string;
  defaultPhone?: string;
  onSubmit: (
    passengers: Passenger[],
    contactInfo: ContactInfo,
    payment?: PaymentData,
  ) => Promise<void>;
}

function buildEmptyPassengers(paxCount: PaxCount): Passenger[] {
  const pax: Passenger[] = [];
  for (let i = 1; i <= paxCount.adults; i++) {
    pax.push({
      paxId: `ADT_${i}`,
      paxType: 'ADT',
      givenName: '',
      surname: '',
      birthdate: '',
      gender: 'M',
      citizenshipCountryCode: 'CO',
      identityDoc: { type: 'CC', number: '', issuingCountryCode: 'CO', expiryDate: '' },
    });
  }
  for (let i = 1; i <= paxCount.children; i++) {
    pax.push({
      paxId: `CHD_${i}`,
      paxType: 'CHD',
      givenName: '',
      surname: '',
      birthdate: '',
      gender: 'M',
      citizenshipCountryCode: 'CO',
      identityDoc: { type: 'CC', number: '', issuingCountryCode: 'CO', expiryDate: '' },
    });
  }
  for (let i = 1; i <= paxCount.infants; i++) {
    pax.push({
      paxId: `INF_${i}`,
      paxType: 'INF',
      givenName: '',
      surname: '',
      birthdate: '',
      gender: 'M',
      citizenshipCountryCode: 'CO',
      identityDoc: { type: 'CC', number: '', issuingCountryCode: 'CO', expiryDate: '' },
    });
  }
  return pax;
}

const PAX_TYPE_LABELS: Record<string, string> = {
  ADT: 'Adulto',
  CHD: 'Niño',
  INF: 'Infante',
};

const DOC_TYPE_OPTIONS = [
  { value: 'CC', label: 'Cédula (CC)' },
  { value: 'CE', label: 'Cédula Extranjería (CE)' },
  { value: 'P', label: 'Pasaporte' },
  { value: 'DNI', label: 'DNI' },
];

const inputClass =
  'h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20';

const selectClass =
  'h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-fg)] focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20';

export function PassengerForm({
  paxCount,
  totalAmountMinor,
  currency,
  defaultEmail,
  defaultPhone,
  onSubmit,
}: PassengerFormProps) {
  const [passengers, setPassengers] = useState<Passenger[]>(() => buildEmptyPassengers(paxCount));
  const [contactInfo, setContactInfo] = useState<ContactInfo>({
    email: defaultEmail ?? '',
    phone: defaultPhone ?? '',
  });
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('bnpl');
  const [paymentData, setPaymentData] = useState<PaymentData | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updatePax(idx: number, patch: Partial<Passenger>) {
    setPassengers((prev) => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  }

  function updateDoc(idx: number, patch: Partial<Passenger['identityDoc']>) {
    setPassengers((prev) =>
      prev.map((p, i) => (i === idx ? { ...p, identityDoc: { ...p.identityDoc, ...patch } } : p)),
    );
  }

  function isValid(): boolean {
    if (!contactInfo.email || !contactInfo.phone) return false;
    const paxValid = passengers.every(
      (p) => p.givenName.trim() && p.surname.trim() && p.birthdate && p.identityDoc.number.trim(),
    );
    if (!paxValid) return false;
    if (paymentMode === 'pay_now' && !paymentData) return false;
    return true;
  }

  async function handleSubmit() {
    if (!isValid()) return;
    setSubmitting(true);
    setError(null);
    try {
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
        <div className="mb-4 flex items-center gap-2">
          <UserPlus className="size-4 text-[var(--color-primary)]" />
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">
            Datos de pasajeros para reservar
          </h2>
        </div>

        {/* Contact info */}
        <div className="mb-5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-4">
          <p className="mb-3 text-xs font-medium text-[var(--color-fg-muted)]">
            Contacto de la reserva
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="booking-email">Email</Label>
              <input
                id="booking-email"
                type="email"
                value={contactInfo.email}
                onChange={(e) => setContactInfo({ ...contactInfo, email: e.target.value })}
                placeholder="contacto@email.com"
                className={inputClass}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="booking-phone">Teléfono</Label>
              <input
                id="booking-phone"
                type="tel"
                value={contactInfo.phone}
                onChange={(e) => setContactInfo({ ...contactInfo, phone: e.target.value })}
                placeholder="+57 300 123 4567"
                className={inputClass}
              />
            </div>
          </div>
        </div>

        {/* Passengers */}
        <div className="space-y-4">
          {passengers.map((pax, idx) => (
            <div key={pax.paxId} className="rounded-lg border border-[var(--color-border)] p-4">
              <div className="mb-3 flex items-center gap-2">
                <Plane className="size-3.5 text-[var(--color-fg-subtle)]" />
                <span className="text-xs font-medium text-[var(--color-fg)]">
                  {PAX_TYPE_LABELS[pax.paxType]} {pax.paxId.split('_')[1]}
                </span>
                <span className="rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 text-[9px] font-medium text-[var(--color-fg-muted)]">
                  {pax.paxType}
                </span>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <div className="space-y-1">
                  <Label>Nombre(s)</Label>
                  <input
                    type="text"
                    value={pax.givenName}
                    onChange={(e) => updatePax(idx, { givenName: e.target.value })}
                    placeholder="OLIVER"
                    className={inputClass}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Apellido(s)</Label>
                  <input
                    type="text"
                    value={pax.surname}
                    onChange={(e) => updatePax(idx, { surname: e.target.value })}
                    placeholder="JACKSON"
                    className={inputClass}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Fecha de nacimiento</Label>
                  <input
                    type="date"
                    value={pax.birthdate}
                    onChange={(e) => updatePax(idx, { birthdate: e.target.value })}
                    className={inputClass}
                  />
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
                  <Label>Tipo de documento</Label>
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
                  <Label>Número de documento</Label>
                  <input
                    type="text"
                    value={pax.identityDoc.number}
                    onChange={(e) => updateDoc(idx, { number: e.target.value })}
                    placeholder="1234567890"
                    className={inputClass}
                  />
                </div>
                <div className="space-y-1">
                  <Label>País emisor</Label>
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
                <div className="space-y-1">
                  <Label>Vencimiento doc.</Label>
                  <input
                    type="date"
                    value={pax.identityDoc.expiryDate}
                    onChange={(e) => updateDoc(idx, { expiryDate: e.target.value })}
                    className={inputClass}
                  />
                </div>
              </div>
            </div>
          ))}
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

        {error && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
            {error}
          </div>
        )}

        <div className="mt-5 flex justify-end">
          <Button
            variant="primary"
            size="sm"
            disabled={!isValid() || submitting}
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
