import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { InflightHandlersInterceptor } from './inflight-handlers.interceptor.js';
import { InflightWorkRegistry } from './inflight-work.registry.js';

/** Global: cualquier saga que siga después de responder se registra sin importar este módulo. */
@Global()
@Module({
  providers: [
    InflightWorkRegistry,
    { provide: APP_INTERCEPTOR, useClass: InflightHandlersInterceptor },
  ],
  exports: [InflightWorkRegistry],
})
export class LifecycleModule {}
