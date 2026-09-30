'use client';

import { Hotel, Info, RefreshCw, TriangleAlert } from 'lucide-react';
import { startTransition, useActionState, useEffect, useId, useRef, useState } from 'react';
import {
  DateRangePicker,
  EMPTY_RANGE,
  rangeLengthLabel,
  todayIso,
  type DateRange,
} from '../../../components/ui/date-range-picker';
import {
  ResultsSkeletonFrame,
  SearchButtonLabel,
  SearchLoading,
} from '../../../components/ui/search-loading';
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
import { degradedProviders, emptyResultsView } from './_components/hotel-provider-view';
import { HotelResultSkeleton } from './_components/hotel-result-card';
import { HotelResults } from './_components/hotel-results';
import {
  newSearchToken,
  saveSearchHandoff,
  stayOfCriteria,
} from './_components/hotel-search-handoff';
import { NationalityField, rememberNationality } from './_components/nationality-field';
import { RoomsPicker } from './_components/rooms-picker';
import {
  currencyFromQuery,
  currencySwitchSuggestion,
  initialSearchCurrency,
  queryWithCurrency,
  type SearchCurrencies,
} from './_components/search-currency';
import { SearchSummaryBar } from './_components/search-summary-bar';
import { searchWalletNotice, type SearchWallets } from './_components/search-wallet';
import { searchingEcho, stayDatesProblem, type StayDatesProblem } from './_components/stay-dates';

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
              Hay tarifas en {switchTo} que no se muestran: busca en {switchTo} para verlas. No se
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
                className={cn('size-3.5', searching && 'animate-spin motion-reduce:animate-none')}
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
  // Entrada y salida en un solo calendario, como vuelos: primer clic la entrada, segundo la salida.
  const [dates, setDates] = useState<DateRange>(EMPTY_RANGE);
  const [datesProblem, setDatesProblem] = useState<string | null>(null);
  const datesIds = {
    label: useId(),
    nights: useId(),
    checkin: useId(),
    checkout: useId(),
    error: useId(),
  };
  const nightsLabel = rangeLengthLabel(dates, 'stay');
  const datesDescribedBy =
    [nightsLabel !== null ? datesIds.nights : null, datesProblem !== null ? datesIds.error : null]
      .filter(Boolean)
      .join(' ') || undefined;
  /** Qué se está buscando, congelado al enviar: si el vendedor sigue tocando, la espera no miente. */
  const [echo, setEcho] = useState('');
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const formId = useId();
  const today = todayIso();

  // Con resultados, el formulario se pliega detrás de la barra de la búsqueda; "Editar búsqueda"
  // lo vuelve a abrir con los mismos datos (sigue montado, sólo oculto). Cada búsqueda nueva lo
  // vuelve a plegar. Sin hoteles no se pliega: lo siguiente es cambiar la búsqueda.
  const [editing, setEditing] = useState(false);
  const resultsHeadingId = useId();
  const summaryId = useId();
  // El envío salió del formulario, que se pliega con el foco adentro: el foco pasa al título de
  // los resultados, que dice cuántos hoteles hay, en vez de perderse en la página. La pantalla
  // muestra desde la barra de la búsqueda, que queda justo encima.
  const focusResults = useRef(false);
  useEffect(() => {
    setEditing(false);
    if (!focusResults.current) return;
    focusResults.current = false;
    window.requestAnimationFrame(() => {
      const heading = document.getElementById(resultsHeadingId);
      if (heading === null) return;
      heading.focus({ preventScroll: true });
      (document.getElementById(summaryId) ?? heading).scrollIntoView({ block: 'nearest' });
    });
  }, [state.receivedAt, resultsHeadingId, summaryId]);
  const hasResults = state.ok && state.criteria !== undefined && state.hotels.length > 0;
  const collapsed = hasResults && !editing;
  function toggleEditing() {
    const next = !editing;
    setEditing(next);
    if (next) {
      // Al abrirlo, el foco va al primer campo: el lector de pantalla y el teclado siguen ahí.
      window.requestAnimationFrame(() =>
        formRef.current?.querySelector<HTMLInputElement>('input[role="combobox"]')?.focus(),
      );
    }
  }

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

  /** Toda búsqueda sale por acá: el eco de la espera y el foco a los resultados al volver. */
  function launch(data: FormData) {
    const field = (name: string) => {
      const value = data.get(name);
      return typeof value === 'string' ? value : '';
    };
    setEcho(
      searchingEcho({
        destinationLabel: field('destinationLabel'),
        hotelIdsCount: field('hotelIds')
          .split(/[\s,;]+/)
          .filter(Boolean).length,
        checkinDate: field('checkinDate'),
        checkoutDate: field('checkoutDate'),
      }),
    );
    focusResults.current = true;
    startTransition(() => formAction(data));
  }

  /** Marca las fechas y lleva el foco a la mitad del calendario que hay que tocar. */
  function showDatesProblem(problem: StayDatesProblem) {
    setDatesProblem(problem.message);
    window.requestAnimationFrame(() =>
      document
        .getElementById(problem.edge === 'end' ? datesIds.checkout : datesIds.checkin)
        ?.focus(),
    );
  }

  /** "Buscar en USD" del aviso: la misma búsqueda, con la otra moneda. */
  function searchIn(next: string) {
    const form = formRef.current;
    if (!form) return;
    chooseCurrency(next);
    // El valor del campo todavía es el anterior hasta el próximo render: se pisa en los datos.
    const data = new FormData(form);
    data.set('currency', next);
    launch(data);
  }

  /**
   * "Buscar de nuevo" del aviso de vencimiento: la misma búsqueda. Con el formulario plegado, un
   * campo que dejó de valer (la entrada quedó en el pasado con la pantalla abierta desde ayer)
   * frenaría el envío sin que se vea por qué: se abre el formulario y se señala el campo. Las
   * fechas van en campos ocultos, que el navegador no valida: las revisa `stayDatesProblem`.
   */
  function searchAgain() {
    const form = formRef.current;
    if (!form) return;
    const problem = stayDatesProblem(dates.start ?? '', dates.end ?? '', todayIso());
    if (problem !== null || !form.checkValidity()) {
      setEditing(true);
      if (problem !== null) showDatesProblem(problem);
      else window.requestAnimationFrame(() => form.reportValidity());
      return;
    }
    form.requestSubmit();
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
    <div className="mx-auto max-w-6xl space-y-4 p-4 sm:space-y-5 sm:p-6">
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
      {hasResults && state.criteria ? (
        <SearchSummaryBar
          id={summaryId}
          criteria={state.criteria}
          editing={editing}
          searching={isPending}
          onToggleEdit={toggleEditing}
          formId={formId}
        />
      ) : null}

      <form
        ref={formRef}
        id={formId}
        hidden={collapsed}
        aria-label="Búsqueda de hoteles"
        action={formAction}
        onSubmit={(event) => {
          event.preventDefault();
          // El botón queda enfocable mientras se busca (`aria-disabled`): un segundo Enter no
          // lanza otra búsqueda encima de la primera.
          if (isPending) return;
          // Hoy se mide al enviar, no al pintar: la pantalla puede llevar abierta desde ayer.
          const problem = stayDatesProblem(dates.start ?? '', dates.end ?? '', todayIso());
          if (problem !== null) {
            showDatesProblem(problem);
            return;
          }
          setDatesProblem(null);
          launch(new FormData(event.currentTarget));
        }}
        className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-xs)] sm:p-5"
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.2fr)_minmax(0,1.1fr)]">
          <div className="sm:col-span-2 lg:col-span-1">
            <DestinationCombobox />
          </div>

          <div className="space-y-1.5">
            {/* Las noches van en el rótulo y no dentro del campo: adentro le quitaban lugar a las
                fechas, que se cortaban («mar…») entre 1024 y 1200 px y a 320 px. */}
            <div className="flex items-baseline justify-between gap-2">
              <span
                id={datesIds.label}
                className="block text-xs font-medium text-[var(--color-fg)]"
              >
                Fechas
              </span>
              {nightsLabel !== null ? (
                <span
                  id={datesIds.nights}
                  className="text-xs font-medium tabular-nums text-[var(--color-fg-muted)]"
                >
                  {nightsLabel}
                </span>
              ) : null}
            </div>
            <DateRangePicker
              mode="roundtrip"
              purpose="stay"
              size="md"
              value={dates}
              onChange={(range) => {
                setDates(range);
                setDatesProblem(null);
              }}
              min={today}
              startName="checkinDate"
              endName="checkoutDate"
              triggerId={datesIds.checkin}
              endTriggerId={datesIds.checkout}
              labelledBy={datesIds.label}
              invalid={datesProblem !== null}
              describedBy={datesDescribedBy}
            />
            {datesProblem !== null ? (
              <p
                id={datesIds.error}
                role="alert"
                className="flex items-start gap-1.5 text-xs font-medium text-[var(--color-danger)]"
              >
                <TriangleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
                {datesProblem}
              </p>
            ) : null}
          </div>

          <RoomsPicker />
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,13rem)_minmax(0,1fr)] xl:items-start">
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
        </div>

        <div className="mt-3 flex items-start gap-2 rounded-lg bg-[var(--color-surface-muted)] px-3 py-2 text-[11px] text-[var(--color-fg-muted)]">
          <Info
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0 text-[var(--color-fg-subtle)]"
          />
          <span>
            Elige un destino del autocompletado y buscamos en el catálogo de hoteles de cada
            proveedor habilitado. Si necesitas hoteles puntuales, puedes escribir sus IDs. Los
            catálogos se actualizan todas las noches: un destino o un hotel nuevo puede tardar un
            día en aparecer. Precio, estrellas, régimen y &quot;Solo reembolsables&quot; se filtran
            en los resultados, sin volver a buscar.
          </span>
        </div>

        <div className="mt-4 flex justify-end">
          {/* `aria-disabled` y no `disabled`: un botón deshabilitado suelta el foco al `body`
              durante toda la espera (y ahí se queda si la búsqueda falla), y el «Buscando…» a
              media opacidad no se lee. El envío repetido lo frena `onSubmit`. */}
          <button
            type="submit"
            aria-disabled={isPending || undefined}
            className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-[var(--color-primary)] px-5 text-sm font-medium text-[var(--color-primary-fg)] shadow-[var(--shadow-xs)] transition-[background-color,transform] hover:bg-[var(--color-primary-hover)] active:scale-[0.99] aria-disabled:cursor-progress aria-disabled:active:scale-100 motion-reduce:transform-none sm:w-auto"
          >
            <SearchButtonLabel searching={isPending}>Buscar hoteles</SearchButtonLabel>
          </button>
        </div>
      </form>

      {/* La espera ocupa el lugar de los resultados. Los de la búsqueda anterior quedan montados
          pero ocultos: filtros, orden y vista viven en ellos (y en la URL) y no se pierden. */}
      <SearchLoading active={isPending} subject="hoteles" echo={echo}>
        <ResultsSkeletonFrame>
          {[0, 1, 2].map((i) => (
            <HotelResultSkeleton key={i} />
          ))}
        </ResultsSkeletonFrame>
      </SearchLoading>

      {state.error && !isPending ? (
        <div
          role="alert"
          className="rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 px-4 py-3 text-sm text-[var(--color-danger)]"
        >
          {state.error}
        </div>
      ) : null}

      {state.ok && !isPending ? (
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
          <div hidden={isPending}>
            <HotelResults
              hotels={state.hotels}
              showProvider={state.showProviderInResults}
              nonRefundableBlocked={state.nonRefundableBlocked === true}
              criteria={state.criteria}
              receivedAt={state.receivedAt}
              clockOffsetMs={clockOffsetMs}
              searchToken={searchToken}
              searching={isPending}
              onSearchAgain={searchAgain}
              headingId={resultsHeadingId}
            />
          </div>
        ) : isPending ? null : (
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
