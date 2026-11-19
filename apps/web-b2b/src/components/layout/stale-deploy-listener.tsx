'use client';

import { useEffect } from 'react';
import { toast } from 'sonner';
import { isStaleDeployError, STALE_DEPLOY_TEXT, STALE_DEPLOY_TITLE } from '../../lib/stale-deploy';

const TOAST_ID = 'stale-deploy';

/**
 * Una server action de un deploy anterior que nadie atrapó (un `startTransition` sin try/catch)
 * termina como promesa rechazada sin manejar: el botón no hacía nada y el vendedor no sabía por
 * qué. Se le avisa con un toast que no se cierra solo y lo deja recargar.
 */
export function StaleDeployListener() {
  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent) => {
      if (!isStaleDeployError(event.reason)) return;
      event.preventDefault();
      toast.warning(STALE_DEPLOY_TITLE, {
        id: TOAST_ID,
        description: STALE_DEPLOY_TEXT,
        duration: Infinity,
        action: { label: 'Recargar', onClick: () => window.location.reload() },
      });
    };
    window.addEventListener('unhandledrejection', onRejection);
    return () => window.removeEventListener('unhandledrejection', onRejection);
  }, []);
  return null;
}
