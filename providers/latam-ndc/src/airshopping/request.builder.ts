import type { FlightSearchCriteria } from '@sales-travel/domain';
import type { LatamNdcConfig } from '../config';

/**
 * Arma el XML IATA_AirShoppingRQ para LATAM v192.
 * - Si hay returnDate → genera 2 OriginDestCriteria (RT).
 * - Si no → 1 OriginDestCriteria (OW).
 * - Pax: ADT_1..N, CHD_1..N, INF_1..N según el PaxCount.
 */
export function buildAirShoppingRequest(
  criteria: FlightSearchCriteria,
  cfg: LatamNdcConfig,
): string {
  const requestTime = new Date().toISOString().replace(/\.\d{3}Z$/, '');
  const pax = buildPaxList(criteria);
  const odList = buildOriginDestList(criteria);

  return `<?xml version="1.0" encoding="UTF-8"?>
<IATA_AirShoppingRQ xmlns="http://www.iata.org/IATA/2015/00/2019.2/IATA_AirShoppingRQ">
  <MessageDoc>
    <RefVersionNumber>1.0</RefVersionNumber>
  </MessageDoc>
  <Party>
    <Sender>
      <TravelAgency>
        <AgencyID>${escape(cfg.agencyId ?? '')}</AgencyID>
        <IATA_Number>${escape(cfg.agencyIata ?? '')}</IATA_Number>
        <Name>${escape(cfg.agencyName ?? '')}</Name>
        ${cfg.travelAgentId ? `<TravelAgent><TravelAgentID>${escape(cfg.travelAgentId)}</TravelAgentID></TravelAgent>` : ''}
      </TravelAgency>
    </Sender>
  </Party>
  <POS>
    <Country>
      <CountryCode>${escape(cfg.country ?? '')}</CountryCode>
    </Country>
    <RequestTime>${requestTime}</RequestTime>
  </POS>
  <Request>
    <FlightCriteria>
      ${odList}
    </FlightCriteria>
    <Paxs>
      ${pax}
    </Paxs>
    <ShoppingCriteria>
      <ProgramCriteria>
        <ProgramOwner>
          <Carrier>
            <AirlineDesigCode>LA</AirlineDesigCode>
          </Carrier>
        </ProgramOwner>
      </ProgramCriteria>
    </ShoppingCriteria>
  </Request>
</IATA_AirShoppingRQ>`;
}

function buildOriginDestList(c: FlightSearchCriteria): string {
  const outbound = `
        <OriginDestCriteria>
          <DestArrivalCriteria>
            <IATA_LocationCode>${c.destination}</IATA_LocationCode>
          </DestArrivalCriteria>
          <OriginDepCriteria>
            <Date>${c.departureDate}</Date>
            <IATA_LocationCode>${c.origin}</IATA_LocationCode>
          </OriginDepCriteria>
        </OriginDestCriteria>`;
  if (!c.returnDate) return outbound;

  const inbound = `
        <OriginDestCriteria>
          <DestArrivalCriteria>
            <IATA_LocationCode>${c.origin}</IATA_LocationCode>
          </DestArrivalCriteria>
          <OriginDepCriteria>
            <Date>${c.returnDate}</Date>
            <IATA_LocationCode>${c.destination}</IATA_LocationCode>
          </OriginDepCriteria>
        </OriginDestCriteria>`;
  return outbound + inbound;
}

function buildPaxList(c: FlightSearchCriteria): string {
  const lines: string[] = [];
  for (let i = 1; i <= c.paxCount.adults; i++) {
    lines.push(`<Pax><PaxID>ADT_${i}</PaxID><PTC>ADT</PTC></Pax>`);
  }
  for (let i = 1; i <= c.paxCount.children; i++) {
    lines.push(`<Pax><PaxID>CHD_${i}</PaxID><PTC>CHD</PTC></Pax>`);
  }
  for (let i = 1; i <= c.paxCount.infants; i++) {
    lines.push(`<Pax><PaxID>INF_${i}</PaxID><PTC>INF</PTC></Pax>`);
  }
  return lines.join('\n      ');
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
