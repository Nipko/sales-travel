'use client';

import { RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Button } from '../../../../../../components/ui/button';
import { cn } from '../../../../../../lib/cn';

/** Vuelve a leer la página en el servidor, sin recargar el navegador. */
export function RefreshStatusButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={() => start(() => router.refresh())}
      aria-disabled={pending || undefined}
      className="gap-1.5"
    >
      <RefreshCw className={cn('size-3.5', pending && 'animate-spin')} aria-hidden="true" />
      Actualizar
    </Button>
  );
}
