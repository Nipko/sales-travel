import type { ServiceListRequest } from '@sales-travel/domain';
import type { LatamNdcConfig } from '../config';

export function buildServiceListRequest(request: ServiceListRequest, cfg: LatamNdcConfig): string {
  const paxList = request.passengers
    .filter((p) => p.paxType !== 'INF')
    .map(
      (p) => `<Pax>
            <PaxID>${escape(p.paxId)}</PaxID>
            <PTC>${escape(p.paxType)}</PTC>
        </Pax>`,
    )
    .join('\n        ');

  const coreRequest = request.orderId
    ? buildPostBookingCore(request.orderId)
    : buildBookingCore(request.offerId ?? '');

  const itemType = request.itemType ?? 'BAGGAGE';

  return `<?xml version="1.0" encoding="UTF-8"?>
<IATA_ServiceListRQ xmlns="http://www.iata.org/IATA/2015/00/2019.2/IATA_ServiceListRQ">
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
        ${coreRequest}
        ${paxList}
        <ShoppingCriteria>
            <OfferItemTypeCriteria>
                <OfferItemTypeCode>${escape(itemType)}</OfferItemTypeCode>
            </OfferItemTypeCriteria>
        </ShoppingCriteria>
    </Request>
</IATA_ServiceListRQ>`;
}

function buildBookingCore(offerId: string): string {
  return `<CoreRequest>
            <Offer>
                <OfferID>${escape(offerId)}</OfferID>
            </Offer>
        </CoreRequest>`;
}

function buildPostBookingCore(orderId: string): string {
  return `<CoreRequest>
            <Order>
                <OrderID>${escape(orderId)}</OrderID>
                <OrderItem>
                    <GrandTotalAmount>0</GrandTotalAmount>
                </OrderItem>
            </Order>
        </CoreRequest>`;
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
