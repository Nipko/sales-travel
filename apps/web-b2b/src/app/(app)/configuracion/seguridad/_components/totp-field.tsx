'use client';

import { Loader2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { OtpInput, type OtpInputHandle } from '../../../../../components/auth/otp-input';

/**
 * El código de 6 dígitos de la app de autenticación dentro de un formulario de Seguridad.
 *
 * - Se envía solo al completar el 6º dígito, pero sólo si el resto del formulario ya es válido: en
 *   "contraseña + código" el código puede terminarse primero, y mandar sin contraseña sería un
 *   error seguro que además suma al bloqueo de la cuenta.
 * - Durante el envío las casillas quedan deshabilitadas y se anuncia "Verificando…".
 * - Después de un error se vacían y el foco vuelve a la primera: el código siguiente es otro.
 */
export function TotpField({
  id,
  label,
  hint,
  error,
  failureKey,
  pending,
  autoFocus = false,
  autoSubmit = true,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  failureKey: number;
  pending: boolean;
  autoFocus?: boolean;
  autoSubmit?: boolean;
}) {
  const otpRef = useRef<OtpInputHandle>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const clearedFor = useRef(0);

  // Se limpia cuando las casillas ya están habilitadas: con `disabled` no reciben el foco.
  useEffect(() => {
    if (failureKey > 0 && !pending && clearedFor.current !== failureKey) {
      clearedFor.current = failureKey;
      otpRef.current?.clear();
    }
  }, [failureKey, pending]);

  function handleComplete(): void {
    if (!autoSubmit || pending) return;
    const form = wrapperRef.current?.closest('form');
    if (!form || !form.checkValidity()) return;
    form.requestSubmit();
  }

  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <div ref={wrapperRef} className="space-y-2">
      <label
        id={labelId}
        htmlFor={id}
        className="block text-xs font-semibold text-[var(--color-fg)]"
      >
        {label}
      </label>
      <OtpInput
        ref={otpRef}
        name="code"
        id={id}
        aria-labelledby={labelId}
        aria-describedby={describedBy || undefined}
        invalid={Boolean(error)}
        disabled={pending}
        autoFocus={autoFocus}
        onComplete={handleComplete}
      />
      {hint ? (
        <p id={hintId} className="text-xs text-[var(--color-fg-muted)]">
          {hint}
        </p>
      ) : null}
      <p
        aria-live="polite"
        className="flex min-h-4 items-center gap-1.5 text-xs text-[var(--color-fg-muted)]"
      >
        {pending ? (
          <>
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            Verificando…
          </>
        ) : null}
      </p>
      {error ? (
        <p id={errorId} role="alert" className="text-sm font-medium text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
