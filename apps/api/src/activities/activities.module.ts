import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { ProviderEnablementModule } from '../provider-enablement/provider-enablement.module.js';
import { DespegarActivitiesProviderModule } from '../providers-despegar/despegar-activities.module.js';
import { ActivitiesController } from './activities.controller.js';
import { ActivitiesService } from './activities.service.js';

/**
 * Actividades de Despegar/HotelDO. Apagado por defecto (`DESPEGAR_ACTIVITIES_ENABLED`): la clave de
 * sandbox todavía no tiene acceso (docs/despegar/03).
 */
@Module({
  imports: [
    DespegarActivitiesProviderModule,
    PricingModule,
    OrdersModule,
    AuditModule,
    ProviderEnablementModule,
  ],
  controllers: [ActivitiesController],
  providers: [ActivitiesService],
})
export class ActivitiesModule {}
