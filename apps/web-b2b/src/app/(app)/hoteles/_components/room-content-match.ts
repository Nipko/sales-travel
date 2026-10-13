import {
  ROOM_CONTENT_PROVIDERS,
  roomSizeLabel,
  type RoomContent,
  type RoomContentResult,
  type RoomContentState,
} from './room-content-view';
import {
  roomDisplayName,
  type GroupableRate,
  type RoomSlot,
  type RoomTypeGroup,
} from './room-type-groups';

/*
 * Qué foto, tamaño y descripción del catálogo del proveedor van con cada habitación de una tarifa,
 * sin React (D-TBO-H2, opción 2):
 *
 * 1. Por id: el `roomTypeId` de la tarifa en ESE proveedor es el `RoomId` de su catálogo. Es la
 *    misma habitación: la foto es la suya.
 * 2. Si la tarifa no trae id (TBO manda `0` o nada cuando no tiene el mapeo, p. 57) o el catálogo
 *    no lo tiene: el nombre normalizado idéntico, y sólo con UN candidato. Es una habitación con el
 *    mismo nombre, no necesariamente la misma: la foto se marca «Foto de referencia».
 * 3. Nada más. Dos habitaciones del catálogo con el mismo nombre, o una con OTRO id, no son un
 *    candidato: ante la duda, sin foto. La coincidencia por el inicio del nombre (opción 3) queda
 *    escrita pero apagada (`allowPrefix`), por si el founder la elige.
 */

export interface RoomContentMatch {
  readonly room: RoomContent;
  /** Por id; `false` si fue por el nombre («Foto de referencia»). */
  readonly exact: boolean;
}

export interface RoomMatchOptions {
  /** El proveedor del contenido: de la tarifa se compara el id de tipo en ESE proveedor. */
  readonly providerCode: string;
  /** D-TBO-H2, opción 3: también por el inicio del nombre. Apagada. */
  readonly allowPrefix?: boolean;
}

/** El único candidato, si lo es: uno solo, y sin un id que diga que es otra habitación. */
function single(candidates: readonly RoomContent[], slotId: string | undefined) {
  if (candidates.length !== 1) return undefined;
  const [room] = candidates;
  // La tarifa dice su id y el catálogo da OTRO para ese nombre: son habitaciones distintas.
  if (room === undefined || (slotId !== undefined && room.roomId !== null)) return undefined;
  return room;
}

function startsWithWord(text: string, prefix: string): boolean {
  return text.startsWith(`${prefix} `);
}

/** La habitación del catálogo de un proveedor que va con una habitación de la tarifa, si hay una. */
export function matchRoomContent(
  slot: Pick<RoomSlot, 'nameKey' | 'roomTypeIds'>,
  rooms: readonly RoomContent[],
  { providerCode, allowPrefix = false }: RoomMatchOptions,
): RoomContentMatch | undefined {
  const slotId = slot.roomTypeIds[providerCode];
  if (slotId !== undefined) {
    const byId = rooms.find((r) => r.roomId === slotId);
    if (byId !== undefined) return { room: byId, exact: true };
  }
  // Un nombre vacío no identifica nada.
  if (slot.nameKey.length === 0) return undefined;
  const sameName = rooms.filter((r) => r.nameKey === slot.nameKey);
  if (sameName.length > 0 || !allowPrefix) {
    const room = single(sameName, slotId);
    return room === undefined ? undefined : { room, exact: false };
  }
  const byPrefix = rooms.filter(
    (r) =>
      r.nameKey !== null &&
      (startsWithWord(r.nameKey, slot.nameKey) || startsWithWord(slot.nameKey, r.nameKey)),
  );
  const room = single(byPrefix, slotId);
  return room === undefined ? undefined : { room, exact: false };
}

/** Una habitación del catálogo que va con una o más habitaciones de un tipo. */
export interface MatchedRoom {
  /** `proveedor:roomKey`: estable y único dentro del tipo. */
  readonly key: string;
  /** El nombre con que la tarifa la nombra: es el que el vendedor ve en el título. */
  readonly name: string;
  readonly room: RoomContent;
  readonly exact: boolean;
  /** Las habitaciones de la combinación con las que va (base 0). */
  readonly slotIndexes: readonly number[];
}

/**
 * Lo que un tipo de habitación muestra del catálogo:
 *
 * - `loading`: se está pidiendo (o el API lo está trayendo del proveedor): un esqueleto.
 * - `ready`: las habitaciones distintas que coincidieron, en el orden de la combinación, y cuál va
 *   con cada habitación de la combinación.
 * - `undefined`: nada que mostrar; el tipo queda como siempre (el icono de la cama).
 */
export type GroupRoomContent =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'ready';
      readonly rooms: readonly MatchedRoom[];
      readonly bySlot: ReadonlyMap<number, MatchedRoom>;
    };

const LOADING: GroupRoomContent = Object.freeze({ kind: 'loading' });

/** Los proveedores de los planes del tipo que dan contenido por habitación, sin repetir. */
function contentProvidersOf<T extends GroupableRate>(group: RoomTypeGroup<T>): string[] {
  const out: string[] = [];
  for (const plan of group.plans) {
    const code = plan.row.pack.provider?.name;
    if (code !== undefined && ROOM_CONTENT_PROVIDERS.has(code) && !out.includes(code)) {
      out.push(code);
    }
  }
  return out;
}

function bestMatch(
  slot: RoomSlot,
  ready: readonly (readonly [string, RoomContentResult])[],
  allowPrefix: boolean,
): { readonly providerCode: string; readonly match: RoomContentMatch } | undefined {
  let byName: { providerCode: string; match: RoomContentMatch } | undefined;
  for (const [providerCode, result] of ready) {
    const match = matchRoomContent(slot, result.rooms, { providerCode, allowPrefix });
    if (match === undefined) continue;
    if (match.exact) return { providerCode, match };
    byName ??= { providerCode, match };
  }
  return byName;
}

/** El contenido del catálogo de un tipo de habitación, con lo que la pantalla sabe hasta ahora. */
export function groupRoomContent<T extends GroupableRate>(
  group: RoomTypeGroup<T>,
  state: RoomContentState,
  { allowPrefix = false }: { readonly allowPrefix?: boolean } = {},
): GroupRoomContent | undefined {
  const providers = contentProvidersOf(group);
  if (providers.length === 0 || state.status === 'idle') return undefined;
  if (state.status === 'loading') return LOADING;

  const results = providers.flatMap((code) => {
    const result = state.reply.byProvider[code];
    return result === undefined ? [] : [[code, result] as const];
  });
  const ready = results.filter(([, r]) => r.status === 'ready');
  const byKey = new Map<string, MatchedRoom & { readonly slotIndexes: number[] }>();
  const bySlot = new Map<number, MatchedRoom>();
  for (const slot of group.slots) {
    const best = bestMatch(slot, ready, allowPrefix);
    if (best === undefined) continue;
    const key = `${best.providerCode}:${best.match.room.roomKey}`;
    let entry = byKey.get(key);
    if (entry === undefined) {
      entry = {
        key,
        name: roomDisplayName(slot),
        room: best.match.room,
        exact: best.match.exact,
        slotIndexes: [],
      };
      byKey.set(key, entry);
    }
    entry.slotIndexes.push(slot.index);
    bySlot.set(slot.index, entry);
  }

  if (byKey.size === 0) {
    // Mientras un proveedor lo sigue trayendo, el esqueleto; si ya respondieron todos, nada.
    return results.some(([, r]) => r.status === 'pending') ? LOADING : undefined;
  }
  return { kind: 'ready', rooms: [...byKey.values()], bySlot };
}

/** Miniaturas por tipo, como mucho: una por habitación distinta de la combinación. */
export const ROOM_PHOTOS_MAX = 3;

/** Las habitaciones del tipo que tienen fotos, una miniatura cada una. */
export function roomsWithPhotos(content: GroupRoomContent | undefined): readonly MatchedRoom[] {
  if (content?.kind !== 'ready') return [];
  return content.rooms.filter((r) => r.room.images.length > 0).slice(0, ROOM_PHOTOS_MAX);
}

/** Las habitaciones del tipo que tienen descripción, en el orden de la combinación. */
export function roomsWithDescription(
  content: GroupRoomContent | undefined,
): readonly MatchedRoom[] {
  if (content?.kind !== 'ready') return [];
  return content.rooms.filter((r) => r.room.description !== null).slice(0, ROOM_PHOTOS_MAX);
}

/** El tamaño de la habitación `index` de la combinación («≈ 25 m²»), si el catálogo lo dice. */
export function slotSizeLabel(
  content: GroupRoomContent | undefined,
  index: number,
): string | undefined {
  if (content?.kind !== 'ready') return undefined;
  const matched = content.bySlot.get(index);
  return matched === undefined ? undefined : roomSizeLabel(matched.room);
}
