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
  type SabreMultipleFaresMode,
  SABRE_BRAND_LADDER_DEFAULT,
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

/** El código de marca que el mapper dejó en `provider.raw`, o `null`. */
function codigoDeMarca(offer: Offer): string | null {
  const code = offer.provider.raw?.['brandCode'];
  return typeof code === 'string' && code.length > 0 ? code : null;
}

/** Carrier comercializador único de toda la oferta; `null` para interline/multi-carrier. */
function carrierUnico(offer: Offer): string | null {
  const carriers = new Set(
    (offer.itineraries ?? []).flatMap((itinerary) =>
      itinerary.segments.map((segment) => segment.carrier),
    ),
  );
  return carriers.size === 1 ? [...carriers][0]! : null;
}

/**
 * Identidad del vuelo, deliberadamente sin clase de reserva ni marca: ambas cambian al subir la
 * escalera. Incluye los límites de tramo para no confundir dos combinaciones con los mismos
 * segmentos en distinto sentido.
 */
function claveDeItinerario(offer: Offer): string | null {
  if (offer.itineraries === undefined || offer.itineraries.length === 0) return null;
  return JSON.stringify(
    offer.itineraries.map((itinerary) =>
      itinerary.segments.map((segment) => [
        segment.carrier,
        segment.flightNumber,
        segment.origin,
        segment.destination,
        segment.departureAt,
        segment.arrivalAt,
      ]),
    ),
  );
}

interface EscaleraCarrier {
  /** Códigos ya observados POR vuelo; jamás se unen globalmente. */
  itinerarios: Map<string, Set<string>>;
}

/** Sólo excluye un código si TODOS los vuelos de este carrier ya lo tienen. */
function codigosComunes(state: EscaleraCarrier): string[] {
  let comunes: Set<string> | null = null;
  for (const vistos of state.itinerarios.values()) {
    if (comunes === null) {
      comunes = new Set(vistos);
      continue;
    }
    for (const code of comunes) {
      if (!vistos.has(code)) comunes.delete(code);
    }
  }
  return [...(comunes ?? new Set<string>())].sort();
}

function estadosDeEscalera(offers: readonly Offer[]): Map<string, EscaleraCarrier> {
  const carriers = new Map<string, EscaleraCarrier>();
  for (const offer of offers) {
    const code = codigoDeMarca(offer);
    const carrier = carrierUnico(offer);
    const itinerary = claveDeItinerario(offer);
    // Un filtro request-level no puede aislar con honestidad un itinerario interline ni una
    // combinación ida/vuelta con códigos de marca distintos (`brandCode` es null en ese caso).
    if (code === null || carrier === null || itinerary === null) continue;
    const state = carriers.get(carrier) ?? { itinerarios: new Map<string, Set<string>>() };
    const vistos = state.itinerarios.get(itinerary) ?? new Set<string>();
    vistos.add(code);
    state.itinerarios.set(itinerary, vistos);
    carriers.set(carrier, state);
  }
  return carriers;
}

/** Clase cerrada para diagnóstico; nunca usa `message`, que puede arrastrar texto del proveedor. */
function claseSeguraDeError(error: unknown): string {
  const name = error instanceof Error ? error.name : 'NonErrorThrown';
  return /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(name) ? name : 'UnknownError';
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
    // Una búsqueda no mueve dinero ni crea estado: es de las pocas llamadas de Sabre que SÍ se
    // puede reintentar. El cliente HTTP ignora esta marca en los paths de `SABRE_NON_IDEMPOTENT_PATHS`.
    const opciones_http = {
      idempotent: true as const,
      ...(ctx.requestId === undefined
        ? {}
        : { conversationId: `${sabreConversationIdPrefix(this.cfg)}-${ctx.requestId}` }),
    };

    // Bucle de degradación, NO un reintento único.
    //
    // El reintento único fue un fallo de diseño y tumbó el buscador dos veces. Con DOS funciones
    // opcionales encendidas —MFPI y el upsell de marcas— hacen falta dos escalones, y sólo había
    // uno: la primera respuesta apagaba MFPI, la segunda seguía pidiendo el upsell que ya se
    // sabía rechazado, y el proveedor caía entero. Con `latam-ndc` descartado por moneda, eso es
    // un 502 y el buscador muerto.
    //
    // El bucle baja UN escalón por vuelta hasta que la petición pasa o no queda nada que apagar,
    // y termina siempre: cada vuelta apaga algo y `siguienteDegradacion` devuelve `null` cuando
    // ya no hay. El orden es MFPI primero —la más nueva y la que menos evidencia tiene— y luego
    // las marcas escalón a escalón (`upsell` → `single` → `off`), porque `single` funciona en
    // producción y perderlo por un rechazo del upsell sería cambiar algo que anda por nada.
    let modoActual = modo;
    let multiActual: SabreMultipleFaresMode = pedirMulti ? modoMulti : 'off';
    let result: SabreResult<unknown> | undefined;

    for (;;) {
      const cuerpo = buildSabreShopRequest(criteria, this.cfg, {
        ...opciones,
        brandedFares: modoActual,
        multipleFares: multiActual,
      });
      try {
        result = await this.http.postJson<unknown>(SABRE_SHOP_PATH, cuerpo, opciones_http);
        break;
      } catch (err) {
        if (!esRechazoDeCapacidad(err)) throw err;

        // El log va por `this.log`, NUNCA por `this.deps.logger` directo: ahí es donde se
        // etiqueta el proveedor y la meta pasa por `redactMeta`. Un guard del paquete lo vigila.
        const detalle =
          err instanceof SabreApiError ? { kind: err.failure.kind, code: err.code } : {};

        if (multiActual !== 'off') {
          multiActual = 'off';
          this.multipleFaresUnsupported = true;
          this.log('warn', 'sabre.shop.multiple_fares_no_soportadas', {
            path: SABRE_SHOP_PATH,
            ...detalle,
          });
          continue;
        }

        if (modoActual !== 'off') {
          const bajado = degradarBrandedFares(modoActual);
          this.log('warn', 'sabre.shop.branded_fares_degradado', {
            path: SABRE_SHOP_PATH,
            de: modoActual,
            a: bajado,
            ...detalle,
          });
          modoActual = bajado;
          this.brandedFaresTecho = bajado;
          continue;
        }

        // Sin enriquecimientos que apagar, el fallo es del proveedor y sube tal cual.
        throw err;
      }
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
    const ofertas = await this.escaleraDeMarcas({
      base: mapped.offers,
      criteria,
      ctx,
      opciones,
      modo: modoActual,
      multi: multiActual,
      httpOptions: opciones_http,
    });

    this.logMapping(mapped, result, ctx, this.brandedFaresTecho === 'off' ? false : pedirMarcas);
    return ofertas;
  }

  /**
   * Recorre las marcas del mismo vuelo excluyendo las ya vistas.
   *
   * Es la comparación de tarifas SIN el producto de upsell, que este PCC no tiene. `SingleBranded
   * Fare` devuelve la marca más barata de cada vuelo; volver a preguntar excluyendo esa devuelve
   * la siguiente. Verificado contra CERT: excluida `MAIN`, American pasó de «MAIN CABIN»
   * (no reembolsable) a «MAIN CABIN FLEXIBLE» (reembolsable, +14%).
   *
   * `BrandFilters.Brand` NO tiene carrier: mandarlo en la búsqueda original excluiría un código
   * homónimo para todas las aerolíneas. Por eso cada ronda se acota a un único marketing carrier
   * con `VendorPref=Only`; las ofertas interline se conservan en la base y no se escalan. Dentro
   * del carrier sólo se excluyen códigos ya vistos en TODOS sus itinerarios, para que una marca de
   * un vuelo tampoco salte una familia todavía no observada en otro.
   *
   * **Cada ronda y carrier es una llamada de shop y Sabre cobra por consulta.** Por eso arranca en
   * 0 y se sube por cuenta: es el único parámetro del paquete cuyo coste es lineal y en dinero.
   *
   * Para en cuanto una ronda no aporta marcas nuevas. No hace falta agotar el presupuesto para
   * descubrir que el carrier sólo publica dos.
   */
  private async escaleraDeMarcas(args: {
    base: readonly Offer[];
    criteria: FlightSearchCriteria;
    ctx: SearchContext;
    opciones: SabreShopOptions;
    modo: SabreBrandedFaresMode;
    multi: SabreMultipleFaresMode;
    httpOptions: { idempotent: true; conversationId?: string };
  }): Promise<Offer[]> {
    const rondas = args.opciones.brandLadderRounds ?? SABRE_BRAND_LADDER_DEFAULT;
    if (rondas <= 0 || args.modo === 'off') return [...args.base];

    const ofertas = [...args.base];
    const porCarrier = estadosDeEscalera(args.base);
    if (porCarrier.size === 0) return ofertas;

    for (const [carrier, state] of porCarrier) {
      let exclusionAnterior = '';
      for (let ronda = 0; ronda < rondas; ronda += 1) {
        const excludeBrands = codigosComunes(state);
        const firma = excludeBrands.join('\u0000');
        // Sin intersección no existe un filtro seguro. Si no avanzó, repetir la llamada sólo
        // devolvería lo mismo y volvería a cobrarla.
        if (excludeBrands.length === 0 || firma === exclusionAnterior) break;
        exclusionAnterior = firma;

        let extra;
        try {
          const respuesta = await this.http.postJson<unknown>(
            SABRE_SHOP_PATH,
            buildSabreShopRequest(
              args.criteria,
              this.cfg,
              {
                ...args.opciones,
                brandedFares: args.modo,
                multipleFares: args.multi,
                excludeBrands,
              },
              { onlyMarketingCarrier: carrier },
            ),
            args.httpOptions,
          );
          extra = this.mapear(respuesta, args.criteria, args.ctx);
        } catch (err) {
          // Una ronda extra NO puede costar la búsqueda: lo que ya se tiene es válido y vendible.
          // Esto incluye transporte/timeout, auth, capacidad y mapeo. A diferencia de la primera
          // ronda, la escalera no determina si hay oferta: sólo intenta enriquecer una base que ya
          // pasó contrato. El diagnóstico conserva clase/código cerrados, nunca `message`.
          this.log('warn', 'sabre.shop.escalera_de_marcas_cortada', {
            path: SABRE_SHOP_PATH,
            carrier,
            ronda,
            errorClass: claseSeguraDeError(err),
            ...(err instanceof SabreApiError ? { kind: err.failure.kind, code: err.code } : {}),
          });
          break;
        }

        // La respuesta se vuelve a comprobar: ni un proveedor que ignore `VendorPref`, ni un
        // itinerario nuevo que entró por el ranking puede contaminar el estado de la escalera.
        // Se filtra antes de actualizar los sets para conservar ofertas distintas de la misma
        // familia (p.ej. otra fuente/PCC) dentro del mismo vuelo.
        const nuevas = extra.offers.filter((offer) => {
          if (carrierUnico(offer) !== carrier) return false;
          const itinerary = claveDeItinerario(offer);
          const code = codigoDeMarca(offer);
          if (itinerary === null || code === null) return false;
          const vistos = state.itinerarios.get(itinerary);
          return vistos !== undefined && !vistos.has(code);
        });
        if (nuevas.length === 0) break;

        for (const offer of nuevas) {
          const itinerary = claveDeItinerario(offer)!;
          const code = codigoDeMarca(offer)!;
          state.itinerarios.get(itinerary)!.add(code);
          ofertas.push(offer);
        }
      }
    }

    return ofertas;
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
