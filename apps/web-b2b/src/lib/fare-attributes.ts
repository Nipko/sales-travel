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
  /** Cuántas maletas facturadas incluye la marca, si los atributos lo dicen. */
  readonly checkedPieces?: number;
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

/**
 * Los atributos de marca de TODOS los componentes (solo ida, multidestino, o la combinación
 * entera), o `null` si alguno no los trae. Sin esto la tarjeta caía al equipaje genérico de la
 * oferta, que sólo informa la maleta facturada, y todas las familias se pintaban iguales.
 */
export function offerInclusions(offer: Offer): FareInclusion[][] | null {
  const porComponente = (offer.fareComponents ?? []).map((component) => component.includes ?? []);
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
  const componentes = leg === undefined ? offerInclusions(offer) : legInclusions(offer, leg);
  if (componentes === null) {
    const baggage = offer.baggage;
    return {
      source: 'offer',
      personalItem: attrDeEquipaje(
        baggage?.personalItem === undefined ? undefined : { qty: baggage.personalItem },
      ),
      carryOn: attrDeEquipaje(baggage?.carryOn),
      checked: attrDeEquipaje(baggage?.checked),
      ...((baggage?.checked?.qty ?? 0) > 0 ? { checkedPieces: baggage!.checked!.qty } : {}),
      change: attrDePolitica(policyState(offer.policies, 'change'), formatMoney),
      refund: attrDePolitica(policyState(offer.policies, 'refund'), formatMoney),
      extras: [],
    };
  }

  const extras = new Map<string, number>();
  for (const items of componentes) {
    for (const item of items) {
      if (item.kind !== 'other' || item.status !== 'included') continue;
      const { label, rank } = extraLabel(item.label);
      extras.set(label, Math.min(rank, extras.get(label) ?? rank));
    }
  }
  const piezas = checkedPieces(componentes);
  const checked = attrDeInclusion(porTipo(componentes, 'checked-bag'), true);
  return {
    source: 'leg',
    personalItem: attrDeInclusion(porTipo(componentes, 'personal-item'), false),
    carryOn: attrDeInclusion(porTipo(componentes, 'carry-on'), true),
    checked:
      checked.value === 'yes' && piezas > 1
        ? { value: 'yes', detail: `${String(piezas)} maletas` }
        : checked,
    ...(piezas > 0 ? { checkedPieces: piezas } : {}),
    change: attrDeInclusion(porTipo(componentes, 'change'), false),
    refund: attrDeInclusion(porTipo(componentes, 'refund'), false),
    seat: attrDeInclusion(porTipo(componentes, 'seat'), false),
    extras: [...extras].sort((a, b) => a[1] - b[1]).map(([label]) => label),
  };
}

/**
 * Cuántas maletas facturadas incluye la marca: las filas `CHECKED BAG` incluidas («FIRST», «SECOND»)
 * de cada componente; entre componentes, la menor (se promete lo que todos cumplen).
 */
function checkedPieces(componentes: FareInclusion[][]): number {
  let menor = Number.POSITIVE_INFINITY;
  for (const items of componentes) {
    const n = items.filter((i) => i.kind === 'checked-bag' && i.status === 'included').length;
    menor = Math.min(menor, n);
  }
  return Number.isFinite(menor) ? menor : 0;
}

/**
 * Los extras de una marca, en español y por lo que más pesa al elegir entre familias: la sala VIP
 * y el embarque prioritario primero, el wifi y las millas después. Lo que no se reconoce va con la
 * etiqueta de la aerolínea, al final.
 */
const EXTRAS: readonly { readonly re: RegExp; readonly label: string }[] = [
  { re: /LOUNGE|ADMIRALS|SALA ?VIP|SALON|SALAS/, label: 'Sala VIP' },
  { re: /LIE ?FLAT|FLAT ?BED|CAMA/, label: 'Asiento cama' },
  {
    re: /PRIORITY BOARD|EMBARQUE PRIORIT|BOARDING PRIORIT|PRIORIDAD.*EMBARQUE/,
    label: 'Embarque prioritario',
  },
  {
    re: /PRIORITY CHECK|CHECK ?IN PRIORIT|FAST ?TRACK|PRIORITY SECURITY/,
    label: 'Check-in prioritario',
  },
  { re: /EXTRA LEG|LEGROOM|ESPACIO|MORE SPACE/, label: 'Más espacio para piernas' },
  { re: /PRIORITY BAG|EQUIPAJE PRIORIT/, label: 'Equipaje prioritario' },
  { re: /MEAL|SNACK|COMIDA|FOOD/, label: 'Comida a bordo' },
  { re: /BEVERAGE|DRINK|BEBIDA/, label: 'Bebidas' },
  { re: /STANDBY/, label: 'Standby el mismo día' },
  { re: /WI ?-?FI|INTERNET/, label: 'Wi-Fi' },
  { re: /ENTERTAINMENT|STREAMING|ENTRETENIMIENTO|\bIFE\b/, label: 'Entretenimiento' },
  { re: /MILES|MILLAS|AADVANTAGE|LATAM ?PASS|LIFEMILES|POINTS|PUNTOS/, label: 'Acumula millas' },
];

function extraLabel(raw: string): { label: string; rank: number } {
  const upper = raw.toUpperCase();
  const index = EXTRAS.findIndex((extra) => extra.re.test(upper));
  return index === -1
    ? { label: etiqueta(raw), rank: EXTRAS.length }
    : { label: EXTRAS[index]!.label, rank: index };
}
