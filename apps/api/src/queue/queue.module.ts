import { Global, Module } from '@nestjs/common';
import { PostSaleQueueService } from './post-sale-queue.service.js';

/** Global: la cola de reintentos de post-venta puede inyectarse desde cualquier módulo. */
@Global()
@Module({
  providers: [PostSaleQueueService],
  exports: [PostSaleQueueService],
})
export class QueueModule {}
