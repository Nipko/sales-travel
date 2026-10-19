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
  const country = currencyToCountry(criteria.currency) ?? cfg.country ?? '';

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

/** Maps ISO currency code to LATAM POS country code */
export function currencyToCountry(currency?: string): string | undefined {
  if (!currency) return undefined;
  return CURRENCY_COUNTRY_MAP[currency.toUpperCase()];
}

const CURRENCY_COUNTRY_MAP: Record<string, string> = {
  COP: 'CO',
  BRL: 'BR',
  CLP: 'CL',
  PEN: 'PE',
  ARS: 'AR',
  USD: 'US',
  EUR: 'ES',
  MXN: 'MX',
  UYU: 'UY',
  BOB: 'BO',
  PYG: 'PY',
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
  const c = {
    ...criteria,
    origin: latamLocationCode(criteria.origin),
    destination: latamLocationCode(criteria.destination),
  };
  const cabinCode = c.cabin ? CABIN_MAP[c.cabin] : undefined;
  const cabinXml = cabinCode
    ? `\n          <PreferredCabinType>\n            <CabinTypeCode>${cabinCode}</CabinTypeCode>\n          </PreferredCabinType>`
    : '';

  const outbound = `
        <OriginDestCriteria>
          <DestArrivalCriteria>
            <IATA_LocationCode>${c.destination}</IATA_LocationCode>
          </DestArrivalCriteria>
          <OriginDepCriteria>
            <Date>${c.departureDate}</Date>
            <IATA_LocationCode>${c.origin}</IATA_LocationCode>
          </OriginDepCriteria>${cabinXml}
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
          </OriginDepCriteria>${cabinXml}
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
