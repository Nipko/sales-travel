import { ArrowLeft, Hotel } from 'lucide-react';
import Link from 'next/link';
import { decodeHotelKey } from '../_components/hotel-key';
import { isSearchToken } from '../_components/hotel-search-handoff';
import { HotelDetail } from './_components/hotel-detail';

/**
 * Detalle de un hotel (PR-6.2): la ficha de contenido y las tarifas de cada proveedor que lo vende
 * para la estadía de la búsqueda desde la que se abrió. La clave dice qué hoteles pedir; la
 * búsqueda —fechas, habitaciones, nacionalidad— queda en este navegador y no viaja en la URL.
 */
export default async function HotelDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ hotelKey: string }>;
  searchParams: Promise<{ busqueda?: string | string[] }>;
}) {
  const [{ hotelKey }, { busqueda }] = await Promise.all([params, searchParams]);
  const refs = decodeHotelKey(hotelKey);
  if (refs === undefined) return <UnknownHotel />;
  const searchToken = isSearchToken(busqueda) ? busqueda : undefined;
  return <HotelDetail hotelKey={hotelKey} refs={refs} searchToken={searchToken} />;
}

function UnknownHotel() {
  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-10 text-center">
        <Hotel aria-hidden="true" className="mx-auto mb-2 size-6 text-[var(--color-fg-subtle)]" />
        <h1 className="text-sm font-medium text-[var(--color-fg)]">No reconocemos ese hotel.</h1>
        <p className="mx-auto mt-1 max-w-md text-xs text-[var(--color-fg-muted)]">
          El enlace está incompleto o no es de un hotel. Abrilo desde los resultados de una
          búsqueda.
        </p>
        <Link
          href="/hoteles"
          className="mt-4 inline-flex items-center gap-1 rounded text-xs font-medium text-[var(--color-fg)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
        >
          <ArrowLeft aria-hidden="true" className="size-3.5" />
          Ir a Hoteles
        </Link>
      </div>
    </div>
  );
}
