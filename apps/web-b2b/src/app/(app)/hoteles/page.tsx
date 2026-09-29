'use client';

import { Hotel, Info, Loader2, RefreshCw, Search, TriangleAlert } from 'lucide-react';
import { startTransition, useActionState, useEffect, useRef, useState } from 'react';
import { cn } from '../../../lib/cn';
import {
  hotelSearchCurrenciesAction,
  hotelSearchWalletsAction,
  searchHotelsAction,
  type HotelProviderOutcome,
  type HotelSearchResult,
} from './actions';
import { CurrencyField } from './_components/currency-field';
import { DestinationCombobox } from './_components/destination-combobox';
import { HotelResultCard } from './_components/hotel-result-card';
import { degradedProviders, emptyResultsView } from './_components/hotel-provider-view';
import {
  detailLinkForOffer,
  newSearchToken,
  saveSearchHandoff,
  stayOfCriteria,
} from './_components/hotel-search-handoff';
import { NationalityField, rememberNationality } from './_components/nationality-field';
import { OfferExpiry } from './_components/offer-expiry';
import { RoomsPicker } from './_components/rooms-picker';
import {
  currencyFromQuery,
  currencySwitchSuggestion,
  initialSearchCurrency,
  queryWithCurrency,
  type SearchCurrencies,
} from './_components/search-currency';
import { searchWalletNotice, type SearchWallets } from './_components/search-wallet';

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
 *
 * Si un proveedor quedó fuera por cotizar en otra moneda que la agencia puede usar, ofrece repetir
 * la búsqueda en esa moneda (D-TBO-15): es lo único que el vendedor puede hacer para verlo.
 */
function DegradedProvidersNotice({
  providers,
  switchTo,
  onSearchIn,
  searching,
}: {
  providers: HotelProviderOutcome[];
  switchTo?: string;
  onSearchIn: (currency: string) => void;
  searching: boolean;
}) {
  const degraded = degradedProviders(providers);
  if (degraded.length === 0) return null;

  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-lg border border-[var(--color-danger)]/35 bg-[var(--color-danger)]/5 px-4 py-3 text-sm text-[var(--color-fg)]"
    >
      <TriangleAlert
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-[var(--color-danger)]"
      />
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
        {switchTo ? (
          <div className="mt-2.5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-[var(--color-fg-muted)]">
              Hay tarifas en {switchTo} que no se muestran: buscá en {switchTo} para verlas. No se
              convierte ningún precio.
            </p>
            <button
              type="button"
              onClick={() => onSearchIn(switchTo)}
              disabled={searching}
              className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs font-medium text-[var(--color-fg)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/30 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RefreshCw
                aria-hidden="true"
                className={cn('size-3.5', searching && 'animate-spin')}
              />
              Buscar en {switchTo}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default function HotelesPage() {
  const [state, formAction, isPending] = useActionState(searchHotelsAction, INITIAL);
  const [checkin, setCheckin] = useState('');
  const [checkout, setCheckout] = useState('');
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [expiredCutoffMs, setExpiredCutoffMs] = useState<number | undefined>(undefined);
  const formRef = useRef<HTMLFormElement>(null);
  const today = todayISO();

  // Moneda de la búsqueda (D-TBO-15): la lista la da el API; la elección se recuerda en la URL.
  const [currencyOptions, setCurrencyOptions] = useState<SearchCurrencies | null | undefined>(
    undefined,
  );
  const [currency, setCurrency] = useState('');
  useEffect(() => {
    let cancelled = false;
    hotelSearchCurrenciesAction()
      .catch(() => null)
      .then((options) => {
        if (cancelled) return;
        setCurrencyOptions(options);
        if (options !== null) {
          setCurrency(initialSearchCurrency(options, currencyFromQuery(window.location.search)));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Las carteras de la agencia, para avisar antes de elegir un hotel si no va a poder reservar en
  // la moneda elegida (una reserva se retiene en la cartera de la moneda de su tarifa).
  const [searchWallets, setSearchWallets] = useState<SearchWallets | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    hotelSearchWalletsAction()
      .catch(() => null)
      .then((wallets) => {
        if (!cancelled) setSearchWallets(wallets);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const walletNotice = searchWalletNotice(searchWallets, currency);

  function chooseCurrency(next: string) {
    setCurrency(next);
    if (!currencyOptions) return;
    const { pathname, search, hash } = window.location;
    const query = queryWithCurrency(search, next, currencyOptions.defaultCurrency);
    // `null`, como indica Next: su router conserva su propio estado y se entera del cambio.
    window.history.replaceState(null, '', `${pathname}${query}${hash}`);
  }

  /** "Buscar en USD" del aviso: la misma búsqueda, con la otra moneda. */
  function searchIn(next: string) {
    const form = formRef.current;
    if (!form) return;
    chooseCurrency(next);
    // El valor del campo todavía es el anterior hasta el próximo render: se pisa en los datos.
    const data = new FormData(form);
    data.set('currency', next);
    startTransition(() => formAction(data));
  }

  // `expiresAt` lo fija el servidor: el contador corre con SU reloj, no con el del navegador,
  // que puede estar minutos corrido.
  useEffect(() => {
    if (state.receivedAt !== undefined) setClockOffsetMs(state.receivedAt - Date.now());
  }, [state.receivedAt]);

  const searchedNationality = state.criteria?.guestNationality;
  useEffect(() => {
    if (searchedNationality) rememberNationality(searchedNationality);
  }, [searchedNationality]);

  // Cada búsqueda que sale bien deja su estadía y su divulgación para los detalles que se abran
  // desde ella, con un identificador propio: dos búsquedas en dos pestañas no se pisan.
  const [handoffToken, setHandoffToken] = useState<
    { readonly forState: HotelSearchResult; readonly token: string } | undefined
  >(undefined);
  useEffect(() => {
    const stay = state.ok && state.criteria ? stayOfCriteria(state.criteria) : undefined;
    if (stay === undefined) {
      setHandoffToken(undefined);
      return;
    }
    const token = newSearchToken();
    saveSearchHandoff(token, {
      stay,
      showProviderInResults: state.showProviderInResults,
      savedAt: Date.now(),
    });
    setHandoffToken({ forState: state, token });
  }, [state]);
  // Sólo el identificador de ESTA búsqueda: en el render que trae resultados nuevos, antes del
  // efecto, el anterior abriría estos hoteles con las fechas y la nacionalidad de la otra.
  const searchToken = handoffToken?.forState === state ? handoffToken.token : undefined;

  const hotelCount = state.hotels.length;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      <header className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-lg bg-[var(--color-primary)]/10">
          <Hotel aria-hidden="true" className="size-5 text-[var(--color-primary)]" />
        </div>
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-[var(--color-fg)]">Hoteles</h1>
          <p className="text-xs text-[var(--color-fg-muted)]">
            Disponibilidad en los proveedores de hoteles habilitados para tu agencia
          </p>
        </div>
      </header>

      {/* El envío lo hace `onSubmit`: React vacía un formulario después de correr su `action`, y
          "Buscar de nuevo" tiene que repetir LA MISMA búsqueda —IDs, solo reembolsables y
          nacionalidad incluidos—, no una con la mitad de los campos en blanco. Con
          `preventDefault` React no corre el `action` ni vacía nada; el `action` queda para un
          envío antes de hidratar, que sin él saldría por GET con la búsqueda y la nacionalidad
          en la URL. */}
      <form
        ref={formRef}
        action={formAction}
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          startTransition(() => formAction(data));
        }}
        className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-xs)] sm:p-5"
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

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,13rem)_minmax(0,1fr)_auto] xl:items-start">
          <NationalityField />

          <CurrencyField
            options={currencyOptions}
            value={currency}
            onChange={chooseCurrency}
            walletNotice={walletNotice}
          />

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

          <label className="flex h-10 items-center gap-2 text-xs text-[var(--color-fg-muted)] sm:mt-[1.375rem]">
            <input
              type="checkbox"
              name="refundableOnly"
              className="size-4 accent-[var(--color-primary)]"
            />
            Solo reembolsables
          </label>
        </div>

        <div className="mt-3 flex items-start gap-2 rounded-lg bg-[var(--color-surface-muted)] px-3 py-2 text-[11px] text-[var(--color-fg-muted)]">
          <Info
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0 text-[var(--color-fg-subtle)]"
          />
          <span>
            Elegí un destino del autocompletado y buscamos en el catálogo de hoteles de cada
            proveedor habilitado. Si necesitás hoteles puntuales, podés escribir sus IDs. Los
            catálogos se actualizan todas las noches: un destino o un hotel nuevo puede tardar un
            día en aparecer.
          </span>
        </div>

        <div className="mt-4 flex justify-end">
          <button
            type="submit"
            disabled={isPending}
            className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-[var(--color-primary)] px-5 text-sm font-medium text-[var(--color-primary-fg)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
          >
            {isPending ? (
              <>
                <Loader2 aria-hidden="true" className="size-4 animate-spin" /> Buscando…
              </>
            ) : (
              <>
                <Search aria-hidden="true" className="size-4" /> Buscar hoteles
              </>
            )}
          </button>
        </div>
      </form>

      {state.error ? (
        <div
          role="alert"
          className="rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 px-4 py-3 text-sm text-[var(--color-danger)]"
        >
          {state.error}
        </div>
      ) : null}

      {state.ok ? (
        <DegradedProvidersNotice
          providers={state.providers}
          switchTo={currencySwitchSuggestion(
            state.providers,
            currencyOptions?.currencies,
            state.criteria?.currency ?? currencyOptions?.defaultCurrency,
          )}
          onSearchIn={searchIn}
          searching={isPending}
        />
      ) : null}

      {state.ok ? (
        hotelCount > 0 ? (
          <section
            aria-labelledby="hotel-results-title"
            aria-busy={isPending}
            className={cn('space-y-3 transition-opacity', isPending && 'opacity-60')}
          >
            <OfferExpiry
              hotels={state.hotels}
              clockOffsetMs={clockOffsetMs}
              onCutoffChange={setExpiredCutoffMs}
              onSearchAgain={() => formRef.current?.requestSubmit()}
              searching={isPending}
            >
              <h2 id="hotel-results-title" className="font-normal">
                {hotelCount} hotel{hotelCount === 1 ? '' : 'es'} con disponibilidad · precios de
                venta{state.criteria?.currency ? ` en ${state.criteria.currency}` : ''} por la
                estadía completa
              </h2>
            </OfferExpiry>
            {/* Con varios proveedores, dos pueden devolver el mismo id de hotel: el id solo no
                es una clave única de la lista. */}
            {state.hotels.map((offer, i) => {
              const detail =
                searchToken === undefined ? undefined : detailLinkForOffer(offer, searchToken);
              return (
                <HotelResultCard
                  key={`${i}:${offer.hotelId}`}
                  offer={offer}
                  showProvider={state.showProviderInResults}
                  nights={state.criteria?.nights}
                  expiredCutoffMs={expiredCutoffMs}
                  detailHref={detail}
                />
              );
            })}
          </section>
        ) : (
          <EmptyResults providers={state.providers} />
        )
      ) : null}
    </div>
  );
}

/** Sin hoteles (U-08): qué pasó, dicho de forma que el vendedor pueda repetírselo al cliente. */
function EmptyResults({ providers }: { providers: HotelProviderOutcome[] }) {
  const view = emptyResultsView(providers);
  return (
    <div
      role="status"
      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-10 text-center"
    >
      <Hotel aria-hidden="true" className="mx-auto mb-2 size-6 text-[var(--color-fg-subtle)]" />
      <p className="text-sm font-medium text-[var(--color-fg)]">{view.title}</p>
      <p className="mx-auto mt-1 max-w-md text-xs text-[var(--color-fg-muted)]">{view.hint}</p>
    </div>
  );
}
