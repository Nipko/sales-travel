import { Injectable, Logger } from '@nestjs/common';
import type { HotelRoompack, Money } from '@sales-travel/canonical';
import type { HotelRateConditionCategory, HotelRateSignal } from '@sales-travel/domain';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { PricingService } from '../pricing/pricing.service.js';
import { HotelProviderRegistry } from '../providers/hotel-provider.registry.js';
import {
  supportsHotelPrebookContext,
  type HotelOfferInvalidation,
  type HotelPrebookWithContext,
  type HotelPriceDirection,
  type HotelRateConditionChange,
  type HotelRepriceComparison,
  type HotelRepriceOutcome,
} from '../providers/hotel-provider.types.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import { providerAccountIssueEvent } from './hotel-account-issues.js';
import { HOTEL_EVENTS } from './hotel-events.js';
import { HotelPrebookSnapshotStore } from './hotel-prebook-snapshot.store.js';
import { priceRoompack } from './hotel-pricing.js';
import { HotelProviderCapabilityError } from './hotel-provider-errors.js';
import {
  HotelSearchContextStore,
  HotelSearchNationalityMissingError,
  type HotelOfferReference,
  type ResolvedHotelSearchOffer,
} from './hotel-search-context.store.js';

/** Lo que ve el vendedor de la comparación C1: códigos y netos, nunca texto del proveedor. */
export interface HotelPrebookRepricing {
  readonly outcome: HotelRepriceOutcome;
  readonly price: HotelPriceDirection;
  readonly changes: readonly HotelRateConditionChange[];
  readonly previousTotal: Money;
  readonly currentTotal: Money;
}

/** Una condición de la tarifa como se muestra: el texto saneado, nunca el original (RF-16). */
export interface HotelPrebookCondition {
  readonly category: HotelRateConditionCategory;
  readonly text: string;
}

/** La respuesta de `POST /hotels/prebook` con el cuerpo neutral. */
export interface HotelPrebookResponse {
  /** Con esto se pide el Book: lo demás queda en el servidor. */
  readonly prebookRef: string;
  readonly providerCode: string;
  readonly hotelId: string;
  /** Hasta cuándo se puede reservar sin volver a buscar (RF-09): no lo mueve el PreBook. */
  readonly expiresAt: string;
  /** Políticas finales del PreBook y precio de venta sobre el neto revalidado (`pricing`). */
  readonly roompack: HotelRoompack;
  readonly rateConditions: readonly HotelPrebookCondition[];
  /** Arriba del paso previo a confirmar (RF-16 CA-3); el Book bloquea `PACKAGE_WITH_FLIGHT_ONLY`. */
  readonly signals: readonly HotelRateSignal[];
  /** Si no es `UNCHANGED`, se muestra antes de seguir (RF-15 CA-3). */
  readonly repricing: HotelPrebookRepricing;
  readonly warnings: readonly string[];
}

const OPERATION = 'la revalidación de una tarifa de su búsqueda (se revalida con su flujo propio)';

function repricingOf(comparison: HotelRepriceComparison): HotelPrebookRepricing {
  return {
    outcome: comparison.outcome,
    price: comparison.price,
    changes: [...comparison.changes],
    previousTotal: { ...comparison.previousTotal },
    currentTotal: { ...comparison.currentTotal },
  };
}

/**
 * PreBook de una tarifa buscada, con revalidación y snapshot en el servidor (docs/tbo/09 PR-4.5;
 * 08 RF-15, RF-12 con el valor de PreBook y RF-09 CA-2; 03 §2 y §5.1).
 *
 * El navegador sólo dice de qué proveedor, de qué búsqueda y cuál (RF-08 CA-4). En orden, y todo
 * lo que rechaza lo rechaza ANTES de llamar al proveedor:
 *
 * 1. **Proveedor por su código** con `registry.byCode`, como vuelos con `priceOffer`: la tarifa ya
 *    la emitió él, así que el flag `opt-in` no se vuelve a mirar. Un proveedor sin PreBook por
 *    contexto (Despegar) responde 400: el suyo sigue siendo el de `choiceId` (D-TBO-08 A).
 * 2. **Contexto de búsqueda** del tenant: vigente, de este tenant (uno ajeno responde igual que uno
 *    vencido, 409, para no confirmar que existe), con la tarifa dentro, no descartada antes y
 *    buscada con la cuenta que va a revalidar.
 * 3. **Nacionalidad**: un proveedor que tarifa por ella no revalida una búsqueda hecha sin ella.
 * 4. **PreBook por el circuito** del proveedor y de su cuenta. El servidor no suma reintentos: los
 *    decide el cliente HTTP del ACL (RF-15 CA-4). Si el proveedor dice que la tarifa ya no está,
 *    se marca; si dice que su sesión venció, se olvida la búsqueda (RF-09 CA-2).
 * 5. **C1** la hace el adapter contra lo que mostró la búsqueda (decimal exacta, sin tolerancia).
 * 6. **Precio de venta** con el waterfall `hotels` y el piso del proveedor sobre el neto y el piso
 *    DEL PreBook (RF-12).
 * 7. **Snapshot aceptable** por `prebookRef`, y `HotelOfferRepriced` si C1 no dio `UNCHANGED`.
 */
@Injectable()
export class HotelPrebookService {
  private readonly logger = new Logger(HotelPrebookService.name);

  constructor(
    private readonly registry: HotelProviderRegistry,
    private readonly searchContexts: HotelSearchContextStore,
    private readonly snapshots: HotelPrebookSnapshotStore,
    private readonly pricing: PricingService,
    private readonly breaker: CircuitBreakerService,
    private readonly audit: AuditService,
  ) {}

  async prebook(
    tenantId: string,
    reference: HotelOfferReference,
    actorUserId: string | undefined,
  ): Promise<HotelPrebookResponse> {
    const provider = await this.registry.byCodeForOffer(tenantId, reference.providerCode);
    const { code, adapter, circuit, searchProfile } = provider;
    if (!supportsHotelPrebookContext(adapter)) {
      throw new HotelProviderCapabilityError(code, OPERATION);
    }

    const offer = await this.searchContexts.resolveOffer(
      tenantId,
      reference,
      adapter.searchAccount,
    );
    if (searchProfile.requiresGuestNationality === true && offer.guestNationality === undefined) {
      throw new HotelSearchNationalityMissingError();
    }

    let found: HotelPrebookWithContext;
    try {
      found = await this.breaker.execute(
        code,
        () =>
          adapter.prebookWithContext(
            {
              searchId: offer.searchId,
              hotelId: offer.pack.hotelId,
              offerRef: offer.pack.offerRef,
              searchSentAt: offer.searchSentAt,
              rooms: offer.rooms,
              baseline: { stage: 'C1', totalText: offer.pack.totalText, seen: offer.pack.seen },
            },
            { tenantId },
          ),
        circuit,
      );
    } catch (err) {
      await this.invalidate(tenantId, code, offer, adapter.offerInvalidatedBy(err));
      // RF-23: un `300` puede llegar ya en el PreBook con `Limit` (03 §6); el aviso es para el
      // dueño de la cuenta y no puede tapar el error que ve el vendedor.
      const issue = providerAccountIssueEvent({
        provider,
        err,
        sellerTenantId: tenantId,
        ...(actorUserId === undefined ? {} : { actorUserId }),
        stage: 'prebook',
      });
      if (issue !== undefined) await this.audit.emit(issue).catch(() => undefined);
      throw err;
    }

    const rules = await this.pricing.getApplicableRules(tenantId, 'hotels');
    const priced = priceRoompack(found.result.roompack, rules, tenantId);
    // `raw` viaja al navegador: sólo la clave de la búsqueda, lo ponga el ACL o no (RF-08 CA-5).
    const roompack: HotelRoompack = {
      ...priced,
      provider: { ...priced.provider, raw: { searchId: offer.searchId } },
    };

    const prebookRef = randomUUID();
    await this.snapshots.save({
      prebookRef,
      tenantId,
      providerCode: code,
      searchId: offer.searchId,
      account: { ...offer.account },
      hotelId: found.pack.hotelId,
      offerRef: found.pack.offerRef,
      totalText: found.pack.totalText,
      currency: found.pack.currency,
      checkinDate: offer.checkinDate,
      checkoutDate: offer.checkoutDate,
      rooms: offer.rooms.map((r) => ({ adults: r.adults, childrenAges: [...r.childrenAges] })),
      ...(offer.guestNationality === undefined ? {} : { guestNationality: offer.guestNationality }),
      searchSentAt: offer.searchSentAt,
      expiresAt: offer.expiresAt,
      roompack,
      rateConditions: found.result.rateConditions.map((c) => ({ ...c })),
      signals: [...found.result.signals],
      rateConditionsHash: found.rateConditionsHash,
      comparison: { ...found.comparison, changes: [...found.comparison.changes] },
      createdAt: Date.now(),
    });

    const repricing = repricingOf(found.comparison);
    if (repricing.outcome !== 'UNCHANGED') {
      await this.audit.emit({
        eventType: HOTEL_EVENTS.offerRepriced,
        tenantId,
        actorUserId,
        aggregateType: 'hotel_prebook',
        aggregateId: prebookRef,
        payload: {
          vertical: 'hotels',
          provider: code,
          hotelId: found.pack.hotelId,
          stage: found.comparison.stage,
          ...repricing,
        },
      });
    }

    return {
      prebookRef,
      providerCode: code,
      hotelId: found.pack.hotelId,
      expiresAt: new Date(offer.expiresAt).toISOString(),
      roompack,
      rateConditions: found.result.rateConditions.map(({ category, text }) => ({ category, text })),
      signals: [...found.result.signals],
      repricing,
      warnings: [...found.result.warnings],
    };
  }

  /**
   * Lo que el error del proveedor deja inservible, marcado ANTES de relanzarlo: el próximo intento
   * responde sin volver a preguntarle. Si la marca falla, se pierde la marca y no el error: el
   * vendedor tiene que ver lo que dijo el proveedor.
   */
  private async invalidate(
    tenantId: string,
    providerCode: string,
    offer: ResolvedHotelSearchOffer,
    scope: HotelOfferInvalidation | undefined,
  ): Promise<void> {
    if (scope === undefined) return;
    try {
      if (scope === 'search') {
        await this.searchContexts.forget(tenantId, offer.searchId);
      } else {
        await this.searchContexts.invalidateOffer(tenantId, offer.searchId, offer.pack.offerRef);
      }
    } catch {
      // Sin el error: el mensaje de un almacén externo puede citar la clave, que lleva el tenant.
      this.logger.warn(
        `hotels.prebook.invalidation_failed provider=${providerCode} scope=${scope}`,
      );
    }
  }
}
