import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module.js';
import { AuthGuard } from './auth/guards/auth.guard.js';
import { IpThrottlerGuard } from './throttler/ip-throttler.guard.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health/health.controller.js';
import { MeModule } from './me/me.module.js';
import { RequestContextMiddleware } from './request-context/request-context.middleware.js';
import { OrdersModule } from './orders/orders.module.js';
import { QuotationsModule } from './quotations/quotations.module.js';
import { SearchModule } from './search/search.module.js';
import { TenantsModule } from './tenants/tenants.module.js';
import { CustomersModule } from './customers/customers.module.js';
import { PortfoliosModule } from './portfolios/portfolios.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { ProviderCredentialsModule } from './provider-credentials/provider-credentials.module.js';
import { NetworkModule } from './network/network.module.js';
import { AuditModule } from './audit/audit.module.js';
import { PricingModule } from './pricing/pricing.module.js';

@Module({
  imports: [
    // Rate limiting global: 300 req/min por IP. Endpoints sensibles (login) bajan el límite
    // con @Throttle. Storage en memoria (1 contenedor api); migrar a Redis si se escala.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
    DatabaseModule,
    AuditModule,
    AuthModule,
    MeModule,
    SearchModule,
    QuotationsModule,
    OrdersModule,
    TenantsModule,
    CustomersModule,
    PortfoliosModule,
    ReportsModule,
    ProviderCredentialsModule,
    NetworkModule,
    PricingModule,
  ],
  controllers: [HealthController],
  providers: [
    // El throttler corre ANTES del auth guard (limita incluso intentos no autenticados).
    {
      provide: APP_GUARD,
      useClass: IpThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
