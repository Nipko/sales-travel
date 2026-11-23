import {
  Calendar,
  Car,
  Check,
  Clock,
  Hotel,
  Luggage,
  MapPin,
  Plane,
  Sparkles,
  Star,
  Users,
  X,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import { formatMoney } from '../../../../lib/flight-format';
import { airlineLogoUrl, airlineName } from '../../cotizaciones/_components/airline-names';
import type { AgencyBranding } from './agency-branding';
import { buildItinerary, type FlightSnapshot, type ItineraryEvent } from './package-model';
import {
  boardText,
  excludedList,
  formatLongDate,
  formatShortDate,
  includedList,
  placeName,
  travelersText,
  type QuoteModel,
} from './package-quote';

/**
 * La cotización del paquete tal como la ve el cliente final: con la marca de la agencia, sin
 * proveedores, sin netos ni márgenes. Se imprime limpia (Ctrl+P / «Guardar como PDF»).
 */

const VERTICAL_LABEL: Record<string, string> = {
  flights: 'Vuelos',
  hotels: 'Hotel',
  cars: 'Auto',
  activities: 'Actividad',
  transfers: 'Traslado',
  other: 'Servicio',
};

function SectionTitle({ icon: Icon, children }: { icon: typeof Plane; children: string }) {
  return (
    <h2 className="mb-4 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--brand)]">
      <Icon className="size-4" /> {children}
    </h2>
  );
}

function clock(iso: string): string {
  return /T(\d{2}:\d{2})/.exec(iso)?.[1] ?? '';
}

function duration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

function FlightBlock({ flight }: { flight: FlightSnapshot }) {
  return (
    <div className="space-y-3">
      {flight.itineraries.map((it, i) => {
        const first = it.segments[0];
        const last = it.segments.at(-1);
        if (!first || !last) return null;
        return (
          <div
            key={i}
            className="rounded-xl border border-[var(--color-border)] p-4 break-inside-avoid"
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <p className="text-xs font-medium text-[var(--color-fg-subtle)]">
                {i === 0 ? 'Ida' : 'Regreso'} · {formatLongDate(first.departureAt)}
              </p>
              <span className="flex items-center gap-2 text-xs text-[var(--color-fg-muted)]">
                <img
                  src={airlineLogoUrl(first.carrier)}
                  alt=""
                  className="size-5 rounded bg-white object-contain"
                />
                {airlineName(first.carrier)}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <div className="min-w-0">
                <p className="text-2xl font-semibold tabular-nums tracking-tight text-[var(--color-fg)]">
                  {clock(first.departureAt)}
                </p>
                <p className="truncate text-xs text-[var(--color-fg-muted)]">
                  {placeName(first.origin)} · {first.origin}
                </p>
              </div>
              <div className="flex min-w-0 flex-1 flex-col items-center px-1">
                <p className="text-[11px] text-[var(--color-fg-subtle)]">
                  {duration(it.totalDurationMinutes)}
                </p>
                <div className="relative my-1 h-px w-full bg-[var(--color-border-strong)]">
                  <Plane className="absolute -top-2 left-1/2 size-4 -translate-x-1/2 bg-[var(--color-surface)] text-[var(--brand)]" />
                </div>
                <p className="text-[11px] text-[var(--color-fg-subtle)]">
                  {it.stops === 0
                    ? 'Directo'
                    : `${it.stops} ${it.stops === 1 ? 'escala' : 'escalas'} · ${it.segments
                        .slice(0, -1)
                        .map((s) => s.destination)
                        .join(', ')}`}
                </p>
              </div>
              <div className="min-w-0 text-right">
                <p className="text-2xl font-semibold tabular-nums tracking-tight text-[var(--color-fg)]">
                  {clock(last.arrivalAt)}
                </p>
                <p className="truncate text-xs text-[var(--color-fg-muted)]">
                  {placeName(last.destination)} · {last.destination}
                </p>
              </div>
            </div>
            <p className="mt-3 text-[11px] text-[var(--color-fg-subtle)]">
              {it.segments.map((s) => `${s.carrier} ${s.flightNumber}`).join(' · ')}
            </p>
          </div>
        );
      })}
      <div className="flex flex-wrap gap-2 text-xs">
        {flight.fareFamily ? <Pill>Tarifa {flight.fareFamily}</Pill> : null}
        {flight.baggage?.carryOn?.qty ? (
          <Pill>
            <Luggage className="size-3" /> Equipaje de mano
          </Pill>
        ) : null}
        {flight.baggage?.checked?.qty ? (
          <Pill>
            <Luggage className="size-3" /> {flight.baggage.checked.qty}{' '}
            {flight.baggage.checked.qty === 1 ? 'maleta' : 'maletas'} en bodega
            {flight.baggage.checked.weightKg ? ` de ${flight.baggage.checked.weightKg} kg` : ''}
          </Pill>
        ) : null}
        {flight.changeable !== undefined ? (
          <Pill>{flight.changeable ? 'Permite cambios' : 'Sin cambios'}</Pill>
        ) : null}
      </div>
    </div>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-surface-muted)] px-2.5 py-1 text-[var(--color-fg-muted)]">
      {children}
    </span>
  );
}

const EVENT_ICON: Record<ItineraryEvent['icon'], typeof Plane> = {
  flight: Plane,
  hotel: Hotel,
  car: Car,
  activity: Sparkles,
};

export function QuoteDocument({
  model,
  branding,
  quoteRef,
}: {
  model: QuoteModel;
  branding: AgencyBranding;
  quoteRef: string;
}) {
  const hotel = model.hotel?.snapshot.kind === 'hotel' ? model.hotel.snapshot : undefined;
  const flight = model.flight?.snapshot.kind === 'flight' ? model.flight.snapshot : undefined;
  const car = model.car?.snapshot.kind === 'car' ? model.car.snapshot : undefined;
  const days =
    model.start && model.end
      ? buildItinerary(
          model.start,
          model.end,
          model.items.map((i) => i.snapshot),
          placeName,
        )
      : [];
  const money = (n: number) => formatMoney(n, model.currency);
  const style = { '--brand': branding.color } as CSSProperties;

  return (
    <article
      style={style}
      className="mx-auto w-full max-w-3xl overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-lg)] print:max-w-none print:rounded-none print:border-0 print:shadow-none"
    >
      {/* Portada */}
      <header className="relative isolate min-h-[18rem] overflow-hidden sm:min-h-[22rem]">
        {model.coverImage ? (
          <img
            src={model.coverImage}
            alt=""
            className="absolute inset-0 -z-20 size-full object-cover"
          />
        ) : (
          <div
            aria-hidden="true"
            className="absolute inset-0 -z-20"
            style={{
              background: `radial-gradient(120% 90% at 10% 0%, ${branding.color} 0%, transparent 60%), linear-gradient(135deg, var(--color-navy) 0%, var(--color-navy-dark) 100%)`,
            }}
          />
        )}
        <div
          aria-hidden="true"
          className="absolute inset-0 -z-10 bg-gradient-to-t from-black/80 via-black/30 to-black/10"
        />
        <div className="flex items-center justify-between gap-3 p-5 sm:p-7">
          {branding.logoUrl ? (
            <span className="inline-flex h-10 items-center rounded-lg bg-white/95 px-3 shadow-sm">
              <img
                src={branding.logoUrl}
                alt={branding.name}
                className="h-7 w-auto object-contain"
              />
            </span>
          ) : (
            <span className="rounded-lg bg-white/95 px-3 py-2 text-sm font-semibold text-[var(--color-fg)] shadow-sm">
              {branding.name}
            </span>
          )}
          <span className="rounded-full bg-black/35 px-3 py-1 text-[11px] font-medium text-white/90 backdrop-blur">
            Cotización {quoteRef}
          </span>
        </div>
        <div className="absolute inset-x-0 bottom-0 p-5 text-white sm:p-7">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-white/75">
            Tu próximo viaje
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight sm:text-4xl">{model.title}</h1>
          <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-white/85">
            {model.start && model.end ? (
              <span className="inline-flex items-center gap-1.5">
                <Calendar className="size-4" /> {formatShortDate(model.start)} –{' '}
                {formatShortDate(model.end)}
              </span>
            ) : null}
            <span className="inline-flex items-center gap-1.5">
              <Users className="size-4" /> {travelersText(model)}
            </span>
            {model.originCode ? (
              <span className="inline-flex items-center gap-1.5">
                <MapPin className="size-4" /> Saliendo de {placeName(model.originCode)}
              </span>
            ) : null}
          </p>
        </div>
      </header>

      {/* Resumen */}
      <section className="grid gap-4 border-b border-[var(--color-border)] p-5 sm:grid-cols-[1fr_auto] sm:items-end sm:p-7">
        <div className="flex flex-wrap gap-2">
          {flight ? <Chip icon={Plane}>Vuelos</Chip> : null}
          {hotel ? <Chip icon={Hotel}>{`${model.nights} noches de hotel`}</Chip> : null}
          {car ? <Chip icon={Car}>Auto</Chip> : null}
          {model.extras.map((e) =>
            e.snapshot.kind === 'manual' ? (
              <Chip key={e.id} icon={Sparkles}>
                {e.snapshot.title}
              </Chip>
            ) : null,
          )}
        </div>
        <div className="sm:text-right">
          <p className="text-xs text-[var(--color-fg-subtle)]">Precio total del paquete</p>
          <p className="text-3xl font-semibold tabular-nums tracking-tight text-[var(--color-fg)]">
            {money(model.totalMinor)}
          </p>
          {model.travelers > 1 ? (
            <p className="text-sm tabular-nums text-[var(--color-fg-muted)]">
              {money(model.perPersonMinor)} por persona
            </p>
          ) : null}
        </div>
      </section>

      <div className="space-y-10 p-5 sm:p-7">
        {flight ? (
          <section className="break-inside-avoid">
            <SectionTitle icon={Plane}>Vuelos</SectionTitle>
            <FlightBlock flight={flight} />
          </section>
        ) : null}

        {hotel ? (
          <section>
            <SectionTitle icon={Hotel}>Alojamiento</SectionTitle>
            {hotel.images.length > 0 ? (
              <div className="mb-4 grid grid-cols-4 grid-rows-2 gap-2 overflow-hidden rounded-xl">
                {hotel.images.slice(0, 5).map((src, i) => (
                  <img
                    key={src}
                    src={src}
                    alt={i === 0 ? hotel.name : ''}
                    className={
                      i === 0
                        ? hotel.images.length >= 5
                          ? 'col-span-4 row-span-2 aspect-[16/9] size-full object-cover sm:col-span-2 sm:aspect-auto'
                          : 'col-span-4 row-span-2 aspect-[16/9] size-full object-cover'
                        : hotel.images.length >= 5
                          ? 'hidden aspect-[4/3] size-full object-cover sm:block'
                          : 'hidden'
                    }
                  />
                ))}
              </div>
            ) : null}
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold tracking-tight text-[var(--color-fg)]">
                  {hotel.name}
                </h3>
                {hotel.stars ? (
                  <span
                    className="mt-1 inline-flex gap-0.5"
                    aria-label={`${hotel.stars} estrellas`}
                  >
                    {Array.from({ length: Math.round(hotel.stars) }, (_, i) => (
                      <Star
                        key={i}
                        className="size-3.5 fill-[var(--color-accent)] text-[var(--color-accent)]"
                      />
                    ))}
                  </span>
                ) : null}
                {hotel.address ? (
                  <p className="mt-1 flex items-center gap-1 text-xs text-[var(--color-fg-muted)]">
                    <MapPin className="size-3" /> {hotel.address}
                  </p>
                ) : null}
              </div>
            </div>
            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
              <Fact label="Entrada" value={formatLongDate(hotel.checkin)} />
              <Fact label="Salida" value={formatLongDate(hotel.checkout)} />
              <Fact label="Régimen" value={boardText(hotel)} />
              {hotel.roomName ? (
                <Fact
                  label={hotel.rooms > 1 ? `Habitaciones (${hotel.rooms})` : 'Habitación'}
                  value={hotel.roomName}
                />
              ) : null}
              <Fact
                label="Cancelación"
                value={
                  hotel.refundable
                    ? hotel.freeCancellationUntilLocal
                      ? `Sin cargo hasta el ${formatShortDate(hotel.freeCancellationUntilLocal)}`
                      : 'Reembolsable'
                    : 'No reembolsable'
                }
              />
            </dl>
            {hotel.description ? (
              <p className="mt-4 text-sm leading-relaxed text-[var(--color-fg-muted)]">
                {hotel.description}
              </p>
            ) : null}
          </section>
        ) : null}

        {car ? (
          <section className="break-inside-avoid">
            <SectionTitle icon={Car}>Auto</SectionTitle>
            <div className="flex flex-col gap-4 rounded-xl border border-[var(--color-border)] p-4 sm:flex-row sm:items-center">
              <div className="flex h-28 w-full shrink-0 items-center justify-center rounded-lg bg-white sm:w-44">
                {car.imageUrl ? (
                  <img src={car.imageUrl} alt={car.model} className="max-h-24 object-contain" />
                ) : (
                  <Car className="size-10 text-[var(--color-fg-subtle)]" />
                )}
              </div>
              <div className="min-w-0 flex-1 space-y-2">
                <p className="text-base font-semibold text-[var(--color-fg)]">
                  {car.model}{' '}
                  <span className="text-sm font-normal text-[var(--color-fg-subtle)]">
                    o similar · {car.category}
                  </span>
                </p>
                <div className="flex flex-wrap gap-2 text-xs">
                  <Pill>
                    <Users className="size-3" /> {car.passengers} pasajeros
                  </Pill>
                  <Pill>
                    <Luggage className="size-3" /> {car.bags}{' '}
                    {car.bags === 1 ? 'maleta' : 'maletas'}
                  </Pill>
                  <Pill>{car.automatic ? 'Automático' : 'Manual'}</Pill>
                  {car.air ? <Pill>Aire acondicionado</Pill> : null}
                </div>
                <p className="text-xs text-[var(--color-fg-muted)]">
                  Retiro {formatShortDate(car.pickUp.date)} {car.pickUp.hour.slice(0, 2)}:
                  {car.pickUp.hour.slice(2)} en {placeName(car.pickUp.code)} · Devolución{' '}
                  {formatShortDate(car.dropOff.date)} {car.dropOff.hour.slice(0, 2)}:
                  {car.dropOff.hour.slice(2)}
                </p>
              </div>
            </div>
          </section>
        ) : null}

        {model.extras.length > 0 ? (
          <section className="break-inside-avoid">
            <SectionTitle icon={Sparkles}>Experiencias y traslados</SectionTitle>
            <ul className="grid gap-3 sm:grid-cols-2">
              {model.extras.map((e) =>
                e.snapshot.kind === 'manual' ? (
                  <li key={e.id} className="rounded-xl border border-[var(--color-border)] p-4">
                    <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--brand)]">
                      {VERTICAL_LABEL[e.vertical] ?? 'Servicio'}
                      {e.snapshot.date ? ` · ${formatShortDate(e.snapshot.date)}` : ''}
                    </p>
                    <p className="mt-1 text-sm font-semibold text-[var(--color-fg)]">
                      {e.snapshot.title}
                    </p>
                    {e.snapshot.description ? (
                      <p className="mt-1 text-xs leading-relaxed text-[var(--color-fg-muted)]">
                        {e.snapshot.description}
                      </p>
                    ) : null}
                  </li>
                ) : null,
              )}
            </ul>
          </section>
        ) : null}

        {days.length > 0 ? (
          <section>
            <SectionTitle icon={Calendar}>Tu viaje, día a día</SectionTitle>
            <ol className="relative space-y-4 border-l border-[var(--color-border-strong)] pl-6">
              {days.map((day) => (
                <li key={day.date} className="relative break-inside-avoid">
                  <span
                    aria-hidden="true"
                    className="absolute -left-[31px] top-0.5 flex size-4 items-center justify-center rounded-full border-2 border-[var(--color-surface)] bg-[var(--brand)]"
                  />
                  <p className="text-sm font-semibold text-[var(--color-fg)]">
                    Día {day.dayNumber}{' '}
                    <span className="font-normal text-[var(--color-fg-subtle)]">
                      · {formatLongDate(day.date)}
                    </span>
                  </p>
                  {day.events.length === 0 ? (
                    <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
                      Día libre para disfrutar{' '}
                      {model.destinationLabel?.split(',')[0] ?? 'el destino'}.
                    </p>
                  ) : (
                    <ul className="mt-1.5 space-y-1">
                      {day.events.map((ev, i) => {
                        const Icon = EVENT_ICON[ev.icon];
                        return (
                          <li
                            key={i}
                            className="flex items-center gap-2 text-sm text-[var(--color-fg-muted)]"
                          >
                            <Icon className="size-3.5 shrink-0 text-[var(--brand)]" />
                            {ev.time ? (
                              <span className="tabular-nums text-[var(--color-fg-subtle)]">
                                {ev.time}
                              </span>
                            ) : null}
                            <span>{ev.text}</span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        <section className="grid gap-6 sm:grid-cols-2 break-inside-avoid">
          <div>
            <SectionTitle icon={Check}>Incluye</SectionTitle>
            <ul className="space-y-2 text-sm">
              {includedList(model).map((t) => (
                <li key={t} className="flex gap-2 text-[var(--color-fg)]">
                  <Check className="mt-0.5 size-4 shrink-0 text-[var(--color-success)]" /> {t}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <SectionTitle icon={X}>No incluye</SectionTitle>
            <ul className="space-y-2 text-sm">
              {excludedList(model).map((t) => (
                <li key={t} className="flex gap-2 text-[var(--color-fg-muted)]">
                  <X className="mt-0.5 size-4 shrink-0 text-[var(--color-fg-subtle)]" /> {t}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="rounded-2xl bg-[var(--color-surface-muted)] p-5 break-inside-avoid sm:p-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--brand)]">
                Inversión
              </p>
              <p className="mt-1 text-3xl font-semibold tabular-nums tracking-tight text-[var(--color-fg)]">
                {money(model.totalMinor)}
              </p>
              <p className="text-sm text-[var(--color-fg-muted)]">
                {model.travelers > 1 ? `${money(model.perPersonMinor)} por persona · ` : ''}
                Impuestos incluidos
              </p>
            </div>
            <p className="flex items-center gap-1.5 text-xs text-[var(--color-fg-muted)]">
              <Clock className="size-3.5" /> Válida hasta el {formatLongDate(model.expiresAt)}
            </p>
          </div>
          {model.showBreakdown ? (
            <dl className="mt-4 space-y-1.5 border-t border-[var(--color-border)] pt-4 text-sm">
              {model.items.map((item) => (
                <div key={item.id} className="flex justify-between gap-3">
                  <dt className="text-[var(--color-fg-muted)]">
                    {item.snapshot.kind === 'manual'
                      ? item.snapshot.title
                      : item.snapshot.kind === 'hotel'
                        ? item.snapshot.name
                        : (VERTICAL_LABEL[item.vertical] ?? 'Servicio')}
                  </dt>
                  <dd className="tabular-nums text-[var(--color-fg)]">{money(item.totalMinor)}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </section>

        <section className="space-y-2 text-xs leading-relaxed text-[var(--color-fg-subtle)]">
          <p className="font-semibold text-[var(--color-fg-muted)]">Condiciones</p>
          <p>
            Precios sujetos a disponibilidad y a cambios del proveedor hasta confirmar la reserva y
            emitir los servicios. Las tarifas aéreas pueden tener restricciones de cambios y
            reembolsos. Los pasajeros deben viajar con documentos de identidad vigentes y cumplir
            los requisitos migratorios y sanitarios del destino.
          </p>
          {model.hasTestContent ? (
            <p className="font-medium text-[var(--color-warning)]">
              Esta cotización incluye tarifas de prueba: no corresponden a servicios reales.
            </p>
          ) : null}
        </section>
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border)] px-5 py-4 text-xs text-[var(--color-fg-muted)] sm:px-7">
        <span className="font-medium text-[var(--color-fg)]">{branding.name}</span>
        <span className="flex flex-wrap gap-x-4 gap-y-1">
          {branding.supportPhone ? <span>{branding.supportPhone}</span> : null}
          {branding.supportEmail ? <span>{branding.supportEmail}</span> : null}
          {branding.websiteUrl ? <span>{branding.websiteUrl}</span> : null}
        </span>
      </footer>
    </article>
  );
}

function Chip({ icon: Icon, children }: { icon: typeof Plane; children: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] px-3 py-1 text-xs font-medium text-[var(--color-fg)]">
      <Icon className="size-3.5 text-[var(--brand)]" /> {children}
    </span>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] px-3 py-2">
      <dt className="text-[11px] text-[var(--color-fg-subtle)]">{label}</dt>
      <dd className="mt-0.5 font-medium text-[var(--color-fg)]">{value}</dd>
    </div>
  );
}
