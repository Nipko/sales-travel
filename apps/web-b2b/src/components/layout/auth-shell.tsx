import Link from 'next/link';
import { Compass } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';

/**
 * Layout de las pantallas públicas de autenticación (reset de contraseña, invitación).
 * Deliberadamente más sobrio que /login: son pantallas de paso, no la puerta de entrada.
 */
export function AuthShell({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-bg)] px-4 py-12">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex items-center justify-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-lg bg-[var(--color-primary)] shadow-[var(--shadow-sm)]">
            <Compass className="size-4 text-[var(--color-primary-fg)]" />
          </div>
          <span className="text-base font-bold tracking-tight text-[var(--color-fg)]">
            Sales-Travel
          </span>
        </div>

        <Card className="border border-[var(--color-border)]/50 bg-[var(--color-surface)] shadow-[var(--shadow-md)] rounded-xl">
          <CardHeader className="space-y-1.5 pb-4">
            <CardTitle className="text-lg font-bold text-[var(--color-fg)]">{title}</CardTitle>
            <CardDescription className="text-xs text-[var(--color-fg-muted)]">
              {description}
            </CardDescription>
          </CardHeader>
          <CardContent>{children}</CardContent>
        </Card>

        {footer ?? (
          <p className="text-center text-xs text-[var(--color-fg-subtle)]">
            <Link href="/login" className="font-medium text-[var(--color-primary)] hover:underline">
              Volver al inicio de sesión
            </Link>
          </p>
        )}
      </div>
    </main>
  );
}

/** Bloque de error de formulario, con el mismo tratamiento visual que /login. */
export function FormError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex gap-2 rounded-lg border border-[var(--color-danger)]/20 bg-[var(--color-danger)]/5 px-3 py-2.5 text-xs text-[var(--color-danger)]"
    >
      <span>{message}</span>
    </div>
  );
}

export function FormSuccess({ message }: { message: string }) {
  return (
    <div
      role="status"
      className="flex gap-2 rounded-lg border border-[var(--color-success)]/20 bg-[var(--color-success)]/5 px-3 py-2.5 text-xs text-[var(--color-success)]"
    >
      <span>{message}</span>
    </div>
  );
}
