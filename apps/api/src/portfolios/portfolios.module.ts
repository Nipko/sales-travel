import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { HotelProvidersModule } from '../providers/hotel-providers.module.js';
import { ProvidersModule } from '../providers/providers.module.js';
import { PortfoliosController } from './portfolios.controller.js';
import { PortfoliosService } from './portfolios.service.js';
import { WalletFinancingController } from './wallet-financing.controller.js';
import { WalletFinancingService } from './wallet-financing.service.js';

/**
 * La cartera es de la agencia, no de una vertical: una reserva retenida se resuelve con el registry
 * de su vertical (vuelos u hoteles). `HotelsModule` la importa para retener antes del Book (RF-23).
 *
 * Dos lados: lo que ve y hace la agencia (`/portfolios`) y lo que hace quien la financia
 * (`/tenants/:tenantId/portfolios`).
 */
@Module({
  imports: [DatabaseModule, ProvidersModule, HotelProvidersModule, OrdersModule],
  controllers: [PortfoliosController, WalletFinancingController],
  providers: [PortfoliosService, WalletFinancingService],
  exports: [PortfoliosService],
})
export class PortfoliosModule {}
