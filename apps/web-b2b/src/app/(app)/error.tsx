'use client';

import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useEffect } from 'react';
import { Button } from '../../components/ui/button';

/**
 * Frontera de error del panel.
 *
 * Sin ella, cualquier excepción de un server component mostraba la pantalla cruda de
 * Next —en producción, un "Application error" sin contexto ni forma de recuperarse.
 */
export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    // El detalle técnico va a la consola del navegador; al usuario se le da una salida.
    console.error('[panel] error no controlado:', error);
  }, [error]);

  return (
    <div className="mx-auto flex max-w-lg flex-col items-center px-6 py-20 text-center">
      <div className="flex size-12 items-center justify-center rounded-xl bg-[var(--color-danger)]/10">
        <AlertTriangle className="size-6 text-[var(--color-danger)]" />
      </div>
      <h1 className="mt-4 text-lg font-bold text-[var(--color-fg)]">Algo salió mal</h1>
      <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
        No pudimos cargar esta sección. Podés reintentar; si sigue fallando, avisale al
        administrador de tu agencia.
      </p>
      <Button onClick={reset} className="mt-6 gap-2">
        <RefreshCw className="size-4" />
        Reintentar
      </Button>
    </div>
  );
}
