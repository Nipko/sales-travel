import { Inject, Injectable } from '@nestjs/common';
import type { Offer } from '@sales-travel/canonical';
import {
  FLIGHT_SEARCH_PORT,
  type FlightSearchCriteria,
  type FlightSearchPort,
} from '@sales-travel/domain/ports';

@Injectable()
export class SearchService {
  constructor(@Inject(FLIGHT_SEARCH_PORT) private readonly flightSearch: FlightSearchPort) {}

  async searchFlights(criteria: FlightSearchCriteria, tenantId: string): Promise<Offer[]> {
    return this.flightSearch.search(criteria, { tenantId });
  }
}
