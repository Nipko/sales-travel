import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { finalize, type Observable } from 'rxjs';
import { InflightWorkRegistry } from './inflight-work.registry.js';

export const HTTP_HANDLER_WORK_KIND = 'http-handler';

/**
 * Cuenta cada handler HTTP como trabajo en curso hasta que termina, aunque el cliente ya se haya
 * ido.
 *
 * Node cierra la respuesta cuando se cae el socket —el 524 de Cloudflare a los 100 s, una pestaña
 * cerrada, Caddy que corta el upstream— pero Nest no cancela el handler: la creación de la orden
 * sigue contra el proveedor y la base. Un apagado que sólo mirara las respuestas abiertas llamaría
 * a `app.close()` y cerraría el pool debajo de ella, con la reserva ya hecha en el proveedor.
 *
 * `@Inject` explícito: los tests compilan con esbuild, que no emite `design:paramtypes`.
 */
@Injectable()
export class InflightHandlersInterceptor implements NestInterceptor {
  constructor(@Inject(InflightWorkRegistry) private readonly work: InflightWorkRegistry) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(finalize(this.work.begin(HTTP_HANDLER_WORK_KIND)));
  }
}
