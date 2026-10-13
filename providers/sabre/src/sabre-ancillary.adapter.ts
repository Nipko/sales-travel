import type { AncillaryCatalog } from '@sales-travel/canonical';
import type { LoggerPort } from '@sales-travel/core';
import type {
  AncillaryAddFailureReason,
  AncillaryAddOutcome,
  AncillaryAddResult,
  AncillaryAddedLine,
  AncillaryFailedLine,
  AncillaryLine,
  AncillaryOrderRef,
  AncillaryPort,
  AncillaryRemoveResult,
  AncillarySelection,
  ProviderIssue,
  SearchContext,
} from '@sales-travel/domain';
import { z } from 'zod';
import {
  buildSabreAncillaryAddRequest,
  type SabreAncillaryAddLineInput,
  type SabreAncillarySentLine,
} from './ancillaries/add.request.builder';
import { mapSabreAncillaryAddResponse } from './ancillaries/add.response.mapper';
import { buildSabreAncillaryRemoveRequest } from './ancillaries/remove.request.builder';
import { mapSabreAncillaryRemoveResponse } from './ancillaries/remove.response.mapper';
import {
  SabreAncillaryRequestError,
  buildSabreAncillaryShopRequest,
  sabreAncillaryZodIssues,
} from './ancillaries/shop.request.builder';
import {
  mapSabreAncillaryShopResponse,
  parseSabreAncillaryOfferRef,
  type SabreAncillaryShopMapResult,
  type SabreAncillaryShopWarning,
} from './ancillaries/shop.response.mapper';
import { sabreConversationIdPrefix, type SabreConfig } from './config';
import { SabreApiError, type SabreIssue } from './errors';
import type { SabreHttpClient, SabreResult } from './http/sabre-http.client';
import { logRedacted, type SabreLogLevel } from './redaction';

/**
 * Adapter de Stateless Ancillaries 1.0: el `AncillaryPort` del dominio, sólo para reservas ATPCO.
 *
 *   listAncillaries   → `/shop` por PNR (lectura, con reintentos)
 *   addAncillaries    → `/shop` otra vez + `/add` en modo recurso (escritura, SIN reintentos)
 *   removeAncillaries → `/remove` por `airExtraId` (escritura, SIN reintentos)
 *
 * **Por qué el alta vuelve a consultar.** La API no guarda estado: el alta tiene que llevar la
 * oferta, los servicios y el itinerario (`help/stateless-ancillaries-api-1.0/1.0-index.txt`). Esos
 * datos salen de una consulta hecha en el mismo momento, nunca del llamador, y cada selección se
 * cruza con ella por su identidad (servicio, vuelos, pasajeros) y su precio. Si la oferta ya no
 * está o cambió de precio, esa línea se rechaza sin mandarse.
 *
 * **Reservas NDC fuera (P-12).** El contrato de `createBooking` dice que los ancillares no se
 * soportan en NDC y `getAncillaries` 2.3 sólo muestra los gratuitos. Se rechazan con
 * {@link SabreAncillaryLaneError} antes de salir.
 *
 * **Si lanza, no se escribió nada.** Todo lo que pasa después de mandar `/add` o `/remove` —un
 * rechazo, un timeout, una respuesta que no se entiende— vuelve como resultado, con `UNVERIFIED`
 * cuando no se puede saber si se aplicó.
 *
 * **Los `airExtraIds` vienen por servicio, no por línea** (`ancillaries/add.response.mapper.ts`): si
 * varias líneas comparten definición, cada una sale con `providerItemIdsShared: true`.
 *
 * Que el PCC tenga Stateless Ancillaries está por confirmar en CERT (P-06, SAB-21).
 */

export interface SabreAncillaryDeps {
  readonly logger?: LoggerPort;
}

/** El único carril que esta API atiende. */
export const SABRE_ANCILLARY_SUPPORTED_LANE = 'ATPCO';

/** Tope de selecciones en un alta: más de esto es un error del llamador, no una compra. */
export const SABRE_ANCILLARY_MAX_SELECTIONS = 64;

export type SabreAncillaryLaneRejection =
  | 'NDC_NOT_SUPPORTED'
  | 'LANE_NOT_SUPPORTED'
  | 'LANE_UNKNOWN';

/** La reserva no es de un carril en el que Sabre venda ancillares por esta API. No sale nada. */
export class SabreAncillaryLaneError extends Error {
  constructor(
    readonly code: SabreAncillaryLaneRejection,
    readonly lane: string | undefined,
  ) {
    super(
      code === 'NDC_NOT_SUPPORTED'
        ? 'Sabre no vende ancillares sobre reservas NDC (P-12); no se envió'
        : code === 'LANE_UNKNOWN'
          ? 'la reserva no declara su carril de contenido: no se puede descartar NDC; no se envió'
          : `el carril ${lane ?? '?'} no se atiende por Stateless Ancillaries; no se envió`,
    );
    this.name = 'SabreAncillaryLaneError';
  }
}

/** Lo que el puerto no expone pero el alta y el log necesitan. */
export interface SabreAncillaryRead {
  readonly catalog: AncillaryCatalog;
  readonly mapped: SabreAncillaryShopMapResult;
  readonly httpWarnings: readonly SabreIssue[];
  readonly conversationId: string;
}

const SelectionsSchema = z
  .array(
    z.object({
      serviceOfferItemId: z.string().min(1).max(255),
      passengerIndexes: z.array(z.number().int().nonnegative()).min(1).max(9),
    }),
  )
  .min(1)
  .max(SABRE_ANCILLARY_MAX_SELECTIONS);

export class SabreAncillaryAdapter implements AncillaryPort {
  constructor(
    private readonly cfg: SabreConfig,
    private readonly http: SabreHttpClient,
    private readonly deps: SabreAncillaryDeps = {},
  ) {}

  async listAncillaries(order: AncillaryOrderRef, ctx: SearchContext): Promise<AncillaryCatalog> {
    return (await this.readAncillaries(order, ctx)).catalog;
  }

  /**
   * `/shop` por PNR. Es una lectura: `idempotent: true`, y un 5xx transitorio se reintenta en vez
   * de convertirse en «no hay servicios».
   */
  async readAncillaries(order: AncillaryOrderRef, ctx: SearchContext): Promise<SabreAncillaryRead> {
    assertOrder(order);
    const plan = buildSabreAncillaryShopRequest({ pnrLocator: order.orderId });
    const result = await this.http.postJson<unknown>(plan.path, plan.body, {
      idempotent: true,
      ...this.conversation(ctx),
    });

    const mapped = mapSabreAncillaryShopResponse(result.data, {
      pnrLocator: plan.body.pnrLocator,
      passengers: order.passengers,
    });
    const catalog: AncillaryCatalog =
      result.partialUnauthorized.length === 0
        ? mapped.catalog
        : {
            ...mapped.catalog,
            // Algún transportista no autoriza a este PCC: el catálogo llega capado y el vendedor
            // tiene que saberlo antes de decirle al pasajero que no hay maletas que comprar.
            warnings: [...new Set([...mapped.catalog.warnings, 'ancillary-partial-unauthorized'])],
          };

    const sellable = catalog.offers.filter((offer) => offer.sellable).length;
    this.log(catalog.offers.length === 0 ? 'warn' : 'debug', 'sabre.ancillaries.shop', {
      tenantId: ctx.tenantId,
      conversationId: result.conversationId,
      durationMs: result.durationMs,
      segments: catalog.segments.length,
      passengers: order.passengers.length,
      offers: catalog.offers.length,
      sellable,
      notSellable: countBy(catalog.offers.flatMap((offer) => offer.notSellableReason ?? [])),
      warnings: countSabreAncillaryWarnings(mapped.warnings),
      partialUnauthorized: result.partialUnauthorized.length,
    });

    return {
      catalog,
      mapped,
      httpWarnings: result.warnings,
      conversationId: result.conversationId,
    };
  }

  async addAncillaries(
    order: AncillaryOrderRef,
    selections: readonly AncillarySelection[],
    ctx: SearchContext,
  ): Promise<AncillaryAddResult> {
    assertOrder(order);
    assertSelections(selections, order.passengers.length);

    const read = await this.readAncillaries(order, ctx);
    const failed: AncillaryFailedLine[] = [];
    const lines: SabreAncillaryAddLineInput[] = [];
    for (const selection of selections) {
      const resolved = resolveSelection(selection, read.mapped);
      failed.push(...resolved.failed);
      if (resolved.line !== undefined) lines.push(resolved.line);
    }

    if (lines.length === 0) {
      return this.finishAdd(ctx, { added: [], failed, unverified: [], issues: [] }, { sent: 0 });
    }

    // El builder corre ANTES del cliente: un cuerpo que no pasa el contrato no sale al cable.
    const plan = buildSabreAncillaryAddRequest({ snapshot: read.mapped.snapshot, lines });

    let result: SabreResult<unknown>;
    try {
      // Sin `idempotent`, y aunque se pidiera el path está en `SABRE_NON_IDEMPOTENT_PATHS`.
      result = await this.http.postJson<unknown>(plan.path, plan.body, this.conversation(ctx));
    } catch (error) {
      if (!(error instanceof SabreApiError)) throw error;
      const verdict = writeFailureVerdict(error);
      const sentLines = plan.sent.map(lineOf);
      return this.finishAdd(
        ctx,
        {
          added: [],
          failed: [
            ...failed,
            ...(verdict === 'REJECTED'
              ? sentLines.map((line) => ({ ...line, reason: 'REJECTED' as const }))
              : []),
          ],
          unverified: verdict === 'UNVERIFIED' ? sentLines : [],
          issues: providerIssues(error.issues),
        },
        { sent: plan.sent.length, status: error.status, kind: error.failure.kind },
      );
    }

    let added: AncillaryAddedLine[];
    let unverified: AncillaryLine[];
    let mapWarnings: readonly string[] = [];
    try {
      const mapped = mapSabreAncillaryAddResponse(result.data, plan.sent);
      added = mapped.added.map((line) => ({
        ...lineOf(line),
        providerItemIds: line.airExtraIds,
        providerItemIdsShared: line.airExtraIdsShared,
      }));
      unverified = mapped.unverified.map(lineOf);
      mapWarnings = mapped.warnings;
    } catch {
      // El alta ya salió: una respuesta que no se entiende no es un fallo, es una duda.
      added = [];
      unverified = plan.sent.map(lineOf);
      mapWarnings = ['add-response-unreadable'];
    }

    return this.finishAdd(
      ctx,
      { added, failed, unverified, issues: providerIssues(result.warnings) },
      {
        sent: plan.sent.length,
        status: result.status,
        conversationId: result.conversationId,
        durationMs: result.durationMs,
        mapWarnings,
      },
    );
  }

  async removeAncillaries(
    order: AncillaryOrderRef,
    providerItemIds: readonly string[],
    ctx: SearchContext,
  ): Promise<AncillaryRemoveResult> {
    assertOrder(order);
    const plan = buildSabreAncillaryRemoveRequest({
      pnrLocator: order.orderId,
      airExtraIds: providerItemIds,
    });
    const ids = plan.body.airExtraIds;

    let result: SabreResult<unknown>;
    try {
      result = await this.http.postJson<unknown>(plan.path, plan.body, this.conversation(ctx));
    } catch (error) {
      if (!(error instanceof SabreApiError)) throw error;
      const verdict = writeFailureVerdict(error);
      const outcome: AncillaryRemoveResult = {
        outcome: verdict === 'REJECTED' ? 'FAILED' : 'UNVERIFIED',
        removed: [],
        failed: verdict === 'REJECTED' ? [...ids] : [],
        unverified: verdict === 'UNVERIFIED' ? [...ids] : [],
        issues: providerIssues(error.issues),
      };
      this.log('warn', 'sabre.ancillaries.remove', {
        tenantId: ctx.tenantId,
        outcome: outcome.outcome,
        requested: ids.length,
        status: error.status,
        kind: error.failure.kind,
        issueTypes: outcome.issues.map((issue) => issue.type),
      });
      return outcome;
    }

    let removed: readonly string[];
    let unverified: readonly string[];
    let mapWarnings: readonly string[];
    try {
      const mapped = mapSabreAncillaryRemoveResponse(result.data, ids);
      removed = mapped.removed;
      unverified = mapped.unverified;
      mapWarnings = mapped.warnings;
    } catch {
      removed = [];
      unverified = [...ids];
      mapWarnings = ['remove-response-unreadable'];
    }

    const outcome: AncillaryRemoveResult = {
      outcome: unverified.length > 0 ? 'UNVERIFIED' : 'REMOVED',
      removed: [...removed],
      failed: [],
      unverified: [...unverified],
      issues: providerIssues(result.warnings),
    };
    this.log(outcome.outcome === 'REMOVED' ? 'debug' : 'warn', 'sabre.ancillaries.remove', {
      tenantId: ctx.tenantId,
      conversationId: result.conversationId,
      durationMs: result.durationMs,
      outcome: outcome.outcome,
      requested: ids.length,
      removed: removed.length,
      unverified: unverified.length,
      mapWarnings: [...mapWarnings],
    });
    return outcome;
  }

  private finishAdd(
    ctx: SearchContext,
    lines: {
      readonly added: readonly AncillaryAddedLine[];
      readonly failed: readonly AncillaryFailedLine[];
      readonly unverified: readonly AncillaryLine[];
      readonly issues: readonly ProviderIssue[];
    },
    meta: Record<string, unknown>,
  ): AncillaryAddResult {
    const outcome = addOutcome(lines.added.length, lines.failed.length, lines.unverified.length);
    this.log(outcome === 'ADDED' ? 'debug' : 'warn', 'sabre.ancillaries.add', {
      tenantId: ctx.tenantId,
      ...meta,
      outcome,
      added: lines.added.length,
      failed: countBy(lines.failed.map((line) => line.reason)),
      unverified: lines.unverified.length,
      // Sólo el vocabulario cerrado del proveedor; `description` es texto libre y no sale nunca.
      issueTypes: lines.issues.map((issue) => issue.type),
    });
    return {
      outcome,
      added: [...lines.added],
      failed: [...lines.failed],
      unverified: [...lines.unverified],
      issues: [...lines.issues],
    };
  }

  private conversation(ctx: SearchContext): { conversationId?: string } {
    if (ctx.requestId === undefined) return {};
    return { conversationId: `${sabreConversationIdPrefix(this.cfg)}-${ctx.requestId}` };
  }

  private log(level: SabreLogLevel, message: string, meta: Record<string, unknown>): void {
    logRedacted(this.deps.logger, level, message, meta);
  }
}

// ---------------------------------------------------------------------------------------------
// Antes del cable
// ---------------------------------------------------------------------------------------------

function assertOrder(order: AncillaryOrderRef): void {
  const declared = order.contentSource;
  if (declared === undefined) throw new SabreAncillaryLaneError('LANE_UNKNOWN', undefined);
  const lane = declared.trim().toUpperCase();
  if (lane === 'NDC') throw new SabreAncillaryLaneError('NDC_NOT_SUPPORTED', 'NDC');
  if (lane !== SABRE_ANCILLARY_SUPPORTED_LANE) {
    throw new SabreAncillaryLaneError(
      'LANE_NOT_SUPPORTED',
      /^[A-Z0-9_-]{2,20}$/.test(lane) ? lane : undefined,
    );
  }
  if (order.passengers.length < 1 || order.passengers.length > 9) {
    throw new SabreAncillaryRequestError('shop', ['order.passengers:invalid']);
  }
}

function assertSelections(selections: readonly AncillarySelection[], passengers: number): void {
  const parsed = SelectionsSchema.safeParse(selections);
  if (!parsed.success) {
    throw new SabreAncillaryRequestError('add', sabreAncillaryZodIssues(parsed.error));
  }
  const ids = new Set<string>();
  parsed.data.forEach((selection, index) => {
    const at = `selections.${String(index)}`;
    if (ids.has(selection.serviceOfferItemId)) {
      throw new SabreAncillaryRequestError('add', [`${at}.serviceOfferItemId:duplicate`]);
    }
    ids.add(selection.serviceOfferItemId);
    const indexes = selection.passengerIndexes;
    if (new Set(indexes).size !== indexes.length || indexes.some((value) => value >= passengers)) {
      throw new SabreAncillaryRequestError('add', [`${at}.passengerIndexes:invalid`]);
    }
  });
}

/**
 * Cruza una selección con la consulta recién hecha. Lo que no casa se rechaza POR LÍNEA, con un
 * motivo que el vendedor entiende, y no sale al cable.
 */
function resolveSelection(
  selection: AncillarySelection,
  mapped: SabreAncillaryShopMapResult,
): { readonly line?: SabreAncillaryAddLineInput; readonly failed: AncillaryFailedLine[] } {
  const { serviceOfferItemId } = selection;
  const fail = (
    passengerIndex: number,
    reason: AncillaryAddFailureReason,
  ): AncillaryFailedLine => ({
    serviceOfferItemId,
    passengerIndex,
    reason,
  });

  const binding = mapped.bindings.get(serviceOfferItemId);
  if (binding === undefined) {
    const ref = parseSabreAncillaryOfferRef(serviceOfferItemId);
    const reason: AncillaryAddFailureReason =
      ref !== undefined && mapped.semanticDigests.has(ref.semantic)
        ? 'PRICE_CHANGED'
        : 'NOT_OFFERED';
    return { failed: selection.passengerIndexes.map((index) => fail(index, reason)) };
  }
  if (!binding.offer.sellable) {
    return { failed: selection.passengerIndexes.map((index) => fail(index, 'NOT_SELLABLE')) };
  }

  const eligible = selection.passengerIndexes.filter((index) =>
    binding.passengerRefByIndex.has(index),
  );
  const failed = selection.passengerIndexes
    .filter((index) => !binding.passengerRefByIndex.has(index))
    .map((index) => fail(index, 'PASSENGER_NOT_ELIGIBLE'));
  return eligible.length === 0
    ? { failed }
    : { line: { binding, passengerIndexes: eligible }, failed };
}

// ---------------------------------------------------------------------------------------------
// Después del cable
// ---------------------------------------------------------------------------------------------

/**
 * Qué se sabe de una escritura que terminó en `SabreApiError`.
 *
 * - `REJECTED`: Sabre la rechazó ANTES de ejecutarla. Un 4xx (petición inválida, token, permiso,
 *   cuota) o un 2xx cuyos errores son todos `BAD_REQUEST` (validación, `help/…/1.0-errors.txt`).
 * - `UNVERIFIED`: todo lo demás. Un timeout, un 5xx o un error de negocio pueden llegar con el
 *   cambio aplicado —`RESERVATION_SERVICE_FAILED` dice literalmente «Required fields missing in the
 *   response»—, y darlo por fallido invita a repetir y cobrar dos veces.
 */
function writeFailureVerdict(error: SabreApiError): 'REJECTED' | 'UNVERIFIED' {
  if (error.status >= 400 && error.status < 500) return 'REJECTED';
  if (error.status >= 200 && error.status < 300) {
    const errors = error.issues.filter((issue) => issue.severity === 'error');
    if (errors.length > 0 && errors.every((issue) => issue.category === 'BAD_REQUEST')) {
      return 'REJECTED';
    }
  }
  return 'UNVERIFIED';
}

function addOutcome(added: number, failed: number, unverified: number): AncillaryAddOutcome {
  if (unverified > 0) return 'UNVERIFIED';
  if (added === 0) return 'FAILED';
  return failed > 0 ? 'PARTIAL' : 'ADDED';
}

function lineOf(line: SabreAncillarySentLine): AncillaryLine {
  return { serviceOfferItemId: line.serviceOfferItemId, passengerIndex: line.passengerIndex };
}

/** `SabreIssue` ya pasó la puerta de vocabulario del cliente: sin texto libre ni valores. */
function providerIssues(issues: readonly SabreIssue[]): ProviderIssue[] {
  return issues.map((issue) => ({
    severity: issue.severity === 'error' ? 'ERROR' : 'WARNING',
    category: issue.category ?? 'UNKNOWN',
    type: issue.type ?? 'UNKNOWN',
    ...(issue.fieldPath === undefined ? {} : { fieldPath: issue.fieldPath }),
  }));
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

/** Avisos agregados por código; el detalle y la ruta no van al log. */
export function countSabreAncillaryWarnings(
  warnings: readonly SabreAncillaryShopWarning[],
): Record<string, number> {
  return countBy(warnings.map((warning) => warning.code));
}
