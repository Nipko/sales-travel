import { describe, expect, it } from 'vitest';
import type {
  TboContentLanguage,
  TboHotelContent,
  TboHotelDetailsMapping,
  TboStaticDiagnostics,
} from './content.types';
import {
  TBO_CONTENT_FALLBACK_LANG,
  TBO_DETAILS_ISOLATION_DEFAULTS,
  resolveTboHotelDetails,
  type TboDetailsCallPurpose,
  type TboDetailsFetch,
  type TboDetailsResolveOptions,
} from './hotel-details.resolver';

/**
 * El lote de HotelDetails hasta su respuesta final (05 CE-23), con un TBO de mentira que sigue una
 * de las dos hipótesis del 2026-09-30 y registra cada llamada. El cable y el cliente se prueban en
 * `tbo-static-content.client.test.ts`; aquí, sólo la decisión de qué pedir después.
 */

const DIAGNOSTICS: TboStaticDiagnostics = {
  received: 0,
  mapped: 0,
  rejected: {},
  notes: {},
  unknownKeys: [],
};

function content(hotelId: string, lang: TboContentLanguage): TboHotelContent {
  return {
    hotelId,
    lang,
    source: 'details',
    name: `Hotel ${hotelId} ${lang}`,
    descriptionHtml: null,
    descriptionText: null,
    sections: [],
    facilities: [],
    unavailableFacilities: [],
    attractionsHtml: null,
    images: [`https://api.tbotechnology.in/imageresource.aspx?img=${hotelId}`],
    phone: null,
    websiteUrl: null,
    checkInTime: null,
    checkOutTime: null,
  };
}

interface World {
  /** Qué códigos tienen contenido en cada idioma. */
  readonly has: Readonly<Partial<Record<TboContentLanguage, readonly string[]>>>;
  /**
   * H2: un código de éstos en el lote lo tumba entero. Sin él, cada lote sigue H1: "No Hotels
   * Found" si ninguno tiene contenido en ese idioma, y si no, un 200 con los que tienen.
   */
  readonly poison?: readonly string[];
  /** Llamadas que fallan, por su número de orden (0 = la principal). */
  readonly failAt?: readonly number[];
}

interface Call {
  readonly codes: readonly string[];
  readonly lang: TboContentLanguage;
  readonly purpose: TboDetailsCallPurpose;
}

function fakeTbo(world: World): { fetch: TboDetailsFetch<string>; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: TboDetailsFetch<string> = (codes, lang, purpose) => {
    const index = calls.length;
    calls.push({ codes: [...codes], lang, purpose });
    if (world.failAt?.includes(index)) return Promise.resolve({ ok: false, failure: `f${index}` });
    const noHotels = (): TboHotelDetailsMapping => ({
      lang,
      outcome: 'NO_HOTELS_FOUND',
      contents: [],
      hotels: [],
      missingHotelCodes: [...codes],
      diagnostics: DIAGNOSTICS,
    });
    if (codes.some((code) => world.poison?.includes(code))) {
      return Promise.resolve({ ok: true, result: noHotels() });
    }
    const found = codes.filter((code) => world.has[lang]?.includes(code));
    if (found.length === 0) return Promise.resolve({ ok: true, result: noHotels() });
    return Promise.resolve({
      ok: true,
      result: {
        lang,
        outcome: 'DETAILS',
        contents: found.map((code) => content(code, lang)),
        hotels: found.map((hotelId) => ({
          hotelId,
          name: `Hotel ${hotelId}`,
          stars: null,
          location: null,
          address: null,
          zipcode: null,
          countryCode: null,
          cityCode: null,
        })),
        missingHotelCodes: codes.filter((code) => !found.includes(code)),
        diagnostics: { ...DIAGNOSTICS, unknownKeys: [`HotelDetails[].Extra${lang}`] },
      },
    });
  };
  return { fetch, calls };
}

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => String(1_000_001 + i));

function resolve(
  codes: readonly string[],
  lang: TboContentLanguage,
  world: World,
  options: TboDetailsResolveOptions = {},
) {
  const tbo = fakeTbo(world);
  return resolveTboHotelDetails(codes, lang, tbo.fetch, options).then((r) => ({ ...r, tbo }));
}

describe('resolveTboHotelDetails: el idioma pedido alcanza', () => {
  it('todo en español en UNA llamada: ni respaldo ni aislamiento', async () => {
    const codes = ids(10);
    const r = await resolve(codes, 'es', { has: { es: codes, en: codes } });

    expect(r.tbo.calls).toEqual([{ codes, lang: 'es', purpose: 'primary' }]);
    expect(r.foundInLang).toEqual(codes);
    expect(r).toMatchObject({
      foundInFallback: [],
      withoutContent: [],
      unresolved: [],
      calls: { primary: 1, fallback: 0, isolation: 0 },
      isolationLimited: false,
      extraFailures: [],
    });
    expect(r.contents.every((c) => c.lang === 'es')).toBe(true);
    expect(r.hotels).toHaveLength(10);
    expect(r.unknownKeys).toEqual(['HotelDetails[].Extraes']);
  });

  it('los códigos se deduplican conservando el orden', async () => {
    const r = await resolve(['2', '1', '2'], 'es', { has: { es: ['1', '2'] } });
    expect(r.requested).toEqual(['2', '1']);
    expect(r.tbo.calls[0]?.codes).toEqual(['2', '1']);
  });
});

describe('H1: TBO no tiene contenido en español; el respaldo en inglés lo trae', () => {
  it('lote entero "No Hotels Found" en ES → UNA llamada en EN con los mismos códigos', async () => {
    const codes = ids(10);
    const r = await resolve(codes, 'es', { has: { en: codes } });

    expect(r.tbo.calls).toEqual([
      { codes, lang: 'es', purpose: 'primary' },
      { codes, lang: 'en', purpose: 'fallback' },
    ]);
    expect(r).toMatchObject({
      foundInLang: [],
      foundInFallback: codes,
      withoutContent: [],
      unresolved: [],
      calls: { primary: 1, fallback: 1, isolation: 0 },
    });
    expect(r.contents.map((c) => c.lang)).toEqual(Array(10).fill(TBO_CONTENT_FALLBACK_LANG));
  });

  it('un 200 parcial en ES: sólo lo que faltó va al inglés; lo que falta también en inglés queda confirmado', async () => {
    const codes = ids(4);
    const [a = '', b = '', c = '', d = ''] = codes;
    const r = await resolve(codes, 'pt', { has: { pt: [a, b], en: [a, b, c] } });

    expect(r.tbo.calls).toEqual([
      { codes, lang: 'pt', purpose: 'primary' },
      { codes: [c, d], lang: 'en', purpose: 'fallback' },
    ]);
    expect(r).toMatchObject({
      foundInLang: [a, b],
      foundInFallback: [c],
      withoutContent: [d],
      unresolved: [],
    });
  });

  it('uno sin inglés en un lote H1: el 200 en inglés descarta H2 y no hay vuelta al español', async () => {
    const codes = ids(10);
    const x = codes[3] ?? '';
    const r = await resolve(codes, 'es', { has: { en: codes.filter((code) => code !== x) } });

    // Dos llamadas, nunca una tercera: en inglés x faltó sin tumbar el lote, así que el vacío del
    // español es de todos (H1) y x queda confirmado sin contenido en los dos idiomas.
    expect(r.tbo.calls.map((c) => [c.lang, c.purpose])).toEqual([
      ['es', 'primary'],
      ['en', 'fallback'],
    ]);
    expect(r).toMatchObject({
      foundInFallback: codes.filter((code) => code !== x),
      withoutContent: [x],
      unconfirmed: [],
      batchBreakers: [],
      calls: { primary: 1, fallback: 1, isolation: 0 },
    });
  });

  it('pedido en inglés: no hay respaldo; lo que falta en un 200 queda confirmado sin contenido', async () => {
    const codes = ids(3);
    const r = await resolve(codes, 'en', { has: { en: codes.slice(0, 2) } });
    expect(r.tbo.calls).toHaveLength(1);
    expect(r.withoutContent).toEqual([codes[2]]);
  });

  it('un código solo sin contenido en ningún idioma: dos llamadas y confirmado', async () => {
    const r = await resolve(['1'], 'es', { has: {} });
    expect(r.tbo.calls.map((c) => [c.lang, c.purpose])).toEqual([
      ['es', 'primary'],
      ['en', 'fallback'],
    ]);
    expect(r).toMatchObject({ withoutContent: ['1'], unresolved: [], isolationLimited: false });
  });
});

describe('H2: un código sin contenido tumba el lote; se parte para encontrar los que sí tienen', () => {
  it('10 con uno malo: se aísla, los 9 reciben inglés y después su español, sin el malo', async () => {
    const codes = ids(10);
    const poison = codes[6] ?? '';
    const good = codes.filter((code) => code !== poison);
    const r = await resolve(codes, 'es', { has: { es: good, en: good }, poison: [poison] });

    // ES y EN del lote entero vuelven vacíos; 10 → 5 + 5; el segundo 5 → 3 + 2; el 3 → 2 + 1;
    // el 2 → 1 + 1: el 7.º queda solo. Después, UNA vez, el español de los 9 sin el malo.
    expect(r.tbo.calls.map((c) => [c.lang, c.purpose, c.codes])).toEqual([
      ['es', 'primary', codes],
      ['en', 'fallback', codes],
      ['en', 'isolation', codes.slice(0, 5)],
      ['en', 'isolation', codes.slice(5, 10)],
      ['en', 'isolation', codes.slice(5, 8)],
      ['en', 'isolation', codes.slice(8, 10)],
      ['en', 'isolation', codes.slice(5, 7)],
      ['en', 'isolation', [codes[7]]],
      ['en', 'isolation', [codes[5]]],
      ['en', 'isolation', [poison]],
      ['es', 'isolation', good],
    ]);
    expect(r).toMatchObject({
      foundInLang: good,
      foundInFallback: [],
      withoutContent: [poison],
      unconfirmed: [],
      unresolved: [],
      batchBreakers: [poison],
      calls: { primary: 1, fallback: 1, isolation: 9 },
      isolationLimited: false,
    });
    // Se guardan los dos idiomas de cada bueno: el inglés ya llegó y el español llegó después.
    expect(r.contents.filter((c) => c.lang === 'es')).toHaveLength(9);
    expect(r.contents.filter((c) => c.lang === 'en')).toHaveLength(9);
    expect(r.calls.isolation).toBeLessThanOrEqual(TBO_DETAILS_ISOLATION_DEFAULTS.maxCallsPerBatch);
  });

  it('con H1 detrás del malo, la llamada en español de los buenos vuelve vacía y quedan en inglés', async () => {
    const codes = ids(4);
    const poison = codes[0] ?? '';
    const r = await resolve(codes, 'es', { has: { en: codes.slice(1) }, poison: [poison] });

    expect(r.tbo.calls.at(-1)).toEqual({
      codes: codes.slice(1),
      lang: 'es',
      purpose: 'isolation',
    });
    // Sin el malo el español también volvió vacío: del malo sólo se sabe que no tiene inglés. Con
    // H2 general, otro de los tres sin español pudo tumbar esa vuelta: su español no se confirma.
    expect(r).toMatchObject({
      foundInLang: [],
      foundInFallback: codes.slice(1),
      withoutContent: [],
      unconfirmed: [poison],
      withoutFallback: [poison],
      batchBreakers: [poison],
    });
  });

  it('uno sin inglés pero con español vuelve en la vuelta al idioma pedido: no se da por perdido', async () => {
    const [a = '', y = '', p = ''] = ids(3);
    const r = await resolve([a, y, p], 'es', { has: { es: [a, y], en: [a] }, poison: [p] });

    // ES y EN del lote vuelven vacíos por p; [a, y] trae a en inglés (y falta en un 200: no tumba
    // nada) y p solo vuelve vacío. La vuelta en español va con a e y, sin p, y trae los dos.
    expect(r.tbo.calls.map((c) => [c.lang, c.purpose, c.codes])).toEqual([
      ['es', 'primary', [a, y, p]],
      ['en', 'fallback', [a, y, p]],
      ['en', 'isolation', [a, y]],
      ['en', 'isolation', [p]],
      ['es', 'isolation', [a, y]],
    ]);
    expect(r).toMatchObject({
      foundInLang: [a, y],
      withoutContent: [p],
      unconfirmed: [],
      batchBreakers: [p],
    });
  });

  it('pedido en inglés: se parte directo, sin respaldo ni vuelta al idioma pedido', async () => {
    const codes = ids(3);
    const r = await resolve(codes, 'en', { has: { en: codes }, poison: [codes[2] ?? ''] });
    expect(r.tbo.calls.map((c) => [c.lang, c.purpose, c.codes])).toEqual([
      ['en', 'primary', codes],
      ['en', 'isolation', codes.slice(0, 2)],
      ['en', 'isolation', [codes[2]]],
    ]);
    expect(r).toMatchObject({ foundInLang: codes.slice(0, 2), withoutContent: [codes[2]] });
  });

  it('el tope por lote corta: lo que no alcanzó queda sin resolver, nunca confirmado', async () => {
    const codes = ids(10);
    const poison = [codes[1] ?? '', codes[8] ?? ''];
    const good = codes.filter((code) => !poison.includes(code));
    const r = await resolve(codes, 'es', { has: { en: good }, poison }, { maxIsolationCalls: 4 });

    expect(r.calls).toEqual({ primary: 1, fallback: 1, isolation: 4 });
    expect(r.isolationLimited).toBe(true);
    expect(r.unresolved.length).toBeGreaterThan(0);
    // Nada queda en dos listas a la vez, y lo pedido está entero entre las cinco.
    const all = [
      ...r.foundInLang,
      ...r.foundInFallback,
      ...r.withoutContent,
      ...r.unconfirmed,
      ...r.unresolved,
    ];
    expect([...all].sort()).toEqual([...codes].sort());
    expect(r.withoutContent.every((code) => poison.includes(code))).toBe(true);
  });

  it('sin cupo por minuto no sale ninguna llamada de aislamiento', async () => {
    const codes = ids(4);
    let asked = 0;
    const r = await resolve(
      codes,
      'es',
      { has: { en: codes.slice(1) }, poison: [codes[0] ?? ''] },
      {
        allowIsolationCall: () => {
          asked += 1;
          return false;
        },
      },
    );
    expect(r.calls).toEqual({ primary: 1, fallback: 1, isolation: 0 });
    expect(asked).toBeGreaterThan(0);
    expect(r).toMatchObject({ unresolved: codes, withoutContent: [], isolationLimited: true });
  });

  it('con el cupo justo para una mitad, la otra queda sin resolver', async () => {
    const codes = ids(4);
    let left = 1;
    const r = await resolve(
      codes,
      'en',
      { has: { en: codes }, poison: [codes[3] ?? ''] },
      { allowIsolationCall: () => left-- > 0 },
    );
    expect(r.tbo.calls.map((c) => c.codes)).toEqual([codes, codes.slice(0, 2)]);
    expect(r).toMatchObject({ foundInLang: codes.slice(0, 2), unresolved: codes.slice(2) });
  });
});

describe('fallos y lo ya conocido', () => {
  it('la principal falla: nada más sale y todo queda sin resolver, con su fallo', async () => {
    const codes = ids(3);
    const r = await resolve(codes, 'es', { has: {}, failAt: [0] });
    expect(r.tbo.calls).toHaveLength(1);
    expect(r).toMatchObject({ primaryFailure: 'f0', unresolved: codes, extraFailures: [] });
  });

  it('el respaldo falla: sus códigos quedan sin resolver y no se parte nada', async () => {
    const codes = ids(3);
    const r = await resolve(codes, 'es', { has: { es: [codes[0] ?? ''] }, failAt: [1] });
    expect(r.tbo.calls).toHaveLength(2);
    expect(r).toMatchObject({
      foundInLang: [codes[0]],
      unresolved: codes.slice(1),
      extraFailures: ['f1'],
      isolationLimited: false,
    });
    expect(r.primaryFailure).toBeUndefined();
  });

  it('una llamada de aislamiento que falla corta las siguientes del lote', async () => {
    const codes = ids(4);
    const r = await resolve(codes, 'en', {
      has: { en: codes },
      poison: [codes[0] ?? ''],
      failAt: [1],
    });
    expect(r.tbo.calls).toHaveLength(2);
    expect(r).toMatchObject({ unresolved: codes, extraFailures: ['f1'] });
  });

  it('lo que el llamador ya sabe del inglés no se vuelve a pedir', async () => {
    const codes = ids(3);
    const [a = '', b = '', c = ''] = codes;
    const r = await resolve(
      codes,
      'pt',
      { has: { en: [c] } },
      { fallbackKnown: (code) => (code === a ? 'content' : code === b ? 'none' : undefined) },
    );
    // Sólo c sale en inglés. El lote en portugués volvió vacío, pero nada dice que b lo haya tumbado
    // (nadie lo vio tumbar un lote): no hay vuelta al portugués, y del portugués de b no se sabe nada.
    expect(r.tbo.calls.map((call) => [call.lang, call.purpose, call.codes])).toEqual([
      ['pt', 'primary', codes],
      ['en', 'fallback', [c]],
    ]);
    expect(r).toMatchObject({
      foundInFallback: [a, c],
      withoutContent: [],
      unconfirmed: [b],
      withoutFallback: [b],
      unresolved: [],
    });
  });

  it('una respuesta con elementos descartados por el ACL no confirma lo que faltó en ella', async () => {
    const codes = ids(2);
    const [a = '', x = ''] = codes;
    const fetch: TboDetailsFetch<string> = (asked, lang) =>
      Promise.resolve({
        ok: true,
        result:
          lang === 'es'
            ? {
                lang,
                outcome: 'NO_HOTELS_FOUND',
                contents: [],
                hotels: [],
                missingHotelCodes: [...asked],
                diagnostics: DIAGNOSTICS,
              }
            : {
                lang,
                outcome: 'DETAILS',
                contents: [content(a, 'en')],
                hotels: [],
                missingHotelCodes: [x],
                diagnostics: {
                  ...DIAGNOSTICS,
                  received: 2,
                  mapped: 1,
                  rejected: { ITEM_SCHEMA: 1 },
                },
              },
      });
    const r = await resolveTboHotelDetails(codes, 'es', fetch);
    // x pudo ser el elemento que no se entendió: ni "sin contenido" ni H2 descartada por él.
    expect(r).toMatchObject({
      foundInFallback: [a],
      withoutContent: [],
      withoutFallback: [],
      unconfirmed: [x],
      unresolved: [],
      untrustedResponses: 1,
    });
  });

  it('lo que lanza `fetch` (una cuenta rechazada en el sync) se propaga', async () => {
    const boom = new Error('cuenta rechazada');
    await expect(resolveTboHotelDetails(['1'], 'es', () => Promise.reject(boom))).rejects.toBe(
      boom,
    );
  });
});
