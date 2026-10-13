import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

/*
 * Etiqueta corta junto a un dato (estado, origen de una tarifa). No es interactiva: va dentro de
 * filas que ya son botones, así que no recibe foco ni lleva su propio `onClick`.
 *
 * `warning` pinta el ámbar como FONDO tenue con el texto en `--color-fg`: el ámbar como color de
 * texto no llega a AA sobre blanco (ver la escala de `flight-row.tsx`), el texto principal sí, en
 * los dos temas.
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-px text-xs font-semibold [&_svg]:size-3.5 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        neutral:
          'border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]',
        warning:
          'border-[var(--color-warning)]/70 bg-[var(--color-warning)]/20 text-[var(--color-fg)]',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
