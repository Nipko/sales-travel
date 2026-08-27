import {
  formatDayShort,
  type IsoDate,
  type TripMode,
} from '../../../../components/ui/date-range-picker';

/* =============================================================================================
   MODELO DEL BUSCADOR

   Todo lo que el formulario DECIDE vive acá, sin React y sin DOM: qué es una búsqueda válida,
   cuántos pasajeros caben, cómo se lee una cabina y qué se está buscando mientras se espera.
   El componente de abajo sólo pinta y enruta eventos.

   Que la validación esté acá no es prolijidad: al reemplazar los dos `<input type="date">` por
   un control con campos OCULTOS, la validación nativa del navegador —`required`— dejó de
   participar. El único guardia que queda antes del server action es esta función, así que tiene
   que ser la que los tests puedan empujar.
   ============================================================================================= */

const IATA_RE = /^[A-Z]{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ---------------------------------------------------------------------------------------------
   Pasajeros
   ------------------------------------------------------------------------------------------- */

export interface PaxCounts {
  readonly adults: number;
  readonly children: number;
  readonly infants: number;
}

export type PaxKey = keyof PaxCounts;

export const DEFAULT_PAX: PaxCounts = { adults: 1, children: 0, infants: 0 };

/** Mínimos por tipo. Un adulto siempre: nadie viaja como acompañante de nadie. */
const PAX_MIN: Readonly<Record<PaxKey, number>> = { adults: 1, children: 0, infants: 0 };

/** Tope del GDS por reserva. Más pasajeros exigen partir el grupo, no es un capricho de la UI. */
export const PAX_MAX_TOTAL = 9;

export function paxTotal(pax: PaxCounts): number {
  return pax.adults + pax.children + pax.infants;
}

/**
 * Aplica un +1/-1 respetando las reglas de la reserva.
 *
 * Los topes se aplican al RESULTADO, no al gesto: bajar adultos por debajo de los infantes
 * arrastra los infantes con él, porque un infante viaja en el regazo de un adulto y si el
 * adulto se va el infante no puede quedarse. Sin ese arrastre la UI dejaba armar "1 adulto,
 * 2 infantes", que el proveedor rechaza recién al reservar, con el cliente ya esperando.
 */
export function adjustPax(pax: PaxCounts, key: PaxKey, delta: 1 | -1): PaxCounts {
  const raw = pax[key] + delta;
  const bounded = Math.max(PAX_MIN[key], raw);

  const next: PaxCounts = { ...pax, [key]: bounded };
  const clamped: PaxCounts = { ...next, infants: Math.min(next.infants, next.adults) };

  // Se rechaza el incremento entero en vez de recortarlo: recortar mostraría un número que el
  // usuario no pidió y parecería que el botón no responde.
  if (delta === 1 && paxTotal(clamped) > PAX_MAX_TOTAL) return pax;
  return clamped;
}

/**
 * ¿Se puede sumar uno más de este tipo? Gobierna el `disabled` del botón `+`.
 *
 * Se pregunta ejecutando `adjustPax` y mirando si el número subió, en vez de repetir las
 * reglas: un botón habilitado que al pulsarlo no hace nada es la forma más barata de que la
 * UI y el modelo se contradigan.
 */
export function canAddPax(pax: PaxCounts, key: PaxKey): boolean {
  return adjustPax(pax, key, 1)[key] > pax[key];
}

/** ¿Se puede restar uno de este tipo? */
export function canRemovePax(pax: PaxCounts, key: PaxKey): boolean {
  return pax[key] > PAX_MIN[key];
}

/** Cuántos pasajeros hay en total. Va en el eco de la búsqueda y en el resumen hablado. */
export function paxLabel(pax: PaxCounts): string {
  const total = paxTotal(pax);
  return total === 1 ? '1 pasajero' : `${total} pasajeros`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * De QUIÉNES se trata, no cuántos: el valor grande de la celda.
 *
 * "3 pasajeros" debajo de la etiqueta "Pasajeros" no agrega nada; el vendedor necesita saber
 * si ese tercer pasajero es un niño, porque cambia la tarifa y cambia lo que tiene que
 * preguntarle al cliente. Los tipos vacíos no se nombran: "2 adultos" y no "2 adultos · 0
 * niños · 0 infantes", que es el caso de casi todas las búsquedas.
 */
export function paxComposition(pax: PaxCounts): string {
  const parts = [plural(pax.adults, 'adulto', 'adultos')];
  if (pax.children > 0) parts.push(plural(pax.children, 'niño', 'niños'));
  if (pax.infants > 0) parts.push(plural(pax.infants, 'infante', 'infantes'));
  return parts.join(' · ');
}

/* ---------------------------------------------------------------------------------------------
   Cabina
   ------------------------------------------------------------------------------------------- */

export interface CabinOption {
  /** Valor del contrato con el API. NO se toca: viaja en el formulario y en la cotización. */
  readonly value: string;
  readonly label: string;
  readonly hint: string;
}

export const CABINS: readonly CabinOption[] = [
  { value: 'economy', label: 'Económica', hint: 'La tarifa que se cotiza casi siempre' },
  { value: 'premium_economy', label: 'Premium', hint: 'Económica premium' },
  { value: 'business', label: 'Ejecutiva', hint: 'Business' },
  { value: 'first', label: 'Primera', hint: 'Primera clase' },
];

export const DEFAULT_CABIN = 'economy';

/**
 * Nombre visible de una cabina.
 *
 * Un valor desconocido devuelve el valor crudo en vez de caer a "Económica": si el API sumara
 * una cabina nueva, mentir sobre cuál está elegida es peor que mostrar un código feo.
 */
export function cabinLabel(value: string): string {
  return CABINS.find((c) => c.value === value)?.label ?? value;
}

/* ---------------------------------------------------------------------------------------------
   Tipo de viaje
   ------------------------------------------------------------------------------------------- */

/**
 * La vuelta que corresponde a este tipo de viaje.
 *
 * Pasar a "solo ida" BORRA la vuelta, no la esconde. El server action ignora `returnDate`
 * cuando el viaje es de ida, pero la cotización que se guarda después la copia tal cual: una
 * vuelta olvidada quedaba impresa en el documento que ve el cliente.
 */
export function returnDateForMode(returnDate: string, mode: TripMode): string {
  return mode === 'oneway' ? '' : returnDate;
}

/* ---------------------------------------------------------------------------------------------
   Validación
   ------------------------------------------------------------------------------------------- */

export interface SearchDraft {
  readonly origin: string;
  readonly destination: string;
  readonly departureDate: string;
  readonly returnDate: string;
  readonly mode: TripMode;
  readonly pax: PaxCounts;
}

/** Qué control tiene la culpa. La página lo traduce a un id para llevar el foco ahí. */
export type SearchField = 'origin' | 'destination' | 'dates';

export interface SearchProblem {
  readonly field: SearchField;
  readonly message: string;
}

/**
 * Lo que falta para poder buscar, o `null` si no falta nada.
 *
 * El orden importa: se señala el primer campo del recorrido que está mal, no el último error
 * encontrado. Quien no eligió origen no necesita enterarse además de que le falta la vuelta.
 */
export function validateSearch(draft: SearchDraft, today: IsoDate): SearchProblem | null {
  const origin = draft.origin.toUpperCase().trim();
  const destination = draft.destination.toUpperCase().trim();

  if (!IATA_RE.test(origin)) {
    return { field: 'origin', message: 'Elegí el aeropuerto de origen.' };
  }
  if (!IATA_RE.test(destination)) {
    return { field: 'destination', message: 'Elegí el aeropuerto de destino.' };
  }
  if (origin === destination) {
    return { field: 'destination', message: 'El origen y el destino tienen que ser distintos.' };
  }
  if (!DATE_RE.test(draft.departureDate)) {
    return { field: 'dates', message: 'Elegí la fecha de ida.' };
  }
  if (draft.departureDate < today) {
    return { field: 'dates', message: 'La fecha de ida ya pasó. Elegí otra.' };
  }
  if (draft.mode === 'roundtrip') {
    if (!DATE_RE.test(draft.returnDate)) {
      return { field: 'dates', message: 'Falta la fecha de vuelta, o cambiá el viaje a solo ida.' };
    }
    if (draft.returnDate < draft.departureDate) {
      return { field: 'dates', message: 'La vuelta no puede ser anterior a la ida.' };
    }
  }
  return null;
}

/* ---------------------------------------------------------------------------------------------
   Eco de la búsqueda
   ------------------------------------------------------------------------------------------- */

/**
 * Qué se está buscando, en una línea.
 *
 * Es el contenido del estado de carga. Antes ahí había cuatro íconos latiendo —vuelo, hotel,
 * traslado, asistencia— que no describían nada de lo que estaba pasando (esta pantalla sólo
 * busca vuelos). Repetir el criterio sirve para algo concreto: el vendedor que dictó las fechas
 * de memoria las ve escritas mientras espera, y corta antes si se equivocó de mes.
 */
export function searchEcho(draft: SearchDraft): string {
  const route = `${draft.origin.toUpperCase()} → ${draft.destination.toUpperCase()}`;
  const dates =
    draft.mode === 'roundtrip' && draft.returnDate
      ? `${formatDayShort(draft.departureDate)} – ${formatDayShort(draft.returnDate)}`
      : `${formatDayShort(draft.departureDate)} · solo ida`;
  return `${route} · ${dates} · ${paxLabel(draft.pax)}`;
}
