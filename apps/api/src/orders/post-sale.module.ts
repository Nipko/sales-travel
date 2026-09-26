import { Module } from '@nestjs/common';
import { HotelsModule } from '../hotels/hotels.module.js';
import { ReconciliationModule } from '../reconciliation/reconciliation.module.js';
import { OrdersModule } from './orders.module.js';
import { PostSaleSweeper } from './post-sale-sweeper.js';
import { PostSaleWorker } from './post-sale.worker.js';

/**
 * El runner de la cola de post-venta y el barrido. Módulo propio porque enruta jobs de varias
 * verticales: dentro de `OrdersModule` tendría que importar `HotelsModule`, que ya importa
 * `OrdersModule` para abrir el intent de la reserva. La conciliación diaria (PR-5.5) también corre
 * desde aquí: sus jobs y su recuperación en el barrido.
 */
@Module({
  imports: [OrdersModule, HotelsModule, ReconciliationModule],
  providers: [PostSaleWorker, PostSaleSweeper],
})
export class PostSaleModule {}
