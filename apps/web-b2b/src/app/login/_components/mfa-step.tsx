'use client';

import { ArrowLeft } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { OtpInput } from '../../../components/auth/otp-input';
import { Checkbox, TextInput } from '../../../components/ui/field';
import { cn } from '../../../lib/cn';
import type { MfaMode, MfaState } from '../login-state';
import {
  FormAlert,
  PendingAnnouncer,
  PendingButton,
  StepCard,
  TEXT_ACTION_CLASS,
} from './login-ui';

export const REMEMBER_DEVICE_LABEL = 'Recordar este equipo por 30 días';

/**
 * Segundo factor. El código de la app se envía solo al completar el 6º dígito: es el paso que más
 * se repite en el día y un toque menos importa. Por eso "Recordar este equipo" va ANTES del código
 * en el orden de tabulación: se puede cambiar antes de que el formulario se envíe solo.
 *
 * El código de recuperación no se envía solo (10 caracteres a mano, se revisa antes de mandar).
 */
export function MfaStep({
  state,
  pending,
  formAction,
  next,
  onBack,
}: {
  state: MfaState;
  pending: boolean;
  formAction: (formData: FormData) => void;
  next: string;
  onBack: () => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [mode, setMode] = useState<MfaMode>(state.mode);
  // El intento que ya se envió solo: un 7º dígito o un pegado repetido antes de que las casillas se
  // deshabiliten no manda el mismo código dos veces (cada envío gasta un intento del desafío).
  const autoSubmittedAttempt = useRef<number | null>(null);
  const descriptionId = useId();
  const codeLabelId = useId();
  const rememberHintId = useId();
  const errorId = useId();

  function submitWhenComplete(): void {
    const form = formRef.current;
    if (!form || pending || autoSubmittedAttempt.current === state.attempt) return;
    autoSubmittedAttempt.current = state.attempt;
    // `requestSubmit` no existe en Safari < 16 (iPhones viejos que siguen en uso): ahí se hace clic
    // en el botón, que dispara el mismo envío con su validación.
    if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else form.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
  }

  const describedBy = state.error ? `${errorId} ${descriptionId}` : descriptionId;
  const recovery = mode === 'recovery';

  return (
    <StepCard
      title="Verificación en dos pasos"
      descriptionId={descriptionId}
      description={
        recovery ? (
          'Ingresá uno de los códigos de recuperación que guardaste al activar la verificación. Cada uno sirve una sola vez.'
        ) : (
          <>
            Ingresá el código de 6 dígitos de tu app de autenticación
            {state.email ? (
              <>
                {' '}
                para <span className="font-medium text-[var(--color-fg)]">{state.email}</span>
              </>
            ) : null}
            .
          </>
        )
      }
    >
      <form ref={formRef} action={formAction} aria-busy={pending} className="space-y-5">
        <input type="hidden" name="intent" value="mfa" />
        <input type="hidden" name="next" value={next} />
        <input type="hidden" name="email" value={state.email} />
        <input type="hidden" name="mfaToken" value={state.mfaToken} />
        <input type="hidden" name="mode" value={mode} />

        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2.5">
          <Checkbox
            name="rememberDevice"
            value="1"
            // No controlado a propósito: React 19 vacía el formulario al terminar la acción y lo
            // devuelve a `defaultChecked`, que viene del estado con lo que se eligió en el intento.
            defaultChecked={state.rememberDevice}
            aria-describedby={rememberHintId}
            className="mt-0.5 size-5 shrink-0 sm:size-4"
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-[var(--color-fg)]">
              {REMEMBER_DEVICE_LABEL}
            </span>
            <span id={rememberHintId} className="block text-xs text-[var(--color-fg-muted)]">
              En este navegador no te vamos a pedir el código. Desmarcalo si la computadora es
              compartida.
            </span>
          </span>
        </label>

        {recovery ? (
          <div className="space-y-1.5">
            <label
              htmlFor="login-recovery-code"
              className="block text-sm font-medium text-[var(--color-fg)]"
            >
              Código de recuperación
            </label>
            <TextInput
              // Remontar tras cada respuesta lo vacía y lo vuelve a enfocar.
              key={`recovery-${state.attempt}`}
              id="login-recovery-code"
              name="code"
              autoFocus
              autoComplete="off"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              maxLength={16}
              placeholder="A1B2C-3D4E5"
              required
              readOnly={pending}
              aria-invalid={Boolean(state.error) || undefined}
              aria-describedby={describedBy}
              className="h-11 font-mono text-base uppercase tracking-wider sm:h-10"
            />
          </div>
        ) : (
          <div className="space-y-2">
            <p id={codeLabelId} className="text-sm font-medium text-[var(--color-fg)]">
              Código de verificación
            </p>
            <OtpInput
              // Remontar tras cada respuesta vacía las casillas y enfoca la primera.
              key={`otp-${state.attempt}`}
              name="code"
              autoFocus
              disabled={pending}
              invalid={Boolean(state.error)}
              aria-labelledby={codeLabelId}
              aria-describedby={describedBy}
              onComplete={submitWhenComplete}
            />
          </div>
        )}

        {state.error ? (
          <FormAlert key={`error-${state.attempt}`} id={errorId} tone="error">
            <p>{state.error}</p>
          </FormAlert>
        ) : null}

        <PendingButton
          type="submit"
          // Con el envío automático el botón es el camino alternativo (teclados o lectores que
          // completan el código de otra forma); con el de recuperación, el principal.
          variant={recovery ? 'primary' : 'secondary'}
          pending={pending}
          pendingLabel="Verificando…"
        >
          Verificar
        </PendingButton>
        <PendingAnnouncer pending={pending} label="Verificando el código…" />

        <div className="flex justify-center">
          <button
            type="button"
            disabled={pending}
            onClick={() => setMode(recovery ? 'totp' : 'recovery')}
            className={TEXT_ACTION_CLASS}
          >
            {recovery ? 'Usar el código de la app' : 'Usar un código de recuperación'}
          </button>
        </div>
      </form>

      <div className="mt-4 border-t border-[var(--color-border)] pt-2">
        <button
          type="button"
          disabled={pending}
          onClick={onBack}
          className={cn(
            TEXT_ACTION_CLASS,
            'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]',
          )}
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Volver
        </button>
      </div>
    </StepCard>
  );
}
