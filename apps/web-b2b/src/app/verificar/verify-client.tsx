'use client';

import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';

type Status = 'verifying' | 'ok' | 'error';

export function VerifyClient({ token }: { token: string }) {
  const [status, setStatus] = useState<Status>(token ? 'verifying' : 'error');
  const [message, setMessage] = useState(token ? '' : 'Enlace inválido: falta el token.');

  useEffect(() => {
    if (!token) return;
    void (async () => {
      try {
        const res = await fetch('/api/auth/verify-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        if (res.ok) {
          setStatus('ok');
        } else {
          const data = (await res.json()) as { error?: string };
          setStatus('error');
          setMessage(
            data.error ?? 'No se pudo verificar el correo. El enlace puede haber expirado.',
          );
        }
      } catch {
        setStatus('error');
        setMessage('Error de conexión. Intentá de nuevo.');
      }
    })();
  }, [token]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-surface-muted)] p-4">
      <div className="w-full max-w-md rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center shadow-sm">
        {status === 'verifying' && (
          <>
            <Loader2 className="mx-auto mb-4 size-10 animate-spin text-[var(--color-primary)]" />
            <h1 className="text-lg font-semibold text-[var(--color-fg)]">Verificando tu correo…</h1>
          </>
        )}
        {status === 'ok' && (
          <>
            <CheckCircle2 className="mx-auto mb-4 size-12 text-emerald-500" />
            <h1 className="text-lg font-semibold text-[var(--color-fg)]">¡Correo verificado!</h1>
            <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
              Tu dirección quedó confirmada. Ya podés usar tu cuenta con normalidad.
            </p>
            <a
              href="/"
              className="mt-6 inline-block rounded-lg bg-[var(--color-primary)] px-5 py-2.5 text-sm font-medium text-white hover:opacity-90"
            >
              Ir al panel
            </a>
          </>
        )}
        {status === 'error' && (
          <>
            <XCircle className="mx-auto mb-4 size-12 text-red-500" />
            <h1 className="text-lg font-semibold text-[var(--color-fg)]">No pudimos verificar</h1>
            <p className="mt-2 text-sm text-[var(--color-fg-muted)]">{message}</p>
            <a
              href="/"
              className="mt-6 inline-block rounded-lg border border-[var(--color-border)] px-5 py-2.5 text-sm font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]"
            >
              Volver al inicio
            </a>
          </>
        )}
      </div>
    </main>
  );
}
