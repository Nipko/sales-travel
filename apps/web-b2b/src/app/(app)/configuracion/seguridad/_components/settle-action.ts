import type { ActionResult } from '../actions';

/** Lo que ve el usuario cuando la llamada a la server action ni siquiera volvió. */
export const TRANSPORT_FAILURE_MESSAGE =
  'No pudimos completar la operación. Revisá tu conexión e intentá de nuevo.';

/**
 * La server action no respondió: se cortó la red entre el navegador y Next, o un deploy nuevo dejó
 * a esta pestaña con una acción que ya no existe. Los errores del API NO llegan por acá: esos
 * vuelven como `{ error }` desde la propia acción.
 */
export interface TransportFailure {
  readonly transport: true;
  readonly error: string;
}

/**
 * El redirect (o el notFound) de una server action viaja como excepción de Next con un `digest`
 * propio: hay que dejarlo pasar para que la navegación siga.
 */
export function isNextNavigation(err: unknown): boolean {
  const digest = (err as { digest?: unknown } | null)?.digest;
  return (
    typeof digest === 'string' && /^NEXT_(REDIRECT|NOT_FOUND|HTTP_ERROR_FALLBACK)/.test(digest)
  );
}

/**
 * Llama a una server action desde un `startTransition(async …)` sin dejar escapar un rechazo.
 *
 * React 19 guarda la promesa de la transición y, si se rechaza, la vuelve a lanzar al pintar: la
 * atrapa el error boundary más cercano. Un corte de red al tocar "Cerrar" cambiaba toda la pantalla
 * de Seguridad por la de error, y en el enrolamiento obligatorio (que el layout pinta por encima de
 * `(app)/error.tsx`) aparecía el "Application error" de Next a pantalla completa. Así, el rechazo se
 * convierte en un error más del formulario.
 */
export async function settleAction<R extends ActionResult>(
  call: () => Promise<R | undefined>,
): Promise<R | TransportFailure | undefined> {
  try {
    return await call();
  } catch (err) {
    if (isNextNavigation(err)) throw err;
    return { transport: true, error: TRANSPORT_FAILURE_MESSAGE };
  }
}
