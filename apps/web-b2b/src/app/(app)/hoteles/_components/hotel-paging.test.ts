import { describe, expect, it } from 'vitest';
import type { HotelOffer, HotelSearchResult } from '../actions';
import {
  RESULTS_PAGE_SIZE,
  arrivalAnnouncement,
  canLoadMore,
  coverageSegments,
  coverageView,
  destinationShortLabel,
  emptyWithMoreView,
  moreArrived,
  moreFailureReason,
  moreLoading,
  moreStateFor,
  parseSearchPaging,
  placeArrival,
  revealView,
  type HotelSearchPaging,
  type MoreHotelsResult,
} from './hotel-paging';

/*
 * La carga por tramos de los resultados de hoteles, sin React (docs/tbo/02 §4.4): lo que se lee
 * del API, cómo crece la lista con cada tramo y lo que dice la pantalla.
 */

const SESION = '5b0e8d1c-2a4f-4c6e-9b7a-0d3e1f2a4b6c';
const CARTAGENA = 'Cartagena de Indias, Colombia';

function hotel(id: string): HotelOffer {
  return { hotelId: id, name: `Hotel ${id}`, roompacks: [] };
}

function busqueda(
  paging?: HotelSearchPaging,
  hotels = [hotel('1'), hotel('2')],
): HotelSearchResult {
  return {
    ok: true,
    hotels,
    providers: [{ code: 'tbo-hotels', status: 'ok', count: hotels.length }],
    showProviderInResults: false,
    ...(paging === undefined ? {} : { paging }),
    receivedAt: 1,
  };
}

const PRIMERO: HotelSearchPaging = {
  sessionId: SESION,
  page: 0,
  consulted: 100,
  total: 420,
  hasMore: true,
  nextBatch: 100,
};

function tramo(extra: Partial<MoreHotelsResult> = {}): MoreHotelsResult {
  return {
    ok: true,
    hotels: [hotel('3'), hotel('4')],
    providers: [{ code: 'tbo-hotels', status: 'ok', count: 2 }],
    paging: { ...PRIMERO, page: 1, consulted: 200 },
    ...extra,
  };
}

describe('parseSearchPaging', () => {
  it('lee lo que manda el API', () => {
    expect(parseSearchPaging(PRIMERO)).toEqual(PRIMERO);
    expect(parseSearchPaging({ page: 2, consulted: 420, total: 420, hasMore: false })).toEqual({
      page: 2,
      consulted: 420,
      total: 420,
      hasMore: false,
    });
  });

  it('sin un `sessionId` válido no se ofrece seguir, aunque diga que hay más', () => {
    expect(parseSearchPaging({ ...PRIMERO, sessionId: 'hotels:*' })).toEqual({
      page: 0,
      consulted: 100,
      total: 420,
      hasMore: false,
    });
  });

  it('lo que no se entiende no existe', () => {
    for (const raw of [
      undefined,
      null,
      'x',
      {},
      { ...PRIMERO, page: -1 },
      { ...PRIMERO, total: '420' },
    ]) {
      expect(parseSearchPaging(raw)).toBeUndefined();
    }
  });

  it('el total nunca es menor que lo consultado', () => {
    expect(parseSearchPaging({ ...PRIMERO, total: 50 })?.total).toBe(100);
  });
});

describe('moreFailureReason', () => {
  it('traduce los motivos del API y nada más', () => {
    expect(moreFailureReason('SEARCH_PAGING_EXPIRED')).toBe('expired');
    expect(moreFailureReason('SEARCH_PAGE_NOT_NEXT')).toBe('not-next');
    expect(moreFailureReason('SEARCH_PAGING_EXHAUSTED')).toBe('exhausted');
    expect(moreFailureReason('SEATS_FULL')).toBeUndefined();
    expect(moreFailureReason(undefined)).toBeUndefined();
  });
});

describe('los tramos de una búsqueda', () => {
  it('empiezan con lo que trajo la búsqueda: el tramo 0 y se pide el 1', () => {
    const s = moreStateFor(busqueda(PRIMERO));
    expect(s).toMatchObject({
      hotels: [],
      segments: [100],
      nextPage: 1,
      arrived: 0,
      status: 'idle',
    });
    expect(canLoadMore(s)).toBe(true);
  });

  it('una búsqueda sin tramos (IDs escritos a mano) no ofrece seguir', () => {
    expect(canLoadMore(moreStateFor(busqueda()))).toBe(false);
  });

  it('mientras se pide uno no se pide otro, y se anuncia qué se busca', () => {
    const s = moreLoading(moreStateFor(busqueda(PRIMERO)));
    expect(s.status).toBe('loading');
    expect(canLoadMore(s)).toBe(false);
    expect(s.announcement).toBe('Buscando los siguientes 100 hoteles del destino.');
  });

  it('un tramo que llega se SUMA al final, avanza el medidor y el tramo que sigue', () => {
    const s = moreArrived(moreLoading(moreStateFor(busqueda(PRIMERO))), tramo());
    expect(s.hotels.map((h) => h.hotelId)).toEqual(['3', '4']);
    expect(s).toMatchObject({ segments: [100, 100], nextPage: 2, arrived: 1, status: 'idle' });
    expect(s.notice).toBeUndefined();
    // Con la lista ya a la vista, el anuncio lo hace ella: sólo ella sabe cuántos cumplen los
    // filtros. Aquí queda vacío para no decirlo dos veces.
    expect(s.announcement).toBe('');

    const otro = moreArrived(
      s,
      tramo({ hotels: [hotel('5')], paging: { ...PRIMERO, page: 2, consulted: 300 } }),
    );
    expect(otro.hotels.map((h) => h.hotelId)).toEqual(['3', '4', '5']);
    expect(otro.segments).toEqual([100, 100, 100]);
  });

  it('desde el estado vacío, la lista recién aparece: el anuncio sale de aquí', () => {
    const s = moreArrived(moreLoading(moreStateFor(busqueda(PRIMERO, []))), tramo());
    expect(s.announcement).toBe('Llegaron 2 hoteles más.');
  });

  it('un tramo sin disponibilidad lo dice, y sigue ofreciendo el siguiente', () => {
    const s = moreArrived(moreStateFor(busqueda(PRIMERO, [])), tramo({ hotels: [] }));
    expect(s.notice).toEqual({
      tone: 'info',
      text: 'Los siguientes 100 hoteles no tienen disponibilidad para estas fechas.',
    });
    expect(s.announcement).toBe(s.notice?.text);
    expect(canLoadMore(s)).toBe(true);
  });

  it('el último tramo lo anuncia', () => {
    const s = moreArrived(
      moreStateFor(busqueda(PRIMERO, [])),
      tramo({ paging: { page: 4, consulted: 420, total: 420, hasMore: false } }),
    );
    expect(s.announcement).toBe('Llegaron 2 hoteles más. Ya no quedan hoteles por consultar.');
    expect(canLoadMore(s)).toBe(false);
  });

  it('un proveedor que falló en el tramo se nombra con su motivo', () => {
    const s = moreArrived(
      moreStateFor(busqueda(PRIMERO)),
      tramo({
        providers: [
          { code: 'tbo-hotels', status: 'ok', count: 2 },
          { code: 'despegar-hotels', status: 'error', count: 0, reason: 'No respondió a tiempo.' },
        ],
      }),
    );
    expect(s.notice).toEqual({
      tone: 'warning',
      text: 'Parte de este tramo no se pudo consultar. despegar-hotels: No respondió a tiempo.',
    });
  });

  it('un fallo deja todo como estaba y se puede reintentar el mismo tramo', () => {
    const antes = moreStateFor(busqueda(PRIMERO));
    const s = moreArrived(moreLoading(antes), {
      ok: false,
      hotels: [],
      providers: [],
      error: 'Ningún proveedor de hoteles respondió.',
    });
    expect(s).toMatchObject({
      status: 'error',
      error: 'Ningún proveedor de hoteles respondió.',
      nextPage: 1,
      segments: [100],
    });
    // El pie lo muestra con `role="alert"`: la región de la página no lo repite.
    expect(s.announcement).toBe('');
    expect(canLoadMore(s)).toBe(true);
    // El error se va apenas se vuelve a pedir.
    expect(moreLoading(s).error).toBeUndefined();
  });

  it('vencida: no se ofrece seguir, se ofrece buscar de nuevo', () => {
    const s = moreArrived(moreStateFor(busqueda(PRIMERO)), {
      ok: false,
      hotels: [],
      providers: [],
      reason: 'expired',
      error: 'Esta búsqueda ya no está vigente. Vuelve a buscar para ver más hoteles.',
    });
    expect(s.status).toBe('expired');
    expect(s.announcement).toBe('');
    expect(canLoadMore(s)).toBe(false);
  });

  it('un tramo cuya respuesta se perdió y ya no se repite: se pone al día con el API y ofrece seguir, no reintentar', () => {
    const s = moreArrived(moreLoading(moreStateFor(busqueda(PRIMERO))), {
      ok: false,
      hotels: [],
      providers: [],
      reason: 'not-next',
      nextPage: 2,
      paging: { ...PRIMERO, page: 1, consulted: 200 },
      error: 'Esos hoteles ya se consultaron en esta búsqueda.',
    });
    const text =
      'No nos llegó la respuesta de los 100 hoteles que ya consultamos. Para verlos, vuelve a buscar.';
    expect(s).toMatchObject({
      status: 'idle',
      nextPage: 2,
      paging: { consulted: 200 },
      segments: [100, 100],
      notice: { tone: 'warning', text },
      announcement: text,
    });
    expect(s.error).toBeUndefined();
    expect(canLoadMore(s)).toBe(true);

    // El siguiente tramo cuenta sólo lo que pidió él, no lo que se perdió.
    const siguiente = moreArrived(
      moreLoading(s),
      tramo({ hotels: [], paging: { ...PRIMERO, page: 2, consulted: 300 } }),
    );
    expect(siguiente.notice?.text).toBe(
      'Los siguientes 100 hoteles no tienen disponibilidad para estas fechas.',
    );
    expect(siguiente.segments).toEqual([100, 100, 100]);
  });

  it('un 409 sin `paging` (un API anterior): sigue desde el que dice, con el mensaje del API', () => {
    const s = moreArrived(moreStateFor(busqueda(PRIMERO)), {
      ok: false,
      hotels: [],
      providers: [],
      reason: 'not-next',
      nextPage: 3,
      error: 'Esos hoteles ya se consultaron en esta búsqueda.',
    });
    expect(s).toMatchObject({
      status: 'idle',
      nextPage: 3,
      notice: { tone: 'warning', text: 'Esos hoteles ya se consultaron en esta búsqueda.' },
    });
    expect(canLoadMore(s)).toBe(true);
  });

  it('sin más: el medidor queda como estaba y se deja de ofrecer', () => {
    const s = moreArrived(moreStateFor(busqueda(PRIMERO)), {
      ok: false,
      hotels: [],
      providers: [],
      reason: 'exhausted',
    });
    expect(s.paging).toEqual({ page: 0, consulted: 100, total: 420, hasMore: false });
    expect(s.status).toBe('idle');
  });
});

describe('un tramo en la lista ya ordenada', () => {
  // 4 hoteles que ya se veían (índices 0-3) y 3 nuevos (4-6).
  it('"Recomendados": los nuevos van al final, se ven hasta 20 más y el foco va al primero', () => {
    const p = placeArrival([0, 1, 2, 3, 4, 5, 6], 4, 4);
    expect(p).toEqual({ visible: 7, matching: 3, firstNew: 4, interleaved: false });
  });

  it('"Menor precio" con un tramo más barato: los nuevos quedan arriba y ninguno de los que se veían se esconde', () => {
    const p = placeArrival([4, 5, 6, 0, 1, 2, 3], 4, 4);
    expect(p).toEqual({ visible: 7, matching: 3, firstNew: 0, interleaved: true });
  });

  it('con muchos nuevos repartidos, se ven todos los viejos y los que cayeron entre ellos', () => {
    // 67 viejos a la vista y 67 nuevos, todos más baratos: nada se vuelve a esconder.
    const viejos = Array.from({ length: 67 }, (_, i) => i);
    const nuevos = Array.from({ length: 67 }, (_, i) => 67 + i);
    expect(placeArrival([...nuevos, ...viejos], 67, 67)).toMatchObject({
      visible: 134,
      firstNew: 0,
    });
    // Al final, como con "Mostrar 20 más": hasta 20 nuevos después de los viejos.
    expect(placeArrival([...viejos, ...nuevos], 67, 67)).toMatchObject({
      visible: 67 + RESULTS_PAGE_SIZE,
      firstNew: 67,
      interleaved: false,
    });
  });

  it('si los filtros esconden a todos los nuevos, no hay a dónde llevar el foco', () => {
    expect(placeArrival([0, 1, 2, 3], 4, 4)).toEqual({
      visible: 4,
      matching: 0,
      interleaved: false,
    });
  });

  it('el anuncio cuenta los que cumplen los filtros y dice dónde quedó el primero', () => {
    expect(arrivalAnnouncement({ added: 67, matching: 67, ended: false })).toBe(
      'Llegaron 67 hoteles más.',
    );
    expect(arrivalAnnouncement({ added: 67, matching: 1, ended: false })).toBe(
      'Llegaron 67 hoteles más; 1 cumple tus filtros.',
    );
    expect(arrivalAnnouncement({ added: 67, matching: 0, ended: true })).toBe(
      'Llegaron 67 hoteles más; ninguno cumple tus filtros. Ya no quedan hoteles por consultar.',
    );
    expect(
      arrivalAnnouncement({
        added: 67,
        matching: 12,
        firstNewAt: 0,
        sortLabel: 'Menor precio',
        ended: false,
      }),
    ).toBe(
      'Llegaron 67 hoteles más; 12 cumplen tus filtros. Con el orden «Menor precio», el primero quedó en el puesto 1.',
    );
    expect(
      arrivalAnnouncement({
        added: 0,
        matching: 0,
        notice: { tone: 'info', text: 'Los siguientes 100 hoteles no tienen disponibilidad.' },
        ended: false,
      }),
    ).toBe('Los siguientes 100 hoteles no tienen disponibilidad.');
    expect(
      arrivalAnnouncement({
        added: 3,
        matching: 3,
        notice: { tone: 'warning', text: 'Parte de este tramo no se pudo consultar.' },
        ended: false,
      }),
    ).toBe('Llegaron 3 hoteles más. Parte de este tramo no se pudo consultar.');
  });
});

describe('lo que dice la pantalla', () => {
  it('"Consultamos 100 de 420 hoteles de Cartagena de Indias" y qué hace el botón', () => {
    expect(coverageView(PRIMERO, CARTAGENA)).toEqual({
      line: 'Consultamos 100 de 420 hoteles de Cartagena de Indias.',
      detail: '"Ver más hoteles" consulta los siguientes 100: es otra búsqueda en los proveedores.',
      complete: false,
    });
  });

  it('con hoteles cargados sin mostrar, primero se ven esos', () => {
    expect(coverageView(PRIMERO, CARTAGENA, { allVisible: false }).detail).toBe(
      'Cuando termines de ver los que ya llegaron, puedes consultar los siguientes 100.',
    );
  });

  it('todo el destino consultado', () => {
    expect(
      coverageView({ page: 4, consulted: 420, total: 420, hasMore: false }, CARTAGENA),
    ).toEqual({
      line: 'Consultamos los 420 hoteles de Cartagena de Indias.',
      detail: 'No quedan más hoteles por consultar en este destino.',
      complete: true,
    });
    expect(coverageView({ page: 0, consulted: 1, total: 1, hasMore: false }, 'Mompox').line).toBe(
      'Consultamos el único hotel de Mompox.',
    );
  });

  it('el tope de la búsqueda: dice cuántos quedaron sin consultar y que no se puede seguir', () => {
    expect(
      coverageView({ page: 19, consulted: 2_000, total: 3_400, hasMore: false }, 'Bogotá'),
    ).toEqual({
      line: 'Consultamos 2.000 de 3.400 hoteles de Bogotá.',
      detail: 'No se pueden consultar más en esta búsqueda.',
      complete: false,
    });
  });

  it('un primer tramo que falló entero', () => {
    expect(coverageView({ ...PRIMERO, consulted: 0 }, undefined).line).toBe(
      'Todavía no pudimos consultar los 420 hoteles del destino.',
    );
  });

  it('el destino es la ciudad, sin el país', () => {
    expect(destinationShortLabel(CARTAGENA)).toBe('Cartagena de Indias');
    expect(destinationShortLabel('  ')).toBeUndefined();
    expect(destinationShortLabel(undefined)).toBeUndefined();
  });

  it('el medidor: un segmento por tramo, el siguiente y lo que queda, en % del destino', () => {
    expect(coverageSegments([100, 100], { ...PRIMERO, consulted: 200 })).toEqual([
      { kind: 'consulted', percent: (100 / 420) * 100 },
      { kind: 'consulted', percent: (100 / 420) * 100 },
      { kind: 'next', percent: (100 / 420) * 100 },
      { kind: 'rest', percent: (120 / 420) * 100 },
    ]);
    expect(
      coverageSegments([100, 100, 100, 100, 20], {
        page: 4,
        consulted: 420,
        total: 420,
        hasMore: false,
      }).map((s) => s.kind),
    ).toEqual(['consulted', 'consulted', 'consulted', 'consulted', 'consulted']);
  });

  it('con muchos tramos, los consultados son uno solo', () => {
    const muchos = Array.from({ length: 13 }, () => 100);
    expect(
      coverageSegments(muchos, { ...PRIMERO, page: 12, consulted: 1_300, total: 3_400 })[0],
    ).toEqual({ kind: 'consulted', percent: (1_300 / 3_400) * 100 });
  });

  it('"Mostrar 20 más" mientras queden cargados sin mostrar', () => {
    expect(RESULTS_PAGE_SIZE).toBe(20);
    expect(revealView(20, 64)).toEqual({
      label: 'Mostrar 20 más',
      progress: 'Viendo 20 de 64 hoteles',
    });
    expect(revealView(60, 64)).toEqual({
      label: 'Mostrar 4 más',
      progress: 'Viendo 60 de 64 hoteles',
    });
    expect(revealView(64, 64)).toBeUndefined();
  });

  it('vacío con hoteles por consultar: no dice "no hay disponibilidad"', () => {
    expect(emptyWithMoreView(PRIMERO, CARTAGENA)).toEqual({
      title:
        'Los 100 hoteles que consultamos de Cartagena de Indias no tienen disponibilidad para estas fechas.',
      hint: 'Quedan 320 hoteles por consultar: con "Ver más hoteles" buscamos en los siguientes.',
    });
  });

  it('todo en "tú": ni voseo ni usted en lo que ve el vendedor', () => {
    const textos = [
      coverageView(PRIMERO, CARTAGENA),
      coverageView(PRIMERO, CARTAGENA, { allVisible: false }),
      coverageView({ page: 1, consulted: 5, total: 9, hasMore: false }, CARTAGENA),
      emptyWithMoreView(PRIMERO, CARTAGENA),
    ]
      .flatMap((v) => Object.values(v))
      .filter((v): v is string => typeof v === 'string')
      .join(' ');
    expect(textos).not.toMatch(/\b(podés|terminés|volvé|buscá|probá|revisá|tenés)\b/i);
  });
});
