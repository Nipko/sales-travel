'use client';

import { AlertCircle, Info, Loader2 } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { Button, type ButtonProps } from '../../../components/ui/button';
import { Card } from '../../../components/ui/card';
import { cn } from '../../../lib/cn';

/**
 * Piezas comunes de los pasos del login. El título de cada paso es el `h1` de la página: es lo que
 * un lector de pantalla necesita saber al cambiar de paso ("Verificación en dos pasos").
 */
export function StepCard({
  title,
  description,
  descriptionId,
  focusTitle = false,
  focusKey,
  titleDescribedBy,
  children,
}: {
  title: string;
  description?: ReactNode;
  descriptionId?: string;
  /** Enfoca el título al montar: para los pasos que no empiezan con un campo que escribir. */
  focusTitle?: boolean;
  /**
   * Con `focusTitle`, lo vuelve a enfocar cada vez que cambia: una respuesta nueva sin cambiar de
   * paso. El botón que se usó para enviar se deshabilita mientras tanto y el navegador manda el
   * foco al body; sin esto, con el teclado había que volver a recorrer la página.
   */
  focusKey?: number;
  /** Lo que un lector de pantalla lee junto con el título al enfocarlo (el error o aviso nuevo). */
  titleDescribedBy?: string;
  children: ReactNode;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (focusTitle) titleRef.current?.focus();
  }, [focusTitle, focusKey]);

  return (
    <Card className="overflow-hidden rounded-xl border-[var(--color-border)] shadow-[var(--shadow-md)]">
      <div className="space-y-1.5 px-5 pt-5 sm:px-6 sm:pt-6">
        <h1
          ref={titleRef}
          tabIndex={-1}
          aria-describedby={titleDescribedBy}
          // Recibe el foco sólo por código (para que el lector anuncie el paso nuevo), no es un
          // control: sin el anillo global de `:focus-visible`, que acá parecía un campo.
          className="text-lg font-semibold tracking-tight text-[var(--color-fg)] outline-none!"
        >
          {title}
        </h1>
        {description ? (
          <p id={descriptionId} className="text-sm leading-relaxed text-[var(--color-fg-muted)]">
            {description}
          </p>
        ) : null}
      </div>
      <div className="px-5 pb-5 pt-5 sm:px-6 sm:pb-6">{children}</div>
    </Card>
  );
}

/**
 * Error (`role="alert"`, se anuncia al aparecer) o aviso (`role="status"`, cortés). Siempre con
 * texto: el color solo no alcanza para quien no distingue el rojo.
 *
 * Quien lo usa le pone `key` con el intento: un texto igual al de la respuesta anterior no cambia el
 * DOM y no se vuelve a anunciar, así que se remonta en cada respuesta.
 */
export function FormAlert({
  id,
  tone,
  children,
  className,
}: {
  id?: string;
  tone: 'error' | 'notice';
  children: ReactNode;
  className?: string;
}) {
  const Icon = tone === 'error' ? AlertCircle : Info;
  return (
    <div
      id={id}
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex gap-2.5 rounded-lg border px-3 py-2.5 text-sm leading-snug',
        tone === 'error'
          ? 'border-[var(--color-danger)]/25 bg-[var(--color-danger)]/5 text-[var(--color-danger)]'
          : 'border-[var(--color-border-strong)] bg-[var(--color-surface-muted)] text-[var(--color-fg)]',
        className,
      )}
    >
      <Icon
        className={cn(
          'mt-0.5 size-4 shrink-0',
          tone === 'notice' && 'text-[var(--color-fg-muted)]',
        )}
        aria-hidden="true"
      />
      <div className="min-w-0 space-y-1">{children}</div>
    </div>
  );
}

/** Botón que muestra el envío en curso. 44 px de alto en el teléfono: se toca con el pulgar. */
export function PendingButton({
  pending,
  pendingLabel,
  children,
  className,
  ...props
}: ButtonProps & { pending: boolean; pendingLabel: string }) {
  return (
    <Button
      {...props}
      disabled={pending || props.disabled}
      className={cn('h-11 w-full text-sm font-semibold sm:h-10', className)}
    >
      {pending ? (
        <>
          <Loader2 className="animate-spin" aria-hidden="true" />
          {pendingLabel}
        </>
      ) : (
        children
      )}
    </Button>
  );
}

/**
 * Anuncia el envío en curso a un lector de pantalla. La región existe siempre, vacía: una región
 * que aparece junto con su texto no se anuncia en todos los lectores.
 */
export function PendingAnnouncer({ pending, label }: { pending: boolean; label: string }) {
  return (
    <p className="sr-only" aria-live="polite">
      {pending ? label : ''}
    </p>
  );
}

/** Los ids presentes, separados por espacio, para `aria-describedby`; `undefined` si no hay. */
export function describedBy(...ids: (string | false | null | undefined)[]): string | undefined {
  const present = ids.filter((id): id is string => typeof id === 'string' && id !== '');
  return present.length > 0 ? present.join(' ') : undefined;
}

/** Link o botón con pinta de link, con área táctil suficiente aunque el texto sea chico. */
export const TEXT_ACTION_CLASS = cn(
  'inline-flex min-h-11 items-center gap-1.5 rounded-md text-sm font-medium sm:min-h-8',
  'text-[var(--color-primary)] underline-offset-4 hover:underline',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]',
  'disabled:pointer-events-none disabled:opacity-50',
);
