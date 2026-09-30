import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../../../../lib/cn';

type Tone = 'error' | 'success' | 'warning' | 'info';

const TONE: Record<Tone, { box: string; icon: string }> = {
  error: {
    box: 'border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5',
    icon: 'text-[var(--color-danger)]',
  },
  success: {
    box: 'border-[var(--color-success)]/30 bg-[var(--color-success)]/5',
    icon: 'text-[var(--color-success)]',
  },
  warning: {
    box: 'border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10',
    icon: 'text-[var(--color-fg)]',
  },
  info: {
    box: 'border-[var(--color-border)] bg-[var(--color-surface-muted)]',
    icon: 'text-[var(--color-fg-muted)]',
  },
};

const ICON = { error: XCircle, success: CheckCircle2, warning: AlertTriangle, info: Info };

/**
 * Aviso dentro de una tarjeta. El texto va siempre en `--color-fg`: el verde y el rojo del tema
 * sobre su propio tinte no llegan a 4.5:1 en letra chica (WCAG AA); el color queda en el borde y
 * en el ícono, que no son la única pista (el texto dice lo mismo).
 *
 * Los errores se anuncian enseguida (`alert`); lo demás, cuando el lector termina (`status`).
 */
export function Notice({
  tone,
  title,
  children,
  className,
  id,
}: {
  tone: Tone;
  title?: string;
  children?: ReactNode;
  className?: string;
  id?: string;
}) {
  const Icon = ICON[tone];
  return (
    <div
      id={id}
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm text-[var(--color-fg)]',
        TONE[tone].box,
        className,
      )}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', TONE[tone].icon)} aria-hidden="true" />
      <div className="min-w-0 space-y-0.5">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? (
          <div className={title ? 'text-[var(--color-fg-muted)]' : undefined}>{children}</div>
        ) : null}
      </div>
    </div>
  );
}
