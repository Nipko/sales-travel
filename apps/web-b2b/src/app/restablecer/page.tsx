'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { AuthShell, FormError, FormSuccess } from '../../components/layout/auth-shell';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { resetPasswordAction, type ResetState } from './actions';

const initialState: ResetState = {};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      disabled={pending}
      size="lg"
      className="w-full bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-[var(--color-primary-fg)] font-medium"
    >
      {pending ? 'Guardando…' : 'Guardar contraseña'}
    </Button>
  );
}

function ResetForm() {
  const token = useSearchParams().get('token') ?? '';
  const [state, formAction] = useActionState(resetPasswordAction, initialState);

  if (!token) {
    return (
      <AuthShell
        title="Enlace inválido"
        description="Este enlace de restablecimiento no tiene un token válido."
      >
        <p className="text-xs text-[var(--color-fg-muted)]">
          Puede que lo hayas copiado incompleto.{' '}
          <Link
            href="/olvide-password"
            className="font-medium text-[var(--color-primary)] hover:underline"
          >
            Pedí uno nuevo
          </Link>
          .
        </p>
      </AuthShell>
    );
  }

  if (state.done) {
    return (
      <AuthShell
        title="Contraseña actualizada"
        description="Ya podés entrar con tu contraseña nueva."
      >
        <div className="space-y-4">
          <FormSuccess message="Listo. Por seguridad cerramos todas las sesiones abiertas en otros dispositivos." />
          <Link href="/login">
            <Button
              size="lg"
              className="w-full bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-[var(--color-primary-fg)] font-medium"
            >
              Iniciar sesión
            </Button>
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Elegí tu contraseña nueva" description="Mínimo 12 caracteres.">
      <form action={formAction} className="space-y-5">
        <input type="hidden" name="token" value={token} />

        <div className="space-y-2">
          <Label htmlFor="newPassword" className="text-xs font-semibold text-[var(--color-fg)]">
            Contraseña nueva
          </Label>
          <Input
            id="newPassword"
            name="newPassword"
            type="password"
            required
            autoFocus
            minLength={12}
            autoComplete="new-password"
            className="h-10 border-[var(--color-border)] bg-[var(--color-bg)] focus-visible:ring-[var(--color-primary)]/20 focus-visible:border-[var(--color-primary)] rounded-lg"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="confirm" className="text-xs font-semibold text-[var(--color-fg)]">
            Repetir contraseña
          </Label>
          <Input
            id="confirm"
            name="confirm"
            type="password"
            required
            minLength={12}
            autoComplete="new-password"
            className="h-10 border-[var(--color-border)] bg-[var(--color-bg)] focus-visible:ring-[var(--color-primary)]/20 focus-visible:border-[var(--color-primary)] rounded-lg"
          />
        </div>

        {state.error ? <FormError message={state.error} /> : null}

        <SubmitButton />
      </form>
    </AuthShell>
  );
}

export default function ResetPasswordPage() {
  // useSearchParams exige un Suspense boundary en el App Router.
  return (
    <Suspense fallback={null}>
      <ResetForm />
    </Suspense>
  );
}
