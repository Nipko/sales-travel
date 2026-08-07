import { Global, Module } from '@nestjs/common';
import { BrandingService } from './branding.service.js';

/** Global: lo consumen quotations, orders, auth e invitations para brandear sus correos. */
@Global()
@Module({
  providers: [BrandingService],
  exports: [BrandingService],
})
export class BrandingModule {}
