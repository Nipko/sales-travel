import {
  TBO_CONTENT_FALLBACK_LANG,
  TBO_DETAILS_ISOLATION_DEFAULTS,
  resolveTboHotelDetails,
  type TboContentLanguage,
  type TboDetailsFetch,
  type TboDetailsResolution,
  type TboFallbackKnowledge,
} from '@sales-travel/tbo-hotels';
import type { CallFailure } from '../call-gate.js';
import {
  isSplittableFailure,
  planContentBatches,
  selectContentTasks,
  type ContentCandidate,
} from '../content-rules.js';
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
  /** Contenidos que HotelDetails devolvió y el ACL entendió, del idioma pedido y del respaldo. */
  readonly contentsReceived: number;
  /** Filas `details` insertadas o reescritas. */
  readonly contentsWritten: number;
  /** Iguales a lo guardado (`content_hash`): sólo avanzó `fetched_at`. */
  readonly contentsUnchanged: number;
  /** Pedidos que no volvieron en el idioma pedido (con "No Hotels Found" o fuera de un 200). */
  readonly hotelsMissing: number;
  /** De ésos, los que sí tienen contenido en el respaldo en inglés (traído ahora o en la corrida). */
  readonly hotelsFromFallback: number;
  /** TBO confirmó que no tienen contenido, ni en el idioma pedido ni en inglés (05 CE-23). */
  readonly hotelsWithoutContent: number;
  /**
   * TBO respondió sin su contenido pero no confirmó los dos idiomas: el pedido sólo llegó en un lote
   * "No Hotels Found" que no descarta H2, o faltó en una respuesta con elementos descartados.
   */
  readonly hotelsUnconfirmed: number;
  /**
   * Códigos que, solos, dejan vacío un lote (H2 observada, 05 CE-23): no van en los lotes de los
   * otros idiomas de la corrida, así sus compañeros reciben su contenido en una llamada.
   */
  readonly batchBreakers: number;
  /** Quedaron sin respuesta: tope de aislamiento o una llamada extra que falló. La próxima corrida. */
  readonly hotelsUnresolved: number;
  /** Códigos aislados a uno que siguieron fallando: se marcan en el log y se sigue. */
  readonly hotelsFailed: number;
  /** Veces que un lote fallido se partió en dos. */
  readonly splits: number;
  /** Lotes que no se partieron (`429`, limitador) y quedan para la próxima corrida. */
  readonly batchesDeferred: number;
  /** Llamadas en inglés por lo que faltó en el idioma pedido. */
  readonly fallbackCalls: number;
  /** Llamadas que partieron un lote vacío entero para encontrar lo que sí tiene contenido. */
  readonly isolationCalls: number;
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
    hotelsFromFallback: 0,
    hotelsWithoutContent: 0,
    hotelsUnconfirmed: 0,
    batchBreakers: 0,
    hotelsUnresolved: 0,
    hotelsFailed: 0,
    splits: 0,
    batchesDeferred: 0,
    fallbackCalls: 0,
    isolationCalls: 0,
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

/**
 * Parte del presupuesto de llamadas de la corrida que puede irse en aislar lotes sin contenido
 * (05 CE-23). Sin este techo, una racha de lotes con códigos sin contenido se comería el
 * presupuesto de todo lo demás: esos hoteles quedan primeros en cada corrida, porque nunca tienen
 * HotelDetails.
 */
export const E4_ISOLATION_BUDGET_SHARE = 0.2;

interface Tally {
  batchesAttempted: number;
  contentsReceived: number;
  contentsWritten: number;
  contentsUnchanged: number;
  hotelsMissing: number;
  hotelsFromFallback: number;
  hotelsWithoutContent: number;
  hotelsUnconfirmed: number;
  hotelsUnresolved: number;
  hotelsFailed: number;
  splits: number;
  batchesDeferred: number;
  fallbackCalls: number;
  isolationCalls: number;
  readonly unknownKeys: Set<string>;
  /**
   * Lo que esta corrida ya sabe del inglés de cada hotel: traído (`content`) o confirmado sin
   * contenido (`none`). Un hotel que el lote en español resolvió en inglés no se vuelve a pedir en
   * inglés, ni como respaldo del portugués ni en su propio lote. Arranca con el inglés que ya está
   * guardado y vigente: sin eso, cada corrida volvería a pedir en inglés el respaldo de todos los
   * hoteles sin español (H1), aunque su fila `en` sea de ayer.
   */
  readonly fallback: Map<string, TboFallbackKnowledge>;
  /**
   * Los que, solos, dejan vacío un lote (H2 observada): no van en los lotes de los otros idiomas de
   * la corrida, así sus compañeros reciben su contenido en una llamada y no en dos.
   */
  readonly breakers: Set<string>;
  /** Llamadas de aislamiento que le quedan a la corrida. */
  isolationLeft: number;
}

type Flow = 'continue' | 'stop';

/**
 * Pide un lote hasta su respuesta final con `resolveTboHotelDetails` del ACL (05 CE-23): el idioma
 * pedido, el respaldo en inglés de lo que faltó, y un lote vacío entero partido para encontrar lo
 * que sí tiene contenido. Cada llamada pasa por la puerta de la corrida, así que cuenta en el
 * presupuesto como cualquier otra; las de respaldo y aislamiento van como `isolating`: un rechazo de
 * TBO por su contenido no alarga la racha de errores. Un "No Hotels Found" no es un fallo: ni cuenta
 * en la racha ni en `errorsByCode`.
 *
 * Si la llamada PRINCIPAL falla por algo del lote (400, 500, timeout, cuerpo ilegible), el lote se
 * parte en dos mitades y se pide cada una, hasta aislar el código que lo tumba (05 §10; Q-62). Ese
 * código se marca y se sigue; sus compañeros de lote reciben su contenido igual.
 *
 * En la racha de errores de la puerta, el lote entero cuenta siempre; sus mitades sólo cuando el
 * fallo parece un TBO caído (500, timeout, transporte), que es cuando partir multiplicaría llamadas
 * en vano. Si TBO rechazó el request por su contenido (un 400 o un 201 en el sobre), las mitades son
 * la partición haciendo su trabajo (`isolating`): cinco códigos malos seguidos ya dan diez fallos.
 */
async function fetchBatch(
  ctx: StageContext,
  lang: TboContentLanguage,
  hotelIds: readonly string[],
  tally: Tally,
  isolating = false,
): Promise<Flow> {
  // Lo que la corrida ya resolvió en inglés no se vuelve a pedir en inglés, y lo que ya se vio
  // tumbar un lote no va en otro: sus compañeros perderían su contenido. Queda pendiente para la
  // próxima corrida, que lo vuelve a encontrar porque sigue sin contenido.
  const ids =
    lang === TBO_CONTENT_FALLBACK_LANG
      ? hotelIds.filter((id) => !tally.fallback.has(id))
      : hotelIds.filter((id) => !tally.breakers.has(id));
  if (ids.length === 0) return 'continue';

  const fetch: TboDetailsFetch<CallFailure> = async (codes, callLang, purpose) => {
    const maxAttempts = codes.length > 1 ? BATCH_MAX_ATTEMPTS : SINGLE_MAX_ATTEMPTS;
    const result = await ctx.gate.call(
      (signal) => ctx.source.getHotelDetails(codes, callLang, { signal, maxAttempts }),
      { isolating: isolating || purpose !== 'primary' },
    );
    if (result.ok) return { ok: true, result: result.value };
    throwIfAccountFailure(result.failure, 'E4');
    return { ok: false, failure: result.failure };
  };
  const resolution = await resolveTboHotelDetails(ids, lang, fetch, {
    maxIsolationCalls: TBO_DETAILS_ISOLATION_DEFAULTS.maxCallsPerBatch,
    allowIsolationCall: () => {
      if (tally.isolationLeft <= 0) return false;
      tally.isolationLeft -= 1;
      return true;
    },
    fallbackKnown: (code) => tally.fallback.get(code),
  });

  if (resolution.primaryFailure !== undefined) {
    return splitFailedBatch(ctx, lang, ids, tally, resolution.primaryFailure);
  }

  tally.fallbackCalls += resolution.calls.fallback;
  tally.isolationCalls += resolution.calls.isolation;
  tally.contentsReceived += resolution.contents.length;
  tally.hotelsMissing += ids.length - resolution.foundInLang.length;
  tally.hotelsFromFallback += resolution.foundInFallback.length;
  tally.hotelsWithoutContent += resolution.withoutContent.length;
  tally.hotelsUnconfirmed += resolution.unconfirmed.length;
  tally.hotelsUnresolved += resolution.unresolved.length;
  for (const unknown of resolution.unknownKeys) {
    if (tally.unknownKeys.size < MAX_UNKNOWN_KEYS) tally.unknownKeys.add(unknown);
  }
  for (const content of resolution.contents) {
    if (content.lang === TBO_CONTENT_FALLBACK_LANG) tally.fallback.set(content.hotelId, 'content');
  }
  for (const id of resolution.withoutFallback) tally.fallback.set(id, 'none');
  for (const id of resolution.batchBreakers) tally.breakers.add(id);

  logBatch(ctx, lang, ids.length, resolution);
  if (resolution.contents.length > 0) {
    const write = await ctx.store.writeHotelContents({
      contents: resolution.contents,
      fetchedAt: new Date(ctx.now()),
    });
    tally.contentsWritten += write.inserted + write.rewritten;
    tally.contentsUnchanged += write.touched + write.unchanged;
  }

  // Una llamada extra que la puerta cortó (presupuesto, `429`, SIGTERM) corta también la etapa.
  const stopped = resolution.extraFailures.some((failure) => failure.type === 'stopped');
  return stopped || ctx.gate.stopReason !== undefined ? 'stop' : 'continue';
}

/** El lote cuya llamada principal falló: se parte hasta aislar el código que lo tumba (05 §10). */
async function splitFailedBatch(
  ctx: StageContext,
  lang: TboContentLanguage,
  hotelIds: readonly string[],
  tally: Tally,
  failure: CallFailure,
): Promise<Flow> {
  if (failure.type === 'stopped') return 'stop';
  // Este fallo completó una racha (`429` o errores): la puerta ya cortó la corrida.
  if (ctx.gate.stopReason !== undefined) return 'stop';
  if (failure.type !== 'failed' || !isSplittableFailure(failure.code)) {
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
 * La línea de diagnóstico de un lote: `info` si algo no vino en el idioma pedido en la primera
 * llamada (respaldo, aislamiento, sin contenido, sin resolver), `debug` si vino todo. Sólo conteos;
 * los códigos sin contenido, que son de catálogo y no de nadie, sólo en `debug`. Con
 * `batchBreakers` mayor que 0 se observó H2; con respaldo y sin ellos, lo que faltó en el idioma
 * pedido es H1 (05 CE-23).
 */
function logBatch(
  ctx: StageContext,
  lang: TboContentLanguage,
  requested: number,
  resolution: TboDetailsResolution<CallFailure>,
): void {
  const found: Partial<Record<TboContentLanguage, number>> = {};
  const seen = new Set<string>();
  for (const content of resolution.contents) {
    const key = `${content.hotelId} ${content.lang}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found[content.lang] = (found[content.lang] ?? 0) + 1;
  }
  const complete = resolution.foundInLang.length === requested;
  const meta = {
    stage: 'E4',
    lang,
    requested,
    found,
    withoutContent: resolution.withoutContent.length,
    unconfirmed: resolution.unconfirmed.length,
    unresolved: resolution.unresolved.length,
    batchBreakers: resolution.batchBreakers.length,
    fallbackUsed: resolution.calls.fallback > 0,
    fallbackCalls: resolution.calls.fallback,
    isolationCalls: resolution.calls.isolation,
    ...(resolution.isolationLimited ? { isolationLimited: true } : {}),
    ...(resolution.untrustedResponses > 0
      ? { untrustedResponses: resolution.untrustedResponses }
      : {}),
  };
  if (complete) {
    ctx.logger.debug('tbo.sync.content_batch', meta);
    return;
  }
  ctx.logger.info('tbo.sync.content_batch', meta);
  const listed =
    resolution.withoutContent.length + resolution.unconfirmed.length + resolution.unresolved.length;
  if (listed > 0) {
    ctx.logger.debug('tbo.sync.content_missing', {
      stage: 'E4',
      lang,
      withoutContent: resolution.withoutContent,
      unconfirmed: resolution.unconfirmed,
      unresolved: resolution.unresolved,
      batchBreakers: resolution.batchBreakers,
    });
  }
}

/**
 * El inglés que la corrida ya tiene guardado y vigente: no se vuelve a pedir como respaldo. Es el
 * mismo plazo con que `selectContentTasks` decide que el inglés no toca.
 */
function freshFallback(
  candidates: readonly ContentCandidate[],
  now: number,
  maxAgeMs: number,
): Map<string, TboFallbackKnowledge> {
  const known = new Map<string, TboFallbackKnowledge>();
  for (const candidate of candidates) {
    const fetchedAt = candidate.detailsFetchedAt[TBO_CONTENT_FALLBACK_LANG];
    if (fetchedAt !== undefined && now - fetchedAt.getTime() < maxAgeMs) {
      known.set(candidate.hotelId, 'content');
    }
  }
  return known;
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
 *   `TBO_SYNC_LANGS_REGULAR`). Lo que no viene en el idioma pedido se pide en inglés y se guarda
 *   como `en` (05 CE-23): es el respaldo que muestran la ficha y las fotos. El inglés guardado y
 *   vigente no se vuelve a pedir como respaldo.
 * - **Lotes** de `TBO_SYNC_DETAILS_BATCH` (10), nunca más de 13 (Q-62), con partición ante fallo y
 *   aislamiento de un lote vacío entero, éste con techo por lote y por corrida
 *   ({@link E4_ISOLATION_BUDGET_SHARE}). Un código que se vio tumbar un lote no va en los lotes de
 *   los otros idiomas de la corrida.
 * - **`content_hash`**: un contenido igual al guardado no se reescribe, sólo avanza `fetched_at`.
 * - **El HTML ya llega saneado** por el ACL con su lista blanca, y las imágenes sólo `https`
 *   (RF-32; RNF-16). El detalle por habitación sigue apagado: el builder no pide
 *   `IsRoomDetailRequired` y nada escribe `hotel_room_content` (N10; Q-65).
 *
 * Corre después de E3 con lo que quede del presupuesto: sin el hotel en `hotel_inventory` no hay
 * contenido que mostrar. Lo que no alcanza queda pendiente para la próxima corrida, que lo vuelve a
 * encontrar porque sigue sin contenido. También lo que TBO no tiene en un idioma: nada guarda "sin
 * contenido" entre corridas, así que un hotel que sólo tiene inglés se vuelve a pedir en español y
 * en portugués en cada corrida (una llamada por lote de 10 y por idioma, ya sin respaldo).
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
    hotelsFromFallback: 0,
    hotelsWithoutContent: 0,
    hotelsUnconfirmed: 0,
    hotelsUnresolved: 0,
    hotelsFailed: 0,
    splits: 0,
    batchesDeferred: 0,
    fallbackCalls: 0,
    isolationCalls: 0,
    unknownKeys: new Set(),
    fallback: freshFallback(candidates, now, content.maxAgeMs),
    breakers: new Set(),
    isolationLeft: Math.floor(ctx.settings.maxCalls * E4_ISOLATION_BUDGET_SHARE),
  };
  for (const batch of batches) {
    if (ctx.gate.stopReason !== undefined) break;
    const callsBefore = ctx.gate.counters().calls;
    const flow = await fetchBatch(ctx, batch.lang, batch.hotelIds, tally);
    // Un lote que la puerta ya no dejó salir (presupuesto agotado justo antes) no cuenta.
    if (ctx.gate.counters().calls > callsBefore) tally.batchesAttempted += 1;
    if (flow === 'stop') break;
  }

  const { unknownKeys, fallback: _fallback, breakers, isolationLeft: _left, ...counters } = tally;
  const summary: E4Result = {
    status: 'done',
    scope: content.scope,
    hotelsDue: new Set(tasks.map((task) => task.hotelId)).size,
    tasksDue: tasks.length,
    batchesPlanned: batches.length,
    ...counters,
    batchBreakers: breakers.size,
    unknownKeys: [...unknownKeys],
  };
  if (unknownKeys.size > 0) {
    ctx.logger.warn('tbo.sync.unknown_keys', { stage: 'E4', unknownKeys: summary.unknownKeys });
  }
  ctx.logger.info('tbo.sync.stage', { stage: 'E4', ...summary });
  return summary;
}
