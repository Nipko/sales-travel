import {
  formatDayShort,
  type IsoDate,
  type TripMode,
} from '../../../../components/ui/date-range-picker';
import type { LocationKind } from '../../../../lib/airport-cities';

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
  /**
   * Edad de cada niño (2 a 11), una por niño y en orden; `null` = todavía sin elegir. Se pide
   * siempre, como en los sitios de venta: con la edad Sabre cotiza el precio real del niño, que
   * puede ser distinto del de un niño genérico (docs/sabre/16).
   */
  readonly childAges?: readonly (number | null)[];
  /** Cuántos de los infantes viajan con asiento propio (pagan como niño). El resto, en brazos. */
  readonly infantsWithSeat?: number;
}

export type PaxKey = 'adults' | 'children' | 'infants';

/** Edades que se pueden elegir para un niño: de 2 a 11 años cumplidos el día del viaje. */
export const CHILD_AGES: readonly number[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

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
  const infants = Math.min(next.infants, next.adults);
  // Una edad por niño: sumar un niño agrega una edad sin elegir; quitarlo se lleva la última.
  const ages = [...(pax.childAges ?? [])];
  while (ages.length < next.children) ages.push(null);
  ages.length = next.children;
  const withSeat = Math.min(pax.infantsWithSeat ?? 0, infants);
  // Sin niños ni infantes con asiento, las claves no aparecen: el caso de casi todas las búsquedas
  // sigue siendo `{ adults, children, infants }`.
  const { childAges: _ages, infantsWithSeat: _seat, ...counts } = next;
  const clamped: PaxCounts = {
    ...counts,
    infants,
    ...(ages.length > 0 ? { childAges: ages } : {}),
    ...(withSeat > 0 ? { infantsWithSeat: withSeat } : {}),
  };

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

/** Fija la edad del niño `index` (0 = el primero). */
export function setChildAge(pax: PaxCounts, index: number, age: number | null): PaxCounts {
  const ages = [...(pax.childAges ?? [])];
  while (ages.length < pax.children) ages.push(null);
  if (index < 0 || index >= pax.children) return pax;
  ages[index] = age;
  return { ...pax, childAges: ages };
}

/** Sube o baja cuántos infantes van con asiento propio, entre 0 y los infantes que hay. */
export function adjustInfantsWithSeat(pax: PaxCounts, delta: 1 | -1): PaxCounts {
  const next = Math.min(pax.infants, Math.max(0, (pax.infantsWithSeat ?? 0) + delta));
  return { ...pax, infantsWithSeat: next };
}

/** Las edades de los niños, si están TODAS elegidas; `null` si falta alguna. */
export function completeChildAges(pax: PaxCounts): number[] | null {
  const ages = pax.childAges ?? [];
  if (ages.length !== pax.children) return pax.children === 0 ? [] : null;
  return ages.every((age): age is number => age !== null) ? [...ages] : null;
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
  if (pax.infants > 0) {
    const withSeat = pax.infantsWithSeat ?? 0;
    const infants = plural(pax.infants, 'infante', 'infantes');
    parts.push(
      withSeat === 0
        ? infants
        : pax.infants === 1
          ? `${infants} con asiento`
          : `${infants} (${String(withSeat)} con asiento)`,
    );
  }
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

/** Solo ida, ida y vuelta, o varios tramos. */
export type SearchTripMode = TripMode | 'multicity';

/** Un tramo del multidestino tal como lo edita el formulario. */
export interface MultiCityLeg {
  /** Estable entre ediciones: la clave de React y el id de sus campos. */
  readonly id: string;
  readonly origin: string;
  readonly originKind?: LocationKind;
  readonly destination: string;
  readonly destinationKind?: LocationKind;
  readonly date: string;
  /** Sube cuando el origen se rellena desde afuera (del destino anterior): remonta su campo. */
  readonly originRev?: number;
}

/** Tope de tramos: el mismo que acepta el API (`FLIGHT_SEARCH_MAX_LEGS`). */
export const MULTICITY_MAX_LEGS = 6;
export const MULTICITY_MIN_LEGS = 2;

let legSeq = 0;
function legId(): string {
  legSeq += 1;
  return `leg-${String(legSeq)}`;
}

/**
 * Los tramos con que se abre el multidestino: el primero es lo que ya estaba en el buscador y el
 * segundo sale de donde llega el primero, que es lo que escribe casi todo el mundo después.
 */
export function initialLegs(seed: {
  origin: string;
  originKind?: LocationKind;
  destination: string;
  destinationKind?: LocationKind;
  departureDate: string;
}): MultiCityLeg[] {
  return [
    {
      id: legId(),
      origin: seed.origin,
      ...(seed.originKind ? { originKind: seed.originKind } : {}),
      destination: seed.destination,
      ...(seed.destinationKind ? { destinationKind: seed.destinationKind } : {}),
      date: seed.departureDate,
    },
    {
      id: legId(),
      origin: seed.destination,
      ...(seed.destinationKind ? { originKind: seed.destinationKind } : {}),
      destination: '',
      date: '',
    },
  ];
}

/** Agrega un tramo que sale de donde llega el último. Sin cambios en el tope. */
export function addLeg(legs: readonly MultiCityLeg[]): MultiCityLeg[] {
  if (legs.length >= MULTICITY_MAX_LEGS) return [...legs];
  const last = legs[legs.length - 1];
  return [
    ...legs,
    {
      id: legId(),
      origin: last?.destination ?? '',
      ...(last?.destinationKind ? { originKind: last.destinationKind } : {}),
      destination: '',
      date: '',
    },
  ];
}

/** Quita un tramo, sin bajar del mínimo de dos. */
export function removeLeg(legs: readonly MultiCityLeg[], id: string): MultiCityLeg[] {
  if (legs.length <= MULTICITY_MIN_LEGS) return [...legs];
  return legs.filter((leg) => leg.id !== id);
}

export function updateLeg(
  legs: readonly MultiCityLeg[],
  id: string,
  patch: Partial<Omit<MultiCityLeg, 'id'>>,
): MultiCityLeg[] {
  return legs.map((leg) => (leg.id === id ? { ...leg, ...patch } : leg));
}

export interface SearchDraft {
  readonly origin: string;
  readonly destination: string;
  readonly departureDate: string;
  readonly returnDate: string;
  readonly mode: SearchTripMode;
  readonly pax: PaxCounts;
  /** Sólo en multidestino. */
  readonly legs?: readonly MultiCityLeg[];
}

/** Qué control tiene la culpa. La página lo traduce a un id para llevar el foco ahí. */
export type SearchField = 'origin' | 'destination' | 'dates' | 'pax' | 'legs';

export interface SearchProblem {
  readonly field: SearchField;
  readonly message: string;
  /** Multidestino: qué tramo y qué campo, para llevar el foco ahí. */
  readonly legIndex?: number;
  readonly part?: 'origin' | 'destination' | 'date';
}

/**
 * Lo que falta para poder buscar, o `null` si no falta nada.
 *
 * El orden importa: se señala el primer campo del recorrido que está mal, no el último error
 * encontrado. Quien no eligió origen no necesita enterarse además de que le falta la vuelta.
 */
export function validateSearch(draft: SearchDraft, today: IsoDate): SearchProblem | null {
  if (draft.mode === 'multicity') return validateMultiCity(draft, today);
  const origin = draft.origin.toUpperCase().trim();
  const destination = draft.destination.toUpperCase().trim();

  if (!IATA_RE.test(origin)) {
    return { field: 'origin', message: 'Elige el aeropuerto de origen.' };
  }
  if (!IATA_RE.test(destination)) {
    return { field: 'destination', message: 'Elige el aeropuerto de destino.' };
  }
  if (origin === destination) {
    return { field: 'destination', message: 'El origen y el destino tienen que ser distintos.' };
  }
  if (!DATE_RE.test(draft.departureDate)) {
    return { field: 'dates', message: 'Elige la fecha de ida.' };
  }
  if (draft.departureDate < today) {
    return { field: 'dates', message: 'La fecha de ida ya pasó. Elige otra.' };
  }
  if (draft.mode === 'roundtrip') {
    if (!DATE_RE.test(draft.returnDate)) {
      return { field: 'dates', message: 'Falta la fecha de vuelta, o cambia el viaje a solo ida.' };
    }
    if (draft.returnDate < draft.departureDate) {
      return { field: 'dates', message: 'La vuelta no puede ser anterior a la ida.' };
    }
  }
  if (completeChildAges(draft.pax) === null) {
    return { field: 'pax', message: 'Elige la edad de cada niño: cambia el precio de su tarifa.' };
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
/** Multidestino: cada tramo completo, distinto en sus dos puntas y en orden de fechas. */
function validateMultiCity(draft: SearchDraft, today: IsoDate): SearchProblem | null {
  const legs = draft.legs ?? [];
  if (legs.length < MULTICITY_MIN_LEGS) {
    return {
      field: 'legs',
      legIndex: 0,
      part: 'origin',
      message: 'Un multidestino tiene al menos dos tramos.',
    };
  }
  for (let index = 0; index < legs.length; index += 1) {
    const leg = legs[index]!;
    const n = index + 1;
    const origin = leg.origin.toUpperCase().trim();
    const destination = leg.destination.toUpperCase().trim();
    if (!IATA_RE.test(origin)) {
      return {
        field: 'legs',
        legIndex: index,
        part: 'origin',
        message: `Elige el origen del tramo ${n}.`,
      };
    }
    if (!IATA_RE.test(destination)) {
      return {
        field: 'legs',
        legIndex: index,
        part: 'destination',
        message: `Elige el destino del tramo ${n}.`,
      };
    }
    if (origin === destination) {
      return {
        field: 'legs',
        legIndex: index,
        part: 'destination',
        message: `El tramo ${n} tiene el mismo origen y destino.`,
      };
    }
    if (!DATE_RE.test(leg.date)) {
      return {
        field: 'legs',
        legIndex: index,
        part: 'date',
        message: `Elige la fecha del tramo ${n}.`,
      };
    }
    if (leg.date < today) {
      return {
        field: 'legs',
        legIndex: index,
        part: 'date',
        message: `La fecha del tramo ${n} ya pasó.`,
      };
    }
    const previous = legs[index - 1];
    if (previous && DATE_RE.test(previous.date) && leg.date < previous.date) {
      return {
        field: 'legs',
        legIndex: index,
        part: 'date',
        message: `El tramo ${n} no puede salir antes que el tramo ${index}.`,
      };
    }
  }
  if (completeChildAges(draft.pax) === null) {
    return { field: 'pax', message: 'Elige la edad de cada niño: cambia el precio de su tarifa.' };
  }
  return null;
}

export function searchEcho(draft: SearchDraft): string {
  if (draft.mode === 'multicity' && draft.legs?.length) {
    const route = draft.legs
      .map((leg) => `${leg.origin.toUpperCase()} → ${leg.destination.toUpperCase()}`)
      .join(' · ');
    return `${route} · ${draft.legs.length} tramos · ${paxLabel(draft.pax)}`;
  }
  const route = `${draft.origin.toUpperCase()} → ${draft.destination.toUpperCase()}`;
  const dates =
    draft.mode === 'roundtrip' && draft.returnDate
      ? `${formatDayShort(draft.departureDate)} – ${formatDayShort(draft.returnDate)}`
      : `${formatDayShort(draft.departureDate)} · solo ida`;
  return `${route} · ${dates} · ${paxLabel(draft.pax)}`;
}
