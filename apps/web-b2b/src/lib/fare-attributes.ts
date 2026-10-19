import type { FareInclusion, Offer } from '../app/(app)/cotizaciones/actions';
import { baggageState } from './baggage';
import { policyBadge, policyState, type PolicyState } from './fare-policy';

type FormatMoney = (amountMinor: number, currency: string) => string;

/**
 * Lo que pinta una fila de atributo. `partial` = se permite con cargo. `unknown` NO es `no`:
 * uno es «el proveedor no lo informó», el otro una afirmación sobre la tarifa.
 */
export type AttrValue = 'yes' | 'no' | 'partial' | 'unknown';

export interface AttrState {
  readonly value: AttrValue;
  readonly detail?: string;
}

/**
 * Los atributos que se comparan entre tarifas.
 *
 * `source: 'leg'` = salen de los atributos de la marca de ESE trayecto (Sabre
 * `ReturnBrandAncillaries`, docs/sabre/15 D3). `source: 'offer'` = del equipaje y las políticas
 * de la oferta entera, que es lo único que hay sin trayecto elegido o sin atributos de marca.
 */
export interface FareAttributes {
  readonly source: 'leg' | 'offer';
  readonly personalItem: AttrState;
  readonly carryOn: AttrState;
  readonly checked: AttrState;
  readonly change: AttrState;
  readonly refund: AttrState;
  /** Sólo con `source: 'leg'`: la oferta entera no informa asiento. */
  readonly seat?: AttrState;
  /** Otros atributos INCLUIDOS de la marca (embarque prioritario, millas…), con su etiqueta. */
  readonly extras: readonly string[];
}

const UNKNOWN: AttrState = { value: 'unknown', detail: 'No informado' };

/** Traduce una franquicia a lo que pinta la fila, sin perder el «no se sabe». */
export function attrDeEquipaje(
  allowance: { qty: number; weightKg?: number } | undefined,
): AttrState {
  const state = baggageState(allowance);
  if (state.kind === 'unknown') return UNKNOWN;
  if (state.kind === 'none') return { value: 'no' };
  return {
    value: 'yes',
    ...(state.weightKg === undefined ? {} : { detail: `${state.weightKg} kg` }),
  };
}

/** La política con cargo es `partial`: se permite, pero no gratis. Un ✓ ahí prometía lo contrario. */
export function attrDePolitica(state: PolicyState, formatMoney: FormatMoney): AttrState {
  const detail = policyBadge(state, formatMoney);
  const value: AttrValue =
    state.kind === 'unknown'
      ? 'unknown'
      : state.kind === 'no'
        ? 'no'
        : state.kind === 'free'
          ? 'yes'
          : 'partial';
  return detail === undefined ? { value } : { value, detail };
}

/** Los atributos de marca de los componentes que cubren el trayecto, o `null` si no hay. */
export function legInclusions(offer: Offer, leg: number): FareInclusion[][] | null {
  const itineraries = offer.itineraries ?? [];
  if (leg >= itineraries.length) return null;
  let start = 0;
  for (let i = 0; i < leg; i += 1) start += itineraries[i]?.segments.length ?? 0;
  const end = start + (itineraries[leg]?.segments.length ?? 0);

  const porComponente = (offer.fareComponents ?? [])
    .filter((component) => component.segmentRefs.some((ref) => ref >= start && ref < end))
    .map((component) => component.includes ?? []);
  // Un componente del trayecto sin atributos deja ese trayecto a medio informar: mezclar sus
  // huecos con lo que dice el otro componente sería inventar. Mejor la oferta entera, rotulada.
  if (porComponente.length === 0 || porComponente.some((items) => items.length === 0)) return null;
  return porComponente;
}

const RANGO: Record<FareInclusion['status'], number> = { included: 2, charge: 1, 'not-offered': 0 };

/** «CHECKED BAG 23KG» → «Checked bag 23kg»: la etiqueta de la aerolínea, legible. */
function etiqueta(label: string): string {
  const lower = label.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function attrDeInclusion(item: FareInclusion | undefined, conDetalle: boolean): AttrState {
  if (item === undefined) return UNKNOWN;
  const value: AttrValue =
    item.status === 'included' ? 'yes' : item.status === 'charge' ? 'partial' : 'no';
  if (item.status === 'charge') return { value, detail: 'Con cargo' };
  return conDetalle && item.status === 'included'
    ? { value, detail: etiqueta(item.label) }
    : { value };
}

/**
 * Lo mejor de cada componente y lo peor entre componentes: dentro de una marca, «1ra maleta
 * incluida» manda sobre «2da con cargo»; entre dos vuelos de un trayecto, se promete sólo lo que
 * ambos cumplen.
 */
function porTipo(
  componentes: FareInclusion[][],
  kind: FareInclusion['kind'],
): FareInclusion | undefined {
  let peor: FareInclusion | undefined;
  for (const items of componentes) {
    let mejor: FareInclusion | undefined;
    for (const item of items) {
      if (item.kind !== kind) continue;
      if (mejor === undefined || RANGO[item.status] > RANGO[mejor.status]) mejor = item;
    }
    // Un componente que no lo informa deja el tipo en «no informado» para todo el trayecto.
    if (mejor === undefined) return undefined;
    if (peor === undefined || RANGO[mejor.status] < RANGO[peor.status]) peor = mejor;
  }
  return peor;
}

export function fareAttributes(
  offer: Offer,
  leg: number | undefined,
  formatMoney: FormatMoney,
): FareAttributes {
  const componentes = leg === undefined ? null : legInclusions(offer, leg);
  if (componentes === null) {
    const baggage = offer.baggage;
    return {
      source: 'offer',
      personalItem: attrDeEquipaje(
        baggage?.personalItem === undefined ? undefined : { qty: baggage.personalItem },
      ),
      carryOn: attrDeEquipaje(baggage?.carryOn),
      checked: attrDeEquipaje(baggage?.checked),
      change: attrDePolitica(policyState(offer.policies, 'change'), formatMoney),
      refund: attrDePolitica(policyState(offer.policies, 'refund'), formatMoney),
      extras: [],
    };
  }

  const extras = new Set<string>();
  for (const items of componentes) {
    for (const item of items) {
      if (item.kind === 'other' && item.status === 'included') extras.add(etiqueta(item.label));
    }
  }
  return {
    source: 'leg',
    personalItem: attrDeInclusion(porTipo(componentes, 'personal-item'), false),
    carryOn: attrDeInclusion(porTipo(componentes, 'carry-on'), true),
    checked: attrDeInclusion(porTipo(componentes, 'checked-bag'), true),
    change: attrDeInclusion(porTipo(componentes, 'change'), false),
    refund: attrDeInclusion(porTipo(componentes, 'refund'), false),
    seat: attrDeInclusion(porTipo(componentes, 'seat'), false),
    extras: [...extras],
  };
}
