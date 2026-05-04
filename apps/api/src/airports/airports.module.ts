import { Module } from '@nestjs/common';
import { AirportsController } from './airports.controller.js';
import { AirportsService } from './airports.service.js';

@Module({
  controllers: [AirportsController],
  providers: [AirportsService],
})
export class AirportsModule {}
