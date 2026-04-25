import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  check(): { status: 'ok'; uptime: number; version: string } {
    return {
      status: 'ok',
      uptime: process.uptime(),
      version: process.env['APP_VERSION'] ?? 'dev',
    };
  }
}
