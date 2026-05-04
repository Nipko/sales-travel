import { Controller, Get, Query } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator.js';
import { AirportsService, type AirportView } from './airports.service.js';

@Controller('airports')
export class AirportsController {
  constructor(private readonly airports: AirportsService) {}

  /**
   * Búsqueda de aeropuertos para autocomplete. Público — no requiere auth.
   * Cualquier vendedor o cliente final puede usarlo. Cap de resultados a 25.
   */
  @Public()
  @Get()
  async search(
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ): Promise<{ items: AirportView[] }> {
    const items = await this.airports.search(q ?? '', Number(limit) || 8);
    return { items };
  }
}
