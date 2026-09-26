import { Module } from '@nestjs/common';
import { HotelsModule } from '../hotels/hotels.module.js';
import { NetworkModule } from '../network/network.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { ProviderCredentialsModule } from '../provider-credentials/provider-credentials.module.js';
import { HotelProvidersModule } from '../providers/hotel-providers.module.js';
import { SearchModule } from '../search/search.module.js';
import { ReconciliationController } from './reconciliation.controller.js';
import { ReconciliationService } from './reconciliation.service.js';
import { ReconciliationStore } from './reconciliation.store.js';

/**
 * La conciliación diaria por cuenta de proveedor (docs/tbo/09 PR-5.5). Consume la post-venta de
 * órdenes (`OrdersModule`: el intent, el seguimiento, la cancelación y la retención de cartera), el
 * HCN (`HotelsModule`), el registry de hoteles y el breaker de la búsqueda, que es el mismo que usa
 * toda la post-venta. Lo ejecuta `PostSaleModule`, que enruta sus jobs y la suma al barrido; la cola
 * es global (`QueueModule`) y el registro de trabajo en vuelo también (`LifecycleModule`).
 */
@Module({
  imports: [
    OrdersModule,
    HotelsModule,
    HotelProvidersModule,
    SearchModule,
    ProviderCredentialsModule,
    NetworkModule,
  ],
  controllers: [ReconciliationController],
  providers: [ReconciliationService, ReconciliationStore],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
