import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module.js';
import { AuthGuard } from './auth/guards/auth.guard.js';
import { RolesGuard } from './auth/guards/roles.guard.js';
import { IpThrottlerGuard } from './throttler/ip-throttler.guard.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health/health.controller.js';
import { MeModule } from './me/me.module.js';
import { RequestContextMiddleware } from './request-context/request-context.middleware.js';
import { RequestContextModule } from './request-context/request-context.module.js';
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
import { BrandingModule } from './branding/branding.module.js';
import { PricingModule } from './pricing/pricing.module.js';
import { MailerModule } from './mail/mailer.module.js';
import { QueueModule } from './queue/queue.module.js';
import { HotelsModule } from './hotels/hotels.module.js';
import { CarsModule } from './cars/cars.module.js';
import { CrmModule } from './crm/crm.module.js';

@Module({
  imports: [
    // Rate limiting global: 300 req/min por IP. Endpoints sensibles (login) bajan el límite
    // con @Throttle. Storage en memoria (1 contenedor api); migrar a Redis si se escala.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
    DatabaseModule,
    RequestContextModule,
    AuditModule,
    BrandingModule,
    AuthModule,
    MeModule,
    SearchModule,
    QuotationsModule,
    OrdersModule,
    TenantsModule,
    CustomersModule,
    CrmModule,
    PortfoliosModule,
    ReportsModule,
    ProviderCredentialsModule,
    NetworkModule,
    PricingModule,
    MailerModule,
    QueueModule,
    HotelsModule,
    CarsModule,
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
    // Después de AuthGuard: sólo opina en handlers marcados con @Roles().
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
