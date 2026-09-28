import type { TboContentLanguage } from '@sales-travel/tbo-hotels';
import { isSplittableFailure, planContentBatches, selectContentTasks } from '../content-rules.js';
import type { ContentScope } from '../env.js';
import { throwIfAccountFailure, type StageContext } from './context.js';

export interface E4Result {
  readonly status: 'done' | 'skipped';
  readonly scope: ContentScope;
  /** Hoteles con al menos un idioma pendiente. */
  readonly hotelsDue: number;
  /** Pares hotel-idioma pendientes. */
  readonly tasksDue: number;
  readonly batchesPlanned: number;
  /** Lotes que se pidieron enteros o partidos, hasta el final o hasta el corte. */
  readonly batchesAttempted: number;
  /** Contenidos que HotelDetails devolvió y el ACL entendió. */
  readonly contentsReceived: number;
  /** Filas `details` insertadas o reescritas. */
  readonly contentsWritten: number;
  /** Iguales a lo guardado (`content_hash`): sólo avanzó `fetched_at`. */
  readonly contentsUnchanged: number;
  /** Pedidos que volvieron sin ese hotel: TBO no dice si es un código sin contenido (Q-62). */
  readonly hotelsMissing: number;
  /** Códigos aislados a uno que siguieron fallando: se marcan en el log y se sigue. */
  readonly hotelsFailed: number;
  /** Veces que un lote fallido se partió en dos. */
  readonly splits: number;
  /** Lotes que no se partieron (`429`, limitador) y quedan para la próxima corrida. */
  readonly batchesDeferred: number;
  /** Nombres de claves que el ACL no conoce: un contrato que cambió (p. ej. habitaciones, N10). */
  readonly unknownKeys: readonly string[];
}

function skipped(scope: ContentScope): E4Result {
  return {
    status: 'skipped',
    scope,
    hotelsDue: 0,
    tasksDue: 0,
    batchesPlanned: 0,
    batchesAttempted: 0,
    contentsReceived: 0,
    contentsWritten: 0,
    contentsUnchanged: 0,
    hotelsMissing: 0,
    hotelsFailed: 0,
    splits: 0,
    batchesDeferred: 0,
    unknownKeys: [],
  };
}

/**
 * Un lote grande que falla por un timeout tarda en aislarse: con dos intentos, un fallo pasajero
 * todavía se reintenta, y uno determinista se parte antes. Un código solo conserva tres.
 */
const BATCH_MAX_ATTEMPTS = 2;
const SINGLE_MAX_ATTEMPTS = 3;
const MAX_UNKNOWN_KEYS = 20;

interface Tally {
  batchesAttempted: number;
  contentsReceived: number;
  contentsWritten: number;
  contentsUnchanged: number;
  hotelsMissing: number;
  hotelsFailed: number;
  splits: number;
  batchesDeferred: number;
  readonly unknownKeys: Set<string>;
}

type Flow = 'continue' | 'stop';

/**
 * Pide un lote y, si falla por algo del lote (400, 500, timeout, cuerpo ilegible), lo parte en dos
 * mitades y pide cada una, hasta aislar el código que lo tumba (05 §10; Q-62). Ese código se marca
 * y se sigue; sus compañeros de lote reciben su contenido igual.
 *
 * Las llamadas de la partición cuentan en el presupuesto como cualquier otra. En la racha de
 * errores de la puerta, el lote entero cuenta siempre; sus mitades sólo cuando el fallo parece un
 * TBO caído (500, timeout, transporte), que es cuando partir multiplicaría llamadas en vano. Si TBO
 * rechazó el request por su contenido (un 400 o un 201 en el sobre), las mitades son la partición
 * haciendo su trabajo (`isolating`): cinco códigos malos seguidos ya dan diez fallos seguidos.
 */
async function fetchBatch(
  ctx: StageContext,
  lang: TboContentLanguage,
  hotelIds: readonly string[],
  tally: Tally,
  isolating = false,
): Promise<Flow> {
  const maxAttempts = hotelIds.length > 1 ? BATCH_MAX_ATTEMPTS : SINGLE_MAX_ATTEMPTS;
  const result = await ctx.gate.call(
    (signal) => ctx.source.getHotelDetails(hotelIds, lang, { signal, maxAttempts }),
    { isolating },
  );

  if (result.ok) {
    const { contents, missingHotelCodes, diagnostics } = result.value;
    tally.contentsReceived += contents.length;
    tally.hotelsMissing += missingHotelCodes.length;
    for (const unknown of diagnostics.unknownKeys) {
      if (tally.unknownKeys.size < MAX_UNKNOWN_KEYS) tally.unknownKeys.add(unknown);
    }
    if (missingHotelCodes.length > 0) {
      ctx.logger.debug('tbo.sync.content_missing', {
        stage: 'E4',
        lang,
        requested: hotelIds.length,
        missing: missingHotelCodes,
      });
    }
    if (contents.length > 0) {
      const write = await ctx.store.writeHotelContents({
        contents,
        fetchedAt: new Date(ctx.now()),
      });
      tally.contentsWritten += write.inserted + write.rewritten;
      tally.contentsUnchanged += write.touched + write.unchanged;
    }
    return 'continue';
  }

  const { failure } = result;
  throwIfAccountFailure(failure, 'E4');
  if (failure.type === 'stopped') return 'stop';
  // Este fallo completó una racha (`429` o errores): la puerta ya cortó la corrida.
  if (ctx.gate.stopReason !== undefined) return 'stop';
  if (!isSplittableFailure(failure.code)) {
    tally.batchesDeferred += 1;
    return 'continue';
  }
  const [only] = hotelIds;
  if (hotelIds.length === 1 && only !== undefined) {
    tally.hotelsFailed += 1;
    ctx.logger.warn('tbo.sync.content_failed', {
      stage: 'E4',
      lang,
      hotel: only,
      code: failure.code,
      statusCode: failure.statusCode,
    });
    return 'continue';
  }

  tally.splits += 1;
  const middle = Math.ceil(hotelIds.length / 2);
  for (const half of [hotelIds.slice(0, middle), hotelIds.slice(middle)]) {
    if ((await fetchBatch(ctx, lang, half, tally, true)) === 'stop') return 'stop';
  }
  return 'continue';
}

/**
 * E4 — `POST HotelDetails` por lotes e idioma (p. 56-62; 05 §6.3 y §10; 09 PR-3.3) →
 * `hotel_content` con `source = 'details'`.
 *
 * - **Qué hoteles:** los activos de los países de la corrida que no tienen HotelDetails en un idioma
 *   o lo tienen de hace más de `TBO_SYNC_CONTENT_REFRESH_DAYS`; primero los de destinos con demanda
 *   (`selectContentTasks`). Con `TBO_SYNC_CONTENT_SCOPE=demand` (por defecto), sólo esos. Con
 *   `TBO_SYNC_CITIES`, sólo los de esas ciudades.
 * - **Idiomas:** ES, PT y EN para demanda y ES y PT para el resto (`TBO_SYNC_LANGS`,
 *   `TBO_SYNC_LANGS_REGULAR`). El inglés del resto es el `listing` de E3 y la lectura bajo demanda
 *   del API (PR-3.6), que no escribe estas tablas.
 * - **Lotes** de `TBO_SYNC_DETAILS_BATCH` (10), nunca más de 13 (Q-62), con partición ante fallo.
 * - **`content_hash`**: un contenido igual al guardado no se reescribe, sólo avanza `fetched_at`.
 * - **El HTML ya llega saneado** por el ACL con su lista blanca, y las imágenes sólo `https`
 *   (RF-32; RNF-16). El detalle por habitación sigue apagado: el builder no pide
 *   `IsRoomDetailRequired` y nada escribe `hotel_room_content` (N10; Q-65).
 *
 * Corre después de E3 con lo que quede del presupuesto: sin el hotel en `hotel_inventory` no hay
 * contenido que mostrar. Lo que no alcanza queda pendiente para la próxima corrida, que lo vuelve a
 * encontrar porque sigue sin contenido.
 */
export async function runHotelContentStage(
  ctx: StageContext,
  countries: readonly string[],
): Promise<E4Result> {
  const { content, cadence } = ctx.settings;
  if (!ctx.settings.stages.has('E4') || countries.length === 0) return skipped(content.scope);
  // Una corrida que ya se cortó en E3 no gasta una consulta: la puerta no dejaría pedir nada.
  if (ctx.gate.stopReason !== undefined) return skipped(content.scope);

  const now = ctx.now();
  const { cities } = ctx.settings;
  const candidates = await ctx.store.listContentCandidates({
    countries,
    ...(cities === undefined ? {} : { cities }),
    demandSince: new Date(now - cadence.demandWindowMs),
    onlyDemand: content.scope === 'demand',
  });
  const tasks = selectContentTasks(candidates, { ...content, now });
  const batches = planContentBatches(tasks, content.batchSize);

  const tally: Tally = {
    batchesAttempted: 0,
    contentsReceived: 0,
    contentsWritten: 0,
    contentsUnchanged: 0,
    hotelsMissing: 0,
    hotelsFailed: 0,
    splits: 0,
    batchesDeferred: 0,
    unknownKeys: new Set(),
  };
  for (const batch of batches) {
    if (ctx.gate.stopReason !== undefined) break;
    const callsBefore = ctx.gate.counters().calls;
    const flow = await fetchBatch(ctx, batch.lang, batch.hotelIds, tally);
    // Un lote que la puerta ya no dejó salir (presupuesto agotado justo antes) no cuenta.
    if (ctx.gate.counters().calls > callsBefore) tally.batchesAttempted += 1;
    if (flow === 'stop') break;
  }

  const { unknownKeys, ...counters } = tally;
  const summary: E4Result = {
    status: 'done',
    scope: content.scope,
    hotelsDue: new Set(tasks.map((task) => task.hotelId)).size,
    tasksDue: tasks.length,
    batchesPlanned: batches.length,
    ...counters,
    unknownKeys: [...unknownKeys],
  };
  if (unknownKeys.size > 0) {
    ctx.logger.warn('tbo.sync.unknown_keys', { stage: 'E4', unknownKeys: summary.unknownKeys });
  }
  ctx.logger.info('tbo.sync.stage', { stage: 'E4', ...summary });
  return summary;
}
