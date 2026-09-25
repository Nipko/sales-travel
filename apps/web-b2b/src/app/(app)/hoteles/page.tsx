'use client';

import { Hotel, Info, Loader2, Search, TriangleAlert } from 'lucide-react';
import { useActionState, useState } from 'react';
import { cn } from '../../../lib/cn';
import { searchHotelsAction, type HotelProviderOutcome, type HotelSearchResult } from './actions';
import { DestinationCombobox } from './_components/destination-combobox';
import { HotelResultCard } from './_components/hotel-result-card';
import { degradedProviders } from './_components/hotel-provider-view';
import { RoomsPicker } from './_components/rooms-picker';

const INITIAL: HotelSearchResult = {
  ok: false,
  hotels: [],
  providers: [],
  showProviderInResults: false,
};

const inputClass = cn(
  'flex h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] shadow-[var(--shadow-xs)]',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/30 focus-visible:border-[var(--color-primary)]',
  'transition-all duration-150',
);

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Resultados incompletos: un proveedor no respondió, se omitió en esta búsqueda o respondió con
 * tarifas que no se pueden mostrar. Sin este aviso, una lista corta —o vacía— se lee como "no hay
 * más hoteles", y eso es lo que el vendedor le dice a su cliente.
 */
function DegradedProvidersNotice({ providers }: { providers: HotelProviderOutcome[] }) {
  const degraded = degradedProviders(providers);
  if (degraded.length === 0) return null;

  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-lg border border-[var(--color-danger)]/35 bg-[var(--color-danger)]/5 px-4 py-3 text-sm text-[var(--color-fg)]"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--color-danger)]" />
      <div>
        <strong className="font-semibold">
          Resultados incompletos:{' '}
          {degraded.length === 1
            ? 'un proveedor no aportó todas sus tarifas'
            : `${degraded.length} proveedores no aportaron todas sus tarifas`}
          .
        </strong>{' '}
        Puede haber hoteles y tarifas que no se están mostrando.
        <ul className="mt-1.5 space-y-0.5 text-xs text-[var(--color-fg-muted)]">
          {degraded.map((p) => (
            <li key={p.code}>
              <span className="font-medium">{p.code}</span>
              {p.reason ? ` · ${p.reason}` : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default function HotelesPage() {
  const [state, formAction, isPending] = useActionState(searchHotelsAction, INITIAL);
  const [checkin, setCheckin] = useState('');
  const [checkout, setCheckout] = useState('');
  const today = todayISO();

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      <header className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-lg bg-[var(--color-primary)]/10">
          <Hotel className="size-5 text-[var(--color-primary)]" />
        </div>
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-[var(--color-fg)]">Hoteles</h1>
          <p className="text-xs text-[var(--color-fg-muted)]">
            Disponibilidad en los proveedores de hoteles habilitados para tu agencia
          </p>
        </div>
      </header>

      <form
        action={formAction}
        className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-xs)]"
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <DestinationCombobox />

          <div className="space-y-1.5">
            <label
              htmlFor="checkinDate"
              className="block text-xs font-medium text-[var(--color-fg)]"
            >
              Entrada
            </label>
            <input
              id="checkinDate"
              name="checkinDate"
              type="date"
              required
              min={today}
              value={checkin}
              onChange={(e) => {
                setCheckin(e.target.value);
                if (checkout && e.target.value >= checkout) setCheckout('');
              }}
              className={inputClass}
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="checkoutDate"
              className="block text-xs font-medium text-[var(--color-fg)]"
            >
              Salida
            </label>
            <input
              id="checkoutDate"
              name="checkoutDate"
              type="date"
              required
              min={checkin || today}
              value={checkout}
              onChange={(e) => setCheckout(e.target.value)}
              className={inputClass}
            />
          </div>

          <RoomsPicker />
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
          <div className="space-y-1.5">
            <label htmlFor="hotelIds" className="block text-xs font-medium text-[var(--color-fg)]">
              IDs de hotel (opcional)
            </label>
            <input
              id="hotelIds"
              name="hotelIds"
              type="text"
              placeholder="Ej: 123456, 789012"
              className={inputClass}
            />
          </div>

          <label className="flex h-10 items-center gap-2 text-xs text-[var(--color-fg-muted)]">
            <input
              type="checkbox"
              name="refundableOnly"
              className="size-4 accent-[var(--color-primary)]"
            />
            Solo reembolsables
          </label>
        </div>

        <div className="mt-3 flex items-start gap-2 rounded-lg bg-[var(--color-surface-muted)] px-3 py-2 text-[11px] text-[var(--color-fg-muted)]">
          <Info className="mt-0.5 size-3.5 shrink-0 text-[var(--color-fg-subtle)]" />
          <span>
            Elegí un destino del autocompletado y buscamos por ciudad (resolvemos los IDs vía el
            catálogo de inventario). Opcionalmente podés forzar IDs de hotel específicos. El
            catálogo se sincroniza al configurar las credenciales del proveedor.
          </span>
        </div>

        <div className="mt-4 flex justify-end">
          <button
            type="submit"
            disabled={isPending}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-[var(--color-primary)] px-5 text-sm font-medium text-[var(--color-primary-fg)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" /> Buscando…
              </>
            ) : (
              <>
                <Search className="size-4" /> Buscar hoteles
              </>
            )}
          </button>
        </div>
      </form>

      {state.error ? (
        <div className="rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 px-4 py-3 text-sm text-[var(--color-danger)]">
          {state.error}
        </div>
      ) : null}

      {state.ok ? <DegradedProvidersNotice providers={state.providers} /> : null}

      {state.ok ? (
        state.hotels.length > 0 ? (
          <div className="space-y-3">
            <p className="text-xs text-[var(--color-fg-muted)]">
              {state.hotels.length} hotel{state.hotels.length === 1 ? '' : 'es'} con disponibilidad
            </p>
            {/* Con varios proveedores, dos pueden devolver el mismo id de hotel: el id solo no
                es una clave única de la lista. */}
            {state.hotels.map((offer, i) => (
              <HotelResultCard
                key={`${i}:${offer.hotelId}`}
                offer={offer}
                showProvider={state.showProviderInResults}
              />
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-10 text-center">
            <Hotel className="mx-auto mb-2 size-6 text-[var(--color-fg-subtle)]" />
            <p className="text-sm text-[var(--color-fg-muted)]">
              Sin disponibilidad para esos hoteles y fechas.
            </p>
          </div>
        )
      ) : null}
    </div>
  );
}
