import type { HotelOffer, HotelProviderOutcome, HotelSearchResult } from '../actions';
import { degradedProviders, type EmptyResultsView } from './hotel-provider-view';

/*
 * La carga por tramos de los resultados de hoteles, sin React (pedido del founder del 2026-09-30:
 * "no veo más páginas para seguir"; docs/tbo/02 §4.4).
 *
 * Dos cosas distintas, a propósito:
 *
 * - "Ver más hoteles" le pide al API el TRAMO siguiente del catálogo del destino: otra consulta al
 *   proveedor, que cuenta en la cuota de la agencia. Sólo lo pide el vendedor, con un botón: una
 *   carga automática al llegar al final encadenaría consultas con un filtro que deja pocos hoteles
 *   a la vista (la lista nunca se alarga y el final siempre está a la vista).
 * - "Mostrar 20 más" muestra más de lo que YA llegó, sin preguntarle nada a nadie: con cientos de
 *   hoteles cargados, la lista se pinta de a 20 y crece hacia abajo, sin perder la posición.
 *
 * Nada de esto va a la URL: la búsqueda misma no viaja por la URL (la nacionalidad es un dato del
 * pasajero) y al recargar la pantalla no hay resultados que retomar.
 */

/** De a cuántos hoteles se pinta la lista. */
export const RESULTS_PAGE_SIZE = 20;

/** Espejo de `HotelSearchPaging` del API. */
export interface HotelSearchPaging {
  /** Con qué pedir el tramo siguiente. Ausente si no queda ninguno. */
  readonly sessionId?: string;
  /** El tramo que trajo esta respuesta, base 0. */
  readonly page: number;
  /** Hoteles del catálogo del destino ya consultados. */
  readonly consulted: number;
  /** Hoteles del catálogo del destino. */
  readonly total: number;
  readonly hasMore: boolean;
  /** Cuántos consulta el tramo siguiente. */
  readonly nextBatch?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * `paging` tal como llega del API, o `undefined` si no viene o no se entiende. Un `sessionId` que
 * no es un UUID no se usa: sin él no se ofrece seguir, que es el lado seguro.
 */
export function parseSearchPaging(raw: unknown): HotelSearchPaging | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const page = count(r['page']);
  const consulted = count(r['consulted']);
  const total = count(r['total']);
  if (page === undefined || consulted === undefined || total === undefined) return undefined;
  const sessionId =
    typeof r['sessionId'] === 'string' && UUID_RE.test(r['sessionId']) ? r['sessionId'] : undefined;
  const nextBatch = count(r['nextBatch']);
  const hasMore = r['hasMore'] === true && sessionId !== undefined;
  return {
    page,
    consulted,
    total: Math.max(total, consulted),
    hasMore,
    ...(hasMore ? { sessionId } : {}),
    ...(hasMore && nextBatch !== undefined && nextBatch > 0 ? { nextBatch } : {}),
  };
}

/** Lo que devuelve la acción del tramo siguiente. */
export interface MoreHotelsResult {
  readonly ok: boolean;
  readonly hotels: HotelOffer[];
  readonly providers: HotelProviderOutcome[];
  /** Con `ok`, lo que dejó este tramo; con `not-next`, cuánto se consultó de verdad. */
  readonly paging?: HotelSearchPaging;
  readonly error?: string;
  /**
   * Por qué no llegó, cuando el API lo dice: la búsqueda venció, ese tramo no era el siguiente
   * (`nextPage` dice cuál sigue) o ya no queda ninguno.
   */
  readonly reason?: 'expired' | 'not-next' | 'exhausted';
  readonly nextPage?: number;
}

/** El motivo máquina del API → lo que la pantalla hace con él. */
export function moreFailureReason(apiReason: string | undefined): MoreHotelsResult['reason'] {
  switch (apiReason) {
    case 'SEARCH_PAGING_EXPIRED':
      return 'expired';
    case 'SEARCH_PAGE_NOT_NEXT':
      return 'not-next';
    case 'SEARCH_PAGING_EXHAUSTED':
      return 'exhausted';
    default:
      return undefined;
  }
}

// ───────────────────────── El estado de los tramos ─────────────────────────

export type MoreStatus = 'idle' | 'loading' | 'error' | 'expired';

/** Lo que dejó el último tramo y el vendedor tiene que saber. */
export interface MoreNotice {
  readonly tone: 'info' | 'warning';
  readonly text: string;
}

export interface MoreState {
  /** La búsqueda de la que son estos tramos: una nueva empieza de cero. */
  readonly forSearch: HotelSearchResult;
  /** Los hoteles de los tramos siguientes al primero, en el orden en que llegaron. */
  readonly hotels: readonly HotelOffer[];
  readonly paging?: HotelSearchPaging;
  /** Hoteles consultados en cada tramo cargado, para el medidor. */
  readonly segments: readonly number[];
  /** El tramo que se pide con "Ver más hoteles". */
  readonly nextPage: number;
  /** Tramos siguientes que llegaron: la lista crece y el foco sigue donde estaba el vendedor. */
  readonly arrived: number;
  readonly status: MoreStatus;
  readonly error?: string;
  readonly notice?: MoreNotice;
  /** Lo que oye un lector de pantalla del último cambio. */
  readonly announcement: string;
}

export function moreStateFor(search: HotelSearchResult): MoreState {
  const paging = search.paging;
  return {
    forSearch: search,
    hotels: [],
    ...(paging === undefined ? {} : { paging }),
    segments: paging !== undefined && paging.consulted > 0 ? [paging.consulted] : [],
    nextPage: (paging?.page ?? 0) + 1,
    arrived: 0,
    status: 'idle',
    announcement: '',
  };
}

/** Se puede pedir el tramo siguiente ahora. */
export function canLoadMore(state: MoreState): boolean {
  return (
    state.paging?.hasMore === true &&
    state.paging.sessionId !== undefined &&
    state.status !== 'loading' &&
    state.status !== 'expired'
  );
}

const NUMBER = new Intl.NumberFormat('es-CO');

export function formatCount(n: number): string {
  return NUMBER.format(n);
}

function nHotels(n: number): string {
  return `${formatCount(n)} hotel${n === 1 ? '' : 'es'}`;
}

export function moreLoading(state: MoreState): MoreState {
  const next = state.paging?.nextBatch;
  const { error: _e, notice: _n, ...rest } = state;
  return {
    ...rest,
    status: 'loading',
    announcement:
      next === undefined
        ? 'Buscando más hoteles.'
        : `Buscando los siguientes ${nHotels(next)} del destino.`,
  };
}

/** Por qué parte del tramo no llegó, dicho corto y con el código del proveedor. */
function degradedNotice(providers: readonly HotelProviderOutcome[]): MoreNotice | undefined {
  const degraded = degradedProviders(providers);
  if (degraded.length === 0) return undefined;
  const detail = degraded.map((p) => (p.reason ? `${p.code}: ${p.reason}` : p.code)).join(' · ');
  return {
    tone: 'warning',
    text: `Parte de este tramo no se pudo consultar. ${detail}`,
  };
}

const ENDED = 'Ya no quedan hoteles por consultar.';

/**
 * Lo que dejó la respuesta del tramo siguiente, bien o mal.
 *
 * El anuncio de un tramo que llega a una lista que YA estaba a la vista lo hace la lista
 * (`HotelResults`, con {@link arrivalAnnouncement}): sólo ella sabe cuántos cumplen los filtros y
 * dónde quedaron con el orden elegido. Aquí queda vacío para no decirlo dos veces. Si antes no había
 * hoteles (el estado vacío), la lista recién aparece y el anuncio sale de aquí.
 */
export function moreArrived(state: MoreState, res: MoreHotelsResult): MoreState {
  const { error: _e, notice: _n, ...rest } = state;
  if (!res.ok) return moreFailed(rest, res);

  const paging = res.paging ?? state.paging;
  const before = state.paging?.consulted ?? 0;
  const asked = paging === undefined ? 0 : Math.max(0, paging.consulted - before);
  const added = res.hotels.length;
  const notice: MoreNotice | undefined =
    degradedNotice(res.providers) ??
    (added === 0 && asked > 0
      ? {
          tone: 'info',
          text: `Los siguientes ${nHotels(asked)} no tienen disponibilidad para estas fechas.`,
        }
      : undefined);
  const listShown = state.forSearch.hotels.length + state.hotels.length > 0;

  return {
    ...rest,
    hotels: added > 0 ? [...state.hotels, ...res.hotels] : state.hotels,
    ...(paging === undefined ? {} : { paging }),
    segments: asked > 0 ? [...state.segments, asked] : state.segments,
    nextPage: paging === undefined ? state.nextPage + 1 : paging.page + 1,
    arrived: state.arrived + 1,
    status: 'idle',
    ...(notice === undefined ? {} : { notice }),
    announcement: listShown
      ? ''
      : arrivalAnnouncement({
          added,
          matching: added,
          ...(notice === undefined ? {} : { notice }),
          ended: paging !== undefined && !paging.hasMore,
        }),
  };
}

/**
 * Lo que oye un lector de pantalla cuando llega un tramo, contado sobre lo que el vendedor ve: los
 * que cumplen sus filtros y, si con el orden elegido no quedaron al final, dónde quedó el primero.
 */
export function arrivalAnnouncement({
  added,
  matching,
  firstNewAt,
  sortLabel,
  notice,
  ended,
}: {
  /** Hoteles que trajo el tramo. */
  added: number;
  /** Cuántos de ellos cumplen los filtros. */
  matching: number;
  /** Puesto (base 0) del primero, si quedó entre los que ya se veían y no al final. */
  firstNewAt?: number;
  /** El orden elegido, si no es el de llegada. */
  sortLabel?: string;
  notice?: MoreNotice;
  ended: boolean;
}): string {
  const parts: string[] = [];
  if (added === 0) {
    parts.push(notice?.text ?? 'No llegaron hoteles nuevos.');
  } else {
    const arrived = `Llegaron ${nHotels(added)} más`;
    parts.push(
      matching >= added
        ? `${arrived}.`
        : matching === 0
          ? `${arrived}; ninguno cumple tus filtros.`
          : `${arrived}; ${formatCount(matching)} ${matching === 1 ? 'cumple' : 'cumplen'} tus filtros.`,
    );
    if (matching > 0 && firstNewAt !== undefined && sortLabel !== undefined) {
      parts.push(
        `Con el orden «${sortLabel}», el primero quedó en el puesto ${formatCount(firstNewAt + 1)}.`,
      );
    }
    if (notice?.tone === 'warning') parts.push(notice.text);
  }
  if (ended) parts.push(ENDED);
  return parts.join(' ');
}

/** Dónde quedó un tramo en la lista ya filtrada y ordenada, y cuánto se pinta ahora. */
export interface ArrivalPlacement {
  /** Tarjetas que se pintan: ninguna de las que ya se veían se esconde. */
  readonly visible: number;
  /** Hoteles nuevos que cumplen los filtros. */
  readonly matching: number;
  /** Puesto (base 0) del primer hotel nuevo en el orden actual. */
  readonly firstNew?: number;
  /** El primero nuevo quedó entre los que ya se veían (otro orden que el de llegada). */
  readonly interleaved: boolean;
}

/**
 * Un tramo que llega se reparte en la lista según el orden elegido: con "Recomendados" va al final,
 * con "Menor precio" puede quedar arriba de todo. `indexes` es el índice de llegada de cada tarjeta
 * en el orden en que se ve (ya filtrada); los nuevos son los de índice `>= totalBefore`. Se siguen
 * pintando todas las que ya se veían —con los nuevos que cayeron entre ellas— y, como con
 * "Mostrar 20 más", hasta 20 nuevos más.
 */
export function placeArrival(
  indexes: readonly number[],
  totalBefore: number,
  visibleBefore: number,
): ArrivalPlacement {
  let oldSeen = 0;
  let lastOld = -1;
  let matching = 0;
  let firstNew: number | undefined;
  for (const [position, index] of indexes.entries()) {
    if (index >= totalBefore) {
      matching += 1;
      firstNew ??= position;
    } else if (oldSeen < visibleBefore) {
      oldSeen += 1;
      lastOld = position;
    }
  }
  const withNew = Math.min(indexes.length, visibleBefore + Math.min(matching, RESULTS_PAGE_SIZE));
  return {
    visible: Math.max(lastOld + 1, withNew),
    matching,
    ...(firstNew === undefined ? {} : { firstNew }),
    interleaved: firstNew !== undefined && firstNew < lastOld,
  };
}

function moreFailed(state: Omit<MoreState, 'error' | 'notice'>, res: MoreHotelsResult): MoreState {
  const message = res.error ?? 'No pudimos traer más hoteles. Intenta de nuevo.';
  // Los errores se muestran en el pie con `role="alert"`, que ya los anuncia: la región de la
  // página queda vacía para no decirlos dos veces.
  switch (res.reason) {
    case 'expired':
      return { ...state, status: 'expired', error: message, announcement: '' };
    case 'exhausted': {
      const paging = state.paging;
      return {
        ...state,
        ...(paging === undefined
          ? {}
          : {
              paging: {
                page: paging.page,
                consulted: paging.consulted,
                total: paging.total,
                hasMore: false,
              },
            }),
        status: 'idle',
        announcement: ENDED,
      };
    }
    case 'not-next': {
      // El servidor ya consultó ese tramo pero la respuesta no llegó y ya no se puede repetir
      // (pasó el rato en que se repite igual). La pantalla se pone al día con lo que dice el API
      // —cuánto se consultó y cuál sigue— y ofrece seguir, no "Reintentar": reintentar ese tramo
      // ya no es posible en esta búsqueda.
      const paging = res.paging ?? state.paging;
      const before = state.paging?.consulted ?? 0;
      const lost = paging === undefined ? 0 : Math.max(0, paging.consulted - before);
      const text =
        lost > 0
          ? `No nos llegó la respuesta de los ${nHotels(lost)} que ya consultamos. Para verlos, vuelve a buscar.`
          : message;
      return {
        ...state,
        ...(paging === undefined ? {} : { paging }),
        segments: lost > 0 ? [...state.segments, lost] : state.segments,
        nextPage: res.nextPage ?? (paging === undefined ? state.nextPage : paging.page + 1),
        status: 'idle',
        notice: { tone: 'warning', text },
        announcement: text,
      };
    }
    default:
      return { ...state, status: 'error', error: message, announcement: '' };
  }
}

// ───────────────────────── Lo que dice la pantalla ─────────────────────────

/** El destino en la línea de cobertura: la ciudad, sin el país ("Cartagena de Indias"). */
export function destinationShortLabel(label: string | undefined): string | undefined {
  const city = label?.split(',')[0]?.trim();
  return city === undefined || city === '' ? undefined : city;
}

export interface CoverageView {
  /** "Consultamos 100 de 420 hoteles de Cartagena de Indias." */
  readonly line: string;
  /** Qué sigue, o por qué no sigue. */
  readonly detail: string;
  /** Ya se consultó todo el catálogo del destino. */
  readonly complete: boolean;
}

/**
 * Cuánto del destino se consultó. "De" y no "en": son los hoteles del catálogo de los proveedores
 * para ese destino, con disponibilidad o sin ella.
 */
export function coverageView(
  paging: HotelSearchPaging,
  destinationLabel: string | undefined,
  { allVisible = true }: { allVisible?: boolean } = {},
): CoverageView {
  const where = destinationShortLabel(destinationLabel);
  const of = where === undefined ? 'del destino' : `de ${where}`;
  const { consulted, total } = paging;

  if (paging.hasMore) {
    const next = paging.nextBatch;
    const siguientes =
      next === undefined ? 'los siguientes' : `los siguientes ${formatCount(next)}`;
    return {
      line:
        consulted === 0
          ? `Todavía no pudimos consultar los ${nHotels(total)} ${of}.`
          : `Consultamos ${formatCount(consulted)} de ${nHotels(total)} ${of}.`,
      detail: allVisible
        ? `"Ver más hoteles" consulta ${siguientes}: es otra búsqueda en los proveedores.`
        : `Cuando termines de ver los que ya llegaron, puedes consultar ${siguientes}.`,
      complete: false,
    };
  }
  if (consulted >= total) {
    return {
      line:
        total === 1
          ? `Consultamos el único hotel ${of}.`
          : `Consultamos los ${nHotels(total)} ${of}.`,
      detail: 'No quedan más hoteles por consultar en este destino.',
      complete: true,
    };
  }
  return {
    line: `Consultamos ${formatCount(consulted)} de ${nHotels(total)} ${of}.`,
    detail: 'No se pueden consultar más en esta búsqueda.',
    complete: false,
  };
}

/** Un tramo del medidor, en % del catálogo del destino. */
export interface CoverageSegment {
  readonly kind: 'consulted' | 'next' | 'rest';
  readonly percent: number;
}

/**
 * El medidor de cobertura: un segmento por tramo consultado, el siguiente punteado y lo que queda.
 * Con muchos tramos, los consultados se juntan en uno: más de 12 rayitas no se distinguen.
 */
export function coverageSegments(
  segments: readonly number[],
  paging: HotelSearchPaging,
): CoverageSegment[] {
  const total = Math.max(paging.total, paging.consulted);
  if (total <= 0) return [];
  const pct = (n: number) => (n / total) * 100;
  const consulted: CoverageSegment[] =
    segments.length > 12 || segments.reduce((a, b) => a + b, 0) !== paging.consulted
      ? paging.consulted > 0
        ? [{ kind: 'consulted', percent: pct(paging.consulted) }]
        : []
      : segments.map((n) => ({ kind: 'consulted' as const, percent: pct(n) }));
  const next = paging.hasMore ? Math.min(paging.nextBatch ?? 0, total - paging.consulted) : 0;
  const rest = total - paging.consulted - next;
  return [
    ...consulted,
    ...(next > 0 ? [{ kind: 'next' as const, percent: pct(next) }] : []),
    ...(rest > 0 ? [{ kind: 'rest' as const, percent: pct(rest) }] : []),
  ];
}

/** El pie de la lista cuando todavía hay hoteles cargados sin mostrar. */
export function revealView(
  visible: number,
  shown: number,
): { label: string; progress: string } | undefined {
  if (visible >= shown) return undefined;
  const next = Math.min(RESULTS_PAGE_SIZE, shown - visible);
  return {
    label: `Mostrar ${formatCount(next)} más`,
    progress: `Viendo ${formatCount(visible)} de ${nHotels(shown)}`,
  };
}

/**
 * La lista vacía cuando el primer tramo no trajo hoteles pero quedan por consultar: "no hay
 * disponibilidad" sería mentira, sólo la no hay en los que se consultaron.
 */
export function emptyWithMoreView(
  paging: HotelSearchPaging,
  destinationLabel: string | undefined,
): EmptyResultsView {
  const where = destinationShortLabel(destinationLabel);
  const of = where === undefined ? 'del destino' : `de ${where}`;
  const left = paging.total - paging.consulted;
  return {
    title:
      paging.consulted === 1
        ? `El hotel que consultamos ${of} no tiene disponibilidad para estas fechas.`
        : `Los ${nHotels(paging.consulted)} que consultamos ${of} no tienen disponibilidad para estas fechas.`,
    hint: `Quedan ${nHotels(left)} por consultar: con "Ver más hoteles" buscamos en los siguientes.`,
  };
}
