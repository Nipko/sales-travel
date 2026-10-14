import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { NetworkModule } from '../network/network.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { HotelProvidersModule } from '../providers/hotel-providers.module.js';
import { ProvidersModule } from '../providers/providers.module.js';
import { DepositReportQueueController } from './deposit-report-queue.controller.js';
import { DepositReportQueueService } from './deposit-report-queue.service.js';
import { PortfoliosController } from './portfolios.controller.js';
import { PortfoliosService } from './portfolios.service.js';
import { WalletFinancingController } from './wallet-financing.controller.js';
import { WalletFinancingService } from './wallet-financing.service.js';

/**
 * La cartera es de la agencia, no de una vertical: una reserva retenida se resuelve con el registry
 * de su vertical (vuelos u hoteles). `HotelsModule` la importa para retener antes del Book (RF-23).
 *
 * Tres lados: lo que ve y hace la agencia (`/portfolios`), lo que hace quien la financia
 * (`/tenants/:tenantId/portfolios`) y la cola de depósitos informados de toda la red que ve el
 * superadmin (`/admin/deposit-reports`).
 */
@Module({
  imports: [DatabaseModule, NetworkModule, ProvidersModule, HotelProvidersModule, OrdersModule],
  controllers: [PortfoliosController, WalletFinancingController, DepositReportQueueController],
  providers: [PortfoliosService, WalletFinancingService, DepositReportQueueService],
  exports: [PortfoliosService],
})
export class PortfoliosModule {}
