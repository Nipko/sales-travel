'use client';

import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  normalizeStepUpCode,
  registerStepUpPrompt,
  STEP_UP_COPY,
  submitStepUp,
} from '../lib/step-up';
import { OtpInput, type OtpInputHandle } from './auth/otp-input';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';

export interface StepUpDialogProps {
  readonly open: boolean;
  readonly pending: boolean;
  /** El motivo del último código rechazado, o vacío. */
  readonly error: string;
  /** Sube con cada código rechazado: las casillas se vacían y el foco vuelve a la primera. */
  readonly failureKey: number;
  readonly onSubmit: (code: string) => void;
  readonly onCancel: () => void;
}

const noop = (): void => undefined;

/**
 * "Confirma que eres tú": el código de 6 dígitos de la app antes de una acción de alto impacto
 * (USR-13). Se envía solo al completar el 6º dígito; "Confirmar" sirve para quien lo pega o lo
 * escribe y prefiere confirmar a mano. Mientras verifica no se puede cerrar: la acción espera la
 * respuesta.
 */
export function StepUpDialog({
  open,
  pending,
  error,
  failureKey,
  onSubmit,
  onCancel,
}: StepUpDialogProps) {
  const otpRef = useRef<OtpInputHandle>(null);
  const clearedFor = useRef(0);
  const [code, setCode] = useState('');
  const labelId = useId();
  const errorId = useId();

  // Se limpia cuando las casillas ya están habilitadas: con `disabled` no reciben el foco.
  useEffect(() => {
    if (failureKey > 0 && !pending && clearedFor.current !== failureKey) {
      clearedFor.current = failureKey;
      otpRef.current?.clear();
    }
  }, [failureKey, pending]);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!pending) onSubmit(code);
  }

  return (
    <Dialog
      open={open}
      onClose={pending ? noop : onCancel}
      title={STEP_UP_COPY.title}
      description={STEP_UP_COPY.description}
    >
      <form onSubmit={submit} noValidate className="space-y-3">
        <span id={labelId} className="sr-only">
          Código de verificación
        </span>
        <OtpInput
          ref={otpRef}
          name="code"
          aria-labelledby={labelId}
          aria-describedby={error ? errorId : undefined}
          invalid={error !== ''}
          disabled={pending}
          onChange={setCode}
          onComplete={(value) => {
            if (!pending) onSubmit(value);
          }}
        />
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
        {/* Apiladas en el teléfono, como en las confirmaciones (useConfirm). */}
        <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
            Cancelar
          </Button>
          <Button type="submit" disabled={pending}>
            {STEP_UP_COPY.confirm}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * El diálogo de la reconfirmación, montado UNA vez en el layout del panel. Se registra como el que
 * abre `withStepUp` (lib/step-up.ts): cualquier acción del panel que reciba 403
 * MFA_RECENT_REQUIRED lo abre, sin que la pantalla tenga que montar nada.
 */
export function StepUpProvider() {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [failureKey, setFailureKey] = useState(0);
  const resolver = useRef<((confirmed: boolean) => void) | null>(null);

  const settle = useCallback((confirmed: boolean) => {
    resolver.current?.(confirmed);
    resolver.current = null;
    setOpen(false);
    setPending(false);
    setError('');
  }, []);

  useEffect(() => {
    const unregister = registerStepUpPrompt(
      () =>
        new Promise<boolean>((resolve) => {
          resolver.current = resolve;
          setError('');
          setPending(false);
          setOpen(true);
        }),
    );
    return () => {
      unregister();
      // Si se desmonta con el diálogo abierto, la acción que esperaba no queda colgada.
      resolver.current?.(false);
      resolver.current = null;
    };
  }, []);

  async function submit(code: string): Promise<void> {
    if (normalizeStepUpCode(code) === null) {
      setError(STEP_UP_COPY.incomplete);
      return;
    }
    setPending(true);
    setError('');
    const res = await submitStepUp(code);
    if (res.ok) {
      settle(true);
      return;
    }
    setPending(false);
    setError(res.message);
    setFailureKey((k) => k + 1);
  }

  return (
    <StepUpDialog
      open={open}
      pending={pending}
      error={error}
      failureKey={failureKey}
      onSubmit={(code) => void submit(code)}
      onCancel={() => settle(false)}
    />
  );
}
