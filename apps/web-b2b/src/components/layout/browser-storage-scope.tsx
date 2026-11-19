'use client';

import { setStorageScope } from '../../lib/storage-scope';

/**
 * Fija en el navegador el alcance (usuario + agencia) de lo que las pantallas guardan en
 * `localStorage` (`lib/storage-scope.ts`). Va antes que el contenido del panel: React lo dibuja
 * primero, así que cuando una pantalla lee o guarda, el alcance ya es el de esta sesión. No pinta
 * nada.
 */
export function BrowserStorageScope({ scope }: { scope: string | undefined }) {
  setStorageScope(scope);
  return null;
}
