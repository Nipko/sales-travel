import type { Offer } from '@sales-travel/canonical';
import type { BookingContactInfo, Passenger } from '@sales-travel/domain';
import type { LatamNdcConfig } from '../config';

export function buildOrderCreateRequest(
  offer: Offer,
  passengers: Passenger[],
  contactInfo: BookingContactInfo,
  cfg: LatamNdcConfig,
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

  return `<?xml version="1.0" encoding="UTF-8"?>
<IATA_OrderCreateRQ xmlns="http://www.iata.org/IATA/2015/00/2019.2/IATA_OrderCreateRQ">
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
  </Request>
</IATA_OrderCreateRQ>`;
}

function buildContactInfoList(passengers: Passenger[], contactInfo: BookingContactInfo): string {
  const items: string[] = [];

  for (const pax of passengers) {
    items.push(`<ContactInfo>
          <ContactInfoID>${escape(pax.paxId)}_CNT</ContactInfoID>
          <EmailAddress>
            <EmailAddressText>${escape(contactInfo.email)}</EmailAddressText>
          </EmailAddress>
          <Phone>
            <PhoneNumber>${escape(contactInfo.phone)}</PhoneNumber>
          </Phone>
        </ContactInfo>`);
  }

  return items.join('\n        ');
}

function buildPaxList(passengers: Passenger[]): string {
  return passengers
    .map(
      (p) => `<Pax>
          <CitizenshipCountryCode>${escape(p.citizenshipCountryCode)}</CitizenshipCountryCode>
          <ContactInfoRefID>${escape(p.paxId)}_CNT</ContactInfoRefID>
          <IdentityDoc>
            <ExpiryDate>${escape(p.identityDoc.expiryDate)}</ExpiryDate>
            <IdentityDocID>${escape(p.identityDoc.number)}</IdentityDocID>
            <IdentityDocTypeCode>${escape(p.identityDoc.type === 'P' ? 'P' : 'NI')}</IdentityDocTypeCode>
            <IssuingCountryCode>${escape(p.identityDoc.issuingCountryCode)}</IssuingCountryCode>
          </IdentityDoc>
          <Individual>
            <Birthdate>${escape(p.birthdate)}</Birthdate>
            <GenderCode>${escape(p.gender)}</GenderCode>
            <GivenName>${escape(p.givenName.toUpperCase())}</GivenName>
            <Surname>${escape(p.surname.toUpperCase())}</Surname>
          </Individual>
          <PaxID>${escape(p.paxId)}</PaxID>
          <PTC>${escape(p.paxType)}</PTC>
        </Pax>`,
    )
    .join('\n        ');
}

function parseOfferRef(ref: string): { offerId: string; offerItemIds: string[] } {
  const pipeIdx = ref.indexOf('|');
  if (pipeIdx === -1) {
    return { offerId: ref, offerItemIds: [`${ref}-ITEM1`] };
  }
  const offerId = ref.slice(0, pipeIdx);
  const offerItemIds = ref.slice(pipeIdx + 1).split(',').filter(Boolean);
  return { offerId, offerItemIds: offerItemIds.length > 0 ? offerItemIds : [`${offerId}-ITEM1`] };
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
