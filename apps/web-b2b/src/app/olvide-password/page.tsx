'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { AuthShell, FormError, FormSuccess } from '../../components/layout/auth-shell';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { forgotPasswordAction, type ForgotState } from './actions';

const initialState: ForgotState = {};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      disabled={pending}
      size="lg"
      className="w-full bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-[var(--color-primary-fg)] font-medium"
    >
      {pending ? 'Enviando…' : 'Enviar enlace'}
    </Button>
  );
}

export default function ForgotPasswordPage() {
  const [state, formAction] = useActionState(forgotPasswordAction, initialState);

  return (
    <AuthShell
      title="Restablecer contraseña"
      description="Te mandamos un enlace para que elijas una contraseña nueva."
    >
      {state.sent ? (
        <div className="space-y-4">
          <FormSuccess message="Si ese correo tiene una cuenta activa, te llega un enlace en unos minutos. El enlace vence en 1 hora." />
          <p className="text-xs text-[var(--color-fg-subtle)]">
            Revisá también la carpeta de spam. Si no llega, puede que la dirección no esté
            registrada.
          </p>
        </div>
      ) : (
        <form action={formAction} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="email" className="text-xs font-semibold text-[var(--color-fg)]">
              Correo electrónico
            </Label>
            <Input
              id="email"
              name="email"
              type="email"
              required
              autoFocus
              autoComplete="email"
              placeholder="ejemplo@agencia.com"
              className="h-10 border-[var(--color-border)] bg-[var(--color-bg)] focus-visible:ring-[var(--color-primary)]/20 focus-visible:border-[var(--color-primary)] rounded-lg"
            />
          </div>

          {state.error ? <FormError message={state.error} /> : null}

          <SubmitButton />
        </form>
      )}
    </AuthShell>
  );
}
