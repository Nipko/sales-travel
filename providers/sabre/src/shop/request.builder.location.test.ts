import type { FlightSearchCriteria } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import { SABRE_HOSTS, type SabreConfig } from '../config';
import { buildSabreShopRequest } from './request.builder';

const CONFIG: SabreConfig = {
  host: SABRE_HOSTS.cert.rest,
  epr: '500001',
  password: 'Pa55w0rd!',
  homePcc: 'ZZZZ',
};

function legs(overrides: Partial<FlightSearchCriteria>) {
  const criteria: FlightSearchCriteria = {
    origin: 'MDE',
    destination: 'SAO',
    departureDate: '2026-11-12',
    returnDate: '2026-11-20',
    paxCount: { adults: 1, children: 0, infants: 0 },
    currency: 'COP',
    ...overrides,
  };
  return buildSabreShopRequest(criteria, CONFIG).OTA_AirLowFareSearchRQ
    .OriginDestinationInformation;
}

describe('ciudad o aeropuerto: LocationType (v5.yml:4428)', () => {
  it('la ciudad entera va con C y el aeropuerto concreto con A, también en la vuelta', () => {
    const [ida, vuelta] = legs({ originKind: 'airport', destinationKind: 'city' });

    expect(ida?.OriginLocation).toEqual({ LocationCode: 'MDE', LocationType: 'A' });
    expect(ida?.DestinationLocation).toEqual({ LocationCode: 'SAO', LocationType: 'C' });
    expect(vuelta?.OriginLocation).toEqual({ LocationCode: 'SAO', LocationType: 'C' });
    expect(vuelta?.DestinationLocation).toEqual({ LocationCode: 'MDE', LocationType: 'A' });
  });

  it('Medellín entera: el mismo código MDE, pero como ciudad (MDE + EOH)', () => {
    const [ida] = legs({ originKind: 'city' });

    expect(ida?.OriginLocation).toEqual({ LocationCode: 'MDE', LocationType: 'C' });
  });

  it('sin saber qué es, no se manda LocationType: queda el default de BFM, como antes', () => {
    const [ida] = legs({});

    expect(ida?.OriginLocation).toEqual({ LocationCode: 'MDE' });
    expect(ida?.DestinationLocation).toEqual({ LocationCode: 'SAO' });
  });
});
