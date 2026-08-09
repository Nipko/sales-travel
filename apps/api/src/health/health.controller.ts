import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator.js';
import { DatabaseService } from '../database/database.service.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';

interface HealthResponse {
  status: 'ok';
  uptime: number;
  version: string;
  checks: {
    db: 'ok' | 'fail';
  };
  /**
   * Estado de los circuitos por proveedor. Se expone acá para poder ver desde fuera que
   * una vertical está degradada sin tener que leer logs: un circuito `open` explica por
   * qué las búsquedas de ese proveedor fallan rápido.
   */
  providers: Record<string, { state: string; failures: number }>;
}

@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly db: DatabaseService,
    private readonly breaker: CircuitBreakerService,
  ) {}

  @Get()
  async check(): Promise<HealthResponse> {
    let dbOk = false;
    try {
      dbOk = await this.db.ping();
    } catch {
      dbOk = false;
    }

    if (!dbOk) {
      throw new ServiceUnavailableException({
        status: 'fail',
        checks: { db: 'fail' },
      });
    }

    return {
      status: 'ok',
      uptime: process.uptime(),
      version: process.env['APP_VERSION'] ?? 'dev',
      checks: { db: 'ok' },
      providers: this.breaker.snapshot(),
    };
  }
}
