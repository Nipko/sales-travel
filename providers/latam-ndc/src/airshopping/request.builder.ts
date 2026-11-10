import { searchLegs, type FlightSearchCriteria } from '@sales-travel/domain';
import { posCityFor, type LatamNdcConfig } from '../config';

/**
 * Arma el XML IATA_AirShoppingRQ para LATAM v192.
 * - Un OriginDestCriteria por tramo (`searchLegs`): solo ida, ida y vuelta o multidestino.
 * - Pax: ADT_1..N, CHD_1..N, INF_1..N según el PaxCount.
 */
export function buildAirShoppingRequest(
  criteria: FlightSearchCriteria,
  cfg: LatamNdcConfig,
): string {
  const requestTime = new Date().toISOString().replace(/\.\d{3}Z$/, '');
  const pax = buildPaxList(criteria);
  const odList = buildOriginDestList(criteria);
  // País de la cuenta, no de la moneda: ver `LatamNdcFlightSearchAdapter.search`.
  const country = cfg.country ?? '';
  const city = posCityFor(cfg, country);

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
  <POS>${
    city
      ? `
    <City>
      <IATA_LocationCode>${escape(city)}</IATA_LocationCode>
    </City>`
      : ''
  }
    <Country>
      <CountryCode>${escape(country)}</CountryCode>
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
    <ResponseParameters>
      <LangUsage>
        <LangCode>ES</LangCode>
      </LangUsage>
    </ResponseParameters>
    <ShoppingCriteria>${cfg.accountCode ? `\n      <AccountCriteria>\n        <AccountCode>${escape(cfg.accountCode)}</AccountCode>\n      </AccountCriteria>` : ''}
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

const CABIN_MAP: Record<string, string> = {
  economy: 'Y',
  premium_economy: 'W',
  business: 'J',
  first: 'J',
};

/**
 * Códigos de ciudad con varios aeropuertos que no son a la vez un aeropuerto, con el que LATAM
 * opera como principal.
 *
 * El buscador deja elegir la ciudad entera (SAO = GRU + CGH + VCP). Sabre lo resuelve con
 * `LocationType`; para el AirShopping de LATAM no tenemos evidencia de que `IATA_LocationCode`
 * acepte un código de ciudad, así que se pide el aeropuerto principal en vez de arriesgar un
 * rechazo que deje la búsqueda sin LATAM. Los códigos que son ciudad y aeropuerto a la vez
 * (MDE, MEX, HOU) pasan tal cual.
 */
export const LATAM_CITY_MAIN_AIRPORT: Readonly<Record<string, string>> = {
  SAO: 'GRU',
  RIO: 'GIG',
  BHZ: 'CNF',
  BUE: 'EZE',
  NYC: 'JFK',
  WAS: 'IAD',
  CHI: 'ORD',
  LON: 'LHR',
  PAR: 'CDG',
  MIL: 'MXP',
  ROM: 'FCO',
  TYO: 'NRT',
  YTO: 'YYZ',
  SEL: 'ICN',
  BJS: 'PEK',
  OSA: 'KIX',
};

export function latamLocationCode(code: string): string {
  return LATAM_CITY_MAIN_AIRPORT[code] ?? code;
}

function buildOriginDestList(criteria: FlightSearchCriteria): string {
  const cabinCode = criteria.cabin ? CABIN_MAP[criteria.cabin] : undefined;
  const cabinXml = cabinCode
    ? `
          <PreferredCabinType>
            <CabinTypeCode>${cabinCode}</CabinTypeCode>
          </PreferredCabinType>`
    : '';
  // Un OriginDestCriteria por tramo: solo ida, ida y vuelta o multidestino (LATAM lo habilitó el
  // 17/10/2025, docs/latam-ndc/01). Los tramos salen de `searchLegs`, la misma regla que Sabre.
  return searchLegs(criteria)
    .map(
      (leg) => `
        <OriginDestCriteria>
          <DestArrivalCriteria>
            <IATA_LocationCode>${latamLocationCode(leg.destination)}</IATA_LocationCode>
          </DestArrivalCriteria>
          <OriginDepCriteria>
            <Date>${leg.departureDate}</Date>
            <IATA_LocationCode>${latamLocationCode(leg.origin)}</IATA_LocationCode>
          </OriginDepCriteria>${cabinXml}
        </OriginDestCriteria>`,
    )
    .join('');
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
