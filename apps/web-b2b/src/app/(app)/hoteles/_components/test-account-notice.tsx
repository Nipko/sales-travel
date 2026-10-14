import { FlaskConical, TriangleAlert } from 'lucide-react';
import { cn } from '../../../../lib/cn';
import type { HotelAccountEnvironment } from '../actions';
import type { TestAccountView } from './hotel-provider-view';

/*
 * Los avisos de una cuenta de prueba del proveedor (hoy, la cuenta TEST de TBO): una reserva con ella
 * se puede hacer para probar el flujo, pero no es una habitación de verdad. Sin esto se veía igual
 * que una real. Van siempre, como el de una tarifa simulada en vuelos; el ajuste de divulgación sólo
 * decide si el aviso nombra al proveedor.
 */

const NOTICE_BOX =
  'flex items-start gap-2.5 rounded-lg border border-[var(--color-warning)]/70 bg-[var(--color-warning)]/10 px-4 py-3 text-sm text-[var(--color-fg)]';

/** El texto del aviso de resultados y ficha. */
export function testAccountNoticeText(view: TestAccountView): string {
  const who =
    view.providerLabel === undefined
      ? 'Algunas tarifas vienen de una cuenta de prueba de un proveedor'
      : `Las tarifas de ${view.providerLabel} vienen de una cuenta de prueba`;
  return `${who}: puedes reservarlas para probar el flujo, pero no son habitaciones reales para un cliente.`;
}

/** Arriba de la lista de resultados y de las tarifas de la ficha. Sin tarifas de prueba, nada. */
export function TestAccountNotice({
  view,
  className,
}: {
  view: TestAccountView | undefined;
  className?: string;
}) {
  if (view === undefined || view.codes.size === 0) return null;
  return (
    <div role="note" className={cn(NOTICE_BOX, className)}>
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <p>{testAccountNoticeText(view)}</p>
    </div>
  );
}

/**
 * La etiqueta de cada plan de un proveedor de prueba. Va aunque la pastilla del proveedor esté
 * oculta: lo que se marca es que la tarifa no es real, no de quién es.
 */
export function TestAccountTag() {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-[var(--color-warning)]/70 bg-[var(--color-warning)]/20 px-1.5 py-px text-xs font-semibold text-[var(--color-fg)]">
      <FlaskConical aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="sr-only">Tarifa de una cuenta de </span>
      Prueba
    </span>
  );
}

export const TEST_BOOKING_NOTICE =
  'esta reserva no es real y no le asegura una habitación a tu cliente.';

/**
 * En el checkout, en la tarifa revalidada y junto al botón que reserva: el PreBook dijo que la
 * cuenta que la va a reservar es de prueba.
 */
export function TestBookingNotice({
  environment,
  className,
}: {
  environment: HotelAccountEnvironment | undefined;
  className?: string;
}) {
  if (environment !== 'test') return null;
  return (
    <div
      role="note"
      className={cn(
        'flex items-start gap-2 rounded-md border border-[var(--color-warning)]/70 bg-[var(--color-warning)]/10 px-2.5 py-2 text-xs text-[var(--color-fg)]',
        className,
      )}
    >
      <TriangleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
      <p>
        <strong className="font-semibold">Cuenta de prueba:</strong> {TEST_BOOKING_NOTICE}
      </p>
    </div>
  );
}
