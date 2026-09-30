import type {
  TboCatalogHotel,
  TboContentLanguage,
  TboHotelContent,
  TboHotelDetailsMapping,
} from './content.types';

/**
 * Un lote de HotelDetails hasta su respuesta final (docs/tbo/05 CE-23 y §10; Q-62 y Q-66): el idioma
 * pedido, el respaldo en inglés y, si hace falta, el lote partido para encontrar los códigos que sí
 * tienen contenido. Lo usan el API (fotos de los resultados) y el sync (E4), cada uno con su manera
 * de llamar: el API por su circuito y con un cupo por minuto, el sync por la puerta de su corrida.
 *
 * El 2026-09-30 TBO contestó TODOS los lotes de 10 en `ES` con HTTP 200 y `Status.Code` 500
 * "No Hotels Found" en 95-320 ms. Sin credenciales locales no se puede saber por qué, y el arreglo
 * tiene que servir con las dos explicaciones:
 *
 * - **H1: TBO no tiene contenido en ese idioma** para esos hoteles. Lo arregla el respaldo: los
 *   códigos que no volvieron se piden en inglés, que es el idioma de todos los ejemplos de TBO
 *   (p. 56, 58; Postman) y el del listado de ciudad (05 §6.3), y ese contenido se guarda como `en`.
 * - **H2: un código sin contenido tumba el lote entero.** Lo arregla el aislamiento: si el lote en
 *   inglés también vuelve "No Hotels Found", se parte en mitades hasta encontrar los códigos que sí
 *   tienen contenido.
 *
 * **Qué confirma cada respuesta.** Un código falta CONFIRMADO en un idioma si faltó en un 200 de ese
 * idioma o si volvió "No Hotels Found" pedido solo. Un lote de varios que vuelve "No Hotels Found" no
 * confirma nada por sí mismo: con H1 ninguno tiene ese idioma, con H2 uno solo lo tumbó. Dos
 * evidencias deciden cuál:
 *
 * - **H2 descartada**: el respaldo en inglés volvió 200 SIN algún código. En inglés, un código sin
 *   contenido no tumbó el lote, así que el "No Hotels Found" del idioma pedido es H1: ninguno de los
 *   que faltaron lo tiene, y queda confirmado.
 * - **H2 observada**: una mitad de un lote que volvió "No Hotels Found" trajo contenido. Los códigos
 *   que, solos, volvieron "No Hotels Found" son los que tumban el lote (`batchBreakers`), y los demás
 *   se piden UNA vez en el idioma pedido sin ellos. Si esa vuelta es un 200, lo que falte en ella y
 *   los que tumban el lote quedan confirmados sin el idioma pedido. Sin H2 observada no hay vuelta:
 *   con H1 sólo gastaría una llamada que vuelve vacía.
 *
 * Una respuesta con elementos que el ACL descartó (`ITEM_SCHEMA`) o sin el contenedor no confirma
 * nada de lo que faltó: pudo ser el código que no se entendió (`unconfirmed`, con
 * `untrustedResponses` para el log).
 *
 * Topes: el aislamiento gasta a lo sumo `maxIsolationCalls` llamadas por lote y, antes de cada una,
 * pregunta a `allowIsolationCall` (el cupo por minuto del API). Lo que no alcanza queda en
 * `unresolved`, igual que lo que no respondió porque falló una llamada extra: una llamada extra que
 * falla corta las siguientes del lote, porque partir contra un TBO caído sólo multiplica fallos.
 *
 * Nada aquí lanza por TBO: los fallos vuelven como valor (`primaryFailure`, `extraFailures`) con
 * el tipo que les dé quien llama. Sí se propaga lo que lance `fetch`, que es cómo el sync corta la
 * corrida por una cuenta rechazada.
 */

/** El idioma de respaldo del contenido de hotel. */
export const TBO_CONTENT_FALLBACK_LANG: TboContentLanguage = 'en';

export const TBO_DETAILS_ISOLATION_DEFAULTS = Object.freeze({
  /**
   * Llamadas de aislamiento por lote. Encontrar UN código sin contenido entre 10 (o 13) cuesta a lo
   * sumo 8 (10 → 5+5 → 3+2 → 2+1 → 1+1), más la vuelta al idioma pedido: 9. Con más de uno, lo que
   * no alcanza queda sin resolver para la próxima vez, que ya pide menos códigos.
   */
  maxCallsPerBatch: 10,
});

/** Para qué es cada llamada: el API y el sync la cuentan y la etiquetan distinto. */
export type TboDetailsCallPurpose = 'primary' | 'fallback' | 'isolation';

export type TboDetailsFetchOutcome<F> =
  | { readonly ok: true; readonly result: TboHotelDetailsMapping }
  | { readonly ok: false; readonly failure: F };

/** UNA llamada a HotelDetails, como la haga quien llama (circuito, puerta, plazo, intentos). */
export type TboDetailsFetch<F> = (
  hotelCodes: readonly string[],
  lang: TboContentLanguage,
  purpose: TboDetailsCallPurpose,
) => Promise<TboDetailsFetchOutcome<F>>;

/**
 * Lo que quien llama ya sabe del respaldo de un código, p. ej. el sync dentro de una corrida:
 * `content` = el inglés ya se trajo; `none` = TBO ya confirmó que no lo tiene en inglés.
 */
export type TboFallbackKnowledge = 'content' | 'none';

export interface TboDetailsResolveOptions {
  /** Llamadas de aislamiento por lote; por defecto {@link TBO_DETAILS_ISOLATION_DEFAULTS}. */
  readonly maxIsolationCalls?: number;
  /** Se consulta justo antes de cada llamada de aislamiento; `false` = sin cupo, no sale. */
  readonly allowIsolationCall?: () => boolean;
  /** Los códigos con respaldo ya conocido no se vuelven a pedir en inglés. */
  readonly fallbackKnown?: (hotelCode: string) => TboFallbackKnowledge | undefined;
}

export interface TboDetailsCalls {
  readonly primary: number;
  readonly fallback: number;
  readonly isolation: number;
}

/**
 * La respuesta final de un lote. `foundInLang`, `foundInFallback`, `withoutContent`, `unconfirmed`
 * y `unresolved` reparten los códigos pedidos: cada uno está en una sola.
 */
export interface TboDetailsResolution<F> {
  readonly lang: TboContentLanguage;
  /** Los códigos pedidos, sin repetir y en su orden. */
  readonly requested: readonly string[];
  /** El contenido que llegó, del idioma pedido y del respaldo: cada uno dice el suyo. */
  readonly contents: readonly TboHotelContent[];
  /** Lo que HotelDetails trajo del catálogo; un hotel una vez, de la primera respuesta que lo trajo. */
  readonly hotels: readonly TboCatalogHotel[];
  /** Con contenido en el idioma pedido. */
  readonly foundInLang: readonly string[];
  /** Sin contenido en el idioma pedido y con contenido en el respaldo (traído ahora o ya conocido). */
  readonly foundInFallback: readonly string[];
  /** TBO confirmó que no tiene contenido en el idioma pedido NI en el respaldo (con `en`, en inglés). */
  readonly withoutContent: readonly string[];
  /**
   * TBO contestó sin su contenido, pero no confirmó que no lo tiene en los dos idiomas: el idioma
   * pedido sólo llegó en un lote "No Hotels Found" que no descarta H2, o faltó en una respuesta con
   * elementos que el ACL descartó. No dicen que el hotel no tenga contenido.
   */
  readonly unconfirmed: readonly string[];
  /** Sin respuesta final: tope o cupo de aislamiento agotado, o una llamada que falló. */
  readonly unresolved: readonly string[];
  /**
   * Confirmados sin contenido en el respaldo, tengan o no el idioma pedido: con `en`, lo mismo que
   * `withoutContent`. El sync los recuerda en la corrida para no volver a pedirlos en inglés.
   */
  readonly withoutFallback: readonly string[];
  /**
   * H2 observada: sin contenido en inglés y, en el lote, el "No Hotels Found" era de ellos (sus
   * compañeros sí tenían contenido). Un lote con uno de éstos vuelve vacío entero.
   */
  readonly batchBreakers: readonly string[];
  /** El fallo de la llamada principal: no se intentó nada más y todo lo pedido queda sin resolver. */
  readonly primaryFailure?: F;
  /** Los fallos de las llamadas de respaldo o aislamiento. */
  readonly extraFailures: readonly F[];
  readonly calls: TboDetailsCalls;
  /** Algo quedó sin resolver por el tope por lote o por el cupo, no por un fallo. */
  readonly isolationLimited: boolean;
  /** Respuestas con elementos descartados o sin contenedor: lo que faltó en ellas no se confirmó. */
  readonly untrustedResponses: number;
  /** Nombres de claves desconocidas de todas las respuestas, sin repetir. Nunca valores. */
  readonly unknownKeys: readonly string[];
}

function halves(codes: readonly string[]): [string[], string[]] {
  const middle = Math.ceil(codes.length / 2);
  return [codes.slice(0, middle), codes.slice(middle)];
}

/** Lo que dijo UNA respuesta de los códigos pedidos en ella. */
interface Taken {
  /** Pedidos que no volvieron con contenido. */
  readonly missing: string[];
  /** `false`: la respuesta tuvo elementos descartados o no traía el contenedor. */
  readonly trusted: boolean;
  /** Trajo contenido de alguno de los pedidos. */
  readonly found: boolean;
}

/**
 * Una respuesta en la que lo que falta puede ser un elemento que el ACL no entendió: no confirma
 * nada. `DUPLICATE` y `NOT_REQUESTED` no esconden un código pedido; `ITEM_SCHEMA` sí.
 */
function isTrusted(result: TboHotelDetailsMapping): boolean {
  const { rejected, notes } = result.diagnostics;
  return (rejected.ITEM_SCHEMA ?? 0) === 0 && (notes.CONTAINER_MISSING ?? 0) === 0;
}

/** Lo que va juntando la resolución de UN lote. */
class Ledger<F> {
  readonly contents: TboHotelContent[] = [];
  readonly hotels: TboCatalogHotel[] = [];
  readonly foundIn = new Map<string, TboContentLanguage>();
  /** Por código, los idiomas en que TBO confirmó que no tiene contenido. */
  readonly absent = new Map<string, Set<TboContentLanguage>>();
  /** Faltaron en una respuesta que no confirma nada (elementos descartados, sin contenedor). */
  readonly untrustedMissing = new Set<string>();
  readonly extraFailures: F[] = [];
  readonly unknownKeys = new Set<string>();
  readonly #hotelIds = new Set<string>();
  readonly #contentKeys = new Set<string>();
  calls = { primary: 0, fallback: 0, isolation: 0 };
  isolationLimited = false;
  untrustedResponses = 0;
  /** Una llamada extra falló: no sale ninguna más de este lote. */
  halted = false;

  constructor(readonly lang: TboContentLanguage) {}

  isAbsent(code: string, lang: TboContentLanguage): boolean {
    return this.absent.get(code)?.has(lang) === true;
  }

  markAbsent(code: string, lang: TboContentLanguage): void {
    const langs = this.absent.get(code) ?? new Set<TboContentLanguage>();
    langs.add(lang);
    this.absent.set(code, langs);
  }

  /**
   * Guarda lo que volvió de `asked` en `lang` y confirma lo que la respuesta confirma: lo que faltó
   * en un 200 de fiar, o el código pedido solo que volvió "No Hotels Found".
   */
  take(result: TboHotelDetailsMapping, asked: readonly string[], lang: TboContentLanguage): Taken {
    const askedSet = new Set(asked);
    for (const key of result.diagnostics.unknownKeys) this.unknownKeys.add(key);
    const trusted = isTrusted(result);
    if (!trusted) this.untrustedResponses += 1;
    const returned = new Set<string>();
    for (const content of result.contents) {
      // El mapper ya descarta lo que no se pidió; esto es la red si alguien lo cambia.
      if (!askedSet.has(content.hotelId)) continue;
      returned.add(content.hotelId);
      const key = `${content.hotelId} ${content.lang}`;
      if (!this.#contentKeys.has(key)) {
        this.#contentKeys.add(key);
        this.contents.push(content);
      }
      // El idioma pedido le gana al respaldo: la vuelta al idioma pedido puede traerlo después.
      if (!this.foundIn.has(content.hotelId) || content.lang === this.lang) {
        this.foundIn.set(content.hotelId, content.lang);
      }
    }
    for (const hotel of result.hotels) {
      if (!askedSet.has(hotel.hotelId) || this.#hotelIds.has(hotel.hotelId)) continue;
      this.#hotelIds.add(hotel.hotelId);
      this.hotels.push(hotel);
    }
    const missing = asked.filter((code) => !returned.has(code));
    const confirms =
      result.outcome === 'NO_HOTELS_FOUND' ? asked.length === 1 : trusted && missing.length > 0;
    for (const code of missing) {
      if (confirms) this.markAbsent(code, lang);
      else if (!trusted) this.untrustedMissing.add(code);
    }
    return { missing, trusted, found: returned.size > 0 };
  }
}

/**
 * Resuelve UN lote (a lo sumo 13 códigos, los del builder) en `lang`. Ver el comentario del módulo.
 */
export async function resolveTboHotelDetails<F>(
  hotelCodes: readonly string[],
  lang: TboContentLanguage,
  fetch: TboDetailsFetch<F>,
  options: TboDetailsResolveOptions = {},
): Promise<TboDetailsResolution<F>> {
  const requested = [...new Set(hotelCodes)];
  const maxIsolation = Math.max(
    0,
    Math.floor(options.maxIsolationCalls ?? TBO_DETAILS_ISOLATION_DEFAULTS.maxCallsPerBatch),
  );
  const fallbackLang = TBO_CONTENT_FALLBACK_LANG;
  const ledger = new Ledger<F>(lang);
  const knownFallbackContent = new Set<string>();
  /** Códigos que, pedidos solos al partir un lote, volvieron "No Hotels Found" en inglés. */
  const aloneWithout = new Set<string>();
  /** Una mitad de un lote "No Hotels Found" trajo contenido: H2 observada. */
  let h2Observed = false;

  const primary = await fetch(requested, lang, 'primary');
  ledger.calls.primary += 1;
  if (!primary.ok) {
    return finish(ledger, requested, knownFallbackContent, aloneWithout, false, primary.failure);
  }
  const { missing: missingInLang } = ledger.take(primary.result, requested, lang);
  const primaryNoHotels = primary.result.outcome === 'NO_HOTELS_FOUND' && requested.length > 1;
  if (missingInLang.length === 0) {
    return finish(ledger, requested, knownFallbackContent, aloneWithout, false);
  }

  /** Grupos que volvieron "No Hotels Found" en inglés y hay que partir. */
  const toIsolate: string[][] = [];

  if (lang === fallbackLang) {
    // Pedido ya en inglés: no hay respaldo. Lo que faltó en un 200 ya quedó confirmado; un lote
    // entero "No Hotels Found" se parte.
    if (primaryNoHotels) toIsolate.push(missingInLang);
  } else {
    const ask: string[] = [];
    for (const code of missingInLang) {
      const known = options.fallbackKnown?.(code);
      if (known === 'content') knownFallbackContent.add(code);
      else if (known === 'none') ledger.markAbsent(code, fallbackLang);
      else ask.push(code);
    }
    if (ask.length > 0) {
      const fallback = await fetch(ask, fallbackLang, 'fallback');
      ledger.calls.fallback += 1;
      if (!fallback.ok) {
        ledger.extraFailures.push(fallback.failure);
        ledger.halted = true;
      } else {
        const taken = ledger.take(fallback.result, ask, fallbackLang);
        if (fallback.result.outcome === 'NO_HOTELS_FOUND') {
          if (ask.length > 1) toIsolate.push(taken.missing);
        } else if (primaryNoHotels && taken.trusted && taken.missing.length > 0) {
          // H2 descartada: en inglés un código sin contenido no tumbó el lote, así que el vacío del
          // idioma pedido es H1 y ninguno de los que faltaron lo tiene.
          for (const code of missingInLang) ledger.markAbsent(code, lang);
        }
      }
    }
  }

  const canIsolate = (): boolean => {
    if (ledger.halted) return false;
    if (ledger.calls.isolation >= maxIsolation || options.allowIsolationCall?.() === false) {
      ledger.isolationLimited = true;
      return false;
    }
    return true;
  };

  // En profundidad, como la partición por fallo del sync: una mitad se termina antes de la otra.
  const stack = toIsolate.reverse();
  for (let group = stack.pop(); group !== undefined; group = stack.pop()) {
    if (group.length < 2) continue;
    const pending: string[][] = [];
    for (const half of halves(group)) {
      // Sin llamada, la mitad queda sin resolver: no está ni encontrada ni confirmada (`finish`).
      if (!canIsolate()) continue;
      const outcome = await fetch(half, fallbackLang, 'isolation');
      ledger.calls.isolation += 1;
      if (!outcome.ok) {
        ledger.extraFailures.push(outcome.failure);
        ledger.halted = true;
        continue;
      }
      const taken = ledger.take(outcome.result, half, fallbackLang);
      if (taken.found) h2Observed = true;
      if (outcome.result.outcome !== 'NO_HOTELS_FOUND') continue;
      // `take` ya confirmó el código solo; uno de varios se sigue partiendo.
      const [only] = half;
      if (half.length === 1 && only !== undefined) aloneWithout.add(only);
      else pending.push(taken.missing);
    }
    // La primera mitad queda arriba de la pila: se termina antes que la segunda.
    for (const half of pending.reverse()) stack.push(half);
  }

  // H2 observada: sin los que tumban el lote, los demás se piden UNA vez en el idioma pedido. Van los
  // que tienen inglés (traído o conocido) y los que TBO ya confirmó sin inglés en un 200, que no
  // tumban nada; no van los que quedaron sin resolver, que pueden ser otro que lo tumba.
  if (primaryNoHotels && lang !== fallbackLang && h2Observed && aloneWithout.size > 0) {
    const innocent = requested.filter(
      (code) =>
        ledger.foundIn.get(code) !== lang &&
        !aloneWithout.has(code) &&
        (ledger.foundIn.has(code) ||
          knownFallbackContent.has(code) ||
          ledger.isAbsent(code, fallbackLang)),
    );
    if (innocent.length > 0 && canIsolate()) {
      const outcome = await fetch(innocent, lang, 'isolation');
      ledger.calls.isolation += 1;
      if (!outcome.ok) {
        ledger.extraFailures.push(outcome.failure);
        ledger.halted = true;
      } else {
        const taken = ledger.take(outcome.result, innocent, lang);
        // Sin ellos el lote respondió: el "No Hotels Found" del idioma pedido era suyo.
        if (outcome.result.outcome === 'DETAILS' && taken.trusted) {
          for (const code of aloneWithout) ledger.markAbsent(code, lang);
        }
      }
    }
  }

  return finish(ledger, requested, knownFallbackContent, aloneWithout, h2Observed);
}

function finish<F>(
  ledger: Ledger<F>,
  requested: readonly string[],
  knownFallbackContent: ReadonlySet<string>,
  aloneWithout: ReadonlySet<string>,
  h2Observed: boolean,
  primaryFailure?: F,
): TboDetailsResolution<F> {
  const { lang } = ledger;
  const fallbackLang = TBO_CONTENT_FALLBACK_LANG;
  const foundInLang = requested.filter((code) => ledger.foundIn.get(code) === lang);
  const foundInFallback = requested.filter(
    (code) =>
      ledger.foundIn.get(code) !== lang &&
      (ledger.foundIn.has(code) || knownFallbackContent.has(code)),
  );
  const found = new Set([...foundInLang, ...foundInFallback]);
  const missing = requested.filter((code) => !found.has(code));
  // Un código con contenido nunca queda "sin contenido", aunque otra llamada lo haya dado por
  // perdido. Sin contenido confirmado es sin el idioma pedido Y sin el respaldo.
  const withoutFallback = missing.filter((code) => ledger.isAbsent(code, fallbackLang));
  const withoutContent = withoutFallback.filter((code) => ledger.isAbsent(code, lang));
  const confirmed = new Set(withoutContent);
  // TBO contestó de él sin confirmar los dos idiomas: sin inglés confirmado, o con una respuesta
  // de la que no se puede fiar. Sin resolver es lo que no se llegó a preguntar o no contestó.
  const unconfirmed = missing.filter(
    (code) =>
      !confirmed.has(code) &&
      (ledger.isAbsent(code, fallbackLang) || ledger.untrustedMissing.has(code)),
  );
  const answered = new Set([...confirmed, ...unconfirmed]);
  const unresolved = missing.filter((code) => !answered.has(code));
  return {
    lang,
    requested,
    contents: ledger.contents,
    hotels: ledger.hotels,
    foundInLang,
    foundInFallback,
    withoutContent,
    unconfirmed,
    unresolved,
    withoutFallback,
    batchBreakers: h2Observed ? requested.filter((code) => aloneWithout.has(code)) : [],
    ...(primaryFailure === undefined ? {} : { primaryFailure }),
    extraFailures: ledger.extraFailures,
    calls: { ...ledger.calls },
    isolationLimited: ledger.isolationLimited,
    untrustedResponses: ledger.untrustedResponses,
    unknownKeys: [...ledger.unknownKeys],
  };
}
