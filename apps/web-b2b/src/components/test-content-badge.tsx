import { FlaskConical } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { TEST_CONTENT_LABEL, TEST_FARE_DESCRIPTION } from '../lib/test-content';
import { Badge } from './ui/badge';

/*
 * La marca de una tarifa o reserva del entorno de pruebas del proveedor. Va siempre, aunque la
 * pastilla del proveedor esté oculta: lo que se marca es que no es real, no de quién es.
 *
 * La explicación va en texto para el lector de pantalla y en `title` para el ratón. No es un
 * tooltip con foco a propósito: la etiqueta vive dentro de filas que ya son botones, y un elemento
 * enfocable dentro de un botón no es HTML válido. Tampoco `aria-label`: en un `span` sin rol no se
 * anuncia de forma fiable.
 */
export function TestContentBadge({
  label = TEST_CONTENT_LABEL,
  description = TEST_FARE_DESCRIPTION,
  className,
}: {
  label?: string;
  description?: string;
  className?: string;
}) {
  return (
    <Badge variant="warning" title={description} className={className}>
      <FlaskConical aria-hidden="true" />
      {label}
      <span className="sr-only">: {description}</span>
    </Badge>
  );
}

/** Aviso en bloque (checkout, detalle de una reserva). Mismo ámbar que la etiqueta. */
export function TestContentNotice({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="note"
      className={cn(
        'flex items-start gap-2.5 rounded-lg border border-[var(--color-warning)]/70 bg-[var(--color-warning)]/10 px-4 py-3 text-sm text-[var(--color-fg)]',
        className,
      )}
    >
      <FlaskConical aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <p>{children}</p>
    </div>
  );
}
