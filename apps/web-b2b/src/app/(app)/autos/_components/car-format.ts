import type { CarOffer, Money } from '../actions';

/*
 * Cómo se lee un auto de AgentCars en pantalla, sin React. La clase, la transmisión y el
 * combustible salen del código SIPP (ACRISS), que es un estándar de la industria y viene en todas
 * las ofertas; el nombre de categoría que manda el proveedor viene en inglés y cambia según la
 * arrendadora ("Economy Automatic", "ECONOMY"), así que no sirve para agrupar ni para filtrar.
 */

export function formatMoney(m: Money | undefined): string {
  if (!m) return '—';
  return formatMinor(m.amountMinor, m.currency);
}

export function formatMinor(amountMinor: number, currency: string): string {
  const value = amountMinor / 100;
  try {
    return new Intl.NumberFormat('es', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

/** Precio de VENTA: el neto con la cascada de markup si hay reglas; si no, el neto del proveedor. */
export function saleOf(o: Pick<CarOffer, 'pricing' | 'rateAmount'>): Money {
  return o.pricing
    ? { amountMinor: o.pricing.finalMinor, currency: o.pricing.currency }
    : o.rateAmount;
}

// ───────────────────────── SIPP / ACRISS ─────────────────────────

export type CarClass =
  | 'mini'
  | 'economico'
  | 'compacto'
  | 'intermedio'
  | 'estandar'
  | 'grande'
  | 'premium'
  | 'lujo'
  | 'suv'
  | 'van'
  | 'convertible'
  | 'pickup'
  | 'especial';

/** En el orden en que se muestran: de más chico a más grande, y los tipos de carrocería al final. */
export const CAR_CLASSES: readonly CarClass[] = [
  'mini',
  'economico',
  'compacto',
  'intermedio',
  'estandar',
  'grande',
  'premium',
  'lujo',
  'suv',
  'van',
  'convertible',
  'pickup',
  'especial',
];

export const CAR_CLASS_LABELS: Readonly<Record<CarClass, string>> = {
  mini: 'Mini',
  economico: 'Económico',
  compacto: 'Compacto',
  intermedio: 'Intermedio',
  estandar: 'Estándar',
  grande: 'Grande',
  premium: 'Premium',
  lujo: 'Lujo',
  suv: 'SUV',
  van: 'Van o minivan',
  convertible: 'Convertible',
  pickup: 'Pickup',
  especial: 'Especial',
};

/** Primera letra del SIPP: el tamaño. Las "Elite" van con su tamaño. */
const SIZE_BY_LETTER: Readonly<Record<string, CarClass>> = {
  M: 'mini',
  N: 'mini',
  E: 'economico',
  H: 'economico',
  C: 'compacto',
  D: 'compacto',
  I: 'intermedio',
  J: 'intermedio',
  S: 'estandar',
  R: 'estandar',
  F: 'grande',
  G: 'grande',
  P: 'premium',
  U: 'premium',
  L: 'lujo',
  W: 'lujo',
  O: 'van',
  X: 'especial',
};

/** Segunda letra: la carrocería. Cuando es una de éstas, pesa más que el tamaño. */
const BODY_BY_LETTER: Readonly<Record<string, CarClass>> = {
  F: 'suv',
  G: 'suv',
  J: 'suv',
  V: 'van',
  M: 'van',
  K: 'van',
  T: 'convertible',
  N: 'convertible',
  P: 'pickup',
  Q: 'pickup',
};

function sippOf(code: string): string {
  return code.trim().toUpperCase();
}

/** La clase del auto según su SIPP ("ECAR" → económico, "IFAR" → SUV). */
export function carClassOf(sipp: string): CarClass {
  const code = sippOf(sipp);
  const body = BODY_BY_LETTER[code.charAt(1)];
  if (body) return body;
  return SIZE_BY_LETTER[code.charAt(0)] ?? 'especial';
}

export type Transmission = 'automatica' | 'manual';

export const TRANSMISSION_LABELS: Readonly<Record<Transmission, string>> = {
  automatica: 'Automática',
  manual: 'Manual',
};

/**
 * Tercera letra del SIPP (A/B/D automática, M/N/C manual). Si el código no la trae, el texto del
 * proveedor ("Automatic", "Manual", "Mecánica").
 */
export function transmissionOf(o: Pick<CarOffer, 'sippCode' | 'trans'>): Transmission | undefined {
  const letter = sippOf(o.sippCode).charAt(2);
  if (letter && 'ABD'.includes(letter)) return 'automatica';
  if (letter && 'MNC'.includes(letter)) return 'manual';
  if (/autom/i.test(o.trans)) return 'automatica';
  if (/manual|mec/i.test(o.trans)) return 'manual';
  return undefined;
}

export type Fuel = 'electrico' | 'hibrido';

/** Cuarta letra del SIPP: sólo se destaca lo que cambia cómo se usa el auto. */
export function fuelOf(sipp: string): Fuel | undefined {
  const letter = sippOf(sipp).charAt(3);
  if (letter === 'E' || letter === 'C') return 'electrico';
  if (letter === 'H' || letter === 'I') return 'hibrido';
  return undefined;
}

export function hasUnlimitedKm(kmIncluded: string): boolean {
  return /unlimit|ilimit|illimit/i.test(kmIncluded);
}

/** El kilometraje como se lee en la tarjeta. Vacío cuando el proveedor no lo informa. */
export function kmLabel(kmIncluded: string): string {
  const km = kmIncluded.trim();
  if (!km) return '';
  if (hasUnlimitedKm(km)) return 'Kilometraje ilimitado';
  return km;
}

/** "Chevrolet Spark o similar": el modelo nunca está garantizado, la clase sí. */
export function modelLabel(carModel: string): string {
  const model = carModel.trim();
  if (!model) return '';
  if (/similar/i.test(model)) return model.replace(/\bor similar\b/i, 'o similar');
  return `${model} o similar`;
}
