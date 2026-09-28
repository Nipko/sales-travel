import { Module } from '@nestjs/common';
import { ProviderPayloadsPurgeScheduler } from './provider-payloads-purge.scheduler.js';
import {
  PROVIDER_PAYLOADS_CONFIG,
  loadProviderPayloadsConfig,
} from './provider-payloads.config.js';
import { ProviderPayloadsController } from './provider-payloads.controller.js';
import { ProviderPayloadsService } from './provider-payloads.service.js';
import { PROVIDER_PAYLOADS_REPOSITORY, ProviderPayloadsStore } from './provider-payloads.store.js';
import { PROVIDER_PAYLOAD_WRITER } from './provider-payloads.types.js';

/**
 * Bóveda cifrada de RQ/RS de proveedor (migración 0043). Exporta el escritor que los factories de
 * proveedor conectan a su ACL; `DatabaseModule` y `AuditModule` son globales.
 */
@Module({
  controllers: [ProviderPayloadsController],
  providers: [
    {
      provide: PROVIDER_PAYLOADS_CONFIG,
      useFactory: () => loadProviderPayloadsConfig(process.env),
    },
    { provide: PROVIDER_PAYLOADS_REPOSITORY, useClass: ProviderPayloadsStore },
    ProviderPayloadsService,
    { provide: PROVIDER_PAYLOAD_WRITER, useExisting: ProviderPayloadsService },
    ProviderPayloadsPurgeScheduler,
  ],
  exports: [PROVIDER_PAYLOAD_WRITER, ProviderPayloadsService],
})
export class ProviderPayloadsModule {}
