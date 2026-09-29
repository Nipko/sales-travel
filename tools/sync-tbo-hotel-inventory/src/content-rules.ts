import {
  TBO_HOTEL_DETAILS_LIMITS,
  tboHotelContentHash,
  type TboContentLanguage,
  type TboContentSource,
  type TboHotelContent,
} from '@sales-travel/tbo-hotels';
import type { ContentSettings } from './env.js';

/**
 * Las reglas del contenido de hotel (E4), sin I/O: qué par hotel-idioma toca, cómo se arman los
 * lotes de HotelDetails y qué hace el escritor con cada fila de `hotel_content`. Viven aparte por
 * lo mismo que `catalog-rules.ts`: el escritor de Postgres y el doble de los tests deciden igual.
 */

/**
 * `hotel_content.content_hash` (0041). La regla vive en el ACL (`tboHotelContentHash`,
 * `tbo-content-v1`) porque el API también escribe contenido de HotelDetails bajo demanda: con dos
 * cálculos, cada uno vería "cambió" en las filas del otro y las reescribiría en cada pasada.
 *
 * `source` no entra: su cambio (`listing` → `details`) se decide aparte y siempre reescribe.
 */
export function contentHash(content: TboHotelContent): string {
  return tboHotelContentHash(content);
}

export interface StoredContentRef {
  readonly source: TboContentSource;
  readonly contentHash: string;
}

/**
 * Qué pasa con una fila de contenido que llega:
 *
 * - `insert`: no había fila para ese hotel e idioma.
 * - `rewrite`: cambió la huella, o llega `details` sobre un `listing`.
 * - `touch`: `details` igual al guardado; sólo avanza `fetched_at`, para que la próxima corrida no
 *   lo vuelva a pedir. Sin esto, un contenido que no cambia se pediría en cada corrida.
 * - `unchanged`: `listing` igual al guardado. Su `fetched_at` no decide nada, así que no se toca.
 * - `protected`: `listing` sobre `details`. El texto de TBOHotelCodeList es el respaldo en inglés
 *   hasta que haya HotelDetails, nunca lo reemplaza: no tiene imágenes ni horarios (05 §6.3).
 */
export type ContentWriteAction = 'insert' | 'rewrite' | 'touch' | 'unchanged' | 'protected';

/** El contador del resultado de escritura que suma cada camino. */
export const CONTENT_WRITE_COUNTER = Object.freeze({
  insert: 'inserted',
  rewrite: 'rewritten',
  touch: 'touched',
  unchanged: 'unchanged',
  protected: 'protected',
} as const satisfies Record<ContentWriteAction, string>);

export type ContentWriteCounter = (typeof CONTENT_WRITE_COUNTER)[ContentWriteAction];

export function contentWriteAction(
  stored: StoredContentRef | undefined,
  incoming: StoredContentRef,
): ContentWriteAction {
  if (stored === undefined) return 'insert';
  if (incoming.source === 'listing' && stored.source === 'details') return 'protected';
  if (stored.source === incoming.source && stored.contentHash === incoming.contentHash) {
    return incoming.source === 'details' ? 'touch' : 'unchanged';
  }
  return 'rewrite';
}

/** Un hotel activo con lo que ya tiene de HotelDetails, por idioma. */
export interface ContentCandidate {
  readonly hotelId: string;
  /** Búsquedas recientes de destinos mapeados a la ciudad del hotel (la misma demanda que E3). */
  readonly demand: number;
  /** `fetched_at` del contenido `details` guardado, por idioma. El `listing` no cuenta. */
  readonly detailsFetchedAt: Readonly<Partial<Record<TboContentLanguage, Date>>>;
}

export interface ContentTask {
  readonly hotelId: string;
  readonly lang: TboContentLanguage;
  readonly demand: number;
  /** `null` = nunca hubo HotelDetails en ese idioma. */
  readonly fetchedAt: Date | null;
  /** Posición del idioma en la lista configurada: el primero es el que más vende. */
  readonly langRank: number;
}

export type ContentSelection = Pick<
  ContentSettings,
  'scope' | 'demandLangs' | 'regularLangs' | 'maxAgeMs'
>;

function languagesFor(
  candidate: ContentCandidate,
  selection: ContentSelection,
): readonly TboContentLanguage[] {
  if (candidate.demand > 0) return selection.demandLangs;
  return selection.scope === 'all' ? selection.regularLangs : [];
}

/**
 * Los pares hotel-idioma que tocan en esta corrida, en orden (05 §6.3, entrada de E4: "hoteles
 * activos sin contenido o con contenido de más de X días, priorizando destinos con demanda"):
 *
 * 1. de más a menos demanda;
 * 2. los que nunca tuvieron HotelDetails en ese idioma, antes que los que sólo están viejos;
 * 3. el idioma en el orden configurado (ES primero: el mercado inicial vende en español);
 * 4. el más viejo primero, y el código de hotel para que el orden sea estable.
 */
export function selectContentTasks(
  candidates: readonly ContentCandidate[],
  options: ContentSelection & { readonly now: number },
): ContentTask[] {
  const tasks: ContentTask[] = [];
  for (const candidate of candidates) {
    languagesFor(candidate, options).forEach((lang, langRank) => {
      const fetchedAt = candidate.detailsFetchedAt[lang] ?? null;
      if (fetchedAt !== null && options.now - fetchedAt.getTime() < options.maxAgeMs) return;
      tasks.push({
        hotelId: candidate.hotelId,
        lang,
        demand: candidate.demand,
        fetchedAt,
        langRank,
      });
    });
  }
  return tasks.sort(
    (a, b) =>
      b.demand - a.demand ||
      Number(b.fetchedAt === null) - Number(a.fetchedAt === null) ||
      a.langRank - b.langRank ||
      (a.fetchedAt?.getTime() ?? 0) - (b.fetchedAt?.getTime() ?? 0) ||
      a.hotelId.localeCompare(b.hotelId),
  );
}

export interface ContentBatch {
  readonly lang: TboContentLanguage;
  readonly hotelIds: readonly string[];
}

interface OpenBatch {
  readonly lang: TboContentLanguage;
  readonly hotelIds: string[];
}

/**
 * Lotes de HotelDetails: un idioma por llamada (`Language` es uno solo, p. 58) y a lo sumo
 * `batchSize` códigos, nunca más de 13 (Q-62). Cada lote se llena con los pares de su idioma en el
 * orden de prioridad, y los lotes salen en el orden de su primer par: con el presupuesto cortado,
 * lo que queda sin pedir es lo menos prioritario.
 */
export function planContentBatches(
  tasks: readonly ContentTask[],
  batchSize: number,
): ContentBatch[] {
  // Con `NaN`, `Math.min` y `Math.max` devuelven `NaN` y el lote no se cerraría nunca.
  const requested = Number.isFinite(batchSize)
    ? Math.trunc(batchSize)
    : TBO_HOTEL_DETAILS_LIMITS.defaultBatchSize;
  const size = Math.max(1, Math.min(requested, TBO_HOTEL_DETAILS_LIMITS.maxCodesPerRequest));
  // Un lote entra en la lista al abrirse, con su primer par: la lista ya queda en ese orden.
  const planned: OpenBatch[] = [];
  const open = new Map<TboContentLanguage, OpenBatch>();
  for (const task of tasks) {
    let batch = open.get(task.lang);
    if (batch === undefined) {
      batch = { lang: task.lang, hotelIds: [] };
      planned.push(batch);
      open.set(task.lang, batch);
    }
    if (!batch.hotelIds.includes(task.hotelId)) batch.hotelIds.push(task.hotelId);
    if (batch.hotelIds.length >= size) open.delete(task.lang);
  }
  return planned.map(({ lang, hotelIds }) => ({ lang, hotelIds }));
}

/**
 * Qué fallos de un lote justifican partirlo (05 §10: "si el lote da 400, 500 o timeout, se parte en
 * dos"). No se parte ante `429` ni ante una llamada que nuestro limitador no despachó: el lote no
 * tiene la culpa, y partirlo sólo gastaría más llamadas contra la misma cuota. Esos lotes quedan
 * para la próxima corrida.
 */
export function isSplittableFailure(code: string): boolean {
  return code !== 'THROTTLED' && !code.startsWith('NOT_DISPATCHED_');
}
