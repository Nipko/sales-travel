import { Module } from '@nestjs/common';
import { FLIGHT_SEARCH_PORT, OFFER_PRICE_PORT } from '@sales-travel/domain';
import { LatamNdcFlightSearchAdapter } from '@sales-travel/latam-ndc';
import { SearchController } from './search.controller.js';
import { SearchService } from './search.service.js';

const LATAM_ADAPTER_FACTORY = {
  provide: 'LATAM_NDC_ADAPTER',
  useFactory: (): LatamNdcFlightSearchAdapter =>
    new LatamNdcFlightSearchAdapter({
      apiUrl: process.env['LATAM_API_URL'] ?? 'https://sandbox.api.latam.com',
      apiKey: process.env['LATAM_API_KEY'],
      apiSecret: process.env['LATAM_API_SECRET'],
      agencyId: process.env['LATAM_AGENCY_ID'],
      agencyIata: process.env['LATAM_AGENCY_IATA'],
      agencyName: process.env['LATAM_AGENCY_NAME'],
      travelAgentId: process.env['LATAM_TRAVEL_AGENT_ID'],
      country: process.env['LATAM_COUNTRY'],
      mock: process.env['LATAM_FORCE_MOCK'] === 'true',
    }),
};

@Module({
  controllers: [SearchController],
  providers: [
    SearchService,
    LATAM_ADAPTER_FACTORY,
    {
      provide: FLIGHT_SEARCH_PORT,
      useExisting: 'LATAM_NDC_ADAPTER',
    },
    {
      provide: OFFER_PRICE_PORT,
      useExisting: 'LATAM_NDC_ADAPTER',
    },
  ],
})
export class SearchModule {}
