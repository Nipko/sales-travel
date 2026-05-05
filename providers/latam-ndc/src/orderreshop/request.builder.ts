import type { OrderReshopRequest } from '@sales-travel/domain';
import type { LatamNdcConfig } from '../config';

export function buildOrderReshopRequest(request: OrderReshopRequest, cfg: LatamNdcConfig): string {
  const orderItemRefs = request.ticketDocIds
    .map((id) => `<OrderItemRefID>${escape(id)}</OrderItemRefID>`)
    .join('\n                ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<IATA_OrderReshopRQ xmlns="http://www.iata.org/IATA/2015/00/2019.2/IATA_OrderReshopRQ">
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
        <BookingRef>
            <BookingEntity></BookingEntity>
            <BookingID>${escape(request.paidOrderId)}</BookingID>
        </BookingRef>
        <OrderRefID>${escape(request.bnplOrderId)}</OrderRefID>
        <UpdateOrder>
            <RepriceOrder>
                ${orderItemRefs}
            </RepriceOrder>
        </UpdateOrder>
    </Request>
</IATA_OrderReshopRQ>`;
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
