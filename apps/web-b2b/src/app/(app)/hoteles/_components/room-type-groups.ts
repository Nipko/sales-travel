import type { HotelRoomOccupancy } from '../actions';
import type { HotelRateRoomSlot, HotelRateRow } from './hotel-rate-view';
import type { RateRefundability } from './rate-refundability';

/*
 * Las tarifas de un hotel agrupadas por tipo de habitación, sin React: el vendedor elige primero la
 * habitación (nombre, camas, ocupación) y después su plan (régimen, reembolso, precio).
 *
 * Un pack de TBO es indivisible —un BookingCode para todas sus habitaciones—, así que el grupo es la
 * COMBINACIÓN de habitaciones del pack, en su orden: la habitación j va con la ocupación j de la
 * búsqueda, y «Doble + Suite» no es lo mismo que «Suite + Doble».
 *
 * La identidad de una habitación es su id de tipo (RoomID en TBO) y, sin él, su nombre normalizado.
 * Un id sólo se compara con los de SU proveedor. Dos grupos de proveedores distintos se juntan por
 * nombre sólo si ninguno de los dos tiene otro grupo con ese mismo nombre: ante la duda, quedan
 * separados. Nunca se fusiona de más.
 */

/**
 * La clave de comparación de un nombre de habitación: NFKD, sin diacríticos, en minúsculas y todo lo
 * que no sea `[a-z0-9]` como un espacio, colapsado y recortado. El ACL de TBO calcula la misma clave
 * para el contenido por habitación (TBO-05): es un espejo, y los dos lados se prueban con
 * `ROOM_NAME_VECTORS`.
 */
export function normalizeRoomName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Casos de `normalizeRoomName` que el espejo del ACL tiene que dar igual. */
export const ROOM_NAME_VECTORS: readonly { readonly name: string; readonly key: string }[] =
  Object.freeze([
    { name: 'Doble Estándar', key: 'doble estandar' },
    { name: '  Deluxe Room, 1 King Bed ', key: 'deluxe room 1 king bed' },
    { name: 'DELUXE ROOM - 1 KING BED', key: 'deluxe room 1 king bed' },
    { name: 'Habitación  Doble/Twin', key: 'habitacion doble twin' },
    { name: 'Suite Júnior (Vista al mar)', key: 'suite junior vista al mar' },
    {
      name: 'Quarto Duplo Superior – Não reembolsável',
      key: 'quarto duplo superior nao reembolsavel',
    },
    { name: 'Habitación Señorial', key: 'habitacion senorial' },
    { name: 'Doble\testándar\n', key: 'doble estandar' },
    { name: 'Ｄｅｌｕｘｅ Ｒｏｏｍ', key: 'deluxe room' },
    { name: 'Cama ½', key: 'cama 1 2' },
    { name: 'Room #2', key: 'room 2' },
    { name: 'Straße', key: 'stra e' },
    { name: '!!!', key: '' },
    { name: '', key: '' },
  ]);

function ageList(ages: readonly number[]): string {
  if (ages.length <= 1) return ages.map(String).join('');
  return `${ages.slice(0, -1).join(', ')} y ${ages[ages.length - 1]}`;
}

/**
 * «2 adultos», «1 adulto, 1 niño (5 años)», «2 adultos, 2 niños (3 y 7 años)». Las edades en el
 * orden de la búsqueda.
 */
export function occupancyText({ adults, childrenAges }: HotelRoomOccupancy): string {
  const parts: string[] = [];
  if (adults > 0) parts.push(`${adults} adulto${adults === 1 ? '' : 's'}`);
  const n = childrenAges.length;
  if (n > 0) {
    const years = n === 1 && childrenAges[0] === 1 ? 'año' : 'años';
    parts.push(`${n} niño${n === 1 ? '' : 's'} (${ageList(childrenAges)} ${years})`);
  }
  return parts.join(', ');
}

/** Lo mínimo que se agrupa: una fila de tarifa y, si se leyó con la hora de la búsqueda, su reembolso. */
export interface GroupableRate {
  readonly row: HotelRateRow;
  readonly refund?: Pick<RateRefundability, 'refundable'>;
}

/** Una habitación de la combinación de un grupo. */
export interface RoomSlot {
  /** Su lugar en el pack, base 0: va con la ocupación de ese lugar en la búsqueda. */
  readonly index: number;
  /** El nombre como lo dio el proveedor, recortado; puede estar vacío. */
  readonly name: string;
  readonly nameKey: string;
  /**
   * El id de tipo del plan más barato que lo trae. Es de SU proveedor: para cruzarlo con el
   * contenido de un proveedor, `roomTypeIds[proveedor]`.
   */
  readonly roomTypeId?: string;
  /** El id de tipo de esta habitación en cada proveedor del grupo (código del proveedor → id). */
  readonly roomTypeIds: Readonly<Record<string, string>>;
  /** Las camas, la primera opción que informa algún plan. */
  readonly beds?: string;
  readonly occupancyText?: string;
}

export interface RoomTypeGroup<T extends GroupableRate> {
  /** Estable para las mismas tarifas: sirve de `key` y de id en la página. */
  readonly key: string;
  readonly slots: readonly RoomSlot[];
  /** «Doble estándar», «2 × Doble estándar» o «Doble estándar + Suite». */
  readonly title: string;
  /** Por precio de venta y, ante un empate, en el orden de llegada. */
  readonly plans: readonly T[];
  /** El plan más barato que sigue vigente; si vencieron todos, el más barato. */
  readonly from: T;
  readonly fromExpired: boolean;
  /** Los regímenes de sus planes, sin repetir, en el orden de los planes. */
  readonly boards: readonly string[];
  readonly anyRefundable: boolean;
}

/** El nombre que se muestra de una habitación: el suyo o, si vino vacío, «Habitación». */
export function roomDisplayName(slot: Pick<RoomSlot, 'name'>): string {
  return slot.name || 'Habitación';
}

interface Identity {
  readonly key: string;
  /** El id resuelto (propio o inferido por el nombre), si lo hay. */
  readonly id?: string;
}

interface RatedPlan<T> {
  readonly rate: T;
  readonly index: number;
  readonly scope: string;
  readonly identities: readonly Identity[];
}

interface RawGroup<T> {
  readonly key: string;
  readonly plans: RatedPlan<T>[];
  readonly scope: string;
  readonly hasId: boolean;
  readonly signature: string;
}

const SEP = '\u0000';

function scopeOf(row: HotelRateRow): string {
  return row.pack.provider?.name ?? '';
}

function only<V>(values: ReadonlySet<V> | undefined): V | undefined {
  if (values === undefined || values.size !== 1) return undefined;
  const [value] = values;
  return value;
}

/**
 * Los ids de tipo que cada nombre normalizado tiene dentro de cada proveedor. Un nombre vacío no
 * entra: no identifica nada, y una habitación sin nombre ni id no hereda el id de otra sin nombre
 * (sería fusionar de más y, con TBO-07, ponerle la foto de otra habitación).
 */
function idsByName(rates: readonly GroupableRate[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const { row } of rates) {
    for (const slot of row.roomSlots) {
      if (slot.roomTypeId === undefined || slot.nameKey.length === 0) continue;
      const key = `${scopeOf(row)}${SEP}${slot.nameKey}`;
      const ids = out.get(key) ?? new Set<string>();
      ids.add(slot.roomTypeId);
      out.set(key, ids);
    }
  }
  return out;
}

function identityOf(
  slot: HotelRateRoomSlot,
  scope: string,
  byName: ReadonlyMap<string, ReadonlySet<string>>,
): Identity {
  const id = slot.roomTypeId ?? only(byName.get(`${scope}${SEP}${slot.nameKey}`));
  if (id === undefined) return { key: `n:${slot.nameKey}` };
  return { key: `id:${encodeURIComponent(scope)}:${encodeURIComponent(id)}`, id };
}

function saleOrder<T extends GroupableRate>(a: RatedPlan<T>, b: RatedPlan<T>): number {
  return a.rate.row.sale.amountMinor - b.rate.row.sale.amountMinor || a.index - b.index;
}

/** Los grupos con ids de varios proveedores que se juntan por nombre, sin ambigüedad. */
function mergeAcrossProviders<T>(raw: readonly RawGroup<T>[]): RawGroup<T>[] {
  const bySignature = new Map<string, RawGroup<T>[]>();
  for (const group of raw) {
    const list = bySignature.get(group.signature) ?? [];
    list.push(group);
    bySignature.set(group.signature, list);
  }
  const merged = new Map<RawGroup<T>, RawGroup<T>>();
  for (const [signature, list] of bySignature) {
    // Un nombre vacío no identifica nada: no junta grupos de proveedores distintos.
    if (list.length < 2 || signature.split('|').some((k) => k.length === 0)) continue;
    const withIds = list.filter((g) => g.hasId);
    const idScopes = new Set(withIds.map((g) => g.scope));
    // Dos grupos con ids del mismo proveedor y el mismo nombre son habitaciones distintas.
    if (withIds.length === 0 || idScopes.size !== withIds.length) continue;
    // El grupo sin ids se suma sólo si no tiene planes de esos proveedores: en ellos, que una
    // habitación no haya resuelto su id quiere decir que su nombre tiene más de uno.
    const byName = list.filter((g) => !g.hasId);
    const members = byName.every((g) => g.plans.every((p) => !idScopes.has(p.scope)))
      ? list
      : withIds;
    if (members.length < 2) continue;
    const into: RawGroup<T> = {
      key: `m:${signature}`,
      plans: members.flatMap((g) => g.plans),
      scope: '',
      hasId: true,
      signature,
    };
    for (const group of members) merged.set(group, into);
  }
  const out: RawGroup<T>[] = [];
  const seen = new Set<RawGroup<T>>();
  for (const group of raw) {
    const target = merged.get(group) ?? group;
    if (seen.has(target)) continue;
    seen.add(target);
    out.push(target);
  }
  return out;
}

function slotsOf<T extends GroupableRate>(plans: readonly RatedPlan<T>[]): RoomSlot[] {
  const first = plans[0];
  if (first === undefined) return [];
  return first.rate.row.roomSlots.map((rep, j) => {
    const roomTypeIds: Record<string, string> = {};
    let roomTypeId: string | undefined;
    let beds: string | undefined;
    let occupancy: HotelRoomOccupancy | undefined;
    for (const plan of plans) {
      const slot = plan.rate.row.roomSlots[j];
      const id = plan.identities[j]?.id;
      if (id !== undefined) {
        roomTypeIds[plan.scope] ??= id;
        roomTypeId ??= id;
      }
      beds ??= slot?.beds;
      occupancy ??= slot?.occupancy;
    }
    const text = occupancy === undefined ? '' : occupancyText(occupancy);
    return {
      index: rep.index,
      name: rep.name,
      nameKey: rep.nameKey,
      ...(roomTypeId === undefined ? {} : { roomTypeId }),
      roomTypeIds,
      ...(beds === undefined ? {} : { beds }),
      ...(text ? { occupancyText: text } : {}),
    };
  });
}

function titleOf(slots: readonly RoomSlot[], identities: readonly Identity[]): string {
  const [first] = slots;
  if (first === undefined) return 'Habitación';
  if (slots.length === 1) return roomDisplayName(first);
  const same = identities.every((i) => i.key === identities[0]?.key);
  if (same) return `${slots.length} × ${roomDisplayName(first)}`;
  return slots.map(roomDisplayName).join(' + ');
}

/**
 * Las tarifas agrupadas por tipo de habitación. Los grupos van del «desde» más barato al más caro
 * (ante un empate, el que llegó primero); el «desde» de cada uno es su plan vigente más barato.
 * Los filtros de la pantalla se aplican antes, por fila: acá llegan sólo las que los cumplen.
 */
export function roomTypeGroups<T extends GroupableRate>(
  rates: readonly T[],
  isExpired: (rate: T) => boolean = () => false,
): RoomTypeGroup<T>[] {
  const byName = idsByName(rates);
  const rawByKey = new Map<string, RawGroup<T>>();
  rates.forEach((rate, index) => {
    const scope = scopeOf(rate.row);
    const identities = rate.row.roomSlots.map((slot) => identityOf(slot, scope, byName));
    const plan: RatedPlan<T> = { rate, index, scope, identities };
    const key = identities.map((i) => i.key).join('|');
    const existing = rawByKey.get(key);
    if (existing) {
      existing.plans.push(plan);
      return;
    }
    rawByKey.set(key, {
      key,
      plans: [plan],
      scope,
      hasId: identities.some((i) => i.id !== undefined),
      signature: rate.row.roomSlots.map((s) => s.nameKey).join('|'),
    });
  });

  return mergeAcrossProviders([...rawByKey.values()])
    .flatMap((group) => {
      const plans = [...group.plans].sort(saleOrder);
      const [head] = plans;
      if (head === undefined) return [];
      const fromPlan = plans.find((p) => !isExpired(p.rate)) ?? head;
      const slots = slotsOf(plans);
      return {
        firstIndex: Math.min(...plans.map((p) => p.index)),
        group: {
          key: group.key,
          slots,
          title: titleOf(slots, head.identities),
          plans: plans.map((p) => p.rate),
          from: fromPlan.rate,
          fromExpired: isExpired(fromPlan.rate),
          boards: [...new Set(plans.map((p) => p.rate.row.board))],
          anyRefundable: plans.some(
            (p) => p.rate.refund?.refundable ?? p.rate.row.cancellation.refundable,
          ),
        } satisfies RoomTypeGroup<T>,
      };
    })
    .sort(
      (a, b) =>
        a.group.from.row.sale.amountMinor - b.group.from.row.sale.amountMinor ||
        a.firstIndex - b.firstIndex,
    )
    .map(({ group }) => group);
}

/** «1 tipo de habitación · 3 tarifas». */
export function roomTypesCountText(groups: number, rates: number): string {
  return `${groups} tipo${groups === 1 ? '' : 's'} de habitación · ${rates} tarifa${rates === 1 ? '' : 's'}`;
}
