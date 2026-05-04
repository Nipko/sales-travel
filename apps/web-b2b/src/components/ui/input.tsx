import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        ref={ref}
        className={cn(
          'flex h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] shadow-[var(--shadow-xs)]',
          'placeholder:text-[var(--color-fg-subtle)]',
          'focus-visible:outline-none focus-visible:border-[var(--color-primary)] focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'transition-colors',
          className,
        )}
        {...props}
      />
    );
  },
);
Input.displayName = 'Input';
