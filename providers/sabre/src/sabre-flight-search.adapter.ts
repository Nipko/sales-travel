import type { CachePort, LoggerPort } from '@sales-travel/core';
import type { Offer } from '@sales-travel/canonical';
import type { FlightSearchCriteria, FlightSearchPort, SearchContext } from '@sales-travel/domain';
import { SabreTokenService, type SabreFetch, type SabreTokenProvider } from './auth/token.service';
import { missingSabreCredentials, sabreConversationIdPrefix, type SabreConfig } from './config';
import { SabreApiError, SabreConfigError } from './errors';
import { SabreHttpClient, type SabreResult } from './http/sabre-http.client';
import { logRedacted, type SabreLogLevel } from './redaction';
import {
  SABRE_BRANDED_FARES_DEFAULT,
  degradarBrandedFares,
  type SabreBrandedFaresMode,
  SABRE_MULTIPLE_FARES_DEFAULT,
  SABRE_SHOP_PATH,
  buildSabreShopRequest,
  type SabreShopOptions,
} from './shop/request.builder';
import {
  mapSabreShopResponse,
  type SabreMapWarning,
  type SabreMapWarningCode,
  type SabreShopMapResult,
} from './shop/response.mapper';

/**
 * ¿Este fallo significa «tu PCC no tiene esta función» y no «la búsqueda falló»?
 *
 * Cerrado a dos clases a propósito. `ENTITLEMENT` es el caso nombrado; `BUSINESS` es donde cae
 * hoy el rechazo real observado en producción, porque Sabre lo devuelve dentro de un 200 con un
 * código que el clasificador no tiene mapeado. Ampliar esto a más clases convertiría el
 * reintento en un «si algo falla, prueba otra cosa», que esconde averías en vez de degradar.
 */
function esRechazoDeCapacidad(err: unknown): boolean {
  return (
    err instanceof SabreApiError &&
    (err.failure.kind === 'ENTITLEMENT' || err.failure.kind === 'BUSINESS')
  );
}

/** El más conservador de dos modos. `off` < `single` < `upsell`. */
function menorModo(a: SabreBrandedFaresMode, b: SabreBrandedFaresMode): SabreBrandedFaresMode {
  const rango: Record<SabreBrandedFaresMode, number> = { off: 0, single: 1, upsell: 2 };
  return rango[a] <= rango[b] ? a : b;
}

export interface SabreFlightSearchDeps {
  fetch?: SabreFetch;
  cache?: CachePort;
  logger?: LoggerPort;
  now?: () => number;
  uuid?: () => string;
  sleep?: (ms: number) => Promise<void>;
  jitter?: () => number;
  /** `ownerTenantId` de la `provider_account` resuelta: entra en la clave de caché del ATK. */
  cacheNamespace?: string;
  /** Opciones de BFM (tier, `MaximumNumberOfPCCs`). Se validan dentro del builder. */
  shopOptions?: SabreShopOptions;
  /** Sustituye al `SabreTokenService` por defecto. Sólo para tests. */
  tokens?: SabreTokenProvider;
}

/**
 * Anti-Corruption Layer de Sabre para búsqueda de vuelos (RF-03, RF-04).
 *
 * Un único modo: `POST /v5/offers/shop` y `groupedItineraryResponse` → `Offer[]` canónico.
 *
 * El modo mock —fixtures sintéticas con la misma forma canónica que una tarifa real— ya no
 * existe: sin `epr`, `password` u `homePcc` esta clase NO se construye, así que ninguna
 * instancia puede devolver una oferta que Sabre no haya cotizado.
 *
 * Ver `docs/sabre/11-plan-implementacion.md` §6.
 */
export class SabreFlightSearchAdapter implements FlightSearchPort {
  private readonly tokens: SabreTokenProvider;
  private readonly http: SabreHttpClient;

  /**
   * Nombres —nunca valores— de las credenciales que faltan. Para el panel BYOC y los logs.
   *
   * En una instancia viva sale siempre vacío —el constructor rechaza lo contrario—; se conserva
   * porque el factory de `apps/api` lo lee al construir para decir QUÉ falta.
   */
  get missingCredentials(): readonly string[] {
    return missingSabreCredentials(this.cfg);
  }

  /**
   * Esta cuenta pidió marcas tarifarias y Sabre las rechazó por capacidad.
   *
   * Vive en la INSTANCIA, y el factory cachea una instancia por credenciales, así que el coste de
   * descubrirlo es UNA llamada de más por agencia y por vida del proceso — no una por búsqueda.
   * No se persiste a propósito: un alta comercial con Sabre no emite ningún evento hacia nosotros,
   * y un flag en base de datos lo dejaría apagado para siempre sin que nadie sepa por qué.
   */
  /**
   * Techo al que esta cuenta puede aspirar en marcas, aprendido de los rechazos del motor.
   *
   * `null` = todavía no se sabe, se pide lo que diga la config. Cada rechazo baja UN escalón
   * (`upsell` → `single` → `off`) en vez de apagarlo todo: `single` funciona en producción y
   * perderlo por un rechazo del upsell sería cambiar una función que anda por ninguna.
   */
  private brandedFaresTecho: SabreBrandedFaresMode | null = null;

  /**
   * Esta cuenta YA devolvió ofertas pidiendo marcas, así que una ruta vacía es una ruta vacía y
   * no una sospecha. Sin este flag, cada búsqueda sin resultados de una agencia que sí las
   * soporta pagaría una segunda llamada para comprobar algo que ya se sabe.
   */
  private brandedFaresProven = false;

  /**
   * Igual que {@link brandedFaresUnsupported}, para MFPI (`multipleFares`).
   *
   * Se recuerdan POR SEPARADO a propósito: son dos funciones distintas de Sabre y que falte una
   * no dice nada de la otra. Un solo flag apagaría las marcas —que en esta cuenta funcionan— por
   * culpa de una función experimental.
   */
  private multipleFaresUnsupported = false;

  constructor(
    private readonly cfg: SabreConfig,
    private readonly deps: SabreFlightSearchDeps = {},
  ) {
    // Rechaza la construcción sin credenciales usables. Está aquí —y no sólo en el factory de
    // `apps/api`— porque es la barrera que un llamador nuevo no puede saltarse por olvido:
    // mientras la comprobación viva únicamente en quien construye, cada sitio de construcción
    // nuevo la vuelve a arriesgar. El mensaje nombra los campos, nunca sus valores (RNF-07).
    const missing = missingSabreCredentials(cfg);
    if (missing.length > 0) {
      throw new SabreConfigError(
        `no se puede construir el adapter de Sabre sin credenciales usables (faltan: ${missing.join(', ')})`,
      );
    }

    this.tokens =
      deps.tokens ??
      new SabreTokenService(cfg, {
        ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
        ...(deps.cache === undefined ? {} : { cache: deps.cache }),
        ...(deps.logger === undefined ? {} : { logger: deps.logger }),
        ...(deps.now === undefined ? {} : { now: deps.now }),
        ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
        ...(deps.jitter === undefined ? {} : { jitter: deps.jitter }),
        ...(deps.cacheNamespace === undefined ? {} : { cacheNamespace: deps.cacheNamespace }),
      });
    this.http = new SabreHttpClient(cfg, this.tokens, {
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
      ...(deps.jitter === undefined ? {} : { jitter: deps.jitter }),
      ...(deps.uuid === undefined ? {} : { uuid: deps.uuid }),
    });
  }

  async search(criteria: FlightSearchCriteria, ctx: SearchContext): Promise<Offer[]> {
    const opciones = this.deps.shopOptions ?? {};
    // Las marcas tarifarias son una capacidad del PCC, no una opción universal. Si esta cuenta ya
    // demostró no tenerla, no se vuelve a pedir: ver `brandedFaresUnsupported`.
    // `?? DEFAULT`, NO `=== true`: `deps.shopOptions` es la entrada SIN parsear, y el default del
    // Zod se aplica al parsear, no antes. Con `=== true` sobre un campo ausente salía `false`, y
    // encima se le pasaba explícito al builder pisando su propio default: las marcas estaban
    // apagadas para toda la red mientras el código decía lo contrario.
    const pedido = opciones.brandedFares ?? SABRE_BRANDED_FARES_DEFAULT;
    const modo =
      this.brandedFaresTecho === null ? pedido : menorModo(pedido, this.brandedFaresTecho);
    const pedirMarcas = modo !== 'off';
    const modoMulti = opciones.multipleFares ?? SABRE_MULTIPLE_FARES_DEFAULT;
    const pedirMulti = modoMulti !== 'off' && !this.multipleFaresUnsupported;
    const body = buildSabreShopRequest(criteria, this.cfg, {
      ...opciones,
      brandedFares: modo,
      multipleFares: pedirMulti ? modoMulti : 'off',
    });

    // Una búsqueda no mueve dinero ni crea estado: es de las pocas llamadas de Sabre que SÍ se
    // puede reintentar. El cliente HTTP ignora esta marca en los paths de `SABRE_NON_IDEMPOTENT_PATHS`.
    const opciones_http = {
      idempotent: true as const,
      ...(ctx.requestId === undefined
        ? {}
        : { conversationId: `${sabreConversationIdPrefix(this.cfg)}-${ctx.requestId}` }),
    };

    let result: SabreResult<unknown>;
    try {
      result = await this.http.postJson<unknown>(SABRE_SHOP_PATH, body, opciones_http);
    } catch (err) {
      // Degradación, no rescate genérico: SÓLO cuando el único extra que llevaba la consulta
      // eran las marcas, y sólo ante los fallos que significan «tu PCC no hace esto».
      //
      // Existe por un incidente: pedir marcas a un PCC que no las tiene no devuelve una lista
      // sin marcas, devuelve un fallo de negocio, y eso dejó el buscador entero en 502. Que una
      // mejora opcional pueda tumbar la búsqueda es el fallo de diseño; el reintento lo cierra.
      if ((!pedirMarcas && !pedirMulti) || !esRechazoDeCapacidad(err)) throw err;

      // Se apaga UNA función por reintento, y MFPI primero: es la más nueva y la que menos
      // evidencia tiene. Apagar las dos de golpe perdería las marcas —que en esta cuenta SÍ
      // funcionan— por culpa de una función experimental que nadie encendió por defecto.
      //
      // El log va por `this.log`, NUNCA por `this.deps.logger` directo: ahí es donde se etiqueta
      // el proveedor y la meta pasa por `redactMeta`. Un guard del paquete lo vigila y ya cazó
      // una versión de esto — el `code` de Sabre es la clase de dato que tiene que cruzar esa
      // puerta.
      const detalle =
        err instanceof SabreApiError ? { kind: err.failure.kind, code: err.code } : {};
      let reintento: SabreShopOptions;
      if (pedirMulti) {
        this.multipleFaresUnsupported = true;
        this.log('warn', 'sabre.shop.multiple_fares_no_soportadas', {
          path: SABRE_SHOP_PATH,
          ...detalle,
        });
        reintento = { ...opciones, multipleFares: 'off' };
      } else {
        // Se recuerda POR INSTANCIA, y el factory cachea una instancia por credenciales: la
        // siguiente búsqueda de esta agencia ya no paga la llamada de más.
        const bajado = degradarBrandedFares(modo);
        this.brandedFaresTecho = bajado;
        this.log('warn', 'sabre.shop.branded_fares_degradado', {
          path: SABRE_SHOP_PATH,
          de: modo,
          a: bajado,
          ...detalle,
        });
        reintento = { ...opciones, brandedFares: bajado };
      }

      result = await this.http.postJson<unknown>(
        SABRE_SHOP_PATH,
        buildSabreShopRequest(criteria, this.cfg, reintento),
        opciones_http,
      );
    }

    let mapped = this.mapear(result, criteria, ctx);

    // El OTRO modo de fallar de Sabre, y el peor: no rechazar, devolver CERO. La propia doc del
    // proyecto lo documenta para el tier (`docs/sabre/02` §8.1) — «pedir uno al que la agencia no
    // está suscrita no devuelve error, sino cero resultados, indistinguible de "no hay vuelos"».
    // Sin esto, encender las marcas en una cuenta que no las tiene no da un 502 sino algo peor:
    // un buscador que dice «no hay vuelos» en una ruta que sí los tiene, y nadie se entera.
    //
    // Se paga UNA vez por instancia: si el reintento tampoco trae nada, la ruta está vacía de
    // verdad y no se marca nada.
    if (mapped.offers.length === 0 && pedirMarcas && !this.brandedFaresProven) {
      const sinMarcas = await this.http.postJson<unknown>(
        SABRE_SHOP_PATH,
        buildSabreShopRequest(criteria, this.cfg, {
          ...opciones,
          brandedFares: 'off',
          multipleFares: 'off',
        }),
        opciones_http,
      );
      const reintento = this.mapear(sinMarcas, criteria, ctx);
      if (reintento.offers.length > 0) {
        // La respuesta VACÍA también degrada un escalón, por la misma razón que el rechazo.
        this.brandedFaresTecho = degradarBrandedFares(modo);
        this.log('warn', 'sabre.shop.branded_fares_vacian_la_respuesta', {
          path: SABRE_SHOP_PATH,
          offersSinMarcas: reintento.offers.length,
        });
        result = sinMarcas;
        mapped = reintento;
      }
    } else if (mapped.offers.length > 0 && pedirMarcas) {
      // Esta cuenta SÍ las soporta: no se vuelve a sospechar de ella en una ruta vacía.
      this.brandedFaresProven = true;
    }

    // Lo que se logue es lo que ESTA respuesta llevaba, no lo que se pretendía: si la degradación
    // saltó, el sobre que se mapeó vino sin marcas, y decir `pidioMarcas: true` al lado de
    // `conMarca: 0` invita a concluir «el PCC no publica marcas» cuando lo que pasó es que las
    // rechazó y se reintentó sin ellas. Son dos diagnósticos distintos.
    this.logMapping(mapped, result, ctx, this.brandedFaresTecho === 'off' ? false : pedirMarcas);
    return mapped.offers;
  }

  /** El mapeo, en un solo sitio: lo llaman el camino normal y el reintento sin marcas. */
  private mapear(
    result: SabreResult<unknown>,
    criteria: FlightSearchCriteria,
    ctx: SearchContext,
  ): ReturnType<typeof mapSabreShopResponse> {
    return mapSabreShopResponse(result.data, {
      tenantId: ctx.tenantId,
      // La MISMA moneda que se pidió en `PriceRequestInformation.CurrencyCode`. Pedirla no
      // obliga a Sabre a respetarla, así que el mapper vuelve a compararla y descarta lo que
      // no encaje: el ACL no deja salir una tarifa que la agencia no puede cotizar.
      currency: criteria.currency,
      fetchedAt: new Date((this.deps.now ?? Date.now)()).toISOString(),
    });
  }

  /**
   * Lo que se sube a la superficie de un mapeo. Nunca el payload ni texto del proveedor: sólo
   * códigos propios y conteos (RNF-07). Un `groupedItineraryResponse` arrastra nombres de
   * pasajero en algunas variantes; loguearlo entero sería filtrar PII.
   */
  private logMapping(
    mapped: SabreShopMapResult,
    result: SabreResult<unknown>,
    ctx: SearchContext,
    pidioMarcas: boolean,
  ): void {
    const meta = {
      tenantId: ctx.tenantId,
      conversationId: result.conversationId,
      durationMs: result.durationMs,
      offers: mapped.offers.length,
      // `pidioMarcas` va al lado del censo a propósito: `conMarca: 0` sin saber si se pidieron
      // no dice nada. Juntos sí: pedidas y cero = el PCC no publica marcas en esta ruta.
      pidioMarcas,
      ...censoDeContenido(mapped.offers),
      ...(mapped.statistics === undefined ? {} : { statistics: mapped.statistics }),
    };

    if (mapped.warnings.length > 0) {
      this.log('warn', 'sabre.shop.warnings', {
        ...meta,
        warnings: countWarningsByCode(mapped.warnings),
      });
    }

    // Degradación declarada por Sabre: la respuesta llegó, pero incompleta. Callarla convierte
    // "te devolví menos de lo que había" en "no hay vuelos" en la pantalla del vendedor (RNF-13).
    if (mapped.degraded || result.partialUnauthorized.length > 0) {
      this.log('warn', 'sabre.shop.degradado', {
        ...meta,
        partialUnauthorized: result.partialUnauthorized.length,
      });
      return;
    }

    if (mapped.warnings.length === 0) this.log('debug', 'sabre.shop.ok', meta);
  }

  /**
   * La meta de este adapter la compone el LLAMADOR, no este paquete: `ctx.tenantId` y el
   * `ctx.requestId` que acaba dentro del `conversationId` cruzan el port desde el fan-out. Son
   * datos de fuera y por eso pasan por la misma pasada que el resto (RNF-07). El reenvío no lleva
   * política: vive en `redaction.ts`.
   */
  private log(level: SabreLogLevel, message: string, meta: Record<string, unknown>): void {
    logRedacted(this.deps.logger, level, message, meta);
  }
}

/**
 * Qué CONTENIDO trae la respuesta, no cuánto.
 *
 * `offers: 50` no distingue «50 vuelos con una tarifa cada uno» de «50 tarifas de 12 vuelos», y
 * ésa es justo la pregunta cuando se acaba de encender el upsell de marcas: si el PCC no publica
 * marcas, pedirlas no da error —da exactamente lo mismo de antes— y sin este conteo la única
 * forma de saberlo es mirar la pantalla y opinar.
 *
 * `marcas` lleva los NOMBRES porque son códigos de producto de la aerolínea (`LIGHT`, `PLUS`),
 * no datos de nadie; se ordenan y se acotan para que el log no crezca con la respuesta.
 */
export function censoDeContenido(offers: readonly Offer[]): {
  conMarca: number;
  marcas: string[];
  conEquipaje: number;
  conMarcaDisponible: number;
} {
  const marcas = new Set<string>();
  let conMarca = 0;
  let conEquipaje = 0;
  let conMarcaDisponible = 0;

  for (const offer of offers) {
    const nombre = offer.fareFamily?.name;
    if (nombre !== undefined && nombre.length > 0) {
      conMarca += 1;
      marcas.add(nombre);
    }
    if (offer.baggage !== undefined) conEquipaje += 1;
    if (offer.provider.raw?.['brandsOnAnyMarket'] === true) conMarcaDisponible += 1;
  }

  return {
    conMarca,
    marcas: [...marcas].sort().slice(0, 12),
    conEquipaje,
    // La diferencia entre `conMarcaDisponible` y `conMarca` es el diagnóstico entero:
    //   0 y 0  → el contenido NO tiene marcas. No hay nada que habilitar con Sabre.
    //   N y 0  → las marcas existen y no nos llegan. Eso sí es el alta de MIP pendiente.
    conMarcaDisponible,
  };
}

/**
 * Warnings agregados por código. Se cuentan en vez de listarse porque una respuesta de BFM trae
 * cientos de itinerarios: un `leg-ref-unresolved` por cada uno llenaría el log sin decir nada más
 * que el número.
 */
export function countWarningsByCode(
  warnings: readonly SabreMapWarning[],
): Partial<Record<SabreMapWarningCode, number>> {
  const counts: Partial<Record<SabreMapWarningCode, number>> = {};
  for (const warning of warnings) {
    counts[warning.code] = (counts[warning.code] ?? 0) + 1;
  }
  return counts;
}
