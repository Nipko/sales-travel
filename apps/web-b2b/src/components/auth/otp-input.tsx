'use client';

import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';
import { cn } from '../../lib/cn';
import {
  OTP_DEFAULT_LENGTH,
  applyBackspace,
  applyDelete,
  applyDigit,
  applyInput,
  applyPaste,
  emptyOtp,
  firstEmptyIndex,
  isOtpComplete,
  isOtpNavigationKey,
  navigateOtp,
  otpValue,
  type OtpState,
} from './otp-input-state';

/** Seleccionada, la próxima tecla reemplaza el dígito en vez de sumarse al lado. */
function focusAndSelect(el: HTMLInputElement | null | undefined): void {
  if (!el) return;
  el.focus();
  el.select();
}

export interface OtpInputHandle {
  /** Vacía las casillas y enfoca la primera (p. ej. después de un código rechazado). */
  clear(): void;
  /** Enfoca la primera casilla vacía. */
  focus(): void;
}

export interface OtpInputProps {
  /** Nombre del `<input type="hidden">` que viaja en el formulario con el código completo. */
  name: string;
  length?: number;
  autoFocus?: boolean;
  disabled?: boolean;
  /** Marca las casillas como inválidas (borde de error y `aria-invalid`). */
  invalid?: boolean;
  /** `id` de la primera casilla, para un `<label htmlFor>` externo. */
  id?: string;
  /** Nombre accesible del grupo cuando no hay `aria-labelledby`. */
  label?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  /** Cada cambio del valor, completo o no. */
  onChange?: (value: string) => void;
  /**
   * Al completar las casillas por un gesto del usuario. El `<input type="hidden">` ya tiene el valor
   * cuando se llama, así que se puede enviar el formulario desde acá (`form.requestSubmit()`).
   */
  onComplete?: (value: string) => void;
  className?: string;
}

/**
 * Código de un solo uso en casillas: una `<input>` real por dígito.
 *
 * Se eligió una casilla real por dígito (y no un input único pintado como casillas) porque cada
 * dígito queda con su propio nombre accesible ("Dígito 3 de 6") y foco visible nativo, sin cursor
 * falso ni texto transparente que dependa del navegador. Lo que ese diseño suele romper está
 * cubierto en `otp-input-state.ts`:
 *
 *   - el autocompletado de iOS y de los gestores de contraseñas pone los 6 dígitos en la casilla
 *     enfocada: por eso NO hay `maxLength` (lo truncaría a uno) y un código completo se reparte
 *     entre todas;
 *   - pegar funciona en cualquier casilla;
 *   - retroceso borra hacia atrás, flechas/Inicio/Fin navegan, y sólo entran dígitos;
 *   - los teclados de Android no informan la tecla en `keydown`: esos casos se resuelven con el
 *     valor que queda en el evento `input`.
 *
 * Tamaño: 16 px o más de fuente (iOS hace zoom en campos con menos) y 48 px de alto. El ancho se
 * adapta: en un teléfono angosto las casillas se achican antes que desbordar la tarjeta.
 */
export const OtpInput = forwardRef<OtpInputHandle, OtpInputProps>(function OtpInput(
  {
    name,
    length = OTP_DEFAULT_LENGTH,
    autoFocus = false,
    disabled = false,
    invalid = false,
    id,
    label = 'Código de verificación',
    'aria-labelledby': labelledBy,
    'aria-describedby': describedBy,
    onChange,
    onComplete,
    className,
  },
  ref,
) {
  const [digits, setDigits] = useState<readonly string[]>(() => emptyOtp(length));
  // Fuente de verdad para calcular el siguiente estado dentro de un mismo evento: el pegado y el
  // autocompletado pueden disparar más de un evento antes de que React vuelva a pintar.
  const digitsRef = useRef<readonly string[]>(digits);
  const inputsRef = useRef<(HTMLInputElement | null)[]>([]);
  const hiddenRef = useRef<HTMLInputElement | null>(null);
  const pendingFocusRef = useRef<number | null>(null);

  function focusBox(index: number): void {
    focusAndSelect(inputsRef.current[index]);
  }

  // El foco se mueve DESPUÉS de que React escribió los valores: escribir `value` en una casilla
  // borra su selección, y sin selección la tecla siguiente se suma al dígito en vez de reemplazarlo.
  useLayoutEffect(() => {
    const target = pendingFocusRef.current;
    if (target === null) return;
    pendingFocusRef.current = null;
    focusAndSelect(inputsRef.current[target]);
  }, [digits]);

  function commit(update: OtpState): void {
    const before = otpValue(digitsRef.current);
    digitsRef.current = update.digits;
    pendingFocusRef.current = update.focus;
    setDigits(update.digits);

    const value = otpValue(update.digits);
    if (value === before) return;
    // El padre puede enviar el formulario dentro de `onComplete`; el FormData se arma en ese
    // momento, antes de que React pinte, así que el valor se escribe ya.
    if (hiddenRef.current) hiddenRef.current.value = value;
    onChange?.(value);
    if (isOtpComplete(update.digits)) onComplete?.(value);
  }

  useImperativeHandle(ref, () => ({
    clear() {
      commit({ digits: emptyOtp(length), focus: 0 });
    },
    focus() {
      focusBox(firstEmptyIndex(digitsRef.current));
    },
  }));

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>, index: number): void {
    if (event.nativeEvent.isComposing) return;
    const { key } = event;

    if (key === 'Backspace') {
      event.preventDefault();
      commit(applyBackspace(digitsRef.current, index));
      return;
    }
    if (key === 'Delete') {
      event.preventDefault();
      commit(applyDelete(digitsRef.current, index));
      return;
    }
    if (isOtpNavigationKey(key)) {
      event.preventDefault();
      focusBox(navigateOtp(index, key, length));
      return;
    }
    // Ctrl/Cmd+V, Ctrl+A, Tab, Enter: lo suyo.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (/^[0-9]$/.test(key)) {
      event.preventDefault();
      commit(applyDigit(digitsRef.current, index, key));
      return;
    }
    // Cualquier otro carácter imprimible no entra.
    if (key.length === 1) event.preventDefault();
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>, index: number): void {
    commit(applyInput(digitsRef.current, index, event.currentTarget.value));
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>, index: number): void {
    event.preventDefault();
    commit(applyPaste(digitsRef.current, index, event.clipboardData.getData('text')));
  }

  const value = otpValue(digits);

  return (
    <div
      role="group"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className={cn('grid w-full max-w-[20rem] gap-1 min-[400px]:gap-2', className)}
      style={{ gridTemplateColumns: `repeat(${length}, minmax(0, 1fr))` }}
    >
      {digits.map((digit, index) => (
        <input
          // El orden de las casillas no cambia nunca: el índice es la identidad.
          key={index}
          ref={(el) => {
            inputsRef.current[index] = el;
          }}
          id={index === 0 ? id : undefined}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          // En todas: iOS ofrece el código de Mensajes para la casilla que esté enfocada.
          autoComplete="one-time-code"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          autoFocus={autoFocus && index === 0}
          disabled={disabled}
          value={digit}
          aria-label={`Dígito ${index + 1} de ${length}`}
          aria-invalid={invalid || undefined}
          aria-describedby={index === 0 ? describedBy : undefined}
          data-filled={digit !== '' || undefined}
          onKeyDown={(event) => handleKeyDown(event, index)}
          onChange={(event) => handleChange(event, index)}
          onPaste={(event) => handlePaste(event, index)}
          onFocus={(event) => event.currentTarget.select()}
          className={cn(
            'h-12 w-full min-w-0 rounded-lg border bg-[var(--color-surface)] p-0 text-center sm:h-14',
            // 20 px: legible y por encima de los 16 px que evitan el zoom de iOS.
            'font-mono text-xl font-semibold tabular-nums text-[var(--color-fg)]',
            'border-[var(--color-border-strong)] shadow-[var(--shadow-xs)]',
            'caret-[var(--color-primary)] selection:bg-[var(--color-primary)]/20',
            'transition-[border-color,box-shadow] duration-150',
            'data-[filled=true]:border-[var(--color-fg-subtle)]',
            'focus-visible:border-[var(--color-primary)] focus-visible:outline-none',
            'focus-visible:ring-[3px] focus-visible:ring-[var(--color-primary)]/35',
            'aria-[invalid=true]:border-[var(--color-danger)] aria-[invalid=true]:focus-visible:ring-[var(--color-danger)]/30',
            'disabled:cursor-not-allowed disabled:bg-[var(--color-surface-muted)] disabled:text-[var(--color-fg-subtle)]',
          )}
        />
      ))}
      <input ref={hiddenRef} type="hidden" name={name} value={value} />
    </div>
  );
});
