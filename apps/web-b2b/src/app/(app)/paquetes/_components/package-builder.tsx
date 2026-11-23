'use client';

import {
  ArrowRight,
  Car,
  FolderOpen,
  Hotel,
  Loader2,
  MapPin,
  Package,
  Plane,
  Search,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { AirportCombobox } from '../../../../components/ui/airport-combobox';
import { Button } from '../../../../components/ui/button';
import {
  DateRangePicker,
  EMPTY_RANGE,
  type DateRange,
} from '../../../../components/ui/date-range-picker';
import { areaOfAirport, cityByCode, type LocationKind } from '../../../../lib/airport-cities';
import { getAirportByCode, loadFullDataset } from '../../../../lib/airports';
import { cn } from '../../../../lib/cn';
import { currencyDecimals, formatMoney } from '../../../../lib/flight-format';
import type { CarOffer, CarSearchResult, CarSearchValues } from '../../autos/actions';
import type { Offer, SearchResult } from '../../cotizaciones/actions';
import type { GeoSuggestion, HotelSearchResult, RoomDistribution } from '../../hoteles/actions';
import { DestinationCombobox } from '../../hoteles/_components/destination-combobox';
import { encodeHotelKey, hotelRefsOf } from '../../hoteles/_components/hotel-key';
import { resultHotelsOf } from '../../hoteles/_components/hotel-results-filters';
import { NationalityField } from '../../hoteles/_components/nationality-field';
import { RoomsPicker } from '../../hoteles/_components/rooms-picker';
import { useHotelPhotos } from '../../hoteles/_components/use-hotel-photos';
import {
  createPackageAction,
  hotelGalleryAction,
  resolveHotelDestinationAction,
  type PackageSearchCriteria,
} from '../actions';
import { CarLane, ExtrasLane, FlightLane, HotelLane, type LaneStatus } from './package-lanes';
import {
  carItem,
  carKey,
  carSale,
  carSearchFor,
  flightItem,
  flightSale,
  hotelChoices,
  hotelItem,
  hotelSnapshot,
  manualItem,
  nightsBetween,
  packageCurrency,
  packageTitle,
  paxFromRooms,
  payingTravelers,
  perPerson,
  recommendCar,
  recommendFlight,
  recommendHotel,
  roompackSale,
  type HotelChoice,
  type ManualDraft,
  type PackageItemPayload,
} from './package-model';
import { searchCars, searchFlights, searchHotels } from './package-search';

type Include = 'flights' | 'hotels' | 'cars';

interface Lane<T> {
  status: LaneStatus;
  result?: T;
  error?: string;
}

const OFF: Lane<never> = { status: 'off' };

interface Place {
  city: string;
  country: string;
  countryCode: string;
  airportCode: string;
}

/** La ciudad de un código de vuelo: área metropolitana primero (MDE es Medellín, no Rionegro). */
async function placeOf(code: string, kind: LocationKind | undefined): Promise<Place | undefined> {
  const area = cityByCode(code) ?? areaOfAirport(code);
  if (area) {
    const airportCode =
      kind === 'city' || code === area.code ? (area.airports[0]?.code ?? code) : code;
    return { city: area.city, country: area.country, countryCode: area.countryCode, airportCode };
  }
  await loadFullDataset();
  const airport = getAirportByCode(code);
  return airport?.city
    ? {
        city: airport.city,
        country: airport.country,
        countryCode: airport.countryCode,
        airportCode: airport.code,
      }
    : undefined;
}

function dayLabel(iso: string, index: number): string {
  const text = new Date(`${iso}T12:00:00Z`).toLocaleDateString('es-CO', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  return `Día ${index + 1} · ${text}`;
}

function laneOf<T extends { ok: boolean; error?: string }>(
  result: T,
  count: number,
  emptyText?: string,
): Lane<T> {
  if (!result.ok) return { status: 'error', result, error: result.error ?? 'No pudimos buscar.' };
  if (count === 0) return { status: 'empty', result, ...(emptyText ? { error: emptyText } : {}) };
  return { status: 'ready', result };
}

const INCLUDE_META: { key: Include; label: string; icon: typeof Plane }[] = [
  { key: 'flights', label: 'Vuelo', icon: Plane },
  { key: 'hotels', label: 'Hotel', icon: Hotel },
  { key: 'cars', label: 'Auto', icon: Car },
];

export function PackageBuilder() {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const ids = useId();

  const [includes, setIncludes] = useState<Record<Include, boolean>>({
    flights: true,
    hotels: true,
    cars: false,
  });
  const [dates, setDates] = useState<DateRange>(EMPTY_RANGE);
  const [destination, setDestination] = useState<{ code: string; kind?: LocationKind }>({
    code: '',
  });
  const [place, setPlace] = useState<Place>();
  const [hotelDest, setHotelDest] = useState<GeoSuggestion | null>();
  const [resolvingDest, setResolvingDest] = useState(false);
  const [pickHotelDest, setPickHotelDest] = useState(false);
  const [formError, setFormError] = useState<string>();

  const [flights, setFlights] = useState<Lane<SearchResult>>(OFF);
  const [hotels, setHotels] = useState<Lane<HotelSearchResult>>(OFF);
  const [cars, setCars] = useState<Lane<CarSearchResult>>(OFF);
  const [carSearch, setCarSearch] = useState<CarSearchValues>();
  const [criteria, setCriteria] = useState<PackageSearchCriteria>();
  const [lastForms, setLastForms] = useState<{
    flights?: Record<string, string>;
    hotels?: Record<string, string>;
  }>({});

  const [flightPick, setFlightPick] = useState<string>();
  const [hotelPick, setHotelPick] = useState<{ hotelId: string; packId: string }>();
  const [carPick, setCarPick] = useState<string>();
  const [extras, setExtras] = useState<ManualDraft[]>([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string>();

  // ── Destino de hotel derivado del aeropuerto de llegada ──
  useEffect(() => {
    let cancelled = false;
    const code = destination.code;
    if (!/^[A-Z]{3}$/.test(code)) {
      setPlace(undefined);
      setHotelDest(undefined);
      return;
    }
    setResolvingDest(true);
    void (async () => {
      const p = await placeOf(code, destination.kind);
      if (cancelled) return;
      setPlace(p);
      const suggestion = p ? await resolveHotelDestinationAction(p.city, p.country) : null;
      if (cancelled) return;
      setHotelDest(suggestion);
      setResolvingDest(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [destination.code, destination.kind]);

  // ── Resultados derivados ──
  const offers = useMemo(() => flights.result?.offers ?? [], [flights.result]);
  const hotelOffers = useMemo(() => hotels.result?.hotels ?? [], [hotels.result]);
  const carOffers = useMemo(() => cars.result?.cars ?? [], [cars.result]);

  const currency = useMemo(
    () =>
      packageCurrency({
        flightSaleCurrency: flights.result?.saleCurrency,
        hotelCriteriaCurrency: hotels.result?.criteria?.currency,
        flights: offers,
        hotels: hotelOffers,
        cars: carOffers,
      }),
    [flights.result, hotels.result, offers, hotelOffers, carOffers],
  );

  const flightsInCurrency = useMemo(
    () => (currency ? offers.filter((o) => flightSale(o).currency === currency) : []),
    [offers, currency],
  );
  const choices = useMemo(
    () => (currency ? hotelChoices(hotelOffers, currency) : []),
    [hotelOffers, currency],
  );
  const carsInCurrency = useMemo(
    () => (currency ? carOffers.filter((c) => carSale(c).currency === currency) : []),
    [carOffers, currency],
  );

  const recommendedFlight = useMemo(
    () => (currency ? recommendFlight(offers, currency) : undefined),
    [offers, currency],
  );
  const recommendedHotel = useMemo(
    () => (currency ? recommendHotel(hotelOffers, currency) : undefined),
    [hotelOffers, currency],
  );
  const recommendedCar = useMemo(
    () => (currency ? recommendCar(carOffers, currency) : undefined),
    [carOffers, currency],
  );

  const selectedFlight: Offer | undefined =
    flightsInCurrency.find((o) => o.id === flightPick) ?? recommendedFlight;
  const selectedHotel: HotelChoice | undefined = (() => {
    if (hotelPick) {
      const hotel = hotelOffers.find((h) => h.hotelId === hotelPick.hotelId);
      const pack = hotel?.roompacks.find((p) => p.id === hotelPick.packId);
      if (hotel && pack && currency && roompackSale(pack).currency === currency)
        return { hotel, pack };
    }
    return recommendedHotel;
  })();
  const selectedCar: CarOffer | undefined =
    carsInCurrency.find((c) => carKey(c) === carPick) ?? recommendedCar;

  // Fotos de hotel: las del catálogo y, las que falten, en segundo plano.
  const resultHotels = useMemo(
    () => resultHotelsOf(hotelOffers, false, hotels.result?.receivedAt),
    [hotelOffers, hotels.result?.receivedAt],
  );
  const photoKeys = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of resultHotels) map.set(r.offer.hotelId, r.key);
    return map;
  }, [resultHotels]);
  const photoOrder = useMemo(() => {
    const sorted = [...choices].sort(
      (a, b) => roompackSale(a.pack).amountMinor - roompackSale(b.pack).amountMinor,
    );
    const ids = [selectedHotel?.hotel.hotelId, ...sorted.slice(0, 10).map((c) => c.hotel.hotelId)];
    return [...new Set(ids)]
      .map((id) => (id ? photoKeys.get(id) : undefined))
      .filter((k): k is string => !!k);
  }, [choices, selectedHotel?.hotel.hotelId, photoKeys]);
  const photos = useHotelPhotos(resultHotels, photoOrder);

  // ── Total ──
  const rooms = criteria?.rooms ?? [];
  const travelers = rooms.length > 0 ? payingTravelers(rooms) : 1;
  const lines = useMemo(() => {
    const out: { label: string; amountMinor: number }[] = [];
    if (includes.flights && selectedFlight)
      out.push({ label: 'Vuelo', amountMinor: flightSale(selectedFlight).amountMinor });
    if (includes.hotels && selectedHotel)
      out.push({ label: 'Hotel', amountMinor: roompackSale(selectedHotel.pack).amountMinor });
    if (includes.cars && selectedCar)
      out.push({ label: 'Auto', amountMinor: carSale(selectedCar).amountMinor });
    for (const e of extras) out.push({ label: e.title, amountMinor: e.priceMinor });
    return out;
  }, [includes, selectedFlight, selectedHotel, selectedCar, extras]);
  const totalMinor = lines.reduce((n, l) => n + l.amountMinor, 0);
  const anyLoading = [flights, hotels, cars].some((l) => l.status === 'loading');
  const searched = criteria !== undefined;

  // ── Búsquedas ──
  const runCars = useCallback(async (values: CarSearchValues) => {
    setCarSearch(values);
    setCars({ status: 'loading' });
    setCarPick(undefined);
    const res = await searchCars(values);
    setCars(
      laneOf(res, res.cars.length, 'No hay autos disponibles en ese aeropuerto para esas fechas.'),
    );
  }, []);

  const runFlights = useCallback(
    async (
      form: Record<string, string>,
      carBase?: Omit<Parameters<typeof carSearchFor>[0], 'flight'>,
    ) => {
      setFlights({ status: 'loading' });
      setFlightPick(undefined);
      const res = await searchFlights(form);
      setFlights(laneOf(res, res.offers.length, 'No hay vuelos para esa ruta y fechas.'));
      if (carBase) {
        const cur =
          res.saleCurrency ?? (res.offers[0] ? flightSale(res.offers[0]).currency : undefined);
        const best = cur ? recommendFlight(res.offers, cur) : undefined;
        await runCars(carSearchFor({ ...carBase, flight: best }));
      }
    },
    [runCars],
  );

  const runHotels = useCallback(async (form: Record<string, string>) => {
    setHotels({ status: 'loading' });
    setHotelPick(undefined);
    const res = await searchHotels(form);
    setHotels(laneOf(res, res.hotels.length, 'No hay hoteles disponibles para esas fechas.'));
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(undefined);
    setCreateError(undefined);
    const fd = new FormData(event.currentTarget);
    const get = (k: string) => {
      const v = fd.get(k);
      return typeof v === 'string' ? v.trim() : '';
    };

    const origin = get('origin');
    const originKind = get('originKind');
    const dest = get('destination');
    const destKind = get('destinationKind');
    const departureDate = get('departureDate');
    const returnDate = get('returnDate');
    let roomsValue: RoomDistribution[] = [];
    try {
      roomsValue = JSON.parse(get('rooms') || '[]') as RoomDistribution[];
    } catch {
      roomsValue = [];
    }

    if (!includes.flights && !includes.hotels && !includes.cars) {
      return setFormError('Elige al menos un servicio para el paquete.');
    }
    if (!/^[A-Z]{3}$/.test(dest)) return setFormError('Elige el destino.');
    if (includes.flights && !/^[A-Z]{3}$/.test(origin))
      return setFormError('Elige desde dónde viajan.');
    if (!departureDate || !returnDate) return setFormError('Elige las fechas de ida y vuelta.');
    if (roomsValue.length === 0) return setFormError('Indica cuántos viajan.');

    const hotelDestinationId = pickHotelDest ? get('destinationId') : String(hotelDest?.id ?? '');
    const hotelDestinationLabel = pickHotelDest
      ? get('destinationLabel')
      : (hotelDest?.display ?? '');
    if (includes.hotels && !hotelDestinationId) {
      setPickHotelDest(true);
      return setFormError('Elige la ciudad del hotel de la lista.');
    }

    const resolved =
      place ?? (await placeOf(dest, (destKind || undefined) as LocationKind | undefined));
    if (includes.cars && !resolved?.countryCode) {
      return setFormError('No pudimos ubicar el aeropuerto de destino para el auto.');
    }

    const pax = paxFromRooms(roomsValue);
    if (includes.flights && pax.adults + pax.children + pax.infants > 9) {
      return setFormError('Máximo 9 pasajeros por reserva de vuelo.');
    }

    const destinationLabel =
      hotelDestinationLabel || (resolved ? `${resolved.city}, ${resolved.country}` : dest);
    const originPlace = origin
      ? await placeOf(origin, (originKind || undefined) as LocationKind | undefined)
      : undefined;
    setCriteria({
      ...(origin ? { origin } : {}),
      ...(originPlace ? { originLabel: originPlace.city } : {}),
      destination: dest,
      destinationLabel,
      departureDate,
      returnDate,
      rooms: roomsValue,
      includes: (Object.keys(includes) as Include[]).filter((k) => includes[k]),
    });
    setExtras([]);

    const flightForm: Record<string, string> = {
      tripType: 'roundtrip',
      origin,
      destination: dest,
      ...(originKind ? { originKind } : {}),
      ...(destKind ? { destinationKind: destKind } : {}),
      departureDate,
      returnDate,
      cabin: 'economy',
      adults: String(pax.adults),
      children: String(pax.children),
      infants: String(pax.infants),
      childAges: pax.childAges.join(','),
    };
    const nationality = get('guestNationality');
    const hotelForm: Record<string, string> = {
      checkinDate: departureDate,
      checkoutDate: returnDate,
      rooms: JSON.stringify(roomsValue),
      destinationId: hotelDestinationId,
      destinationLabel: hotelDestinationLabel,
      ...(nationality ? { guestNationality: nationality } : {}),
    };
    setLastForms({ flights: flightForm, hotels: hotelForm });

    const carBase =
      includes.cars && resolved
        ? {
            airportCode: resolved.airportCode,
            countryCode: resolved.countryCode,
            departureDate,
            returnDate,
          }
        : undefined;

    if (includes.flights) void runFlights(flightForm, carBase);
    else setFlights(OFF);
    if (includes.hotels) void runHotels(hotelForm);
    else setHotels(OFF);
    if (!includes.cars) setCars(OFF);
    else if (!includes.flights && carBase) void runCars(carSearchFor(carBase));
    else setCars({ status: 'loading' });
  }

  async function onCreate() {
    if (!criteria || !currency) return;
    setCreating(true);
    setCreateError(undefined);
    try {
      const items: PackageItemPayload[] = [];
      if (includes.flights && selectedFlight) items.push(flightItem(selectedFlight));
      if (includes.hotels && selectedHotel) {
        const refs = hotelRefsOf(selectedHotel.hotel);
        const hotelKey = refs.length > 0 ? encodeHotelKey(refs) : undefined;
        const gallery = hotelKey ? await hotelGalleryAction(hotelKey) : { images: [] };
        const photo = photoKeys.get(selectedHotel.hotel.hotelId);
        const known = photo ? photos.get(photo) : undefined;
        const testAccount = hotels.result?.providers.some(
          (p) => p.code === selectedHotel.pack.provider?.name && p.accountEnvironment === 'test',
        );
        items.push(
          hotelItem(
            selectedHotel.pack,
            hotelSnapshot({
              hotel:
                known?.status === 'ready' && known.url && !selectedHotel.hotel.mainImage
                  ? { ...selectedHotel.hotel, mainImage: { url: known.url } }
                  : selectedHotel.hotel,
              pack: selectedHotel.pack,
              checkin: criteria.departureDate,
              checkout: criteria.returnDate,
              images: gallery.images,
              description: gallery.description,
              hotelKey,
              test: testAccount === true,
            }),
          ),
        );
      }
      if (includes.cars && selectedCar && carSearch) items.push(carItem(selectedCar, carSearch));
      extras.forEach((e, i) => items.push(manualItem(e, currency, i + 1)));

      const nights = nightsBetween(criteria.departureDate, criteria.returnDate);
      const res = await createPackageAction({
        title: packageTitle(criteria.destinationLabel ?? criteria.destination ?? 'Viaje', nights),
        currency,
        searchCriteria: criteria,
        items,
      });
      if (!res.ok) {
        setCreateError(res.error);
        setCreating(false);
        return;
      }
      router.push(`/paquetes/${res.data.id}`);
    } catch {
      setCreateError('No pudimos crear la cotización. Reintenta en un momento.');
      setCreating(false);
    }
  }

  const tripDays = useMemo(() => {
    if (!criteria) return [];
    const n = nightsBetween(criteria.departureDate, criteria.returnDate);
    return Array.from({ length: n + 1 }, (_, i) => {
      const d = new Date(`${criteria.departureDate}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + i);
      const iso = d.toISOString().slice(0, 10);
      return { date: iso, label: dayLabel(iso, i) };
    });
  }, [criteria]);

  const route =
    criteria?.origin && criteria.destination
      ? `${criteria.origin} → ${criteria.destination} · ida y vuelta`
      : undefined;
  const nights = criteria ? nightsBetween(criteria.departureDate, criteria.returnDate) : 0;
  const canCreate = searched && !anyLoading && lines.length > 0 && !!currency && !creating;
  const flightHidden = offers.length - flightsInCurrency.length;
  const hotelHidden = hotelOffers.filter((h) => h.roompacks.length > 0).length - choices.length;
  const carHidden = carOffers.length - carsInCurrency.length;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 pb-28 lg:pb-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-[var(--color-fg)]">
            <Package className="size-5 text-[var(--color-primary)]" /> Paquetes
          </h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Vuelo, hotel y auto en una sola búsqueda. Te armamos la mejor combinación y la cambias
            en un toque.
          </p>
        </div>
        <Button asChild variant="secondary" size="sm">
          <Link href="/paquetes/guardados">
            <FolderOpen /> Paquetes guardados
          </Link>
        </Button>
      </header>

      <form
        ref={formRef}
        onSubmit={onSubmit}
        noValidate
        className="space-y-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-sm)] sm:p-5"
      >
        <div role="group" aria-label="Qué incluye el paquete" className="flex flex-wrap gap-2">
          {INCLUDE_META.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              aria-pressed={includes[key]}
              onClick={() => setIncludes((v) => ({ ...v, [key]: !v[key] }))}
              className={cn(
                'inline-flex h-9 items-center gap-2 rounded-full border px-4 text-sm font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40',
                includes[key]
                  ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]'
                  : 'border-[var(--color-border)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]',
              )}
            >
              <Icon className="size-4" /> {label}
            </button>
          ))}
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div className={cn(!includes.flights && 'hidden')}>
            <AirportCombobox name="origin" label="Desde" placeholder="Ciudad de salida" />
          </div>
          <div className={cn(!includes.flights && 'md:col-span-2')}>
            <AirportCombobox
              name="destination"
              label="Destino"
              placeholder="¿A dónde viajan?"
              onChange={(code, _reason, kind) => setDestination(kind ? { code, kind } : { code })}
            />
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-[1.4fr_1fr_1fr]">
          <div className="space-y-1.5">
            <span id={`${ids}-dates`} className="text-xs font-medium text-[var(--color-fg-muted)]">
              Fechas del viaje
            </span>
            <DateRangePicker
              mode="roundtrip"
              size="md"
              purpose="trip"
              value={dates}
              onChange={setDates}
              labelledBy={`${ids}-dates`}
              startName="departureDate"
              endName="returnDate"
              startLabel="Ida"
              endLabel="Vuelta"
            />
          </div>
          <RoomsPicker />
          <div className={cn(!includes.hotels && 'hidden')}>
            <NationalityField />
          </div>
        </div>

        {includes.hotels ? (
          <div className="rounded-lg bg-[var(--color-surface-muted)] px-3 py-2.5 text-sm">
            {pickHotelDest ? (
              <div className="space-y-2">
                <DestinationCombobox />
                {hotelDest ? (
                  <button
                    type="button"
                    className="text-xs font-medium text-[var(--color-primary)] hover:underline"
                    onClick={() => setPickHotelDest(false)}
                  >
                    Usar {hotelDest.display}
                  </button>
                ) : null}
              </div>
            ) : (
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[var(--color-fg-muted)]">
                <MapPin className="size-4 shrink-0 text-[var(--color-primary)]" />
                {resolvingDest ? (
                  <span className="inline-flex items-center gap-1">
                    <Loader2 className="size-3 animate-spin" /> Ubicando hoteles en el destino…
                  </span>
                ) : hotelDest ? (
                  <span>
                    Hoteles en{' '}
                    <strong className="text-[var(--color-fg)]">{hotelDest.display}</strong>
                  </span>
                ) : (
                  <span>Los hoteles se buscan en la ciudad del destino.</span>
                )}
                <button
                  type="button"
                  className="text-xs font-medium text-[var(--color-primary)] hover:underline"
                  onClick={() => setPickHotelDest(true)}
                >
                  Cambiar ciudad del hotel
                </button>
              </p>
            )}
          </div>
        ) : null}

        {formError ? (
          <p role="alert" className="text-sm text-[var(--color-danger)]">
            {formError}
          </p>
        ) : null}

        <div className="flex justify-end">
          <Button type="submit" size="lg" disabled={anyLoading} className="w-full sm:w-auto">
            {anyLoading ? <Loader2 className="animate-spin" /> : <Search />}
            {anyLoading ? 'Buscando…' : 'Buscar paquete'}
          </Button>
        </div>
      </form>

      {searched ? (
        <div className="grid items-start gap-6 lg:grid-cols-[1fr_20rem]">
          <div className="space-y-4">
            {includes.flights && flights.status !== 'off' ? (
              <FlightLane
                status={flights.status}
                error={flights.error}
                onRetry={() => lastForms.flights && void runFlights(lastForms.flights)}
                subtitle={route}
                offers={flightsInCurrency}
                hiddenByCurrency={flightHidden}
                currency={currency}
                selected={selectedFlight}
                recommendedId={recommendedFlight?.id}
                onSelect={(o) => setFlightPick(o.id)}
              />
            ) : null}
            {includes.hotels && hotels.status !== 'off' ? (
              <HotelLane
                status={hotels.status}
                error={hotels.error}
                onRetry={() => lastForms.hotels && void runHotels(lastForms.hotels)}
                subtitle={
                  criteria
                    ? `${criteria.destinationLabel ?? ''} · ${nights} ${nights === 1 ? 'noche' : 'noches'}`
                    : undefined
                }
                choices={choices}
                hiddenByCurrency={Math.max(0, hotelHidden)}
                currency={currency}
                selected={selectedHotel}
                recommendedHotelId={recommendedHotel?.hotel.hotelId}
                photos={photos}
                photoKeyOf={(id) => photoKeys.get(id)}
                onSelect={(c) => setHotelPick({ hotelId: c.hotel.hotelId, packId: c.pack.id })}
              />
            ) : null}
            {includes.cars && cars.status !== 'off' ? (
              <CarLane
                status={cars.status}
                error={cars.error}
                onRetry={() => carSearch && void runCars(carSearch)}
                subtitle={
                  carSearch
                    ? `Retiro y devolución en ${carSearch.pickUpLocation} · ${carSearch.pickUpDate.slice(5)} → ${carSearch.dropOffDate.slice(5)}`
                    : undefined
                }
                cars={carsInCurrency}
                hiddenByCurrency={carHidden}
                currency={currency}
                selected={selectedCar}
                recommendedKey={recommendedCar ? carKey(recommendedCar) : undefined}
                onSelect={(c) => setCarPick(carKey(c))}
              />
            ) : null}
            <ExtrasLane
              items={extras}
              currency={currency}
              currencyDecimals={currency ? currencyDecimals(currency) : 0}
              tripDays={tripDays}
              onAdd={(d) => setExtras((xs) => [...xs, d])}
              onRemove={(i) => setExtras((xs) => xs.filter((_, j) => j !== i))}
            />
          </div>

          <PackageSummary
            lines={lines}
            totalMinor={totalMinor}
            currency={currency}
            travelers={travelers}
            nights={nights}
            loading={anyLoading}
            canCreate={canCreate}
            creating={creating}
            error={createError}
            onCreate={onCreate}
          />
        </div>
      ) : (
        <EmptyState />
      )}
    </div>
  );
}

function PackageSummary(props: {
  lines: { label: string; amountMinor: number }[];
  totalMinor: number;
  currency: string | undefined;
  travelers: number;
  nights: number;
  loading: boolean;
  canCreate: boolean;
  creating: boolean;
  error: string | undefined;
  onCreate: () => void;
}) {
  const money = (n: number) => (props.currency ? formatMoney(n, props.currency) : '—');
  const action = (
    <Button
      type="button"
      size="lg"
      className="w-full"
      disabled={!props.canCreate}
      onClick={props.onCreate}
    >
      {props.creating ? <Loader2 className="animate-spin" /> : <ArrowRight />}
      {props.creating ? 'Armando la cotización…' : 'Crear cotización'}
    </Button>
  );
  return (
    <>
      <aside
        aria-label="Resumen del paquete"
        className="hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-sm)] lg:sticky lg:top-20 lg:block"
      >
        <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
          Tu paquete
        </p>
        <ul className="mt-3 space-y-2 text-sm">
          {props.lines.length === 0 ? (
            <li className="text-[var(--color-fg-muted)]">
              {props.loading ? 'Buscando las mejores opciones…' : 'Sin servicios todavía.'}
            </li>
          ) : (
            props.lines.map((l, i) => (
              <li key={`${l.label}-${i}`} className="flex justify-between gap-3">
                <span className="truncate text-[var(--color-fg-muted)]">{l.label}</span>
                <span className="tabular-nums text-[var(--color-fg)]">{money(l.amountMinor)}</span>
              </li>
            ))
          )}
        </ul>
        <div className="mt-4 border-t border-[var(--color-border)] pt-4">
          <p className="text-xs text-[var(--color-fg-subtle)]">Total del paquete</p>
          <p className="text-2xl font-semibold tabular-nums tracking-tight text-[var(--color-fg)]">
            {money(props.totalMinor)}
          </p>
          <p className="text-xs tabular-nums text-[var(--color-fg-muted)]">
            {money(perPerson(props.totalMinor, props.travelers))} por persona · {props.travelers}{' '}
            {props.travelers === 1 ? 'viajero' : 'viajeros'}
            {props.nights > 0 ? ` · ${props.nights} noches` : ''}
          </p>
        </div>
        <div className="mt-4">{action}</div>
        {props.error ? (
          <p role="alert" className="mt-2 text-xs text-[var(--color-danger)]">
            {props.error}
          </p>
        ) : null}
        <p className="mt-3 text-[11px] leading-relaxed text-[var(--color-fg-subtle)]">
          Precios de venta con impuestos. Sujetos a disponibilidad hasta reservar.
        </p>
      </aside>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-[var(--color-border)] bg-[var(--color-surface)]/95 px-4 py-3 shadow-[var(--shadow-lg)] backdrop-blur lg:hidden">
        <div className="mx-auto flex max-w-6xl items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-lg font-semibold tabular-nums leading-tight text-[var(--color-fg)]">
              {money(props.totalMinor)}
            </p>
            <p className="truncate text-xs tabular-nums text-[var(--color-fg-muted)]">
              {money(perPerson(props.totalMinor, props.travelers))} por persona
            </p>
          </div>
          <Button type="button" disabled={!props.canCreate} onClick={props.onCreate}>
            {props.creating ? <Loader2 className="animate-spin" /> : <ArrowRight />}
            Cotizar
          </Button>
        </div>
        {props.error ? (
          <p role="alert" className="mx-auto mt-1 max-w-6xl text-xs text-[var(--color-danger)]">
            {props.error}
          </p>
        ) : null}
      </div>
    </>
  );
}

function EmptyState() {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {[
        { icon: Search, title: 'Una sola búsqueda', text: 'Vuelo, hotel y auto salen a la vez.' },
        {
          icon: Package,
          title: 'Paquete recomendado',
          text: 'Elegimos la mejor combinación; cambias lo que quieras.',
        },
        {
          icon: ArrowRight,
          title: 'Cotización lista',
          text: 'Con fotos, itinerario y precio por persona, lista para enviar.',
        },
      ].map(({ icon: Icon, title, text }) => (
        <div
          key={title}
          className="rounded-xl border border-dashed border-[var(--color-border-strong)] p-4"
        >
          <Icon className="size-5 text-[var(--color-primary)]" />
          <p className="mt-2 text-sm font-medium text-[var(--color-fg)]">{title}</p>
          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{text}</p>
        </div>
      ))}
    </div>
  );
}
