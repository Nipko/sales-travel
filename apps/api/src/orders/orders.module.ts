import { Module } from '@nestjs/common';
import { ORDER_CREATE_PORT, ORDER_MANAGE_PORT } from '@sales-travel/domain';
import { LatamNdcFlightSearchAdapter } from '@sales-travel/latam-ndc';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';

const LATAM_ADAPTER_FACTORY = {
  provide: 'LATAM_NDC_ORDERS_ADAPTER',
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
  controllers: [OrdersController],
  providers: [
    OrdersService,
    LATAM_ADAPTER_FACTORY,
    { provide: ORDER_CREATE_PORT, useExisting: 'LATAM_NDC_ORDERS_ADAPTER' },
    { provide: ORDER_MANAGE_PORT, useExisting: 'LATAM_NDC_ORDERS_ADAPTER' },
  ],
})
export class OrdersModule {}
