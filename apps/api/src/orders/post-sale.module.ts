import { Module } from '@nestjs/common';
import { HotelsModule } from '../hotels/hotels.module.js';
import { OrdersModule } from './orders.module.js';
import { PostSaleSweeper } from './post-sale-sweeper.js';
import { PostSaleWorker } from './post-sale.worker.js';

/**
 * El runner de la cola de post-venta y el barrido. Módulo propio porque enruta jobs de varias
 * verticales: dentro de `OrdersModule` tendría que importar `HotelsModule`, que ya importa
 * `OrdersModule` para abrir el intent de la reserva.
 */
@Module({
  imports: [OrdersModule, HotelsModule],
  providers: [PostSaleWorker, PostSaleSweeper],
})
export class PostSaleModule {}
