'use client';

import { Eye, EyeOff } from 'lucide-react';
import {
  forwardRef,
  useId,
  useState,
  type FocusEvent,
  type InputHTMLAttributes,
  type KeyboardEvent,
} from 'react';
import { cn } from '../../lib/cn';
import { TextInput } from '../ui/field';

export const CAPS_LOCK_WARNING = 'Bloq Mayús activado';

export type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;

/**
 * Campo de contraseña con "mostrar/ocultar" y aviso de Bloq Mayús.
 *
 * Las dos cosas evitan el error más común del login: tipear bien la contraseña con Bloq Mayús
 * puesto, o con un error que no se ve. Cada intento fallido suma al bloqueo de la cuenta, así que
 * un error de tipeo cuesta caro.
 *
 * - El botón es un toggle: nombre fijo "Mostrar contraseña" y el estado en `aria-pressed` (cambiar
 *   el nombre Y el estado a la vez hace que un lector de pantalla anuncie lo contrario).
 * - El aviso de Bloq Mayús vive siempre en el DOM, vacío, dentro de una región `aria-live`: una
 *   región que aparece junto con su texto no se anuncia en todos los lectores.
 * - 16 px en móvil: con menos, iOS hace zoom al enfocar.
 */
export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  function PasswordInput(
    {
      id,
      className,
      disabled,
      onKeyDown,
      onKeyUp,
      onBlur,
      'aria-describedby': describedBy,
      ...props
    },
    ref,
  ) {
    const generatedId = useId();
    const inputId = id ?? generatedId;
    const capsId = `${inputId}-caps`;
    const [visible, setVisible] = useState(false);
    const [capsLock, setCapsLock] = useState(false);

    function readCapsLock(event: KeyboardEvent<HTMLInputElement>): void {
      // Algunos navegadores no la informan en ciertos eventos: si no se puede saber, no se avisa.
      if (typeof event.getModifierState === 'function') {
        setCapsLock(event.getModifierState('CapsLock'));
      }
    }

    const describedByAll = [describedBy, capsLock ? capsId : null].filter(Boolean).join(' ');

    return (
      <div>
        <div className="relative">
          <TextInput
            ref={ref}
            id={inputId}
            type={visible ? 'text' : 'password'}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={disabled}
            aria-describedby={describedByAll || undefined}
            onKeyDown={(event) => {
              readCapsLock(event);
              onKeyDown?.(event);
            }}
            onKeyUp={(event) => {
              // En keyup la tecla Bloq Mayús ya cambió el estado; en keydown no en todos los SO.
              readCapsLock(event);
              onKeyUp?.(event);
            }}
            onBlur={(event: FocusEvent<HTMLInputElement>) => {
              setCapsLock(false);
              onBlur?.(event);
            }}
            className={cn('h-10 pr-11 text-base sm:text-sm', className)}
            {...props}
          />
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            disabled={disabled}
            aria-label="Mostrar contraseña"
            aria-pressed={visible}
            aria-controls={inputId}
            title={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'}
            className={cn(
              'absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-lg',
              'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-primary)]',
              'disabled:cursor-not-allowed disabled:opacity-50',
            )}
          >
            {visible ? (
              <EyeOff className="size-4" aria-hidden="true" />
            ) : (
              <Eye className="size-4" aria-hidden="true" />
            )}
          </button>
        </div>
        <p
          id={capsId}
          aria-live="polite"
          className={cn('text-xs font-medium text-[var(--color-fg-muted)]', capsLock && 'mt-1.5')}
        >
          {capsLock ? CAPS_LOCK_WARNING : ''}
        </p>
      </div>
    );
  },
);
