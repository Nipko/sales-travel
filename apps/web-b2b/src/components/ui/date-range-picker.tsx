'use client';

import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { cn } from '../../lib/cn';

/* =============================================================================================
   MODELO PURO
   ---------------------------------------------------------------------------------------------
   Todo lo que decide QUÉ pasa vive acá arriba, exportado y sin React: es la puerta pública que
   cubren los tests. El componente de abajo sólo pinta y enruta eventos hacia estas funciones.
   Una fecha es siempre 'YYYY-MM-DD', y por eso se comparan con `<` y `>` directamente: en ese
   formato el orden lexicográfico ES el orden cronológico, sin construir un `Date` por celda.
   ============================================================================================= */

/** Fecha de calendario en 'YYYY-MM-DD'. Sin hora y sin huso: un día del calendario, nada más. */
export type IsoDate = string;

export interface DateRange {
  readonly start: IsoDate | null;
  readonly end: IsoDate | null;
}

export const EMPTY_RANGE: DateRange = { start: null, end: null };

export type TripMode = 'roundtrip' | 'oneway';

/** Las dos reglas que gobiernan la selección: qué se pide y desde cuándo. */
export interface RangeRules {
  readonly mode: TripMode;
  /** Primer día seleccionable. Para este control, lo anterior no existe. */
  readonly min: IsoDate;
}

const MS_PER_DAY = 86_400_000;

/*
  Nombres en español escritos a mano en vez de `Intl.DateTimeFormat`. Dos razones concretas:
  el disparador se renderiza en el servidor y en el cliente, y una diferencia de datos ICU entre
  Node y el navegador produciría un error de hidratación silencioso; y acá hace falta controlar
  la tipografía del dato (minúscula, sin punto abreviativo) que cada runtime resuelve distinto.
*/
const MONTHS_ES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
] as const;

const MONTHS_ES_SHORT = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
] as const;

/*
  La semana arranca el lunes y el fin de semana queda junto, a la derecha. No es una convención
  heredada: casi todo viaje de ocio se ancla en un fin de semana, y con la semana partida entre
  las dos puntas de la fila el vendedor tiene que leer dos veces para ver si el rango cubre uno.
*/
const WEEKDAYS_ES = [
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
  'domingo',
] as const;

const WEEKDAYS_ES_SHORT = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'] as const;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Arma la fecha desde sus partes, con el mes en base 1 (como se lee, no como lo cuenta `Date`). */
export function isoFrom(year: number, month: number, day: number): IsoDate {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/*
  Toda la aritmética pasa por UTC a propósito. Con horas locales, un país que mueve el reloj
  —o simplemente un servidor en otro huso— desplaza el resultado de sumar un día, y el bug
  aparece una vez al año en un rango que cruza el cambio de hora.
*/
function utcOf(iso: IsoDate): number {
  return Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
}

function isoFromUtc(ms: number): IsoDate {
  const d = new Date(ms);
  return isoFrom(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

export function addDays(iso: IsoDate, days: number): IsoDate {
  return isoFromUtc(utcOf(iso) + days * MS_PER_DAY);
}

/** Cuántos días tiene el mes (base 1). */
export function daysInMonth(year: number, month: number): number {
  // El día 0 del mes siguiente es el último del pedido; evita la tabla de 30/31 y el bisiesto.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Suma meses conservando el día; si el mes destino es más corto, cae en su último día. */
export function addMonths(iso: IsoDate, months: number): IsoDate {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  const target = month - 1 + months;
  const targetYear = year + Math.floor(target / 12);
  const targetMonth = (((target % 12) + 12) % 12) + 1;
  return isoFrom(targetYear, targetMonth, Math.min(day, daysInMonth(targetYear, targetMonth)));
}

export function firstOfMonth(iso: IsoDate): IsoDate {
  return `${iso.slice(0, 7)}-01`;
}

export function lastOfMonth(iso: IsoDate): IsoDate {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  return isoFrom(year, month, daysInMonth(year, month));
}

/** Días calendario entre dos fechas. Negativo si `to` es anterior a `from`. */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((utcOf(to) - utcOf(from)) / MS_PER_DAY);
}

/** Lunes = 0 … domingo = 6. */
export function weekdayIndex(iso: IsoDate): number {
  return (new Date(utcOf(iso)).getUTCDay() + 6) % 7;
}

export function startOfWeek(iso: IsoDate): IsoDate {
  return addDays(iso, -weekdayIndex(iso));
}

export function endOfWeek(iso: IsoDate): IsoDate {
  return addDays(startOfWeek(iso), 6);
}

/**
 * Hoy según el calendario del usuario.
 *
 * Local y no UTC: quien abre el buscador a las 21:00 en Bogotá tiene que poder elegir "hoy",
 * y en UTC ese instante ya es mañana.
 */
export function todayIso(now: Date = new Date()): IsoDate {
  return isoFrom(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/** Las semanas de un mes (base 1), con `null` en los huecos de los extremos. */
export function monthMatrix(year: number, month: number): readonly (IsoDate | null)[][] {
  const total = daysInMonth(year, month);
  const offset = weekdayIndex(isoFrom(year, month, 1));
  const cells: (IsoDate | null)[] = Array.from({ length: offset }, () => null);
  for (let day = 1; day <= total; day++) cells.push(isoFrom(year, month, day));
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks: (IsoDate | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/* ---------------------------------------------------------------------------------------------
   Selección
   ------------------------------------------------------------------------------------------- */

export function isDisabledDay(day: IsoDate, rules: RangeRules): boolean {
  return day < rules.min;
}

/** Sube al mínimo cualquier fecha anterior. El teclado no puede aterrizar en un día apagado. */
export function clampToMin(day: IsoDate, rules: RangeRules): IsoDate {
  return day < rules.min ? rules.min : day;
}

/**
 * El rango que resulta de tocar `day`. Única fuente de verdad de la selección.
 *
 * El caso que decide el diseño es el tercero: si el segundo clic cae ANTES de la ida, no se
 * rechaza — se reinicia el rango desde ahí. Quien se equivocó de mes al elegir la ida hace
 * exactamente eso, tocar el día correcto; devolverle un error lo obligaría a borrar primero.
 *
 * Tocar el mismo día de la ida sí cierra un rango de cero noches: el regreso en el día es un
 * itinerario real (los regionales de LATAM se venden así), no un error que haya que impedir.
 */
export function nextRange(current: DateRange, day: IsoDate, rules: RangeRules): DateRange {
  if (isDisabledDay(day, rules)) return current;
  if (rules.mode === 'oneway') return { start: day, end: null };
  if (current.start === null || current.end !== null) return { start: day, end: null };
  if (day < current.start) return { start: day, end: null };
  return { start: current.start, end: day };
}

/**
 * Lo que se pintaría si el usuario tocara `hovered`.
 *
 * Se delega en `nextRange` en vez de reimplementar el criterio: la previsualización es, por
 * construcción, exactamente lo que va a pasar al hacer clic. En solo ida no previsualiza nada
 * porque no hay rango que anticipar — mover la única fecha ya lo comunica el hover de la celda.
 */
export function previewRange(draft: DateRange, hovered: IsoDate, rules: RangeRules): DateRange {
  if (rules.mode === 'oneway') return draft;
  if (draft.start === null || draft.end !== null) return draft;
  if (isDisabledDay(hovered, rules)) return draft;
  return nextRange(draft, hovered, rules);
}

export type DayRole = 'start' | 'end' | 'both' | 'inside' | null;

export function dayRole(day: IsoDate, range: DateRange): DayRole {
  const { start, end } = range;
  if (start === null) return null;
  if (end === null) return day === start ? 'start' : null;
  if (day === start && day === end) return 'both';
  if (day === start) return 'start';
  if (day === end) return 'end';
  return day > start && day < end ? 'inside' : null;
}

export interface TripLength {
  readonly nights: number;
  readonly days: number;
}

/**
 * Duración del viaje, en noches y en días.
 *
 * La cifra que manda es NOCHES, no días, y no es una preferencia estética: el vendedor cotiza
 * el hotel por noche y el seguro por día, así que "del 12 al 19" son 7 noches y 8 días y las
 * dos cifras se usan para cosas distintas. Un contador que dijera sólo "8" haría que alguien
 * cotice ocho noches de hotel para un viaje de siete. Por eso el modelo devuelve ambas y la UI
 * las etiqueta siempre con su unidad.
 */
export function tripLength(range: DateRange): TripLength | null {
  if (range.start === null || range.end === null) return null;
  const nights = daysBetween(range.start, range.end);
  return { nights, days: nights + 1 };
}

/** Etiqueta corta para el contador flotante. Siempre lleva la unidad. */
export function tripLengthLabel(range: DateRange): string | null {
  const length = tripLength(range);
  if (length === null) return null;
  if (length.nights === 0) return 'Mismo día';
  return `${length.nights} ${length.nights === 1 ? 'noche' : 'noches'}`;
}

export function canApply(range: DateRange, rules: RangeRules): boolean {
  if (range.start === null) return false;
  return rules.mode === 'oneway' ? true : range.end !== null;
}

/**
 * Con qué rango se abre el calendario.
 *
 * Abrir por la mitad "Vuelta" limpia la vuelta: quien toca ese campo va a cambiarla, y dejarla
 * puesta obligaría a un clic extra para reiniciar. Es un borrador: mientras no se aplique, el
 * valor confirmado sigue intacto y Escape lo deja como estaba.
 */
export function openDraft(value: DateRange, editing: RangeEdge, rules: RangeRules): DateRange {
  if (rules.mode === 'oneway') return { start: value.start, end: null };
  if (editing === 'end') return { start: value.start, end: null };
  return value;
}

export type RangeEdge = 'start' | 'end';

/** Qué fecha se está esperando ahora. Se deriva del borrador, con el criterio de `nextRange`. */
export function pickerHint(draft: DateRange, rules: RangeRules): string {
  if (rules.mode === 'oneway') return 'Elija la fecha de ida';
  if (draft.start === null || draft.end !== null) return 'Elija la fecha de ida';
  return 'Elija la fecha de vuelta';
}

/* ---------------------------------------------------------------------------------------------
   Texto
   ------------------------------------------------------------------------------------------- */

function monthName(iso: IsoDate): string {
  return MONTHS_ES[Number(iso.slice(5, 7)) - 1] ?? '';
}

/** "mar 12 sep" — lo que se lee en el disparador. */
export function formatDayShort(iso: IsoDate): string {
  const weekday = WEEKDAYS_ES_SHORT[weekdayIndex(iso)] ?? '';
  const month = MONTHS_ES_SHORT[Number(iso.slice(5, 7)) - 1] ?? '';
  return `${weekday} ${Number(iso.slice(8, 10))} ${month}`;
}

/** "12 de septiembre" */
export function formatDayMedium(iso: IsoDate): string {
  return `${Number(iso.slice(8, 10))} de ${monthName(iso)}`;
}

/** "martes 12 de septiembre de 2026" — la forma que se lee en voz alta. */
export function describeDay(iso: IsoDate): string {
  const weekday = WEEKDAYS_ES[weekdayIndex(iso)] ?? '';
  return `${weekday} ${formatDayMedium(iso)} de ${iso.slice(0, 4)}`;
}

export function formatMonthTitle(iso: IsoDate): string {
  return `${monthName(iso)} ${iso.slice(0, 4)}`;
}

/**
 * Lo que anuncia un lector de pantalla sobre una celda.
 *
 * Acá es donde el rango deja de depender del color: el papel de cada día —ida, vuelta, dentro
 * del viaje, no disponible— viaja como texto, no como un relleno naranja.
 */
export function dayAriaLabel(day: IsoDate, range: DateRange, rules: RangeRules): string {
  const base = describeDay(day);
  if (isDisabledDay(day, rules)) return `${base}, no disponible`;
  if (rules.mode === 'oneway') {
    return dayRole(day, range) === null ? base : `${base}, fecha de ida`;
  }
  switch (dayRole(day, range)) {
    case 'both':
      return `${base}, ida y vuelta el mismo día`;
    case 'start':
      return `${base}, ida`;
    case 'end':
      return `${base}, vuelta`;
    case 'inside':
      return `${base}, dentro del viaje`;
    default:
      return base;
  }
}

/** Estado del rango en una frase. Va al pie del calendario y a la región `aria-live`. */
export function rangeSummary(range: DateRange, rules: RangeRules): string {
  if (range.start === null) return 'Sin fechas seleccionadas';
  if (rules.mode === 'oneway') return `Ida: ${describeDay(range.start)}`;

  const length = tripLength(range);
  if (range.end === null || length === null) {
    return `Ida ${formatDayMedium(range.start)} · falta la fecha de vuelta`;
  }
  // "Del 3 al 3 de septiembre · 0 noches" es correcto y suena a error. Se dice como se vende.
  if (length.nights === 0) {
    return `El ${formatDayMedium(range.start)} · ida y vuelta el mismo día`;
  }
  const nights = `${length.nights} ${length.nights === 1 ? 'noche' : 'noches'}`;
  const days = `${length.days} ${length.days === 1 ? 'día' : 'días'}`;
  return `Del ${formatDayMedium(range.start)} al ${formatDayMedium(range.end)} · ${nights} (${days})`;
}

/* ---------------------------------------------------------------------------------------------
   Teclado
   ------------------------------------------------------------------------------------------- */

export type CalendarKeyAction =
  | { readonly kind: 'move'; readonly days: number }
  | { readonly kind: 'month'; readonly months: number }
  | { readonly kind: 'week-start' }
  | { readonly kind: 'week-end' }
  | { readonly kind: 'select' }
  | { readonly kind: 'close' }
  | { readonly kind: 'none' };

export function calendarKeyAction(key: string): CalendarKeyAction {
  switch (key) {
    case 'ArrowLeft':
      return { kind: 'move', days: -1 };
    case 'ArrowRight':
      return { kind: 'move', days: 1 };
    case 'ArrowUp':
      return { kind: 'move', days: -7 };
    case 'ArrowDown':
      return { kind: 'move', days: 7 };
    case 'PageUp':
      return { kind: 'month', months: -1 };
    case 'PageDown':
      return { kind: 'month', months: 1 };
    case 'Home':
      return { kind: 'week-start' };
    case 'End':
      return { kind: 'week-end' };
    case 'Enter':
    case ' ':
      return { kind: 'select' };
    case 'Escape':
      return { kind: 'close' };
    default:
      return { kind: 'none' };
  }
}

/**
 * Dónde queda el foco tras una tecla.
 *
 * Navegar NO selecciona: esta función mueve el cursor y nada más. Elegir es siempre un acto
 * aparte —Enter o clic—, que es la única forma de que cambiar de mes no elija por sorpresa.
 * El resultado se sube al mínimo, así que las fechas pasadas tampoco son alcanzables a tientas.
 */
export function focusAfterKey(focused: IsoDate, key: string, rules: RangeRules): IsoDate {
  const action = calendarKeyAction(key);
  switch (action.kind) {
    case 'move':
      return clampToMin(addDays(focused, action.days), rules);
    case 'month':
      return clampToMin(addMonths(focused, action.months), rules);
    case 'week-start':
      return clampToMin(startOfWeek(focused), rules);
    case 'week-end':
      return clampToMin(endOfWeek(focused), rules);
    default:
      return focused;
  }
}

/* =============================================================================================
   COMPONENTE
   ============================================================================================= */

export interface DateRangePickerProps {
  readonly mode: TripMode;
  /** Valor confirmado. El borrador interno sólo lo pisa al aplicar. */
  readonly value: DateRange;
  readonly onChange: (range: DateRange) => void;
  /** Primer día seleccionable. Por defecto, hoy. */
  readonly min?: IsoDate;
  /** Nombre del campo oculto de la ida, para enviar el formulario. */
  readonly startName?: string;
  readonly endName?: string;
  readonly startLabel?: string;
  readonly endLabel?: string;
  /** id del disparador de la ida (permite mover el foco a este control desde el formulario). */
  readonly triggerId?: string;
  readonly className?: string;
}

const MONTHS_VISIBLE = 2;

export function DateRangePicker({
  mode,
  value,
  onChange,
  min,
  startName = 'departureDate',
  endName = 'returnDate',
  startLabel = 'Ida',
  endLabel = 'Vuelta',
  triggerId,
  className,
}: DateRangePickerProps) {
  const autoId = useId();
  const startTriggerId = triggerId ?? `${autoId}-start`;
  const dialogId = `${autoId}-dialog`;

  const floor = min ?? todayIso();
  const rules = useMemo<RangeRules>(() => ({ mode, min: floor }), [mode, floor]);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<RangeEdge>('start');
  const [draft, setDraft] = useState<DateRange>(value);
  const [cursor, setCursor] = useState<IsoDate>(() => firstOfMonth(value.start ?? floor));
  const [focusedDay, setFocusedDay] = useState<IsoDate>(() =>
    clampToMin(value.start ?? floor, rules),
  );
  const [hovered, setHovered] = useState<IsoDate | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const startTriggerRef = useRef<HTMLButtonElement>(null);
  const endTriggerRef = useRef<HTMLButtonElement>(null);

  const dayCellId = useCallback((day: IsoDate) => `${autoId}-day-${day}`, [autoId]);

  /**
   * Cierra sin aplicar. `returnFocus` es falso cuando el usuario ya se fue con el ratón o con
   * Tab: devolverle el foco al disparador en ese momento sería moverlo sin que lo pidiera.
   */
  const closePicker = useCallback(
    (returnFocus: boolean) => {
      setOpen(false);
      setHovered(null);
      if (!returnFocus) return;
      const trigger = editing === 'end' ? endTriggerRef.current : startTriggerRef.current;
      trigger?.focus({ preventScroll: true });
    },
    [editing],
  );

  function openPicker(which: RangeEdge) {
    const nextDraft = openDraft(value, which, rules);
    const anchor = which === 'end' ? (value.end ?? value.start ?? floor) : (value.start ?? floor);
    const focus = clampToMin(anchor, rules);
    setDraft(nextDraft);
    setEditing(which);
    setCursor(firstOfMonth(focus));
    setFocusedDay(focus);
    setHovered(null);
    setOpen(true);
  }

  // Clic fuera: cierra y descarta. No devuelve el foco — el usuario ya está en otro lado.
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) closePicker(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open, closePicker]);

  /*
    El foco sigue al día activo (tabindex móvil). Se aplica sólo mientras el calendario está
    abierto y sólo cuando cambia el día activo, que únicamente cambia por acción del usuario:
    ningún efecto de fondo mueve el foco por su cuenta.
  */
  useEffect(() => {
    if (!open) return;
    document.getElementById(dayCellId(focusedDay))?.focus({ preventScroll: true });
  }, [open, focusedDay, dayCellId]);

  const months = useMemo(
    () => Array.from({ length: MONTHS_VISIBLE }, (_, i) => addMonths(cursor, i)),
    [cursor],
  );
  const lastVisibleDay = lastOfMonth(months[MONTHS_VISIBLE - 1] ?? cursor);
  const prevDisabled = cursor <= firstOfMonth(rules.min);

  function moveCursor(months_: number) {
    const target = firstOfMonth(addMonths(cursor, months_));
    const floorMonth = firstOfMonth(rules.min);
    setCursor(target < floorMonth ? floorMonth : target);
  }

  /** Trae el mes del día activo a la vista, conservando la continuidad al avanzar. */
  function ensureVisible(day: IsoDate) {
    if (day < cursor) {
      setCursor(firstOfMonth(day));
      return;
    }
    if (day > lastVisibleDay) setCursor(firstOfMonth(addMonths(day, -(MONTHS_VISIBLE - 1))));
  }

  function selectDay(day: IsoDate) {
    if (isDisabledDay(day, rules)) return;
    setDraft((current) => nextRange(current, day, rules));
    setFocusedDay(day);
  }

  function handleDayKeyDown(event: React.KeyboardEvent<HTMLTableCellElement>, day: IsoDate) {
    const action = calendarKeyAction(event.key);
    if (action.kind === 'none') return;
    // Escape lo atiende el contenedor, para que haya un solo camino de cierre.
    if (action.kind === 'close') return;

    event.preventDefault();
    if (action.kind === 'select') {
      selectDay(day);
      return;
    }
    const next = focusAfterKey(day, event.key, rules);
    setFocusedDay(next);
    ensureVisible(next);
  }

  function applyDraft() {
    if (!canApply(draft, rules)) return;
    onChange(mode === 'oneway' ? { start: draft.start, end: null } : draft);
    closePicker(true);
  }

  function clearDraft() {
    setDraft(EMPTY_RANGE);
    setHovered(null);
    // El foco vuelve a la grilla: quien borró va a elegir de nuevo, no a salir.
    document.getElementById(dayCellId(focusedDay))?.focus({ preventScroll: true });
  }

  const painted = hovered === null ? draft : previewRange(draft, hovered, rules);
  const counter = tripLengthLabel(painted);
  const summary = rangeSummary(draft, rules);

  return (
    <div
      ref={rootRef}
      className={cn('relative', className)}
      onKeyDown={(event) => {
        if (!open || event.key !== 'Escape') return;
        // No dejar que el Escape suba: cerraría también el diálogo o la página que lo contenga.
        event.preventDefault();
        event.stopPropagation();
        closePicker(true);
      }}
      onBlur={(event) => {
        if (!open) return;
        if (rootRef.current?.contains(event.relatedTarget)) return;
        closePicker(false);
      }}
    >
      <input type="hidden" name={startName} value={value.start ?? ''} />
      {mode === 'roundtrip' ? <input type="hidden" name={endName} value={value.end ?? ''} /> : null}

      {/*
        El disparador es un talón de ticket: dos mitades separadas por la perforación. Son dos
        botones y no uno con dos zonas porque tocar «Vuelta» tiene que llevar a elegir la vuelta,
        no a empezar de cero — y un botón dentro de otro botón no es HTML válido.
      */}
      <div
        className={cn(
          'flex h-14 items-stretch overflow-hidden rounded-xl border bg-[var(--color-surface)] shadow-[var(--shadow-xs)] transition-colors',
          open
            ? 'border-[var(--color-primary)]'
            : 'border-[var(--color-border)] hover:border-[var(--color-border-strong)]',
        )}
      >
        <span
          aria-hidden="true"
          className="hidden w-11 shrink-0 items-center justify-center border-r border-[var(--color-border)] text-[var(--color-fg-subtle)] sm:flex"
        >
          <CalendarDays className="size-4" />
        </span>

        <TriggerHalf
          ref={startTriggerRef}
          id={startTriggerId}
          label={startLabel}
          day={value.start}
          placeholder="Elija fecha"
          active={open && editing === 'start'}
          expanded={open}
          controls={dialogId}
          onClick={() => (open && editing === 'start' ? closePicker(true) : openPicker('start'))}
        />

        {mode === 'roundtrip' ? (
          <>
            <span
              aria-hidden="true"
              className="my-2 w-px shrink-0 border-l border-dashed border-[var(--color-border-strong)]"
            />
            <TriggerHalf
              ref={endTriggerRef}
              label={endLabel}
              day={value.end}
              placeholder="Agregar vuelta"
              active={open && editing === 'end'}
              expanded={open}
              controls={dialogId}
              onClick={() => (open && editing === 'end' ? closePicker(true) : openPicker('end'))}
            />
          </>
        ) : null}
      </div>

      {open ? (
        <>
          {/*
            En móvil el calendario es una hoja anclada abajo, al alcance del pulgar, y no un
            desplegable atado al ancho del campo: con 375 px de pantalla, colgarlo del campo
            deja celdas de 34 px, por debajo del área táctil que hace falta para no errar el día.
            El velo, además, es el que recoge el toque de «afuera» para cerrar.
          */}
          <div
            aria-hidden="true"
            onClick={() => closePicker(false)}
            className="fixed inset-0 z-40 bg-[var(--color-navy-dark)]/25 sm:hidden"
          />
          <div
            id={dialogId}
            role="dialog"
            aria-label={mode === 'oneway' ? 'Elegir fecha de ida' : 'Elegir fechas del viaje'}
            className={cn(
              'fixed inset-x-2 bottom-2 z-50 flex max-h-[82vh] flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-lg)]',
              'sm:absolute sm:inset-x-auto sm:bottom-auto sm:left-0 sm:top-full sm:mt-2 sm:max-h-none sm:w-[41rem]',
              'origin-bottom animate-[scale-up_0.15s_cubic-bezier(0.16,1,0.3,1)_forwards] sm:origin-top',
            )}
          >
            <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-2.5">
              <NavButton
                label="Mes anterior"
                disabled={prevDisabled}
                onClick={() => moveCursor(-1)}
                icon={<ChevronLeft className="size-4" />}
              />
              <p className="text-xs font-medium text-[var(--color-fg-muted)]">
                {pickerHint(draft, rules)}
              </p>
              <NavButton
                label="Mes siguiente"
                onClick={() => moveCursor(1)}
                icon={<ChevronRight className="size-4" />}
              />
            </div>

            {/*
            Móvil: una columna que se recorre en vertical. Escritorio: los dos meses lado a lado,
            que es lo que evita el «¿y si vuelvo a principios del mes que viene?» con un clic.
          */}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-1 pt-4 sm:flex-none sm:overflow-visible">
              <div className="grid gap-6 sm:grid-cols-2">
                {months.map((month) => (
                  <MonthTable
                    key={month}
                    month={month}
                    painted={painted}
                    rules={rules}
                    focusedDay={focusedDay}
                    counter={counter}
                    today={floor}
                    dayCellId={dayCellId}
                    onSelect={selectDay}
                    onHover={setHovered}
                    onKeyDown={handleDayKeyDown}
                  />
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-[var(--color-border)] px-3 py-2.5">
              {/* El resumen es la versión en texto del rango: no hace falta ver el color. */}
              <p
                aria-live="polite"
                className="min-w-0 flex-1 text-[11px] leading-snug text-[var(--color-fg-muted)]"
              >
                {summary}
              </p>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={clearDraft}
                  disabled={draft.start === null}
                  className="rounded-lg px-3 py-1.5 text-xs font-medium text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)] disabled:pointer-events-none disabled:opacity-40"
                >
                  Borrar
                </button>
                <button
                  type="button"
                  onClick={applyDraft}
                  disabled={!canApply(draft, rules)}
                  className="rounded-lg bg-[var(--color-primary)] px-4 py-1.5 text-xs font-semibold text-[var(--color-primary-fg)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-primary-hover)] disabled:pointer-events-none disabled:opacity-40"
                >
                  Aplicar
                </button>
              </div>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

interface TriggerHalfProps {
  readonly id?: string;
  readonly label: string;
  readonly day: IsoDate | null;
  readonly placeholder: string;
  readonly active: boolean;
  readonly expanded: boolean;
  readonly controls: string;
  readonly onClick: () => void;
  readonly ref?: React.Ref<HTMLButtonElement>;
}

/** Media entrada del talón: etiqueta chica arriba, fecha grande abajo. */
function TriggerHalf({
  id,
  label,
  day,
  placeholder,
  active,
  expanded,
  controls,
  onClick,
  ref,
}: TriggerHalfProps) {
  return (
    <button
      ref={ref}
      id={id}
      type="button"
      /*
        Abre con clic, nunca al recibir el foco: llegar con Tab desde el destino no puede
        desplegar un calendario encima de la pantalla de quien sólo estaba pasando de largo.
      */
      onClick={onClick}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-controls={expanded ? controls : undefined}
      className={cn(
        'flex min-w-0 flex-1 flex-col justify-center gap-0.5 px-3 text-left transition-colors',
        active ? 'bg-[var(--color-primary)]/6' : 'hover:bg-[var(--color-surface-muted)]',
      )}
    >
      <span className="text-[10px] font-semibold uppercase tracking-[0.09em] text-[var(--color-fg-subtle)]">
        {label}
      </span>
      <span
        className={cn(
          'truncate text-[15px] font-semibold leading-tight',
          day === null ? 'font-normal text-[var(--color-fg-subtle)]' : 'text-[var(--color-fg)]',
        )}
      >
        {day === null ? placeholder : formatDayShort(day)}
      </span>
      <span className="sr-only">{day === null ? 'sin fecha' : describeDay(day)}</span>
    </button>
  );
}

function NavButton({
  label,
  icon,
  onClick,
  disabled,
}: {
  readonly label: string;
  readonly icon: React.ReactNode;
  readonly onClick: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-[var(--color-border)] text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)] disabled:pointer-events-none disabled:opacity-30"
    >
      {icon}
    </button>
  );
}

interface MonthTableProps {
  readonly month: IsoDate;
  readonly painted: DateRange;
  readonly rules: RangeRules;
  readonly focusedDay: IsoDate;
  readonly counter: string | null;
  readonly today: IsoDate;
  readonly dayCellId: (day: IsoDate) => string;
  readonly onSelect: (day: IsoDate) => void;
  readonly onHover: (day: IsoDate | null) => void;
  readonly onKeyDown: (event: React.KeyboardEvent<HTMLTableCellElement>, day: IsoDate) => void;
}

function MonthTable({
  month,
  painted,
  rules,
  focusedDay,
  counter,
  today,
  dayCellId,
  onSelect,
  onHover,
  onKeyDown,
}: MonthTableProps) {
  const titleId = `${dayCellId(month)}-title`;
  const weeks = useMemo(
    () => monthMatrix(Number(month.slice(0, 4)), Number(month.slice(5, 7))),
    [month],
  );

  return (
    <div>
      <p
        id={titleId}
        className="mb-2 text-center text-sm font-semibold capitalize text-[var(--color-fg)]"
      >
        {formatMonthTitle(month)}
      </p>
      <table
        role="grid"
        aria-labelledby={titleId}
        // El rango marca varias celdas a la vez; sin esto el lector anuncia cada día como si
        // hubiera reemplazado al anterior.
        aria-multiselectable={rules.mode === 'roundtrip'}
        className="w-full table-fixed border-separate border-spacing-0"
        onMouseLeave={() => onHover(null)}
      >
        <thead>
          <tr>
            {WEEKDAYS_ES_SHORT.map((short, i) => (
              <th
                key={short}
                scope="col"
                className="pb-1.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]"
              >
                <span aria-hidden="true">{short}</span>
                <span className="sr-only">{WEEKDAYS_ES[i]}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week, weekIndex) => (
            <tr key={week.find((d) => d !== null) ?? weekIndex} role="row">
              {week.map((day, dayIndex) =>
                day === null ? (
                  <td
                    key={`${weekIndex}-${dayIndex}`}
                    role="presentation"
                    className="h-12 p-0 sm:h-11"
                  />
                ) : (
                  <DayCell
                    key={day}
                    day={day}
                    id={dayCellId(day)}
                    painted={painted}
                    rules={rules}
                    focused={day === focusedDay}
                    isToday={day === today}
                    counter={counter}
                    weekIndex={weekIndex}
                    dayIndex={dayIndex}
                    onSelect={onSelect}
                    onHover={onHover}
                    onKeyDown={onKeyDown}
                  />
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface DayCellProps {
  readonly day: IsoDate;
  readonly id: string;
  readonly painted: DateRange;
  readonly rules: RangeRules;
  readonly focused: boolean;
  readonly isToday: boolean;
  readonly counter: string | null;
  readonly weekIndex: number;
  readonly dayIndex: number;
  readonly onSelect: (day: IsoDate) => void;
  readonly onHover: (day: IsoDate | null) => void;
  readonly onKeyDown: (event: React.KeyboardEvent<HTMLTableCellElement>, day: IsoDate) => void;
}

function DayCell({
  day,
  id,
  painted,
  rules,
  focused,
  isToday,
  counter,
  weekIndex,
  dayIndex,
  onSelect,
  onHover,
  onKeyDown,
}: DayCellProps) {
  const disabled = isDisabledDay(day, rules);
  const role = dayRole(day, painted);
  const isEdge = role === 'start' || role === 'end' || role === 'both';
  const lonelyStart = role === 'start' && painted.end === null;

  /*
    El trazo va en una capa a sangre completa detrás del número, así que en días consecutivos
    los fondos se tocan y el rango se lee como una sola línea continua y no como una fila de
    cuadraditos. En los extremos cubre media celda —la mitad que mira hacia dentro del viaje—
    para que no sobresalga un muñón por fuera de la ida o de la vuelta.
  */
  const stroke =
    role === 'inside'
      ? 'inset-0'
      : role === 'start' && !lonelyStart
        ? 'inset-y-0 left-1/2 right-0'
        : role === 'end'
          ? 'inset-y-0 left-0 right-1/2'
          : null;

  return (
    <td
      id={id}
      role="gridcell"
      aria-selected={role !== null}
      aria-disabled={disabled || undefined}
      aria-current={isToday ? 'date' : undefined}
      aria-label={dayAriaLabel(day, painted, rules)}
      tabIndex={focused && !disabled ? 0 : -1}
      onClick={() => onSelect(day)}
      onKeyDown={(event) => onKeyDown(event, day)}
      onMouseEnter={() => onHover(disabled ? null : day)}
      className={cn(
        // 48 px en móvil: la celda ES el objetivo táctil, y el pulgar de un vendedor en ruta
        // no acierta un día de 42 px sin mirar dos veces.
        'relative h-12 p-0 text-center align-middle sm:h-11',
        disabled ? 'cursor-not-allowed' : 'cursor-pointer',
      )}
    >
      {stroke ? (
        <span
          aria-hidden="true"
          className={cn(
            'absolute bg-[var(--color-primary)]/12',
            stroke,
            dayIndex === 0 && 'rounded-l-lg',
            dayIndex === 6 && 'rounded-r-lg',
          )}
        />
      ) : null}

      <span
        className={cn(
          'relative mx-auto flex size-9 items-center justify-center rounded-lg text-[13px] tabular-nums transition-colors',
          disabled && 'text-[var(--color-fg-subtle)]/45',
          !disabled && !isEdge && 'text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]',
          role === 'inside' && 'font-medium',
          isEdge &&
            'bg-[var(--color-primary)] font-semibold text-[var(--color-primary-fg)] shadow-[var(--shadow-xs)]',
          focused && !isEdge && 'ring-1 ring-inset ring-[var(--color-border-strong)]',
        )}
      >
        {/* En los extremos el número sube apenas: deja aire para la etiqueta de abajo. */}
        <span className={cn(isEdge && '-translate-y-[3px]')}>{Number(day.slice(8, 10))}</span>

        {/* Hoy se marca con un punto, no con un aro: un aro competiría con los extremos. */}
        {isToday && !isEdge ? (
          <span
            aria-hidden="true"
            className="absolute bottom-1 size-1 rounded-full bg-[var(--color-fg-subtle)]"
          />
        ) : null}

        {/* IDA / VTA en el propio extremo: el papel del día también se lee, no sólo se ve. */}
        {isEdge ? (
          <span
            aria-hidden="true"
            className="absolute bottom-0.5 text-[8px] font-bold uppercase leading-none tracking-[0.04em] text-[var(--color-primary-fg)]"
          >
            {role === 'both' ? '↔' : role === 'start' ? 'ida' : 'vta'}
          </span>
        ) : null}
      </span>

      {/*
        El contador flota sobre el final del rango, como en un voucher. En la primera semana
        cuelga hacia abajo: arriba no hay lienzo, sólo la cabecera de los días.
      */}
      {counter !== null && (role === 'end' || role === 'both') ? (
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute left-1/2 z-20 -translate-x-1/2 whitespace-nowrap rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-fg)] shadow-[var(--shadow-sm)]',
            weekIndex === 0 ? '-bottom-2 translate-y-full' : '-top-2 -translate-y-full',
          )}
        >
          {counter}
        </span>
      ) : null}
    </td>
  );
}
