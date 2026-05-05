import type { Offer } from '@sales-travel/canonical';
import type { BookingContactInfo, Passenger, PaymentInfo } from '@sales-travel/domain';
import { currencyToCountry } from '../airshopping/request.builder';
import type { LatamNdcConfig } from '../config';

export function buildOrderCreateRequest(
  offer: Offer,
  passengers: Passenger[],
  contactInfo: BookingContactInfo,
  cfg: LatamNdcConfig,
  currency?: string,
  payment?: PaymentInfo,
): string {
  const { offerId, offerItemIds } = parseOfferRef(offer.provider.offerRef);
  const paxRefIds = passengers
    .map((p) => `<PaxRefID>${escape(p.paxId)}</PaxRefID>`)
    .join('\n            ');

  const selectedItems = offerItemIds
    .map(
      (itemId) => `<SelectedOfferItem>
          <OfferItemRefID>${escape(itemId)}</OfferItemRefID>
          ${paxRefIds}
        </SelectedOfferItem>`,
    )
    .join('\n        ');

  const contactInfoList = buildContactInfoList(passengers, contactInfo);
  const paxList = buildPaxList(passengers);
  const paymentBlock = payment ? buildPaymentFunctions(payment) : '';
  const country = currencyToCountry(currency) ?? cfg.country ?? '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<IATA_OrderCreateRQ xmlns="http://www.iata.org/IATA/2015/00/2019.2/IATA_OrderCreateRQ">
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
  <POS>
    <Country>
      <CountryCode>${escape(country)}</CountryCode>
    </Country>
  </POS>
  <Request>
    <CreateOrder>
      <SelectedOffer>
        <OfferRefID>${escape(offerId)}</OfferRefID>
        <OwnerCode>LA</OwnerCode>
        ${selectedItems}
      </SelectedOffer>
    </CreateOrder>
    <DataLists>
      <ContactInfoList>
        ${contactInfoList}
      </ContactInfoList>
      <PaxList>
        ${paxList}
      </PaxList>
    </DataLists>
    ${paymentBlock}
  </Request>
</IATA_OrderCreateRQ>`;
}

function buildContactInfoList(passengers: Passenger[], contactInfo: BookingContactInfo): string {
  const items: string[] = [];
  const { dialCode, areaCode, number } = parsePhone(contactInfo);
  const postalCountry = contactInfo.postalAddress?.countryCode ?? 'CO';
  const postalCode = contactInfo.postalAddress?.postalCode ?? '110001';
  const street = contactInfo.postalAddress?.street ?? 'N/A';

  items.push(`<ContactInfo>
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
        </ContactInfo>`);

  for (const pax of passengers) {
    items.push(`<ContactInfo>
          <ContactInfoID>${escape(pax.paxId)}_CNT</ContactInfoID>
          <EmailAddress>
            <EmailAddressText>${escape(contactInfo.email)}</EmailAddressText>
          </EmailAddress>
          <Phone>
            <AreaCodeNumber>${areaCode}</AreaCodeNumber>
            <ContactTypeText>MOBILE</ContactTypeText>
            <CountryDialingCode>${dialCode}</CountryDialingCode>
            <PhoneNumber>${number}</PhoneNumber>
          </Phone>
        </ContactInfo>`);
  }

  return items.join('\n        ');
}

function buildPaxList(passengers: Passenger[]): string {
  return passengers
    .map((p) => {
      const loyaltyBlock = p.loyaltyProgramAccount
        ? `\n          <LoyaltyProgramAccount>\n            <AccountNumber>${escape(p.loyaltyProgramAccount.accountNumber)}</AccountNumber>\n            <Carrier>\n              <AirlineDesigCode>${escape(p.loyaltyProgramAccount.airlineDesigCode ?? 'LA')}</AirlineDesigCode>\n            </Carrier>\n          </LoyaltyProgramAccount>`
        : '';
      return `<Pax>
          <CitizenshipCountryCode>${escape(p.citizenshipCountryCode)}</CitizenshipCountryCode>
          <ContactInfoRefID>${escape(p.paxId)}_CNT</ContactInfoRefID>
          <IdentityDoc>
            ${p.identityDoc.expiryDate ? `<ExpiryDate>${escape(p.identityDoc.expiryDate)}</ExpiryDate>` : ''}
            <IdentityDocID>${escape(p.identityDoc.number)}</IdentityDocID>
            <IdentityDocTypeCode>${escape(mapDocType(p.identityDoc.type))}</IdentityDocTypeCode>
            ${p.identityDoc.issueDate ? `<IssueDate>${escape(p.identityDoc.issueDate)}</IssueDate>` : `<IssueDate>2020-01-01</IssueDate>`}
            <IssuingCountryCode>${escape(p.identityDoc.issuingCountryCode)}</IssuingCountryCode>
          </IdentityDoc>
          <Individual>
            <Birthdate>${escape(p.birthdate)}</Birthdate>
            <GenderCode>${escape(p.gender)}</GenderCode>
            <GivenName>${escape(p.givenName.toUpperCase())}</GivenName>
            <IndividualID>${escape(p.paxId)}</IndividualID>
            <Surname>${escape(p.surname.toUpperCase())}</Surname>
            <TitleName>${escape(mapTitle(p))}</TitleName>
          </Individual>${loyaltyBlock}
          <PaxID>${escape(p.paxId)}</PaxID>
          <PTC>${escape(p.paxType)}</PTC>
        </Pax>`;
    })
    .join('\n        ');
}

function mapTitle(p: Passenger): string {
  if (p.title) return p.title;
  return p.gender === 'M' ? 'Mr' : 'Mrs';
}

function mapDocType(type: string): string {
  switch (type) {
    case 'P':
      return 'P';
    case 'DNI':
    case 'CC':
    case 'CE':
      return 'IN';
    default:
      return 'IN';
  }
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

function parseOfferRef(ref: string): { offerId: string; offerItemIds: string[] } {
  const pipeIdx = ref.indexOf('|');
  if (pipeIdx === -1) {
    return { offerId: ref, offerItemIds: [`${ref}-ITEM1`] };
  }
  const offerId = ref.slice(0, pipeIdx);
  const offerItemIds = ref
    .slice(pipeIdx + 1)
    .split(',')
    .filter(Boolean);
  return { offerId, offerItemIds: offerItemIds.length > 0 ? offerItemIds : [`${offerId}-ITEM1`] };
}

function buildPaymentFunctions(payment: PaymentInfo): string {
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

  const payerBlock = payment.payer
    ? `\n      <Payer>\n        <Name>\n          <GivenName>${escape(payment.payer.name)}</GivenName>\n          <Surname>${escape(payment.payer.surname)}</Surname>\n        </Name>${payment.payer.taxId ? `\n        <TaxID>${escape(payment.payer.taxId)}</TaxID>` : ''}\n      </Payer>`
    : '';

  return `<PaymentFunctions>${payerBlock}
      <PaymentProcessingDetails>
        <Amount CurCode="${escape(payment.currency)}">${payment.amount}</Amount>
        ${methodContent}
      </PaymentProcessingDetails>
    </PaymentFunctions>`;
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
