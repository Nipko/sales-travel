'use client';

import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '../components/ui/button';
import './globals.css';

/**
 * Frontera de error de la raíz.
 *
 * `(app)/error.tsx` cubre las pantallas, pero no lo que dibuja el propio layout del panel (el gate
 * del 2FA, la guardia de sesión): un error ahí mostraba el "Application error" de Next, en inglés y
 * a pantalla completa. Ésta reemplaza al layout raíz cuando se activa, por eso trae su propio
 * `<html>` y `<body>` (y sus estilos).
 */
export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="es">
      <body>
        <main className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center px-6 text-center">
          <div className="flex size-12 items-center justify-center rounded-xl bg-[var(--color-danger)]/10">
            <AlertTriangle className="size-6 text-[var(--color-danger)]" aria-hidden />
          </div>
          <h1 className="mt-4 text-lg font-bold text-[var(--color-fg)]">Algo salió mal</h1>
          <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
            No pudimos cargar el panel. Probá de nuevo; si sigue fallando, avisale al administrador
            de tu agencia.
          </p>
          <Button onClick={reset} className="mt-6 gap-2">
            <RefreshCw className="size-4" aria-hidden />
            Reintentar
          </Button>
        </main>
      </body>
    </html>
  );
}
