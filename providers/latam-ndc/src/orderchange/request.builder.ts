import type { BookingContactInfo, PaymentInfo } from '@sales-travel/domain';
import type { LatamNdcConfig } from '../config';

export function buildOrderChangePaymentRequest(
  orderId: string,
  payment: PaymentInfo,
  contactInfo: BookingContactInfo,
  passengers: { paxId: string; paxType: string }[],
  cfg: LatamNdcConfig,
): string {
  const { dialCode, areaCode, number } = parsePhone(contactInfo);
  const postalCountry = contactInfo.postalAddress?.countryCode ?? 'CO';
  const postalCode = contactInfo.postalAddress?.postalCode ?? '110001';
  const street = contactInfo.postalAddress?.street ?? 'N/A';

  const paxList = passengers
    .map(
      (p) => `<Pax>
          <PaxID>${escape(p.paxId)}</PaxID>
          <PTC>${escape(p.paxType)}</PTC>
        </Pax>`,
    )
    .join('\n        ');

  const paymentBlock = buildPaymentBlock(payment);

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
          <ContactPurposeText>BILLING</ContactPurposeText>
          <EmailAddress>
            <EmailAddressText>${escape(contactInfo.email)}</EmailAddressText>
          </EmailAddress>
          <Phone>
            <AreaCodeNumber>${areaCode}</AreaCodeNumber>
            <ContactTypeText>MOBILE</ContactTypeText>
            <CountryDialingCode>${dialCode}</CountryDialingCode>
            <PhoneNumber>${number}</PhoneNumber>
          </Phone>
          <PostalAddress>
            <CountryCode>${escape(postalCountry)}</CountryCode>
            <PostalCode>${escape(postalCode)}</PostalCode>
            <StreetText>${escape(street)}</StreetText>
          </PostalAddress>
        </ContactInfo>
      </ContactInfoList>
      <PaxList>
        ${paxList}
      </PaxList>
    </DataLists>
    <Order>
      <OrderID>${escape(orderId)}</OrderID>
      <OwnerCode>LA</OwnerCode>
    </Order>
    ${paymentBlock}
  </Request>
</IATA_OrderChangeRQ>`;
}

function buildPaymentBlock(payment: PaymentInfo): string {
  let methodContent: string;

  if (payment.type === 'Credit Card' && payment.card) {
    const securityCode = payment.card.securityCode
      ? `\n            <CardSecurityCode>${escape(payment.card.securityCode)}</CardSecurityCode>`
      : '';
    methodContent = `<PaymentMethod>
          <PaymentCard>
            <CardBrandCode>${escape(payment.card.brandCode)}</CardBrandCode>
            <CardHolderName>${escape(payment.card.holderName)}</CardHolderName>
            <CardNumber>${escape(payment.card.number)}</CardNumber>${securityCode}
            <ExpirationDate>${escape(payment.card.expirationDate)}</ExpirationDate>
          </PaymentCard>
        </PaymentMethod>
        <TypeCode>${escape(payment.type)}</TypeCode>`;
  } else if (payment.type === 'Cash') {
    methodContent = `<PaymentMethod>
          <Cash/>
        </PaymentMethod>
        <TypeCode>Cash</TypeCode>`;
  } else {
    methodContent = `<PaymentMethod>
          <Cash/>
        </PaymentMethod>
        <TypeCode>GOV</TypeCode>`;
  }

  return `<PaymentFunctions>
      <PaymentProcessingDetails>
        <Amount CurCode="${escape(payment.currency)}">${payment.amount}</Amount>
        ${methodContent}
      </PaymentProcessingDetails>
    </PaymentFunctions>`;
}

function parsePhone(contactInfo: BookingContactInfo): {
  dialCode: string;
  areaCode: string;
  number: string;
} {
  const digits = contactInfo.phone.replace(/\D/g, '');
  const dialCode = contactInfo.countryDialingCode?.replace(/\D/g, '') || '57';
  const areaCode = contactInfo.areaCode?.replace(/\D/g, '') || '1';

  let number = digits;
  if (digits.startsWith(dialCode)) {
    number = digits.slice(dialCode.length);
  }

  return { dialCode, areaCode, number };
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
