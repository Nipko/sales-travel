import type { LoggerPort } from '@sales-travel/core';
import type { Offer, SeatMap } from '@sales-travel/canonical';
import type { FlightSearchCriteria, SearchContext, SeatMapPort } from '@sales-travel/domain';
import { sabreConversationIdPrefix, type SabreConfig } from './config';
import type { SabreIssue } from './errors';
import type { SabreHttpClient, SabreResult } from './http/sabre-http.client';
import { logRedacted, type SabreLogLevel } from './redaction';
import {
  buildSabreGetSeatsRequest,
  type SabreGetSeatsMode,
} from './seats/getseats.request.builder';
import {
  mapSabreGetSeatsResponse,
  type SabreGetSeatsWarning,
} from './seats/getseats.response.mapper';

/**
 * Adapter de Get Seats v3 antes de reservar: el `SeatMapPort` del dominio.
 *
 *   `buildSabreGetSeatsRequest(offer, criteria)` → `SabreHttpClient.postJson` →
 *   `mapSabreGetSeatsResponse(raw, { basis, segmentIndexById, passengerIndexById })`
 *
 * Consultar un mapa no reserva nada ni mueve dinero: el peor caso de un reintento es una consulta
 * repetida. Por eso va con `idempotent: true`, y ninguna ruta de getseats está en
 * `SABRE_NON_IDEMPOTENT_PATHS`.
 *
 * Que el PCC de la cuenta tenga habilitado getseats v3 (y no sólo el v1 de la colección) está
 * por confirmar en CERT (P-06, SAB-21). Si sólo tiene v1, la respuesta no pasa el contrato y el
 * mapper lo dice con `legacy_v1_contract`.
 */

export interface SabreSeatMapDeps {
  readonly logger?: LoggerPort;
}

/** Lo que el puerto no admite pero el log y la reserva de asientos necesitan. */
export interface SabreSeatMapRead {
  readonly seatMap: SeatMap;
  readonly mode: SabreGetSeatsMode;
  readonly warnings: readonly SabreGetSeatsWarning[];
  /** `response.offerId`. Handle para reservar asientos NDC sobre la orden. */
  readonly offerId: string | undefined;
  readonly droppedSeatMaps: number;
  /** Clasificación segura del sobre hecha por `SabreHttpClient`. */
  readonly httpWarnings: readonly SabreIssue[];
  readonly conversationId: string;
}

/** Evita consultar con la cuenta de un tenant una oferta que pertenece a otro. */
export class SabreSeatMapTenantMismatchError extends Error {
  constructor() {
    super('la oferta y el contexto del mapa de asientos pertenecen a tenants distintos');
    this.name = 'SabreSeatMapTenantMismatchError';
  }
}

/**
 * Sabre contestó con la forma del contrato pero ningún mapa se pudo ubicar en la oferta.
 *
 * Se lanza en vez de devolver un mapa vacío porque un mapa vacío se pinta como «no quedan
 * asientos», y eso es una afirmación sobre el avión que nadie hizo.
 */
export class SabreSeatMapEmptyError extends Error {
  constructor(readonly droppedSeatMaps: number) {
    super(
      `getseats devolvió ${String(droppedSeatMaps)} mapa(s) y ninguno se pudo ubicar en la oferta`,
    );
    this.name = 'SabreSeatMapEmptyError';
  }
}

export class SabreSeatMapAdapter implements SeatMapPort {
  constructor(
    private readonly cfg: SabreConfig,
    private readonly http: SabreHttpClient,
    private readonly deps: SabreSeatMapDeps = {},
  ) {}

  async getSeatMap(
    offer: Offer,
    criteria: FlightSearchCriteria,
    ctx: SearchContext,
  ): Promise<SeatMap> {
    return (await this.readSeatMap(offer, criteria, ctx)).seatMap;
  }

  async readSeatMap(
    offer: Offer,
    criteria: FlightSearchCriteria,
    ctx: SearchContext,
  ): Promise<SabreSeatMapRead> {
    if (offer.tenantId !== ctx.tenantId) throw new SabreSeatMapTenantMismatchError();

    // El builder corre ANTES del cliente: una oferta que no se puede consultar no sale al cable.
    const plan = buildSabreGetSeatsRequest(offer, criteria);
    const result: SabreResult<unknown> = await this.http.postJson<unknown>(plan.path, plan.body, {
      idempotent: true,
      ...(ctx.requestId === undefined
        ? {}
        : { conversationId: `${sabreConversationIdPrefix(this.cfg)}-${ctx.requestId}` }),
    });

    const mapped = mapSabreGetSeatsResponse(result.data, {
      basis: offer,
      segmentIndexById: plan.segmentIndexById,
      passengerIndexById: plan.passengerIndexById,
    });

    const seatMap: SeatMap =
      result.partialUnauthorized.length === 0
        ? mapped.seatMap
        : {
            ...mapped.seatMap,
            // Algún transportista del itinerario no autoriza la venta de asientos a este PCC: el
            // mapa llega capado y el vendedor tiene que saberlo (docs/sabre/03 §4.2).
            warnings: [...new Set([...mapped.seatMap.warnings, 'seat-map-partial-unauthorized'])],
          };

    const meta = {
      tenantId: ctx.tenantId,
      conversationId: result.conversationId,
      durationMs: result.durationMs,
      mode: plan.mode,
      segments: seatMap.segments.length,
      droppedSeatMaps: mapped.droppedSeatMaps,
      ...countSeats(seatMap),
      warnings: countSeatMapWarnings(mapped.warnings),
      partialUnauthorized: result.partialUnauthorized.length,
    };

    if (seatMap.segments.length === 0) {
      this.log('warn', 'sabre.seat_map.empty', meta);
      throw new SabreSeatMapEmptyError(mapped.droppedSeatMaps);
    }
    this.log('debug', 'sabre.seat_map.ok', meta);

    return {
      seatMap,
      mode: plan.mode,
      warnings: mapped.warnings,
      offerId: mapped.offerId,
      droppedSeatMaps: mapped.droppedSeatMaps,
      httpWarnings: result.warnings,
      conversationId: result.conversationId,
    };
  }

  private log(level: SabreLogLevel, message: string, meta: Record<string, unknown>): void {
    logRedacted(this.deps.logger, level, message, meta);
  }
}

/** Avisos agregados por código: 300 asientos repiten el mismo, y el número es lo que importa. */
export function countSeatMapWarnings(
  warnings: readonly SabreGetSeatsWarning[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const warning of warnings) counts[warning.code] = (counts[warning.code] ?? 0) + 1;
  return counts;
}

function countSeats(seatMap: SeatMap): { seats: number; availableSeats: number } {
  let seats = 0;
  let availableSeats = 0;
  for (const segment of seatMap.segments) {
    for (const cabin of segment.cabins) {
      for (const row of cabin.rows) {
        seats += row.seats.length;
        availableSeats += row.seats.filter((seat) => seat.available).length;
      }
    }
  }
  return { seats, availableSeats };
}
