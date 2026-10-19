import type { CachePort, LoggerPort } from '@sales-travel/core';
import type { Offer, Segment } from '@sales-travel/canonical';
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
  SABRE_BRAND_ANCILLARIES_DEFAULT,
  SABRE_NDC_CONTENT_DEFAULT,
  SABRE_SHOP_PATH,
  buildSabreShopRequest,
  type SabreFixedFlight,
  type SabreShopOptions,
  type SabreShopRequestScope,
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

/**
 * El código de marca de UN trayecto (0 = ida, 1 = vuelta), o `null` si el trayecto no tiene
 * marca o tiene más de una (un componente por tramo con marcas distintas).
 *
 * Sale de `fareComponents`, que es por trayecto; `provider.raw.brandCode` es de la oferta entera y
 * vale `null` justo en el caso que importa aquí, el de ida y vuelta con marcas distintas.
 */
export function marcaDeTramo(offer: Offer, leg: number): string | null {
  const itineraries = offer.itineraries ?? [];
  if (leg >= itineraries.length) return null;
  let start = 0;
  for (let i = 0; i < leg; i += 1) start += itineraries[i]!.segments.length;
  const end = start + itineraries[leg]!.segments.length;

  const codes = new Set<string>();
  for (const component of offer.fareComponents ?? []) {
    if (!component.segmentRefs.some((ref) => ref >= start && ref < end)) continue;
    const code = component.brand?.code?.trim().toUpperCase();
    if (code === undefined || code.length === 0) return null;
    codes.add(code);
  }
  if (codes.size === 1) return [...codes][0]!;
  if (codes.size > 1) return null;
  // Sin componentes: la marca de la oferta sólo vale para un viaje de un solo trayecto.
  const code = offer.provider.raw?.['brandCode'];
  return itineraries.length === 1 && typeof code === 'string' && code.length > 0 ? code : null;
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
 * Identidad de los vuelos de UN trayecto, deliberadamente sin clase de reserva ni marca: ambas
 * cambian al subir la escalera.
 */
export function claveDeTramo(offer: Offer, leg: number): string | null {
  const itinerary = offer.itineraries?.[leg];
  if (itinerary === undefined || itinerary.segments.length === 0) return null;
  return JSON.stringify(
    itinerary.segments.map((segment) => [
      segment.carrier,
      segment.flightNumber,
      segment.origin,
      segment.destination,
      segment.departureAt,
      segment.arrivalAt,
    ]),
  );
}

/**
 * La escalera mueve la marca de UN trayecto y deja el otro en la más barata.
 *
 * En la búsqueda inicial es la ida (0): así cada vuelo de ida trae sus tarifas con el «desde» de
 * la vuelta más barata, que es lo que el vendedor compara antes de elegir la vuelta. En la
 * búsqueda de vueltas (Anchored Search) es la vuelta (1). El filtro por trayecto se verificó en
 * CERT: excluir LIGHT en la ida dio STANDARD/LIGHT con la misma vuelta (docs/sabre/15 §2.5).
 */
export interface EscaleraCarrier {
  /** Códigos ya observados POR vuelo del trayecto; jamás se unen globalmente. */
  itinerarios: Map<string, Set<string>>;
}

/**
 * Qué códigos excluir en la próxima ronda de un carrier.
 *
 * Primero, los que TODOS sus vuelos ya tienen: así una marca vista en un vuelo no salta una
 * familia todavía no observada en otro. Si no hay ninguno común —pasa en las vueltas de una ida
 * anclada: en CERT unas vueltas salían en LIGHT y otras sólo en STANDARD, y la escalera no daba ni
 * un paso—, el conjunto que más vuelos comparten. Lo peor que hace eso es que a un vuelo con otro
 * conjunto le falte una tarifa intermedia; nunca duplica ni inventa, porque lo ya visto se filtra.
 */
export function codigosComunes(state: EscaleraCarrier): string[] {
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
  if (comunes !== null && comunes.size > 0) return [...comunes].sort();

  const frecuencia = new Map<string, { codes: string[]; vuelos: number }>();
  for (const vistos of state.itinerarios.values()) {
    const codes = [...vistos].sort();
    const firma = codes.join('\u0000');
    const actual = frecuencia.get(firma) ?? { codes, vuelos: 0 };
    actual.vuelos += 1;
    frecuencia.set(firma, actual);
  }
  let moda: { codes: string[]; vuelos: number } | null = null;
  for (const candidato of frecuencia.values()) {
    if (moda === null || candidato.vuelos > moda.vuelos) moda = candidato;
  }
  return moda?.codes ?? [];
}

function estadosDeEscalera(offers: readonly Offer[], leg: number): Map<string, EscaleraCarrier> {
  const carriers = new Map<string, EscaleraCarrier>();
  for (const offer of offers) {
    const code = marcaDeTramo(offer, leg);
    const carrier = carrierUnico(offer);
    const itinerary = claveDeTramo(offer, leg);
    // Un filtro de una ronda acotada a un carrier no puede aislar con honestidad un itinerario
    // interline, ni un trayecto con dos marcas (`marcaDeTramo` es null en ese caso).
    if (code === null || carrier === null || itinerary === null) continue;
    const state = carriers.get(carrier) ?? { itinerarios: new Map<string, Set<string>>() };
    const vistos = state.itinerarios.get(itinerary) ?? new Set<string>();
    vistos.add(code);
    state.itinerarios.set(itinerary, vistos);
    carriers.set(carrier, state);
  }
  return carriers;
}

/**
 * `Segment` canónico → vuelo fijo de Anchored Search. Fecha y hora LOCALES del aeropuerto, que es
 * lo que trae `departureAt` antes del offset: se corta el string, no se pasa por `Date`, que lo
 * convertiría a UTC y movería el vuelo de día.
 */
function vueloFijo(segment: Segment): SabreFixedFlight {
  const local = (iso: string): string => {
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?/.exec(iso);
    if (match === null) throw new SabreConfigError('la ida elegida trae una hora sin forma ISO');
    return `${match[1]}${match[2] ?? ':00'}`;
  };
  const flightNumber = Number.parseInt(segment.flightNumber, 10);
  if (!/^\d{1,4}$/.test(segment.flightNumber) || flightNumber < 1) {
    throw new SabreConfigError('la ida elegida trae un número de vuelo que no se puede fijar');
  }
  return {
    flightNumber,
    departureDateTime: local(segment.departureAt),
    arrivalDateTime: local(segment.arrivalAt),
    origin: segment.origin,
    destination: segment.destination,
    marketingCarrier: segment.carrier,
    operatingCarrier: segment.operatingCarrier ?? segment.carrier,
  };
}

/** Clase cerrada para diagnóstico; nunca usa `message`, que puede arrastrar texto del proveedor. */
function claseSeguraDeError(error: unknown): string {
  const name = error instanceof Error ? error.name : 'NonErrorThrown';
  return /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(name) ? name : 'UnknownError';
}

/**
 * Cuántas aerolíneas recorre la escalera por búsqueda. Cada una cuesta `brandLadderRounds`
 * consultas que Sabre cobra; seis cubre las que de verdad operan una ruta LATAM típica.
 */
export const SABRE_BRAND_LADDER_MAX_CARRIERS = 6;

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
  /**
   * Cliente HTTP de la cuenta, si quien construye ya tiene uno. El semáforo de concurrencia vive en
   * el cliente: con un cliente propio, la búsqueda tendría su cupo aparte del de price/create/
   * manage y la cuenta podría llegar al doble de llamadas en vuelo que su límite. Con él, `fetch`,
   * `logger`, `now`, `sleep`, `jitter` y `uuid` de estas deps no se aplican al cliente: son los del
   * cliente inyectado.
   */
  http?: SabreHttpClient;
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

  /**
   * Igual que {@link multipleFaresUnsupported}, para `ReturnBrandAncillaries` (docs/sabre/15 D3).
   *
   * Aparte de las marcas por la misma razón: que el motor no devuelva los atributos de la marca
   * no dice nada de las marcas en sí, y perder LIGHT/FULL por no saber qué incluyen sería cambiar
   * una función que anda por ninguna.
   */
  private brandAncillariesUnsupported = false;

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
    this.http =
      deps.http ??
      new SabreHttpClient(cfg, this.tokens, {
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
    const pedirAtributos = this.pedirAtributosDeMarca(opciones);
    // Mismo `?? DEFAULT` que las marcas, y por la misma razón. No entra en la degradación: pedir
    // o no NDC no es una capacidad que el PCC rechace, es una decisión de la cuenta, y cada
    // llamada de esta búsqueda la hereda de `...opciones` sin que nadie la pise.
    const pedirNdc = opciones.ndcContent ?? SABRE_NDC_CONTENT_DEFAULT;
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
    let atributosActual = pedirAtributos;
    let result: SabreResult<unknown> | undefined;
    // Lo que se APRENDE de un rechazo se guarda aparte y sólo se fija cuando el escalón de abajo
    // pasa. Fijarlo antes convertía cualquier error BUSINESS —una fecha inválida, un código sin
    // mapear— en «este PCC no tiene marcas» para toda la vida del proceso: si la petición sin
    // marcas falla igual, el error no era de capacidad y no hay nada que aprender.
    let techoAprendido: SabreBrandedFaresMode | null = null;
    let multiAprendido = false;
    let atributosAprendido = false;

    for (;;) {
      const cuerpo = buildSabreShopRequest(criteria, this.cfg, {
        ...opciones,
        brandedFares: modoActual,
        multipleFares: multiActual,
        brandAncillaries: atributosActual,
      });
      try {
        result = await this.http.postJson<unknown>(SABRE_SHOP_PATH, cuerpo, opciones_http);
        if (multiAprendido) this.multipleFaresUnsupported = true;
        if (atributosAprendido) this.brandAncillariesUnsupported = true;
        if (techoAprendido !== null) this.brandedFaresTecho = techoAprendido;
        break;
      } catch (err) {
        if (!esRechazoDeCapacidad(err)) throw err;

        // El log va por `this.log`, NUNCA por `this.deps.logger` directo: ahí es donde se
        // etiqueta el proveedor y la meta pasa por `redactMeta`. Un guard del paquete lo vigila.
        const detalle =
          err instanceof SabreApiError ? { kind: err.failure.kind, code: err.code } : {};

        if (multiActual !== 'off') {
          multiActual = 'off';
          multiAprendido = true;
          this.log('warn', 'sabre.shop.multiple_fares_no_soportadas', {
            path: SABRE_SHOP_PATH,
            ...detalle,
          });
          continue;
        }

        // Segundo escalón: los atributos de marca, antes que las marcas. Sólo viajan cuando se
        // piden marcas, así que con marcas apagadas apagarlos no cambiaría la petición.
        if (atributosActual && modoActual !== 'off') {
          atributosActual = false;
          atributosAprendido = true;
          this.log('warn', 'sabre.shop.brand_ancillaries_no_soportados', {
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
          techoAprendido = bajado;
          // Si ya se había apagado MFPI y aun así hubo que bajar las marcas, quitar MFPI no fue
          // lo que arregló nada: no se aprende. La próxima búsqueda lo vuelve a probar sobre el
          // techo de marcas ya aprendido y converge en una sola llamada.
          multiAprendido = false;
          atributosAprendido = false;
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
    // Desde el modo que PRODUJO la respuesta vacía, no desde el pedido: si el bucle ya bajó a
    // 'off', repetir la llamada sin marcas sería la misma petición otra vez.
    if (mapped.offers.length === 0 && modoActual !== 'off' && !this.brandedFaresProven) {
      const sinMarcas = await this.http.postJson<unknown>(
        SABRE_SHOP_PATH,
        buildSabreShopRequest(criteria, this.cfg, {
          ...opciones,
          brandedFares: 'off',
          multipleFares: 'off',
          brandAncillaries: false,
        }),
        opciones_http,
      );
      const reintento = this.mapear(sinMarcas, criteria, ctx);
      if (reintento.offers.length > 0) {
        // La respuesta VACÍA también degrada un escalón, por la misma razón que el rechazo.
        const nuevo = degradarBrandedFares(modoActual);
        // El techo sólo baja: nunca se sube por una respuesta vacía.
        this.brandedFaresTecho =
          this.brandedFaresTecho === null ? nuevo : menorModo(this.brandedFaresTecho, nuevo);
        this.log('warn', 'sabre.shop.branded_fares_vacian_la_respuesta', {
          path: SABRE_SHOP_PATH,
          offersSinMarcas: reintento.offers.length,
        });
        result = sinMarcas;
        mapped = reintento;
      }
    } else if (mapped.offers.length > 0 && modoActual !== 'off') {
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
      ancillaries: atributosActual,
      httpOptions: opciones_http,
      leg: 0,
    });

    this.logMapping(mapped, result, ctx, {
      pidioMarcas: this.brandedFaresTecho === 'off' ? false : pedirMarcas,
      pidioNdc: pedirNdc,
    });
    return ofertas;
  }

  private pedirAtributosDeMarca(opciones: SabreShopOptions): boolean {
    // Mismo `?? DEFAULT` que las marcas: `opciones` es la entrada sin parsear.
    return (
      (opciones.brandAncillaries ?? SABRE_BRAND_ANCILLARIES_DEFAULT) &&
      !this.brandAncillariesUnsupported
    );
  }

  /**
   * Las vueltas que combinan con una ida ya elegida, cotizadas con la marca de esa ida.
   *
   * Es Anchored Search (docs/sabre/15 §2.5): la ida va fija (`Fixed` + sus vuelos) y, si tiene
   * marca, como `BrandFilters` preferido de ese trayecto. Cada oferta devuelta es una ida y vuelta
   * con precio exacto: no hay sumas de trayectos sueltos. Después, la escalera recorre las marcas
   * de la VUELTA con el mismo presupuesto de rondas que la búsqueda inicial.
   *
   * Sólo se devuelven ofertas cuya ida es exactamente la elegida y, si la ida tenía marca, en esa
   * marca: «Preferred» es una preferencia, y una vuelta cotizada con otra marca de ida no es el
   * precio de lo que el vendedor eligió.
   *
   * Sin `returnDate`, o con una ida que no se puede fijar (sin vuelos, número no numérico), lanza:
   * el llamador decide si cae a las combinaciones de la primera búsqueda.
   */
  async searchReturns(
    criteria: FlightSearchCriteria,
    outbound: Offer,
    ctx: SearchContext,
  ): Promise<Offer[]> {
    if (criteria.returnDate === undefined) {
      throw new SabreConfigError('searchReturns exige una búsqueda de ida y vuelta');
    }
    if (outbound.tenantId !== ctx.tenantId) {
      throw new SabreConfigError('la ida elegida es de otro tenant');
    }
    const ida = outbound.itineraries?.[0];
    if (ida === undefined || ida.segments.length === 0) {
      throw new SabreConfigError('la ida elegida no trae vuelos que fijar');
    }
    const fixedOutbound = ida.segments.map(vueloFijo);
    const claveIda = claveDeTramo(outbound, 0);
    const opciones = this.deps.shopOptions ?? {};
    const pedido = opciones.brandedFares ?? SABRE_BRANDED_FARES_DEFAULT;
    const modo =
      this.brandedFaresTecho === null ? pedido : menorModo(pedido, this.brandedFaresTecho);
    const marcaIda = modo === 'off' ? null : marcaDeTramo(outbound, 0);
    // Sin degradación propia: si la búsqueda inicial ya aprendió que el PCC los rechaza, aquí no
    // se piden; si esta llamada falla, el llamador cae a las combinaciones de la primera búsqueda.
    const atributos = this.pedirAtributosDeMarca(opciones);
    const scope: SabreShopRequestScope = {
      fixedOutbound,
      ...(marcaIda === null ? {} : { legBrandFilters: [{ leg: 0, preferred: [marcaIda] }] }),
    };
    const httpOptions = {
      idempotent: true as const,
      ...(ctx.requestId === undefined
        ? {}
        : { conversationId: `${sabreConversationIdPrefix(this.cfg)}-${ctx.requestId}` }),
    };

    const result = await this.http.postJson<unknown>(
      SABRE_SHOP_PATH,
      buildSabreShopRequest(
        criteria,
        this.cfg,
        { ...opciones, brandedFares: modo, multipleFares: 'off', brandAncillaries: atributos },
        scope,
      ),
      httpOptions,
    );
    const mapped = this.mapear(result, criteria, ctx);
    const deLaIda = (offer: Offer): boolean =>
      claveDeTramo(offer, 0) === claveIda &&
      (marcaIda === null || marcaDeTramo(offer, 0) === marcaIda);
    const base = mapped.offers.filter(deLaIda);

    const ofertas = await this.escaleraDeMarcas({
      base,
      criteria,
      ctx,
      opciones,
      modo,
      multi: 'off',
      ancillaries: atributos,
      httpOptions,
      leg: 1,
      scope,
    });
    this.logMapping(mapped, result, ctx, { pidioMarcas: modo !== 'off', pidioNdc: false });
    return ofertas.filter(deLaIda);
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
    /** Lo que pasó la degradación, no lo que pide la cuenta: `opciones` es la entrada sin tocar. */
    ancillaries: boolean;
    httpOptions: { idempotent: true; conversationId?: string };
    /** Trayecto cuya marca se mueve: 0 en la búsqueda inicial, 1 en la de vueltas. */
    leg: number;
    /** Alcance fijo de todas las rondas (la ida anclada y su marca en la búsqueda de vueltas). */
    scope?: SabreShopRequestScope;
  }): Promise<Offer[]> {
    const rondas = args.opciones.brandLadderRounds ?? SABRE_BRAND_LADDER_DEFAULT;
    if (rondas <= 0 || args.modo === 'off') return [...args.base];

    const porCarrier = estadosDeEscalera(args.base, args.leg);
    if (porCarrier.size === 0) return [...args.base];

    // Las aerolíneas con más vuelos primero, y no más de SABRE_BRAND_LADDER_MAX_CARRIERS: cada una
    // cuesta `rondas` consultas más, y la cola larga de una ruta (un vuelo de una aerolínea que
    // casi no opera ahí) no paga lo que cuesta.
    const elegidos = [...porCarrier]
      .sort(([, a], [, b]) => b.itinerarios.size - a.itinerarios.size)
      .slice(0, SABRE_BRAND_LADDER_MAX_CARRIERS);

    // En PARALELO por aerolínea; las rondas de cada una, en orden (cada una depende de lo que
    // trajo la anterior). En serie, cinco aerolíneas con dos rondas eran diez búsquedas una
    // detrás de otra. El semáforo del cliente HTTP sigue acotando cuántas van a la vez.
    const porAerolinea = await Promise.all(
      elegidos.map(([carrier, state]) => this.escalonarAerolinea(args, rondas, carrier, state)),
    );
    return [...args.base, ...porAerolinea.flat()];
  }

  /** Las rondas de UNA aerolínea. Devuelve sólo lo nuevo; nunca lanza. */
  private async escalonarAerolinea(
    args: Parameters<SabreFlightSearchAdapter['escaleraDeMarcas']>[0],
    rondas: number,
    carrier: string,
    state: EscaleraCarrier,
  ): Promise<Offer[]> {
    const ofertas: Offer[] = [];
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
              brandAncillaries: args.ancillaries,
            },
            {
              ...args.scope,
              onlyMarketingCarrier: carrier,
              legBrandFilters: [
                ...(args.scope?.legBrandFilters ?? []).filter((f) => f.leg !== args.leg),
                { leg: args.leg, excluded: excludeBrands },
              ],
            },
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
        const itinerary = claveDeTramo(offer, args.leg);
        const code = marcaDeTramo(offer, args.leg);
        if (itinerary === null || code === null) return false;
        const vistos = state.itinerarios.get(itinerary);
        return vistos !== undefined && !vistos.has(code);
      });
      if (nuevas.length === 0) break;

      for (const offer of nuevas) {
        const itinerary = claveDeTramo(offer, args.leg)!;
        const code = marcaDeTramo(offer, args.leg)!;
        state.itinerarios.get(itinerary)!.add(code);
        ofertas.push(offer);
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
    pedido: { readonly pidioMarcas: boolean; readonly pidioNdc: boolean },
  ): void {
    const meta = {
      tenantId: ctx.tenantId,
      conversationId: result.conversationId,
      durationMs: result.durationMs,
      offers: mapped.offers.length,
      // `pidioMarcas` va al lado del censo a propósito: `conMarca: 0` sin saber si se pidieron
      // no dice nada. Juntos sí: pedidas y cero = el PCC no publica marcas en esta ruta.
      pidioMarcas: pedido.pidioMarcas,
      // Lo mismo con NDC: `ndc-content-skipped` con `pidioNdc: true` es el mapper NDC que falta;
      // con `pidioNdc: false` es Sabre devolviendo una fuente que se le pidió apagar.
      pidioNdc: pedido.pidioNdc,
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
    // `partialOutcome`: Sabre cotizó lo que pudo y declaró el resto sin tarifa (con niños o
    // infantes, `MIP/PROCESS: NO COMBINABLE FARES FOR CLASS USED`). Hay ofertas, pero menos.
    if (
      mapped.degraded ||
      result.partialUnauthorized.length > 0 ||
      result.partialOutcome.length > 0
    ) {
      this.log('warn', 'sabre.shop.degradado', {
        ...meta,
        partialUnauthorized: result.partialUnauthorized.length,
        partialOutcome: result.partialOutcome.length,
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
