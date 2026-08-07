'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { AuthShell, FormError, FormSuccess } from '../../components/layout/auth-shell';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { acceptInvitationAction, type InvitationState } from './actions';

const initialState: InvitationState = {};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      disabled={pending}
      size="lg"
      className="w-full bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-[var(--color-primary-fg)] font-medium"
    >
      {pending ? 'Creando cuenta…' : 'Aceptar invitación'}
    </Button>
  );
}

function InvitationForm() {
  const token = useSearchParams().get('token') ?? '';
  const [state, formAction] = useActionState(acceptInvitationAction, initialState);

  if (!token) {
    return (
      <AuthShell title="Invitación inválida" description="Este enlace no tiene un token válido.">
        <p className="text-xs text-[var(--color-fg-muted)]">
          Puede que lo hayas copiado incompleto. Pedile a tu administrador que te reenvíe la
          invitación.
        </p>
      </AuthShell>
    );
  }

  if (state.done) {
    return (
      <AuthShell title="Cuenta creada" description="Ya podés entrar con tu contraseña.">
        <div className="space-y-4">
          <FormSuccess message="Listo. Tu correo quedó verificado al aceptar la invitación." />
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
    <AuthShell
      title="Aceptar invitación"
      description="Elegí tu contraseña. Sólo vos la vas a conocer."
    >
      <form action={formAction} className="space-y-5">
        <input type="hidden" name="token" value={token} />

        <div className="space-y-2">
          <Label htmlFor="name" className="text-xs font-semibold text-[var(--color-fg)]">
            Tu nombre
          </Label>
          <Input
            id="name"
            name="name"
            required
            autoFocus
            autoComplete="name"
            placeholder="Nombre y apellido"
            className="h-10 border-[var(--color-border)] bg-[var(--color-bg)] focus-visible:ring-[var(--color-primary)]/20 focus-visible:border-[var(--color-primary)] rounded-lg"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="password" className="text-xs font-semibold text-[var(--color-fg)]">
            Contraseña
          </Label>
          <Input
            id="password"
            name="password"
            type="password"
            required
            minLength={12}
            autoComplete="new-password"
            className="h-10 border-[var(--color-border)] bg-[var(--color-bg)] focus-visible:ring-[var(--color-primary)]/20 focus-visible:border-[var(--color-primary)] rounded-lg"
          />
          <p className="text-xs text-[var(--color-fg-subtle)]">Mínimo 12 caracteres.</p>
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

export default function InvitationPage() {
  return (
    <Suspense fallback={null}>
      <InvitationForm />
    </Suspense>
  );
}
