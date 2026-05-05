import type { Offer } from '@sales-travel/canonical';
import type { FlightSearchCriteria } from '@sales-travel/domain';
import type { LatamNdcConfig } from '../config';

export function buildOfferPriceRequest(
  offer: Offer,
  criteria: FlightSearchCriteria,
  cfg: LatamNdcConfig,
): string {
  const pax = buildPaxList(criteria);
  const paxRefIds = buildPaxRefIds(criteria);
  const offerRef = offer.provider.offerRef;

  return `<?xml version="1.0" encoding="UTF-8"?>
<IATA_OfferPriceRQ xmlns="http://www.iata.org/IATA/2015/00/2019.2/IATA_OfferPriceRQ">
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
  </POS>
  <Request>
    <DataLists>
      <PaxList>
        ${pax}
      </PaxList>
    </DataLists>
    <PricedOffer>
      <SelectedOffer>
        <OfferRefID>${escape(offerRef)}</OfferRefID>
        <OwnerCode>LA</OwnerCode>
        <SelectedOfferItem>
          <OfferItemRefID>${escape(offerRef)}-ITEM1</OfferItemRefID>
          ${paxRefIds}
        </SelectedOfferItem>
      </SelectedOffer>
    </PricedOffer>
  </Request>
</IATA_OfferPriceRQ>`;
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
  return lines.join('\n        ');
}

function buildPaxRefIds(c: FlightSearchCriteria): string {
  const lines: string[] = [];
  for (let i = 1; i <= c.paxCount.adults; i++) {
    lines.push(`<PaxRefID>ADT_${i}</PaxRefID>`);
  }
  for (let i = 1; i <= c.paxCount.children; i++) {
    lines.push(`<PaxRefID>CHD_${i}</PaxRefID>`);
  }
  for (let i = 1; i <= c.paxCount.infants; i++) {
    lines.push(`<PaxRefID>INF_${i}</PaxRefID>`);
  }
  return lines.join('\n          ');
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
