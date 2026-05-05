import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from './auth/auth.module.js';
import { AuthGuard } from './auth/guards/auth.guard.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health/health.controller.js';
import { MeModule } from './me/me.module.js';
import { RequestContextMiddleware } from './request-context/request-context.middleware.js';
import { OrdersModule } from './orders/orders.module.js';
import { QuotationsModule } from './quotations/quotations.module.js';
import { SearchModule } from './search/search.module.js';
import { TenantsModule } from './tenants/tenants.module.js';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    MeModule,
    SearchModule,
    QuotationsModule,
    OrdersModule,
    TenantsModule,
  ],
  controllers: [HealthController],
  providers: [
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
