import type { LatamNdcConfig } from '../config';

export function buildOrderRetrieveRequest(orderId: string, cfg: LatamNdcConfig): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<IATA_OrderRetrieveRQ xmlns="http://www.iata.org/IATA/2015/00/2019.2/IATA_OrderRetrieveRQ">
  <MessageDoc>
    <RefVersionNumber>1.0</RefVersionNumber>
  </MessageDoc>
  <Party>
    <Sender>
      <TravelAgency>
        <AgencyID>${escape(cfg.agencyId ?? '')}</AgencyID>
        <IATA_Number>${escape(cfg.agencyIata ?? '')}</IATA_Number>
        <Name>${escape(cfg.agencyName ?? '')}</Name>
      </TravelAgency>
    </Sender>
  </Party>
  <POS>
    <Country>
      <CountryCode>${escape(cfg.country ?? '')}</CountryCode>
    </Country>
  </POS>
  <Request>
    <OrderFilterCriteria>
      <Order>
        <OrderID>${escape(orderId)}</OrderID>
        <OwnerCode>LA</OwnerCode>
      </Order>
    </OrderFilterCriteria>
  </Request>
</IATA_OrderRetrieveRQ>`;
}

export function buildOrderCancelRequest(orderId: string, cfg: LatamNdcConfig): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<IATA_OrderCancelRQ xmlns="http://www.iata.org/IATA/2015/00/2019.2/IATA_OrderCancelRQ">
  <MessageDoc>
    <RefVersionNumber>1.0</RefVersionNumber>
  </MessageDoc>
  <Party>
    <Sender>
      <TravelAgency>
        <AgencyID>${escape(cfg.agencyId ?? '')}</AgencyID>
        <IATA_Number>${escape(cfg.agencyIata ?? '')}</IATA_Number>
        <Name>${escape(cfg.agencyName ?? '')}</Name>
      </TravelAgency>
    </Sender>
  </Party>
  <POS>
    <Country>
      <CountryCode>${escape(cfg.country ?? '')}</CountryCode>
    </Country>
  </POS>
  <Request>
    <Order>
      <OrderID>${escape(orderId)}</OrderID>
      <OwnerCode>LA</OwnerCode>
    </Order>
  </Request>
</IATA_OrderCancelRQ>`;
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
