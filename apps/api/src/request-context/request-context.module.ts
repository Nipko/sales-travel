import { Global, Module } from '@nestjs/common';
import { ActiveTenantService } from './active-tenant.service.js';

/** Global: lo consumen todos los módulos operativos para resolver el tenant del request. */
@Global()
@Module({
  providers: [ActiveTenantService],
  exports: [ActiveTenantService],
})
export class RequestContextModule {}
