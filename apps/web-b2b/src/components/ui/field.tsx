'use client';

import { forwardRef, useId, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

/**
 * Sistema único de campo de formulario.
 *
 * Convivían CUATRO: la clase global `.form-input` de globals.css, el componente `Input`,
 * y once copias literales del mismo `inputClass` pegadas en distintas páginas. Cada una
 * con su propio alto, su propio radio y su propio anillo de foco, así que dos formularios
 * contiguos no se veían igual — y arreglar el foco en uno no arreglaba los otros.
 *
 * `Field` agrega además lo que ninguna de las cuatro tenía: label asociado por id
 * generado, mensaje de error con `role="alert"` y `aria-invalid`/`aria-describedby`
 * correctos, que es lo que hace que un lector de pantalla anuncie el error.
 */

const CONTROL = [
  'w-full rounded-lg border bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)]',
  'border-[var(--color-border)] placeholder:text-[var(--color-fg-subtle)]',
  'transition-[border-color,box-shadow] duration-150',
  'hover:not-disabled:border-[var(--color-border-strong)]',
  'focus-visible:border-[var(--color-primary)] focus-visible:outline-none',
  'focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20',
  'disabled:cursor-not-allowed disabled:bg-[var(--color-surface-muted)] disabled:text-[var(--color-fg-subtle)]',
  'aria-[invalid=true]:border-[var(--color-danger)] aria-[invalid=true]:ring-[var(--color-danger)]/20',
].join(' ');

/** Alto único: 2.25rem. Antes convivían h-9, h-10 y py-2 según la página. */
const HEIGHT = 'h-9';

export const TextInput = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function TextInput({ className, ...props }, ref) {
    return <input ref={ref} className={cn(CONTROL, HEIGHT, className)} {...props} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...props }, ref) {
    return (
      <select ref={ref} className={cn(CONTROL, HEIGHT, 'pr-8', className)} {...props}>
        {children}
      </select>
    );
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn(CONTROL, 'min-h-20 py-2', className)} {...props} />;
});

export const Checkbox = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Checkbox({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        type="checkbox"
        className={cn(
          'size-4 rounded border-[var(--color-border)] accent-[var(--color-primary)]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20',
          className,
        )}
        {...props}
      />
    );
  },
);

/**
 * Envoltura con label, ayuda y error.
 *
 * `children` recibe los props de accesibilidad ya calculados: no hay que acordarse de
 * cablear aria-invalid ni aria-describedby en cada formulario, que es justo lo que hoy
 * no hace ninguno.
 */
export function Field({
  label,
  error,
  hint,
  required,
  className,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  required?: boolean;
  className?: string;
  children: (props: {
    id: string;
    'aria-invalid': boolean;
    'aria-describedby': string | undefined;
  }) => ReactNode;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = error ? errorId : hint ? hintId : undefined;

  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={id} className="block text-xs font-semibold text-[var(--color-fg)]">
        {label}
        {required ? (
          <span className="ml-0.5 text-[var(--color-danger)]" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>

      {children({ id, 'aria-invalid': Boolean(error), 'aria-describedby': describedBy })}

      {error ? (
        <p id={errorId} role="alert" className="text-xs text-[var(--color-danger)]">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-xs text-[var(--color-fg-subtle)]">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
