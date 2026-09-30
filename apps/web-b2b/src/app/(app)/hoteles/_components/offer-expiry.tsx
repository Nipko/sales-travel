'use client';

import { Clock, RefreshCw, TimerOff } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { cn } from '../../../../lib/cn';
import type { HotelOffer } from '../actions';

/*
 * Vencimiento de las tarifas de una búsqueda (RF-09).
 *
 * Hay proveedores que mantienen una tarifa sólo un rato después de buscarla (TBO: 30 minutos de
 * la búsqueda a la reserva). El API ya descuenta el margen de la reserva y manda `expiresAt` en
 * cada tarifa (búsqueda + 27 min); la pantalla cuenta hacia atrás y avisa a los 20 minutos de la
 * búsqueda, cerca del 75 % de la ventana, como en Sabre. Una tarifa sin `expiresAt` no vence
 * mientras el vendedor mira: su proveedor no informa un plazo.
 */

/** Ventana visible de una tarifa con vencimiento: `expiresAt = búsqueda + 27 min`. */
export const OFFER_WINDOW_MS = 27 * 60_000;
/** Minuto de la búsqueda en el que se avisa. */
export const OFFER_WARNING_AFTER_MS = 20 * 60_000;
/** Lo que falta para `expiresAt` cuando se avisa: 7 minutos. */
export const OFFER_WARNING_REMAINING_MS = OFFER_WINDOW_MS - OFFER_WARNING_AFTER_MS;

export type OfferExpiryPhase = 'none' | 'running' | 'warning' | 'expired';

export interface OfferExpiryState {
  readonly phase: OfferExpiryPhase;
  /** Hasta el próximo vencimiento; 0 si ya no queda ninguno por vencer. */
  readonly remainingMs: number;
  /** Tarifas de la lista. */
  readonly total: number;
  /** Tarifas con `expiresAt`. */
  readonly withExpiry: number;
  /** Tarifas ya vencidas. */
  readonly expired: number;
  /** El último vencimiento que ya pasó: las tarifas que vencen hasta acá están vencidas. */
  readonly cutoffMs?: number;
}

function instantOf(expiresAt: string | undefined): number | undefined {
  if (!expiresAt) return undefined;
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) ? t : undefined;
}

/** ¿Venció esta tarifa? Una sin `expiresAt`, o con uno ilegible, no vence en pantalla. */
export function isRateExpired(expiresAt: string | undefined, nowMs: number): boolean {
  const t = instantOf(expiresAt);
  return t !== undefined && t <= nowMs;
}

/** El estado de los vencimientos de una lista de hoteles en un instante (reloj del servidor). */
export function offerExpiryState(
  hotels: readonly Pick<HotelOffer, 'roompacks'>[],
  nowMs: number,
): OfferExpiryState {
  const packs = hotels.flatMap((h) => h.roompacks);
  const instants = packs
    .map((p) => instantOf(p.expiresAt))
    .filter((t): t is number => t !== undefined);
  const base = { total: packs.length, withExpiry: instants.length };
  if (instants.length === 0) return { ...base, phase: 'none', remainingMs: 0, expired: 0 };

  const passed = instants.filter((t) => t <= nowMs);
  const pending = instants.filter((t) => t > nowMs);
  const cutoff = passed.length > 0 ? Math.max(...passed) : undefined;
  const withCutoff = cutoff === undefined ? {} : { cutoffMs: cutoff };

  if (pending.length === 0) {
    return { ...base, ...withCutoff, phase: 'expired', remainingMs: 0, expired: passed.length };
  }
  const remainingMs = Math.min(...pending) - nowMs;
  return {
    ...base,
    ...withCutoff,
    phase: remainingMs <= OFFER_WARNING_REMAINING_MS ? 'warning' : 'running',
    remainingMs,
    expired: passed.length,
  };
}

/** `m:ss`, redondeando hacia arriba: "0:00" sólo cuando ya venció. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Texto del contador, al lado del tiempo que falta. */
export function timerLabel(state: OfferExpiryState): string {
  if (state.withExpiry === state.total) return 'Tarifas vigentes por';
  return state.withExpiry - state.expired === 1
    ? '1 tarifa vence en'
    : `${state.withExpiry - state.expired} tarifas vencen en`;
}

/** El aviso de los 20 minutos y el de vencidas. `undefined` = no hay nada que avisar todavía. */
export function offerExpiryNotice(
  state: OfferExpiryState,
): { tone: 'warning' | 'expired'; title: string; detail: string } | undefined {
  const again = 'Busca de nuevo para ver precios vigentes antes de reservar.';
  if (state.expired > 0) {
    const all = state.expired === state.total;
    return {
      tone: 'expired',
      title: all
        ? 'Las tarifas vencieron.'
        : state.expired === 1
          ? '1 tarifa venció y quedó marcada en la lista.'
          : `${state.expired} tarifas vencieron y quedaron marcadas en la lista.`,
      detail: again,
    };
  }
  if (state.phase === 'warning') {
    const minutes = OFFER_WARNING_REMAINING_MS / 60_000;
    return {
      tone: 'warning',
      title:
        state.withExpiry === state.total
          ? `Quedan menos de ${minutes} minutos para reservar estas tarifas.`
          : `Quedan menos de ${minutes} minutos para reservar algunas de estas tarifas.`,
      detail: 'Después hay que buscar de nuevo: el proveedor ya no las mantiene.',
    };
  }
  return undefined;
}

interface OfferExpiryProps {
  hotels: readonly Pick<HotelOffer, 'roompacks'>[];
  /** Reloj del servidor menos el del navegador: `expiresAt` lo fija el servidor. */
  clockOffsetMs: number;
  /** El último vencimiento que pasó, para marcar las tarifas vencidas sin redibujar cada segundo. */
  onCutoffChange: (cutoffMs: number | undefined) => void;
  onSearchAgain: () => void;
  searching: boolean;
  /** Lo que va a la izquierda del contador, en la cabecera de los resultados. */
  children: ReactNode;
}

/**
 * Cabecera de los resultados con el contador y, debajo, el aviso. El reloj vive acá y no en la
 * página: sólo esto se redibuja cada segundo.
 */
export function OfferExpiry({
  hotels,
  clockOffsetMs,
  onCutoffChange,
  onSearchAgain,
  searching,
  children,
}: OfferExpiryProps) {
  const [now, setNow] = useState(() => Date.now() + clockOffsetMs);

  useEffect(() => {
    setNow(Date.now() + clockOffsetMs);
  }, [hotels, clockOffsetMs]);

  const state = useMemo(() => offerExpiryState(hotels, now), [hotels, now]);
  const notice = offerExpiryNotice(state);
  const cutoff = state.cutoffMs;
  const counting = state.phase === 'running' || state.phase === 'warning';

  // Sólo corre mientras queda algo por vencer: una lista sin vencimientos no redibuja nada.
  useEffect(() => {
    if (!counting) return;
    const id = window.setInterval(() => setNow(Date.now() + clockOffsetMs), 1000);
    return () => window.clearInterval(id);
  }, [counting, clockOffsetMs]);

  useEffect(() => {
    onCutoffChange(cutoff);
  }, [cutoff, onCutoffChange]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="min-w-0 text-xs text-[var(--color-fg-muted)]">{children}</div>
        {counting ? (
          // `role="timer"`: el lector no anuncia cada segundo; el aviso de abajo sí se anuncia.
          <p
            role="timer"
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium tabular-nums',
              state.phase === 'warning'
                ? 'border-[var(--color-warning)]/60 bg-[var(--color-warning)]/15 text-[var(--color-fg)]'
                : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg-muted)]',
            )}
          >
            <Clock aria-hidden="true" className="size-3.5" />
            {timerLabel(state)} {formatRemaining(state.remainingMs)}
          </p>
        ) : null}
      </div>

      {/* Región viva siempre montada: una que aparece ya con texto no la anuncian todos los
          lectores. El tiempo que corre queda afuera, en el contador. */}
      <div aria-live="polite" aria-atomic="true">
        {notice ? (
          <div
            className={cn(
              'flex flex-col gap-3 rounded-lg border px-4 py-3 text-sm text-[var(--color-fg)] sm:flex-row sm:items-center sm:justify-between',
              notice.tone === 'expired'
                ? 'border-[var(--color-danger)]/35 bg-[var(--color-danger)]/5'
                : 'border-[var(--color-warning)]/60 bg-[var(--color-warning)]/10',
            )}
          >
            <div className="flex items-start gap-2.5">
              {notice.tone === 'expired' ? (
                <TimerOff
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 text-[var(--color-danger)]"
                />
              ) : (
                <Clock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              )}
              <p>
                <strong className="font-semibold">{notice.title}</strong> {notice.detail}
              </p>
            </div>
            <button
              type="button"
              onClick={onSearchAgain}
              disabled={searching}
              className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs font-medium text-[var(--color-fg)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-surface-muted)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RefreshCw
                aria-hidden="true"
                className={cn('size-3.5', searching && 'animate-spin motion-reduce:animate-none')}
              />
              {searching ? 'Buscando…' : 'Buscar de nuevo'}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
