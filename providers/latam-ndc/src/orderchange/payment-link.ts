import type { PaymentLinkResult } from '@sales-travel/domain';
import type { LatamNdcConfig } from '../config';
import { latamErrors, pick } from '../xml';

export const PAYMENT_LINK_PATH = '/ndc/v192/order/change/send/payment/link';

/**
 * `OrderChangeRQ` para que LATAM le mande al pagador un enlace de pago de una reserva sin pagar
 * (`[portal:/ndc/order-payment-link-generation]`). Sólo el `OrderID` y el correo del pagador: el
 * monto lo pone LATAM y la tarjeta la captura LATAM en su sitio (PCI SAQ-A).
 */
export function buildPaymentLinkRequest(
  orderId: string,
  email: string,
  cfg: LatamNdcConfig,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<IATA_OrderChangeRQ xmlns="http://www.iata.org/IATA/2015/00/2019.2/IATA_OrderChangeRQ">
  <MessageDoc>
    <RefVersionNumber>1.0</RefVersionNumber>
  </MessageDoc>
  <Party>
    <Sender>
      <TravelAgency>
        <AgencyID>${escape(cfg.agencyId ?? '')}</AgencyID>
        <ContactInfoRefID>AGENCY_1_CNT</ContactInfoRefID>
        <IATA_Number>${escape(cfg.agencyIata ?? '')}</IATA_Number>
        <Name>${escape(cfg.agencyName ?? '')}</Name>
        ${cfg.travelAgentId ? `<TravelAgent><TravelAgentID>${escape(cfg.travelAgentId)}</TravelAgentID></TravelAgent>` : ''}
      </TravelAgency>
    </Sender>
  </Party>
  <Request>
    <DataLists>
      <ContactInfoList>
        <ContactInfo>
          <ContactInfoID>AGENCY_1_CNT</ContactInfoID>
          <EmailAddress>
            <EmailAddressText>${escape(email)}</EmailAddressText>
          </EmailAddress>
        </ContactInfo>
      </ContactInfoList>
    </DataLists>
    <Order>
      <OrderID>${escape(orderId)}</OrderID>
      <OwnerCode>LA</OwnerCode>
    </Order>
  </Request>
</IATA_OrderChangeRQ>`;
}

/**
 * La guía oficial no publica la respuesta del enlace. Éxito = LATAM respondió un mensaje NDC sin
 * `<Error>`; con `<Error>`, falla con sus códigos.
 */
export function mapPaymentLinkResponse(raw: unknown): PaymentLinkResult {
  const root =
    pick(raw, 'IATA_OrderViewRS', 'OrderViewRS', 'IATA_OrderChangeRS', 'OrderChangeRS') ??
    Object.values((raw as Record<string, unknown>) ?? {}).find(
      (v) => v !== null && typeof v === 'object',
    );
  if (!root) {
    return { success: false, warnings: [], error: 'Respuesta vacía de LATAM' };
  }
  const errors = latamErrors(root);
  if (errors.length > 0) {
    const msg = errors.map((e) => `LATAM error ${e.code}: ${e.desc}`).join(' | ');
    return { success: false, warnings: [msg], error: msg };
  }
  return { success: true, warnings: [] };
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
