'use client';

import { Building2, Clock, Loader2, MapPin, Search } from 'lucide-react';
import { useState, useTransition } from 'react';
import { cn } from '../../../../lib/cn';
import type { CarLocation } from '../actions';
import { CarLocationCombobox } from '../_components/location-combobox';
import {
  findOfficesAction,
  type CarOffice,
  type FindOfficesValues,
  type OfficeScheduleDay,
} from './actions';

const inputClass = cn(
  'flex h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] shadow-[var(--shadow-xs)]',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/30 focus-visible:border-[var(--color-primary)]',
  'transition-all duration-150',
);
const labelClass = 'block text-xs font-medium text-[var(--color-fg)]';

/** Modo de ubicación: por código IATA de ciudad o por coordenadas crudas. */
type LocationMode = 'iata' | 'coords';

const DAY_LABELS: Record<string, string> = {
  '1': 'Lun',
  '2': 'Mar',
  '3': 'Mié',
  '4': 'Jue',
  '5': 'Vie',
  '6': 'Sáb',
  '7': 'Dom',
};
const DAY_ORDER = ['1', '2', '3', '4', '5', '6', '7'] as const;

export default function OficinasPage() {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState('');
  const [searched, setSearched] = useState(false);

  const [mode, setMode] = useState<LocationMode>('iata');
  const [location, setLocation] = useState<CarLocation | null>(null);
  const [cityCode, setCityCode] = useState('');
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [distance, setDistance] = useState('25');
  const [companyCode, setCompanyCode] = useState('');

  const [offices, setOffices] = useState<CarOffice[]>([]);

  function onPickLocation(loc: CarLocation | null) {
    setLocation(loc);
    setCityCode(loc?.iata ?? '');
    if (loc) {
      setLat(String(loc.latitude));
      setLng(String(loc.longitude));
    }
  }

  function runSearch() {
    setError('');
    const dist = Number(distance);
    if (!Number.isFinite(dist) || dist <= 0) {
      setError('Ingresá una distancia válida (en millas).');
      return;
    }

    const values: FindOfficesValues = { distance: dist };
    if (mode === 'iata') {
      const code = (cityCode || location?.iata || '').trim();
      if (!code) {
        setError('Elegí una ciudad con código IATA o ingresá el código manualmente.');
        return;
      }
      values.cityCode = code.toUpperCase();
    } else {
      const latN = Number(lat);
      const lngN = Number(lng);
      if (!Number.isFinite(latN) || !Number.isFinite(lngN)) {
        setError('Ingresá coordenadas válidas (lat y lng).');
        return;
      }
      values.lat = latN;
      values.lng = lngN;
    }
    if (companyCode.trim()) values.companyCode = companyCode.trim();

    startTransition(async () => {
      const res = await findOfficesAction(values);
      setSearched(true);
      if (!res.ok) {
        setError(res.error ?? 'No se pudieron obtener las oficinas.');
        setOffices([]);
        return;
      }
      setOffices(res.offices);
    });
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      <header className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-lg bg-[var(--color-primary)]/10">
          <Building2 className="size-5 text-[var(--color-primary)]" />
        </div>
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-[var(--color-fg)]">
            Oficinas de autos
          </h1>
          <p className="text-xs text-[var(--color-fg-muted)]">
            Buscá oficinas de renta cercanas vía AgentCars · por ciudad o coordenadas
          </p>
        </div>
      </header>

      {error ? (
        <div className="rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 px-4 py-3 text-sm text-[var(--color-danger)]">
          {error}
        </div>
      ) : null}

      {/* ─────────── Formulario ─────────── */}
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-xs)]">
        <div className="flex gap-1 rounded-lg border border-[var(--color-border)] p-0.5">
          {(['iata', 'coords'] as LocationMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                'flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                mode === m
                  ? 'bg-[var(--color-primary)] text-[var(--color-primary-fg)]'
                  : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]',
              )}
            >
              {m === 'iata' ? 'Por ciudad (IATA)' : 'Por coordenadas'}
            </button>
          ))}
        </div>

        {mode === 'iata' ? (
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <CarLocationCombobox
              label="Ciudad"
              value={location}
              onSelect={onPickLocation}
              placeholder="Ciudad o código IATA (BOG, MIA)"
            />
            <div className="space-y-1.5">
              <label htmlFor="cityCode" className={labelClass}>
                Código IATA
              </label>
              <input
                id="cityCode"
                value={cityCode}
                onChange={(e) => setCityCode(e.target.value.toUpperCase())}
                placeholder="BOG"
                maxLength={4}
                className={cn(inputClass, 'font-mono uppercase tracking-wider')}
              />
            </div>
          </div>
        ) : (
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="lat" className={labelClass}>
                Latitud
              </label>
              <input
                id="lat"
                value={lat}
                onChange={(e) => setLat(e.target.value)}
                placeholder="4.6989"
                inputMode="decimal"
                className={inputClass}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="lng" className={labelClass}>
                Longitud
              </label>
              <input
                id="lng"
                value={lng}
                onChange={(e) => setLng(e.target.value)}
                placeholder="-74.1469"
                inputMode="decimal"
                className={inputClass}
              />
            </div>
          </div>
        )}

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="distance" className={labelClass}>
              Distancia (millas)
            </label>
            <input
              id="distance"
              type="number"
              min={1}
              value={distance}
              onChange={(e) => setDistance(e.target.value)}
              className={inputClass}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="companyCode" className={labelClass}>
              Código de proveedor <span className="text-[var(--color-fg-subtle)]">(opcional)</span>
            </label>
            <input
              id="companyCode"
              value={companyCode}
              onChange={(e) => setCompanyCode(e.target.value)}
              placeholder="Ej: ZE, AL, …"
              className={inputClass}
            />
          </div>
        </div>

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={runSearch}
            disabled={isPending}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-[var(--color-primary)] px-5 text-sm font-medium text-[var(--color-primary-fg)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" /> Buscando…
              </>
            ) : (
              <>
                <Search className="size-4" /> Buscar oficinas
              </>
            )}
          </button>
        </div>
      </div>

      {/* ─────────── Resultados ─────────── */}
      {searched ? (
        offices.length === 0 ? (
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-10 text-center">
            <Building2 className="mx-auto mb-2 size-6 text-[var(--color-fg-subtle)]" />
            <p className="text-sm text-[var(--color-fg-muted)]">
              Sin oficinas para esa ubicación y radio.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-[var(--color-fg-muted)]">
              {offices.length}{' '}
              {offices.length === 1 ? 'oficina encontrada' : 'oficinas encontradas'}
            </p>
            {offices.map((office, i) => (
              <OfficeCard key={`${office.officeCode}-${i}`} office={office} />
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

function OfficeCard({ office }: { office: CarOffice }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-xs)]">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-[var(--color-fg)]">
              {office.companyName}
            </h3>
            {office.companyCode ? (
              <span className="rounded-md bg-[var(--color-surface-muted)] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-[var(--color-fg-muted)]">
                {office.companyCode}
              </span>
            ) : null}
          </div>
          <p className="mt-1 flex items-start gap-1.5 text-xs text-[var(--color-fg-muted)]">
            <MapPin className="mt-0.5 size-3.5 shrink-0 text-[var(--color-fg-subtle)]" />
            <span className="min-w-0">
              {office.address}
              {office.address && office.cityName ? ' · ' : ''}
              {office.cityName}
              {office.state ? `, ${office.state}` : ''}
              {office.zipCode ? ` ${office.zipCode}` : ''}
            </span>
          </p>
        </div>
        {Number.isFinite(office.distance) ? (
          <span className="shrink-0 self-start rounded-md bg-[var(--color-primary)]/10 px-2 py-0.5 text-[11px] font-semibold text-[var(--color-primary)]">
            {office.distance.toLocaleString('es-CO', { maximumFractionDigits: 1 })} mi
          </span>
        ) : null}
      </div>

      <OfficeSchedule schedule={office.schedule} />
    </div>
  );
}

function OfficeSchedule({ schedule }: { schedule: Record<string, OfficeScheduleDay> }) {
  const days = DAY_ORDER.flatMap((key) => {
    const day = schedule[key];
    return day ? [{ key, day }] : [];
  });
  if (days.length === 0) {
    return (
      <p className="mt-3 flex items-center gap-1.5 text-[11px] text-[var(--color-fg-subtle)]">
        <Clock className="size-3.5" /> Sin horarios informados.
      </p>
    );
  }
  return (
    <div className="mt-3 border-t border-[var(--color-border)] pt-3">
      <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-[var(--color-fg-muted)]">
        <Clock className="size-3.5 text-[var(--color-fg-subtle)]" /> Horarios
      </p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4 lg:grid-cols-7">
        {days.map(({ key, day }) => (
          <div key={key} className="text-[11px]">
            <span className="font-medium text-[var(--color-fg)]">{DAY_LABELS[key] ?? key}</span>
            <span className="ml-1 text-[var(--color-fg-muted)]">
              {day.opening}–{day.close}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
