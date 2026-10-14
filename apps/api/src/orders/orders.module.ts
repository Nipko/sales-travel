import { Module } from '@nestjs/common';
import { BookingHoldPolicyService } from '../portfolios/booking-hold-policy.service.js';
import { BookingHoldLedger } from '../portfolios/booking-hold.ledger.js';
import { AgentCarsProviderModule } from '../providers-agent-cars/agent-cars.module.js';
import { HotelProvidersModule } from '../providers/hotel-providers.module.js';
import { ProvidersModule } from '../providers/providers.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { SearchModule } from '../search/search.module.js';
import { ExternalOrderIntentService } from './external-order-intent.service.js';
import { FlightDeadlineAlertService } from './flight-deadline-alert.service.js';
import { FlightDeadlineAlertStore } from './flight-deadline-alert.store.js';
import { FlightOrderTrackingStore } from './flight-order-tracking.store.js';
import { HotelOrderCancellationService } from './hotel-order-cancellation.service.js';
import { HotelOrderCancellationStore } from './hotel-order-cancellation.store.js';
import { HotelOrderReadsService } from './hotel-order-reads.service.js';
import { HotelOrderTrackingStore } from './hotel-order-tracking.store.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { StaleCancelClaimService } from './stale-cancel-claim.service.js';
import { StaleCancelClaimStore } from './stale-cancel-claim.store.js';
import { FlightTicketIssueService } from './ticket-issue.service.js';
import { TicketIssueStore } from './ticket-issue.store.js';

/**
 * La post-venta de las órdenes de hotel (PR-5.2) necesita el registry de hoteles y el breaker, que
 * es el mismo de la búsqueda (`SearchModule`): una lectura desde Reservas respeta el kill-switch de
 * post-venta y la suspensión de la cuenta igual que la verificación. Ninguno de los dos importa este
 * módulo, así que no hay ciclo; `HotelsModule` sí, y por eso esto no vive allí.
 *
 * La cancelación de una orden de hotel (PR-5.3) libera la retención de la cartera cuando la orden
 * queda cancelada. `PortfoliosModule` importa este módulo, así que no se puede importar al revés: se
 * usa `BookingHoldLedger`, que sólo depende de la base. Su verificación la ejecuta `PostSaleModule`.
 * Por lo mismo, la reserva de un vuelo que liquida la red (SAB-10) retiene con
 * `BookingHoldPolicyService`, que también depende sólo de la base.
 *
 * La conciliación (PR-5.5, `ReconciliationModule`) cierra órdenes de hotel con lo que confirma una
 * lectura: usa el mismo seguimiento, la misma transición de la cancelación y la misma retención.
 *
 * Los claims de cancelación que un proceso dejó en vuelo (HARD-1) los vence `PostSaleModule` con
 * `StaleCancelClaimService`, que es de todas las verticales.
 *
 * La emisión de tiquetes (SAB-08) la pide el controlador y la ejecuta `PostSaleModule` desde la
 * cola: `FlightTicketIssueService` se exporta para el worker y el barrido.
 *
 * El aviso de plazo de emisión por vencer (SAB-14) también lo corre el barrido de `PostSaleModule`:
 * `FlightDeadlineAlertService` se exporta para él.
 */
@Module({
  imports: [
    ProvidersModule,
    AgentCarsProviderModule,
    PricingModule,
    HotelProvidersModule,
    SearchModule,
  ],
  controllers: [OrdersController],
  // El worker de post-venta vive en `PostSaleModule`: enruta también jobs de hoteles, y
  // `HotelsModule` ya importa este módulo.
  providers: [
    OrdersService,
    ExternalOrderIntentService,
    FlightOrderTrackingStore,
    HotelOrderTrackingStore,
    HotelOrderReadsService,
    HotelOrderCancellationStore,
    HotelOrderCancellationService,
    StaleCancelClaimStore,
    StaleCancelClaimService,
    BookingHoldLedger,
    BookingHoldPolicyService,
    TicketIssueStore,
    FlightTicketIssueService,
    FlightDeadlineAlertStore,
    FlightDeadlineAlertService,
  ],
  exports: [
    OrdersService,
    ExternalOrderIntentService,
    HotelOrderCancellationService,
    HotelOrderTrackingStore,
    HotelOrderCancellationStore,
    StaleCancelClaimService,
    BookingHoldLedger,
    FlightTicketIssueService,
    FlightDeadlineAlertService,
  ],
})
export class OrdersModule {}
