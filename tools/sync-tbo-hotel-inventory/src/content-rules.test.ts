import type { TboHotelContent } from '@sales-travel/tbo-hotels';
import { describe, expect, it } from 'vitest';
import {
  contentHash,
  contentWriteAction,
  isSplittableFailure,
  planContentBatches,
  selectContentTasks,
  type ContentCandidate,
  type ContentSelection,
  type ContentTask,
} from './content-rules.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 25, 8, 0, 0);

function content(extra: Partial<TboHotelContent> = {}): TboHotelContent {
  return {
    hotelId: '1000001',
    lang: 'es',
    source: 'details',
    name: 'Hotel Uno',
    descriptionHtml: '<p>HeadLine : Cerca del centro</p>',
    descriptionText: 'HeadLine : Cerca del centro',
    sections: [{ label: 'HeadLine', text: 'Cerca del centro' }],
    facilities: ['Free WiFi'],
    unavailableFacilities: ['Wheelchair accessible'],
    attractionsHtml: null,
    images: ['https://api.tbotechnology.in/imageresource.aspx?img=a'],
    phone: '+57 1 000',
    websiteUrl: null,
    checkInTime: '15:00',
    checkOutTime: '12:00',
    ...extra,
  };
}

describe('contentHash (hotel_content.content_hash)', () => {
  it('estable para el mismo contenido y distinta si cambia una columna que se guarda', () => {
    const base = contentHash(content());
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHash(content())).toBe(base);
    for (const change of [
      { name: 'Hotel Dos' },
      { images: [] },
      { sections: [{ label: 'HeadLine', text: 'Lejos' }] },
      { checkInTime: '14:00' },
      { facilities: ['Free WiFi', 'Pool'] },
    ] satisfies Partial<TboHotelContent>[]) {
      expect(contentHash(content(change))).not.toBe(base);
    }
  });

  it('lo que no va a la tabla no la cambia: origen, idioma, texto derivado, servicios negados', () => {
    const base = contentHash(content());
    expect(contentHash(content({ source: 'listing' }))).toBe(base);
    expect(contentHash(content({ lang: 'pt' }))).toBe(base);
    expect(contentHash(content({ descriptionText: 'otro' }))).toBe(base);
    expect(contentHash(content({ unavailableFacilities: [] }))).toBe(base);
  });

  it('el orden de las claves del objeto no importa; el de las listas sí', () => {
    const { name, ...rest } = content();
    // `name` pasa de ser la tercera clave a ser la última.
    expect(contentHash({ ...rest, name })).toBe(contentHash(content()));
    expect(contentHash(content({ facilities: ['b', 'a'] }))).not.toBe(
      contentHash(content({ facilities: ['a', 'b'] })),
    );
  });
});

describe('contentWriteAction', () => {
  const details = { source: 'details', contentHash: 'h1' } as const;
  const listing = { source: 'listing', contentHash: 'h1' } as const;

  it('fila nueva, cambio de huella y details sobre listing se escriben', () => {
    expect(contentWriteAction(undefined, details)).toBe('insert');
    expect(contentWriteAction(details, { ...details, contentHash: 'h2' })).toBe('rewrite');
    expect(contentWriteAction(listing, details)).toBe('rewrite');
    expect(contentWriteAction(listing, { ...listing, contentHash: 'h2' })).toBe('rewrite');
  });

  it('el hash evita reescribir: details igual sólo avanza fetched_at; listing igual, nada', () => {
    expect(contentWriteAction(details, details)).toBe('touch');
    expect(contentWriteAction(listing, listing)).toBe('unchanged');
  });

  it('un listing nunca pisa un details, igual o distinto (05 §6.3)', () => {
    expect(contentWriteAction(details, listing)).toBe('protected');
    expect(contentWriteAction(details, { ...listing, contentHash: 'h9' })).toBe('protected');
  });
});

describe('selectContentTasks (E4: qué pares hotel-idioma tocan)', () => {
  const selection: ContentSelection = {
    scope: 'demand',
    demandLangs: ['es', 'pt', 'en'],
    regularLangs: ['es', 'pt'],
    maxAgeMs: 30 * DAY,
  };

  function candidate(
    hotelId: string,
    demand: number,
    detailsFetchedAt: ContentCandidate['detailsFetchedAt'] = {},
  ): ContentCandidate {
    return { hotelId, demand, detailsFetchedAt };
  }

  const pairs = (tasks: readonly ContentTask[]): string[] =>
    tasks.map((task) => `${task.hotelId}:${task.lang}`);

  it('demanda: ES, PT y EN; sin demanda y alcance `demand`: nada', () => {
    const tasks = selectContentTasks([candidate('a', 3), candidate('z', 0)], {
      ...selection,
      now: NOW,
    });
    expect(pairs(tasks)).toEqual(['a:es', 'a:pt', 'a:en']);
  });

  it('alcance `all`: el resto con sus idiomas, siempre detrás de la demanda', () => {
    const tasks = selectContentTasks([candidate('z', 0), candidate('a', 3)], {
      ...selection,
      scope: 'all',
      now: NOW,
    });
    expect(pairs(tasks)).toEqual(['a:es', 'a:pt', 'a:en', 'z:es', 'z:pt']);
  });

  it('lo fresco no toca; lo viejo sí, detrás de lo que nunca se pidió', () => {
    const tasks = selectContentTasks(
      [
        candidate('old', 3, {
          es: new Date(NOW - 45 * DAY),
          pt: new Date(NOW - DAY),
          en: new Date(NOW - 31 * DAY),
        }),
        candidate('new', 3),
      ],
      { ...selection, now: NOW },
    );
    // `old:pt` es de ayer: no toca. Entre los viejos, primero el idioma, después la antigüedad.
    expect(pairs(tasks)).toEqual(['new:es', 'new:pt', 'new:en', 'old:es', 'old:en']);
    expect(tasks.find((task) => task.hotelId === 'old' && task.lang === 'es')?.fetchedAt).toEqual(
      new Date(NOW - 45 * DAY),
    );
  });

  it('más demanda primero; a igual demanda, el orden de idiomas antes que el hotel', () => {
    const tasks = selectContentTasks([candidate('b', 1), candidate('a', 1), candidate('c', 9)], {
      ...selection,
      demandLangs: ['pt', 'es'],
      now: NOW,
    });
    expect(pairs(tasks)).toEqual(['c:pt', 'c:es', 'a:pt', 'b:pt', 'a:es', 'b:es']);
  });
});

describe('planContentBatches (lotes de 10, nunca más de 13, un idioma por llamada)', () => {
  function tasks(ids: readonly string[], lang: ContentTask['lang']): ContentTask[] {
    return ids.map((hotelId) => ({ hotelId, lang, demand: 1, fetchedAt: null, langRank: 0 }));
  }
  const ids = (n: number, prefix = 'h'): string[] =>
    Array.from({ length: n }, (_, i) => `${prefix}${i}`);

  it('parte en lotes del tamaño pedido, en orden', () => {
    const batches = planContentBatches(tasks(ids(23), 'es'), 10);
    expect(batches.map((b) => b.hotelIds.length)).toEqual([10, 10, 3]);
    expect(batches[0]?.hotelIds[0]).toBe('h0');
    expect(batches[2]?.hotelIds).toEqual(['h20', 'h21', 'h22']);
  });

  it('un tamaño mayor que 13 se recorta a 13 (Q-62); uno menor que 1, a 1', () => {
    expect(planContentBatches(tasks(ids(30), 'es'), 50).map((b) => b.hotelIds.length)).toEqual([
      13, 13, 4,
    ]);
    expect(planContentBatches(tasks(ids(2), 'es'), 0).map((b) => b.hotelIds.length)).toEqual([
      1, 1,
    ]);
    expect(
      planContentBatches(tasks(ids(23), 'es'), Number.NaN).map((b) => b.hotelIds.length),
    ).toEqual([10, 10, 3]);
  });

  it('cada lote es de un solo idioma y los lotes salen en el orden de su primer par', () => {
    const batches = planContentBatches(
      [...tasks(['a', 'b'], 'es'), ...tasks(['a', 'b'], 'pt'), ...tasks(['c'], 'es')],
      10,
    );
    expect(batches).toEqual([
      { lang: 'es', hotelIds: ['a', 'b', 'c'] },
      { lang: 'pt', hotelIds: ['a', 'b'] },
    ]);
  });

  it('sin pares no hay lotes', () => {
    expect(planContentBatches([], 10)).toEqual([]);
  });
});

describe('isSplittableFailure (05 §10: 400, 500 o timeout parten el lote)', () => {
  it('parte lo que puede ser culpa del lote y no lo que es culpa de la cuota', () => {
    for (const code of ['CLIENT_BUG', 'UPSTREAM', 'TRANSPORT', 'MALFORMED_RESPONSE']) {
      expect(isSplittableFailure(code)).toBe(true);
    }
    for (const code of ['THROTTLED', 'NOT_DISPATCHED_QUEUE_TIMEOUT']) {
      expect(isSplittableFailure(code)).toBe(false);
    }
  });
});
