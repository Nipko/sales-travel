'use client';

import { Loader2 } from 'lucide-react';
import { TextInput } from '../../../../../components/ui/field';

export const RECOVERY_PLACEHOLDER = 'A1B2C-3D4E5';

/**
 * Un código de recuperación (`XXXXX-XXXXX`) dentro de un formulario de Seguridad, en lugar del de
 * la app. Mismo `name="code"` que `TotpField`, así la acción lo recibe en el mismo campo.
 *
 * A diferencia del de la app, no se envía solo (10 caracteres a mano, se revisan antes de mandar) y
 * no se vacía tras un error: si lo incorrecto era la contraseña, el código no se gastó y sirve igual.
 */
export function RecoveryCodeField({
  id,
  label,
  hint,
  error,
  pending,
  autoFocus = false,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  pending: boolean;
  autoFocus?: boolean;
}) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <div className="max-w-sm space-y-2">
      <label htmlFor={id} className="block text-xs font-semibold text-[var(--color-fg)]">
        {label}
      </label>
      <TextInput
        id={id}
        name="code"
        autoFocus={autoFocus}
        autoComplete="off"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        maxLength={16}
        placeholder={RECOVERY_PLACEHOLDER}
        required
        // `readOnly` y no `disabled`: deshabilitado pierde el foco, y tras un error (el código no se
        // vacía) habría que volver a buscar el campo para corregir un carácter.
        readOnly={pending}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={describedBy || undefined}
        className="h-11 font-mono text-base uppercase tracking-wider sm:h-10"
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
