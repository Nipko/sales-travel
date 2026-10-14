import { supportsOrderCapability, type OrderCapabilities } from './order-capabilities';

/*
 * Maletas y servicios adicionales de una reserva confirmada, antes de emitir (SAB-20), sin React:
 * cuándo se ofrece, cómo se lee el catálogo que manda el API, qué se agrupa por pasajero y tramo,
 * cuánto suma lo elegido y qué se manda.
 *
 * El precio es el de la aerolínea, el mismo que el API vuelve a leer al agregar: la pantalla sólo dice
 * qué y para quién, y lo que vio que suma. Si el catálogo cambió, el API no agrega nada.
 */

export const SERVICES_UI = {
  title: 'Servicios adicionales',
  subtitle: 'Equipaje y servicios que se cobran junto con el tiquete.',
  loading: 'Consultando los servicios de la aerolínea…',
  loadFailed:
    'No pudimos consultar los servicios de esta reserva. Inténtalo de nuevo en unos minutos.',
  empty: 'La aerolínea no publica servicios adicionales para esta reserva.',
  partialCatalog:
    'Alguna aerolínea de la reserva no comparte su catálogo con esta oficina: puede haber más servicios que los que ves.',
  paymentNote:
    'Se cobran con el tiquete, como documento aparte (EMD), con la forma de pago de la cuenta: sin tarjeta.',
  testNote: 'Entorno de pruebas: no se cobra nada real.',
  added: 'Agregados a la reserva',
  available: 'Disponibles',
  noneForPassenger: 'Sin servicios para este pasajero.',
  addButton: 'Agregar a la reserva',
  adding: 'Agregando…',
  removeButton: 'Quitar',
  removing: 'Quitando…',
  total: 'Total a agregar',
  newTotal: 'Nuevo total de la reserva',
  included: 'Incluido',
  notInformed: 'Sin precio',
  confirmAddTitle: '¿Agregar los servicios a la reserva?',
  confirmRemoveTitle: '¿Quitar el servicio de la reserva?',
  sendFailed: 'No pudimos enviar el pedido. Revisa la reserva antes de intentarlo otra vez.',
} as const;

export const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  BAGGAGE: 'Equipaje',
  MEAL: 'Comida',
  LOUNGE: 'Sala VIP',
  PET: 'Mascota',
  FEE: 'Cargo de la aerolínea',
  OTHER: 'Otro servicio',
};

export const LINE_STATUS_LABELS: Readonly<Record<string, string>> = {
  active: 'Agregado',
  unverified: 'Sin confirmar',
  removed: 'Quitado',
  'remove-unverified': 'Quitado sin confirmar',
};

const PAX_LABELS: Readonly<Record<string, string>> = {
  ADT: 'adulto',
  CHD: 'niño',
  INF: 'infante',
};

/** Lo que estas funciones leen de una orden de `GET /orders`. */
export interface ServicesOrder {
  readonly status: string;
  readonly pnr: string | null;
  readonly capabilities?: Partial<OrderCapabilities>;
}

/**
 * «Servicios adicionales» se ofrece con la reserva confirmada (todavía sin emitir), con localizador y
 * si el proveedor los vende (capacidad ya filtrada por quien mira: el superadmin no vende).
 */
export function canManageServices(order: ServicesOrder): boolean {
  return (
    order.status === 'confirmed' &&
    typeof order.pnr === 'string' &&
    order.pnr.length > 0 &&
    supportsOrderCapability(order.capabilities, 'addServices')
  );
}

export interface ServiceSegmentView {
  readonly index: number;
  readonly origin: string;
  readonly destination: string;
  readonly carrier: string;
  readonly flightNumber: string;
}

export interface ServiceOfferView {
  readonly serviceOfferItemId: string;
  readonly category: string;
  readonly name: string;
  readonly segmentRefs: readonly number[];
  readonly weights: readonly { readonly value: number; readonly unit: string }[];
  readonly passengers: readonly {
    readonly passengerIndex: number;
    readonly amountMinor: number | null;
    readonly included: boolean;
  }[];
  readonly addable: boolean;
  readonly notAddableText: string | null;
}

export interface ServiceLineView {
  readonly id: string;
  readonly passengerIndex: number;
  readonly name: string;
  readonly category: string;
  readonly segments: readonly Omit<ServiceSegmentView, 'index'>[];
  readonly amountMinor: number;
  readonly currency: string;
  readonly status: string;
  readonly removable: boolean;
  readonly removalGroup: string | null;
}

export interface ServicesCatalogView {
  readonly currency: string;
  readonly orderTotalMinor: number;
  readonly testContent: boolean;
  readonly segments: readonly ServiceSegmentView[];
  readonly offers: readonly ServiceOfferView[];
  readonly added: readonly ServiceLineView[];
  readonly warnings: readonly string[];
  readonly blocked: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function segmentOf(raw: unknown): Omit<ServiceSegmentView, 'index'> | null {
  const r = record(raw);
  const origin = text(r?.['origin']);
  const destination = text(r?.['destination']);
  if (origin === null || destination === null) return null;
  return {
    origin,
    destination,
    carrier: text(r?.['carrier']) ?? '',
    flightNumber: text(r?.['flightNumber']) ?? '',
  };
}

/**
 * El catálogo que manda el API (`POST /orders/:id/services` con `kind: 'ancillaries'`), o `null` si
 * no lo es. Nunca lanza: lo que no se puede leer se descarta (una oferta sin id), y una oferta rara
 * se muestra como que no se puede agregar.
 */
export function parseServicesCatalog(raw: unknown): ServicesCatalogView | null {
  const body = record(raw);
  if (body?.['kind'] !== 'ancillaries') return null;
  const currency = text(body['currency']);
  const orderTotal = int(body['orderTotalMinor']);
  if (currency === null || orderTotal === null) return null;

  const segments: ServiceSegmentView[] = [];
  for (const item of list(body['segments'])) {
    const segment = segmentOf(item);
    const index = int(record(item)?.['index']);
    if (segment !== null && index !== null) segments.push({ ...segment, index });
  }

  const offers: ServiceOfferView[] = [];
  for (const item of list(body['offers'])) {
    const r = record(item);
    const id = text(r?.['serviceOfferItemId']);
    const name = text(r?.['name']);
    if (r === null || id === null || name === null) continue;
    const passengers = list(r['passengers']).flatMap((p) => {
      const pr = record(p);
      const index = int(pr?.['passengerIndex']);
      if (pr === null || index === null) return [];
      const amount = pr['amountMinor'] === null ? null : int(pr['amountMinor']);
      return [{ passengerIndex: index, amountMinor: amount, included: pr['included'] === true }];
    });
    offers.push({
      serviceOfferItemId: id,
      category: text(r['category']) ?? 'OTHER',
      name,
      segmentRefs: list(r['segmentRefs']).flatMap((v) => (int(v) === null ? [] : [int(v)!])),
      weights: list(r['weights']).flatMap((w) => {
        const wr = record(w);
        const value = int(wr?.['value']);
        const unit = text(wr?.['unit']);
        return value === null || unit === null ? [] : [{ value, unit }];
      }),
      passengers,
      addable: r['addable'] === true,
      notAddableText: text(r['notAddableText']),
    });
  }

  const added: ServiceLineView[] = [];
  for (const item of list(body['added'])) {
    const r = record(item);
    const id = text(r?.['id']);
    const index = int(r?.['passengerIndex']);
    const amount = int(r?.['amountMinor']);
    if (r === null || id === null || index === null || amount === null) continue;
    added.push({
      id,
      passengerIndex: index,
      name: text(r['name']) ?? 'Servicio',
      category: text(r['category']) ?? 'OTHER',
      segments: list(r['segments']).flatMap((s) => {
        const segment = segmentOf(s);
        return segment === null ? [] : [segment];
      }),
      amountMinor: amount,
      currency: text(r['currency']) ?? currency,
      status: text(r['status']) ?? 'unverified',
      removable: r['removable'] === true,
      removalGroup: text(r['removalGroup']),
    });
  }

  return {
    currency,
    orderTotalMinor: orderTotal,
    testContent: body['testContent'] === true,
    segments,
    offers,
    added,
    warnings: list(body['warnings']).flatMap((w) => (text(w) === null ? [] : [text(w)!])),
    blocked: text(body['blocked']),
  };
}

/** «BOG → LIM» por tramo, separados por coma. */
export function segmentsLabel(segments: readonly Omit<ServiceSegmentView, 'index'>[]): string {
  return segments.map((s) => `${s.origin} → ${s.destination}`).join(', ');
}

/** «Pasajero 1 · Ana Pérez (adulto)». Sin nombre, sólo la posición y el tipo. */
export function passengerLabel(
  index: number,
  passenger:
    | { readonly givenName?: string; readonly surname?: string; readonly paxType?: string }
    | undefined,
): string {
  const name = [passenger?.givenName, passenger?.surname].filter(Boolean).join(' ').trim();
  const type = passenger?.paxType === undefined ? undefined : PAX_LABELS[passenger.paxType];
  return `Pasajero ${index + 1}${name ? ` · ${name}` : ''}${type ? ` (${type})` : ''}`;
}

/** La clave de una casilla: un servicio para un pasajero. */
export function selectionKey(serviceOfferItemId: string, passengerIndex: number): string {
  return `${passengerIndex}\u0000${serviceOfferItemId}`;
}

/** Lo que un pasajero puede comprar, por tramos (una oferta cubre uno o varios). */
export interface PassengerServicesView {
  readonly passengerIndex: number;
  readonly added: readonly ServiceLineView[];
  readonly groups: readonly {
    readonly label: string;
    readonly offers: readonly {
      readonly offer: ServiceOfferView;
      readonly amountMinor: number | null;
      readonly included: boolean;
    }[];
  }[];
}

export function servicesByPassenger(
  catalog: ServicesCatalogView,
  passengerCount: number,
): PassengerServicesView[] {
  const segmentByIndex = new Map(catalog.segments.map((s) => [s.index, s]));
  const out: PassengerServicesView[] = [];
  for (let index = 0; index < passengerCount; index += 1) {
    const groups = new Map<string, PassengerServicesView['groups'][number]['offers'][number][]>();
    for (const offer of catalog.offers) {
      const entry = offer.passengers.find((p) => p.passengerIndex === index);
      if (entry === undefined) continue;
      const label = segmentsLabel(
        offer.segmentRefs.flatMap((ref) => {
          const s = segmentByIndex.get(ref);
          return s === undefined ? [] : [s];
        }),
      );
      const bucket = groups.get(label) ?? [];
      bucket.push({ offer, amountMinor: entry.amountMinor, included: entry.included });
      groups.set(label, bucket);
    }
    out.push({
      passengerIndex: index,
      added: catalog.added.filter((line) => line.passengerIndex === index),
      groups: [...groups.entries()].map(([label, offers]) => ({ label, offers })),
    });
  }
  return out;
}

/** Lo que suman las casillas marcadas, con el precio del catálogo. */
export function selectionTotal(
  catalog: ServicesCatalogView,
  selected: ReadonlySet<string>,
): number {
  let total = 0;
  for (const offer of catalog.offers) {
    for (const entry of offer.passengers) {
      if (selected.has(selectionKey(offer.serviceOfferItemId, entry.passengerIndex))) {
        total += entry.amountMinor ?? 0;
      }
    }
  }
  return total;
}

/** El cuerpo de `services/add`: qué y para quién, y lo que el vendedor vio que suma. */
export function addServicesBody(
  catalog: ServicesCatalogView,
  selected: ReadonlySet<string>,
): {
  selections: { serviceOfferItemId: string; passengerIndexes: number[] }[];
  expectedTotalMinor: number;
  currency: string;
} {
  const selections = catalog.offers.flatMap((offer) => {
    const passengerIndexes = offer.passengers
      .filter((p) => selected.has(selectionKey(offer.serviceOfferItemId, p.passengerIndex)))
      .map((p) => p.passengerIndex);
    return passengerIndexes.length === 0
      ? []
      : [{ serviceOfferItemId: offer.serviceOfferItemId, passengerIndexes }];
  });
  return {
    selections,
    expectedTotalMinor: selectionTotal(catalog, selected),
    currency: catalog.currency,
  };
}

/**
 * Las líneas que se quitan al pedir quitar una: ella y las de su grupo (el proveedor dio un solo id
 * para todas y se quitan juntas). La confirmación las nombra todas.
 */
export function removalSet(catalog: ServicesCatalogView, lineId: string): ServiceLineView[] {
  const line = catalog.added.find((l) => l.id === lineId);
  if (line === undefined) return [];
  if (line.removalGroup === null) return [line];
  return catalog.added.filter((l) => l.removalGroup === line.removalGroup);
}

export function removeServicesBody(
  catalog: ServicesCatalogView,
  lines: readonly ServiceLineView[],
): { lineIds: string[]; expectedTotalMinor: number; currency: string } {
  return {
    lineIds: lines.map((l) => l.id),
    expectedTotalMinor: lines.reduce((sum, l) => sum + l.amountMinor, 0),
    currency: catalog.currency,
  };
}

/** En qué quedó un cambio, para el aviso de la pantalla. */
export type ServicesChangeReply =
  | { readonly ok: true; readonly done: boolean; readonly message: string }
  | { readonly ok: false; readonly message: string };

function messageOf(data: unknown): string | undefined {
  const r = record(data);
  if (r === null) return undefined;
  for (const key of ['message', 'error']) {
    const value = r[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
    if (Array.isArray(value)) {
      const parts = value.filter((v): v is string => typeof v === 'string');
      if (parts.length > 0) return parts.join('. ');
    }
  }
  return undefined;
}

/**
 * La respuesta del API: el texto del desenlace (ya en «tú») y si quedó como se pidió. `done: false`
 * (parcial, rechazado o sin confirmar) se muestra como aviso, no como éxito.
 */
export function servicesChangeReplyOf(status: number, data: unknown): ServicesChangeReply {
  const r = record(data);
  const outcome = text(r?.['outcome']);
  if (status === 200 && outcome !== null) {
    return {
      ok: true,
      done: outcome === 'ADDED' || outcome === 'REMOVED',
      message: messageOf(data) ?? SERVICES_UI.sendFailed,
    };
  }
  return { ok: false, message: messageOf(data) ?? SERVICES_UI.sendFailed };
}
