'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from '../../components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { loginAction, type LoginState } from './actions';

const initialState: LoginState = {};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} size="lg" className="w-full">
      {pending ? 'Ingresando…' : 'Ingresar'}
    </Button>
  );
}

export default function LoginPage() {
  const [state, formAction] = useActionState(loginAction, initialState);

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-bg)] p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 flex size-10 items-center justify-center rounded-lg bg-[var(--color-primary)] shadow-[var(--shadow-sm)]">
            <span className="text-sm font-bold tracking-tight text-[var(--color-primary-fg)]">
              ST
            </span>
          </div>
          <h1 className="text-lg font-semibold tracking-tight text-[var(--color-fg)]">
            Sales-Travel
          </h1>
          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">Panel de agencia</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Ingresar a tu cuenta</CardTitle>
            <CardDescription>Usá tu email corporativo</CardDescription>
          </CardHeader>
          <CardContent>
            <form action={formAction} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="vos@agencia.com"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="password">Contraseña</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  required
                  autoComplete="current-password"
                />
              </div>

              {state.error ? (
                <p
                  role="alert"
                  className="rounded-md border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/8 px-3 py-2 text-xs text-[var(--color-danger)]"
                >
                  {state.error}
                </p>
              ) : null}

              <SubmitButton />
            </form>
          </CardContent>
        </Card>

        <p className="mt-6 text-center text-[11px] text-[var(--color-fg-subtle)]">
          ¿Problemas para ingresar? Contactá al admin de tu agencia.
        </p>
      </div>
    </main>
  );
}
