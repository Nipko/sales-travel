'use client';

import { CreditCard, Shield } from 'lucide-react';
import { useState } from 'react';
import { Card, CardContent } from '../../../../components/ui/card';
import { Label } from '../../../../components/ui/label';

export type CardBrandCode = 'VI' | 'AX' | 'CA' | 'DC' | 'TN' | 'HC' | 'EL' | 'TP';

export interface PaymentData {
  type: 'Credit Card';
  card: {
    brandCode: CardBrandCode;
    holderName: string;
    number: string;
    expirationDate: string;
    securityCode: string;
  };
  amount: number;
  currency: string;
}

interface PaymentFormProps {
  totalAmountMinor: number;
  currency: string;
  onPaymentChange: (payment: PaymentData | null) => void;
}

const BRAND_OPTIONS: { value: CardBrandCode; label: string }[] = [
  { value: 'VI', label: 'Visa' },
  { value: 'CA', label: 'Mastercard' },
  { value: 'AX', label: 'American Express' },
  { value: 'DC', label: 'Diners Club' },
  { value: 'TP', label: 'UATP' },
];

const inputClass =
  'h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20';

const selectClass =
  'h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-fg)] focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20';

export function PaymentForm({ totalAmountMinor, currency, onPaymentChange }: PaymentFormProps) {
  const [brandCode, setBrandCode] = useState<CardBrandCode>('VI');
  const [holderName, setHolderName] = useState('');
  const [cardNumber, setCardNumber] = useState('');
  const [expiryMonth, setExpiryMonth] = useState('');
  const [expiryYear, setExpiryYear] = useState('');
  const [securityCode, setSecurityCode] = useState('');

  function emitChange(
    brand: CardBrandCode,
    holder: string,
    number: string,
    month: string,
    year: string,
    cvv: string,
  ) {
    const isComplete =
      holder.trim().length > 0 &&
      number.replace(/\s/g, '').length >= 13 &&
      month.length === 2 &&
      year.length === 2 &&
      (brand === 'TP' || cvv.length >= 3);

    if (isComplete) {
      onPaymentChange({
        type: 'Credit Card',
        card: {
          brandCode: brand,
          holderName: holder.trim().toUpperCase(),
          number: number.replace(/\s/g, ''),
          expirationDate: `${month}${year}`,
          securityCode: cvv,
        },
        amount: totalAmountMinor,
        currency,
      });
    } else {
      onPaymentChange(null);
    }
  }

  function handleBrandChange(val: CardBrandCode) {
    setBrandCode(val);
    emitChange(val, holderName, cardNumber, expiryMonth, expiryYear, securityCode);
  }

  function handleHolderChange(val: string) {
    setHolderName(val);
    emitChange(brandCode, val, cardNumber, expiryMonth, expiryYear, securityCode);
  }

  function handleNumberChange(val: string) {
    const digits = val.replace(/\D/g, '').slice(0, 19);
    const formatted = digits.replace(/(.{4})/g, '$1 ').trim();
    setCardNumber(formatted);
    emitChange(brandCode, holderName, digits, expiryMonth, expiryYear, securityCode);
  }

  function handleMonthChange(val: string) {
    const clean = val.replace(/\D/g, '').slice(0, 2);
    setExpiryMonth(clean);
    emitChange(brandCode, holderName, cardNumber, clean, expiryYear, securityCode);
  }

  function handleYearChange(val: string) {
    const clean = val.replace(/\D/g, '').slice(0, 2);
    setExpiryYear(clean);
    emitChange(brandCode, holderName, cardNumber, expiryMonth, clean, securityCode);
  }

  function handleCvvChange(val: string) {
    const clean = val.replace(/\D/g, '').slice(0, 4);
    setSecurityCode(clean);
    emitChange(brandCode, holderName, cardNumber, expiryMonth, expiryYear, clean);
  }

  return (
    <Card>
      <CardContent className="p-5">
        <div className="mb-4 flex items-center gap-2">
          <CreditCard className="size-4 text-[var(--color-primary)]" />
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">Datos de pago</h2>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label>Marca de tarjeta</Label>
            <select
              value={brandCode}
              onChange={(e) => handleBrandChange(e.target.value as CardBrandCode)}
              className={selectClass}
            >
              {BRAND_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <Label>Titular de la tarjeta</Label>
            <input
              type="text"
              value={holderName}
              onChange={(e) => handleHolderChange(e.target.value)}
              placeholder="NOMBRE COMO APARECE EN LA TARJETA"
              className={inputClass}
            />
          </div>

          <div className="space-y-1 sm:col-span-2">
            <Label>Número de tarjeta</Label>
            <input
              type="text"
              value={cardNumber}
              onChange={(e) => handleNumberChange(e.target.value)}
              placeholder="4563 9601 2200 1999"
              inputMode="numeric"
              autoComplete="cc-number"
              className={inputClass}
            />
          </div>

          <div className="space-y-1">
            <Label>Vencimiento</Label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={expiryMonth}
                onChange={(e) => handleMonthChange(e.target.value)}
                placeholder="MM"
                inputMode="numeric"
                maxLength={2}
                className={inputClass}
              />
              <span className="text-sm text-[var(--color-fg-muted)]">/</span>
              <input
                type="text"
                value={expiryYear}
                onChange={(e) => handleYearChange(e.target.value)}
                placeholder="YY"
                inputMode="numeric"
                maxLength={2}
                className={inputClass}
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label>CVV / Código de seguridad</Label>
            <input
              type="text"
              value={securityCode}
              onChange={(e) => handleCvvChange(e.target.value)}
              placeholder={brandCode === 'TP' ? 'No requerido' : '347'}
              inputMode="numeric"
              maxLength={4}
              disabled={brandCode === 'TP'}
              className={inputClass}
            />
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2 text-[10px] text-[var(--color-fg-muted)]">
          <Shield className="size-3.5 shrink-0 text-green-600" />
          <span>Los datos se envían encriptados directamente al procesador de pagos.</span>
        </div>
      </CardContent>
    </Card>
  );
}
