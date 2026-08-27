'use client';

import { Clock, Plane, Star } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  getAirportByCode,
  getPopularAirports,
  getRecentAirports,
  describeAirport,
  isDatasetLoaded,
  loadFullDataset,
  normalizeAirport,
  rankAirports,
  saveRecentAirport,
  searchAirports,
  type Airport,
} from '../../lib/airports';
import { cn } from '../../lib/cn';

/**
 * Por qué cambió el valor del campo.
 *
 * `type` = el usuario está escribiendo; el valor puede ser un código IATA válido y aun así
 * no ser una decisión. `select` = eligió una opción del desplegable, a propósito.
 */
export type AirportChangeReason = 'type' | 'select';

interface AirportComboboxProps {
  name: string;
  label: string;
  defaultValue?: string;
  required?: boolean;
  placeholder?: string;
  error?: string;
  /**
   * El valor cambió. `reason` distingue teclear de elegir: quien recibe esto NO debe
   * suponer que el usuario terminó con el campo salvo que `reason` sea `select`.
   */
  onChange?: (code: string, reason: AirportChangeReason) => void;
  /** id estable para el input visible (permite mover el foco a este campo desde afuera). */
  inputId?: string;
  /** Enfoca este campo al montar (sin abrir el dropdown), para empezar a escribir directo. */
  autoFocus?: boolean;
}

/**
 * ¿Este cambio autoriza a mover el foco fuera del campo?
 *
 * Sólo `select`. `onChange` dispara en CADA tecla, así que quien escribía el código a mano
 * —"BOG"— perdía el campo en la tercera letra sin haber elegido nada. Escribir tres letras
 * cambia el valor; no es elegir.
 */
export function advancesFocus(reason: AirportChangeReason): boolean {
  return reason === 'select';
}

/** Lo que le toca hacer al combobox ante una tecla. */
export type ComboboxKeyAction = 'select' | 'next' | 'prev' | 'close' | 'none';

/**
 * Traduce una tecla a la acción del combobox.
 *
 * `select` sale ÚNICAMENTE de Enter con una opción resaltada. Sin resaltado —el estado en
 * el que queda alguien que acaba de teclear, porque cada búsqueda resetea el resaltado—
 * Enter no elige nada y el formulario sigue su curso.
 */
export function comboboxKeyAction(
  key: string,
  state: { open: boolean; activeIndex: number; optionCount: number },
): ComboboxKeyAction {
  if (key === 'Escape' || key === 'Tab') return 'close';
  if (state.optionCount === 0) return 'none';
  if (key === 'ArrowDown') return 'next';
  if (key === 'ArrowUp') return 'prev';
  if (key === 'Enter') {
    const highlighted = state.activeIndex >= 0 && state.activeIndex < state.optionCount;
    return state.open && highlighted ? 'select' : 'none';
  }
  return 'none';
}

/**
 * Código IATA que representa el texto tecleado, o '' si todavía no representa ninguno.
 *
 * Un código que el catálogo local no conoce se acepta igual —el dataset puede estar
 * incompleto y el servidor valida después—, pero pasar por acá no convierte el texto en
 * una elección: ver `advancesFocus`.
 */
export function typedAirportCode(value: string): string {
  const upper = value.toUpperCase().trim();
  if (!/^[A-Z]{3}$/.test(upper)) return '';
  return getAirportByCode(upper)?.code ?? upper;
}

/** Lo que el combobox anuncia por `onChange`. */
export interface AirportChange {
  code: string;
  reason: AirportChangeReason;
}

/**
 * Lo que produce teclear en el campo.
 *
 * El valor se actualiza —escribir "BOG" a mano tiene que dejar el formulario enviable—
 * pero el motivo es `type` a propósito: que el texto ya forme un código IATA válido no
 * significa que el usuario haya terminado con el campo.
 */
export function airportTyping(value: string): AirportChange {
  return { code: typedAirportCode(value), reason: 'type' };
}

/**
 * Lo que produce elegir una opción del desplegable: valor, texto visible y el motivo
 * `select`, el único que autoriza al formulario a mover el foco.
 */
export function airportSelection(a: Airport): AirportChange & { query: string } {
  return { code: a.code, query: `${a.city} (${a.code})`, reason: 'select' };
}

const DEBOUNCE_MS = 80;

interface Section {
  label: string;
  icon: typeof Plane;
  items: Airport[];
}

export function AirportCombobox({
  name,
  label,
  defaultValue,
  required,
  placeholder = 'Ciudad o código IATA',
  error,
  onChange,
  inputId,
  autoFocus,
}: AirportComboboxProps) {
  const id = useId();
  const fieldId = inputId ?? id;
  const listboxId = `${id}-listbox`;
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Evita que el foco inicial (autoFocus) abra el dropdown automáticamente.
  const suppressOpenRef = useRef(false);

  const [query, setQuery] = useState(() => {
    if (!defaultValue) return '';
    const a = getAirportByCode(defaultValue);
    return a ? `${a.city} (${a.code})` : defaultValue;
  });
  const [code, setCode] = useState(defaultValue ?? '');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [sections, setSections] = useState<Section[]>([]);
  const [datasetVersion, setDatasetVersion] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Cancela la respuesta en vuelo si el usuario sigue tipeando. */
  const cleanupRef = useRef<(() => void) | null>(null);

  const flatItems = sections.flatMap((s) => s.items);
  const activeItem = activeIndex >= 0 ? flatItems[activeIndex] : undefined;

  const buildSections = useCallback((q: string): Section[] => {
    const trimmed = q.trim();
    if (!trimmed) {
      const result: Section[] = [];
      const recent = getRecentAirports();
      if (recent.length > 0) {
        result.push({ label: 'Recientes', icon: Clock, items: recent });
      }
      result.push({ label: 'Populares', icon: Star, items: getPopularAirports(8) });
      return result;
    }
    const results = searchAirports(trimmed, 8);
    if (results.length === 0) return [];
    return [{ label: 'Resultados', icon: Plane, items: results }];
  }, []);

  /**
   * Búsqueda híbrida: primero el endpoint, con el dataset local como respaldo.
   *
   * El endpoint /airports —que consulta la tabla `airports` de Postgres— existía pero
   * NADIE lo llamaba: toda la búsqueda salía del JSON de 1,27 MB embebido en el cliente,
   * así que había dos fuentes de verdad y la del servidor era código muerto.
   *
   * No se elimina el JSON, y esto es deliberado: el job "Sync Airports" que puebla la
   * tabla viene fallando en su paso de SSH al VPS, así que la tabla puede estar vacía o
   * vieja. Si se quitara el respaldo, el autocompletado dejaría de funcionar por
   * completo. Con el híbrido, cuando el sync se arregle la fuente autoritativa manda
   * sola, y mientras tanto nadie se queda sin buscar.
   */
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const trimmed = query.trim();

    timerRef.current = setTimeout(() => {
      if (!trimmed) {
        setSections(buildSections(query));
        setActiveIndex(-1);
        return;
      }

      let cancelled = false;
      void fetch(`/api/airports?q=${encodeURIComponent(trimmed)}&limit=8`)
        .then((r) => (r.ok ? (r.json() as Promise<{ items?: unknown[] }>) : null))
        .then((data) => {
          if (cancelled) return;
          // El endpoint habla otro dialecto (`countryName`, sin `size` ni `scheduled`) y
          // ordena por código alfabético: se normaliza fila a fila y se reordena con el
          // mismo criterio de negocio que el dataset local, para que las dos fuentes se
          // vean y se ordenen igual.
          const items = rankAirports(
            (data?.items ?? [])
              .map((row) => normalizeAirport(row))
              .filter((a): a is Airport => a !== null),
            trimmed,
          );
          // Sin resultados del servidor se cae al dataset local: puede ser un aeropuerto
          // que la tabla todavía no tiene, no necesariamente uno inexistente.
          setSections(
            items.length > 0 ? [{ label: 'Resultados', icon: Plane, items }] : buildSections(query),
          );
          setActiveIndex(-1);
        })
        .catch(() => {
          if (cancelled) return;
          setSections(buildSections(query));
          setActiveIndex(-1);
        });

      cleanupRef.current = () => {
        cancelled = true;
      };
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      cleanupRef.current?.();
    };
  }, [query, buildSections, datasetVersion]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Auto-foco al montar (sin abrir el dropdown). Precarga el dataset por si el usuario tipea.
  useEffect(() => {
    if (!autoFocus) return;
    suppressOpenRef.current = true;
    inputRef.current?.focus({ preventScroll: true });
    if (!isDatasetLoaded()) {
      void loadFullDataset().then(() => setDatasetVersion((v) => v + 1));
    }
  }, [autoFocus]);

  // Mantiene visible la opción activa al navegar con flechas (scroll-into-view).
  useEffect(() => {
    if (activeIndex < 0 || !open) return;
    const item = flatItems[activeIndex];
    if (item) {
      document.getElementById(`${id}-opt-${item.code}`)?.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex, open]);

  /**
   * Único punto que emite `select`. Lo comparten las dos formas de elegir —clic sobre la
   * opción y Enter sobre la resaltada—, así que no hay una tercera vía por la que un
   * cambio de valor pueda hacerse pasar por una decisión del usuario.
   */
  function selectAirport(a: Airport) {
    const selection = airportSelection(a);
    setCode(selection.code);
    setQuery(selection.query);
    setOpen(false);
    saveRecentAirport(selection.code);
    onChange?.(selection.code, selection.reason);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const total = flatItems.length;
    const action = comboboxKeyAction(e.key, { open, activeIndex, optionCount: total });

    if (action === 'next') {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => (i + 1) % total);
    } else if (action === 'prev') {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? total - 1 : i - 1));
    } else if (action === 'select') {
      if (!activeItem) return;
      e.preventDefault();
      selectAirport(activeItem);
    } else if (action === 'close') {
      setOpen(false);
    }
  }

  function handleInputChange(value: string) {
    setQuery(value);
    setOpen(true);
    const typed = airportTyping(value);
    setCode(typed.code);
    onChange?.(typed.code, typed.reason);
  }

  let globalIdx = -1;

  return (
    <div ref={containerRef} className="relative space-y-1.5">
      <label htmlFor={fieldId} className="block text-xs font-medium text-[var(--color-fg)]">
        {label}
      </label>

      <input type="hidden" name={name} value={code} required={required} />

      <div className="relative">
        <Plane className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--color-fg-subtle)]" />
        <input
          id={fieldId}
          ref={inputRef}
          role="combobox"
          type="text"
          value={query}
          autoComplete="off"
          placeholder={placeholder}
          aria-expanded={open && flatItems.length > 0}
          aria-controls={listboxId}
          aria-activedescendant={activeItem ? `${id}-opt-${activeItem.code}` : undefined}
          aria-autocomplete="list"
          aria-invalid={error ? true : undefined}
          onChange={(e) => handleInputChange(e.target.value)}
          onFocus={() => {
            // El auto-foco inicial enfoca pero no abre el dropdown.
            if (suppressOpenRef.current) {
              suppressOpenRef.current = false;
              return;
            }
            setOpen(true);
            if (!query.trim()) setSections(buildSections(''));
            if (!isDatasetLoaded()) {
              void loadFullDataset().then(() => {
                setDatasetVersion((v) => v + 1);
              });
            }
          }}
          onKeyDown={handleKeyDown}
          className={cn(
            'flex h-10 w-full rounded-lg border bg-[var(--color-surface)] pl-9 pr-14 py-2 text-sm text-[var(--color-fg)]',
            'placeholder:text-[var(--color-fg-subtle)]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/30 focus-visible:border-[var(--color-primary)]',
            'transition-all duration-150',
            error
              ? 'border-[var(--color-danger)] ring-2 ring-[var(--color-danger)]/20'
              : 'border-[var(--color-border)] shadow-[var(--shadow-xs)]',
          )}
        />

        {code ? (
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded-md bg-[var(--color-primary)]/10 px-2 py-0.5 font-mono text-[11px] font-semibold tracking-wider text-[var(--color-primary)]">
            {code}
          </span>
        ) : null}
      </div>

      {error ? <p className="text-[11px] text-[var(--color-danger)]">{error}</p> : null}

      {open && flatItems.length > 0 ? (
        <ul
          id={listboxId}
          role="listbox"
          className={cn(
            'absolute z-50 mt-1 max-h-80 w-full overflow-auto overscroll-contain rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-lg',
            'animate-in fade-in-0 zoom-in-95 duration-100',
          )}
        >
          {sections.map((section) => (
            <li key={section.label} role="presentation">
              <div className="flex items-center gap-2 px-3 pt-2 pb-1">
                <section.icon className="size-3 text-[var(--color-fg-subtle)]" />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-fg-subtle)]">
                  {section.label}
                </span>
              </div>
              <ul role="group" aria-label={section.label}>
                {section.items.map((a) => {
                  globalIdx++;
                  const idx = globalIdx;
                  const isActive = idx === activeIndex;
                  return (
                    <li
                      key={a.code}
                      id={`${id}-opt-${a.code}`}
                      role="option"
                      aria-selected={isActive}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        selectAirport(a);
                      }}
                      onMouseEnter={() => setActiveIndex(idx)}
                      aria-label={describeAirport(a)}
                      className={cn(
                        'flex items-center gap-3 px-3 py-2.5 text-sm cursor-pointer transition-colors duration-75',
                        isActive
                          ? 'bg-[var(--color-primary)]/8 text-[var(--color-fg)]'
                          : 'text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]',
                      )}
                    >
                      {/*
                        Aquí iba un emoji de bandera. Windows no trae fuente para los pares
                        de indicadores regionales, así que en la mayoría de las máquinas de
                        las agencias salían dos cuadros vacíos. El código ISO es texto
                        normal: se ve igual en todas partes y ocupa ancho fijo, que deja el
                        país en columna para poder escanearlo de un vistazo.
                      */}
                      <span
                        aria-hidden="true"
                        className={cn(
                          'w-7 shrink-0 text-center font-mono text-[10px] font-semibold uppercase tracking-wide',
                          isActive
                            ? 'text-[var(--color-fg-muted)]'
                            : 'text-[var(--color-fg-subtle)]',
                        )}
                      >
                        {a.countryCode}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{a.city}</p>
                        <p className="truncate text-xs text-[var(--color-fg-muted)]">
                          {[a.name, a.country].filter(Boolean).join(' · ')}
                        </p>
                      </div>
                      <span
                        className={cn(
                          'shrink-0 rounded-md px-2 py-0.5 font-mono text-[11px] font-bold tracking-wider',
                          isActive
                            ? // primary-fg, no white: en modo oscuro --color-primary es claro
                              // y el blanco encima no llega al contraste AA.
                              'bg-[var(--color-primary)] text-[var(--color-primary-fg)]'
                            : 'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]',
                        )}
                      >
                        {a.code}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      ) : null}

      {open && !query.trim() && flatItems.length === 0 ? (
        <div className="absolute z-50 mt-1 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-6 text-center shadow-lg">
          <Plane className="mx-auto mb-2 size-5 text-[var(--color-fg-subtle)]" />
          <p className="text-xs text-[var(--color-fg-muted)]">
            Escribí una ciudad o código IATA para buscar.
          </p>
        </div>
      ) : null}

      {open && query.trim().length > 0 && flatItems.length === 0 ? (
        <div className="absolute z-50 mt-1 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-5 text-center shadow-lg">
          <p className="text-xs font-medium text-[var(--color-fg)]">
            Sin resultados para «{query.trim()}»
          </p>
          <p className="mt-1 text-[11px] text-[var(--color-fg-muted)]">
            Probá con un código IATA (BOG, MIA) o nombre de ciudad.
          </p>
        </div>
      ) : null}
    </div>
  );
}
