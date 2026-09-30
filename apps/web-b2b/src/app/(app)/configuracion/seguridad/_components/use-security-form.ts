'use client';

import { useRef, useState, useTransition, type FormEvent } from 'react';
import type { ActionResult } from '../actions';
import { isNextNavigation, TRANSPORT_FAILURE_MESSAGE } from './settle-action';

export interface SecurityFormState {
  pending: boolean;
  error: string | undefined;
  /**
   * Cambia con cada fallo (1, 2, 3…) y vuelve a 0 con un éxito. Es lo que usa el campo del código
   * para limpiarse después de un error, aun cuando el texto del error es el mismo que el anterior.
   */
  failureKey: number;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

/**
 * Envío de un formulario de Seguridad a su server action, SIN el `action={}` de React.
 *
 * Con `<form action>`, React vacía el formulario al terminar, también cuando falló: el usuario
 * perdía la contraseña que había escrito por un código vencido. Acá se llama a la acción desde
 * `onSubmit`, y el formulario sólo se vacía si quien lo usa lo pide en `onSuccess`.
 *
 * Sirve igual para el botón y para el auto-envío del código (`form.requestSubmit()` dispara el
 * mismo `submit`).
 */
export function useSecurityForm<R extends ActionResult>(
  action: (data: FormData) => Promise<R>,
  onSuccess: (result: R, form: HTMLFormElement) => void,
): SecurityFormState {
  const [pending, startTransition] = useTransition();
  const [failure, setFailure] = useState<{ message: string; key: number } | null>(null);
  // El auto-envío puede volver a disparar antes de que `pending` llegue al render.
  const inFlight = useRef(false);

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    const form = event.currentTarget;
    const data = new FormData(form);
    startTransition(async () => {
      try {
        const result: R | undefined = await action(data);
        // Una acción que redirige (sesión cerrada) no devuelve nada: la navegación ya está en curso.
        if (!result) return;
        if (result.error) {
          const message = result.error;
          setFailure((prev) => ({ message, key: (prev?.key ?? 0) + 1 }));
          return;
        }
        setFailure(null);
        onSuccess(result, form);
      } catch (err) {
        // El redirect de una server action viaja como excepción de Next: hay que dejarlo pasar.
        if (isNextNavigation(err)) throw err;
        setFailure((prev) => ({ message: TRANSPORT_FAILURE_MESSAGE, key: (prev?.key ?? 0) + 1 }));
      } finally {
        inFlight.current = false;
      }
    });
  }

  return { pending, error: failure?.message, failureKey: failure?.key ?? 0, onSubmit };
}
