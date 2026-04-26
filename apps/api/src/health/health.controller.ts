import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';

interface HealthResponse {
  status: 'ok';
  uptime: number;
  version: string;
  checks: {
    db: 'ok' | 'fail';
  };
}

@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

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
    };
  }
}
