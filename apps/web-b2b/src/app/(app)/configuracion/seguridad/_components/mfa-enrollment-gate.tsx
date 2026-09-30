'use client';

import { LogOut, ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { logout } from '../../../../../components/layout/session-sync';
import { Button } from '../../../../../components/ui/button';
import { MfaEnrollment } from './mfa-enrollment';
import { RecoveryCodes } from './recovery-codes';

export const GATE_TITLE = 'Activá la verificación en dos pasos';

/**
 * El mismo cierre que el menú del panel: revoca en el API y avisa a las demás pestañas, que se van
 * al login juntas en vez de enterarse en el próximo ping.
 */
function SignOutButton() {
  const [pending, setPending] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={pending}
      className="h-11 sm:h-8"
      onClick={() => {
        setPending(true);
        void logout();
      }}
    >
      <LogOut aria-hidden="true" />
      {pending ? 'Cerrando…' : 'Cerrar sesión'}
    </Button>
  );
}

/**
 * Pantalla completa que el layout muestra en lugar del panel cuando el rol exige 2FA y el usuario
 * no lo tiene (el API responde 403 `MFA_ENROLLMENT_REQUIRED` a todo lo demás). No se puede saltar:
 * la única salida es "Cerrar sesión".
 *
 * Al confirmar muestra los códigos de recuperación y recién con "Listo" refresca: el layout vuelve
 * a preguntar el estado del 2FA y, ya activo, pinta el panel normal.
 */
export interface MfaEnrollmentGateProps {
  /** Para el nombre del .txt de códigos y la hoja impresa. */
  email?: string;
  tenantName?: string;
}

export function MfaEnrollmentGate({ email, tenantName }: MfaEnrollmentGateProps) {
  const router = useRouter();
  const [codes, setCodes] = useState<string[] | null>(null);
  const [finishing, startFinishing] = useTransition();

  function finish(): void {
    // En la misma transición que el refresh: los códigos no desaparecen hasta que llega el panel.
    startFinishing(() => {
      router.refresh();
    });
  }

  return (
    <div className="flex min-h-dvh flex-col bg-[var(--color-bg)]">
      <header className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3 sm:px-6">
        <p className="min-w-0 truncate text-sm font-medium text-[var(--color-fg-muted)]">
          {tenantName ?? 'Seguridad de tu cuenta'}
        </p>
        <SignOutButton />
      </header>

      <main className="mx-auto w-full max-w-xl flex-1 px-4 py-8 sm:px-6 sm:py-12">
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-xs)] sm:p-8">
          {codes ? (
            <RecoveryCodes
              codes={codes}
              reason="enabled"
              email={email}
              onDone={finish}
              finishing={finishing}
            />
          ) : (
            <div className="space-y-6">
              <div className="space-y-2">
                <span
                  aria-hidden="true"
                  className="flex size-10 items-center justify-center rounded-full bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
                >
                  <ShieldCheck className="size-5" />
                </span>
                <h1 className="text-xl font-bold tracking-tight text-[var(--color-fg)]">
                  {GATE_TITLE}
                </h1>
                <p className="text-sm text-[var(--color-fg-muted)]">
                  Tu rol exige un segundo factor para usar el panel: además de la contraseña, un
                  código que cambia cada 30 segundos en tu teléfono. Lleva un minuto.
                </p>
                {email ? (
                  <p className="text-xs text-[var(--color-fg-muted)]">
                    Cuenta: <span className="font-medium text-[var(--color-fg)]">{email}</span>
                  </p>
                ) : null}
              </div>
              <MfaEnrollment mode="enroll" startLabel="Empezar" onConfirmed={setCodes} />
            </div>
          )}
        </div>
        <p className="mt-4 text-center text-xs text-[var(--color-fg-muted)]">
          ¿No tenés cómo hacerlo ahora? Cerrá sesión y pedile ayuda al administrador de tu agencia.
        </p>
      </main>
    </div>
  );
}
