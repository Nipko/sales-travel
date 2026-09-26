import { Module } from '@nestjs/common';
import { BookingHoldLedger } from '../portfolios/booking-hold.ledger.js';
import { AgentCarsProviderModule } from '../providers-agent-cars/agent-cars.module.js';
import { HotelProvidersModule } from '../providers/hotel-providers.module.js';
import { ProvidersModule } from '../providers/providers.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { SearchModule } from '../search/search.module.js';
import { ExternalOrderIntentService } from './external-order-intent.service.js';
import { HotelOrderCancellationService } from './hotel-order-cancellation.service.js';
import { HotelOrderCancellationStore } from './hotel-order-cancellation.store.js';
import { HotelOrderReadsService } from './hotel-order-reads.service.js';
import { HotelOrderTrackingStore } from './hotel-order-tracking.store.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';

/**
 * La post-venta de las órdenes de hotel (PR-5.2) necesita el registry de hoteles y el breaker, que
 * es el mismo de la búsqueda (`SearchModule`): una lectura desde Reservas respeta el kill-switch de
 * post-venta y la suspensión de la cuenta igual que la verificación. Ninguno de los dos importa este
 * módulo, así que no hay ciclo; `HotelsModule` sí, y por eso esto no vive allí.
 *
 * La cancelación de una orden de hotel (PR-5.3) libera la retención de la cartera cuando la orden
 * queda cancelada. `PortfoliosModule` importa este módulo, así que no se puede importar al revés: se
 * usa `BookingHoldLedger`, que sólo depende de la base. Su verificación la ejecuta `PostSaleModule`.
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
    HotelOrderTrackingStore,
    HotelOrderReadsService,
    HotelOrderCancellationStore,
    HotelOrderCancellationService,
    BookingHoldLedger,
  ],
  exports: [OrdersService, ExternalOrderIntentService, HotelOrderCancellationService],
})
export class OrdersModule {}
