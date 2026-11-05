import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Offer } from '@sales-travel/canonical';
import type { FlightSearchCriteria } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import { OfferSchema } from '@sales-travel/canonical';
import { buildAirShoppingRequest } from './airshopping/request.builder';
import { buildOfferPriceRequest } from './offerprice/request.builder';
import { readLatamOfferRef } from './offer-ref';
import { mapAirShoppingResponse } from './airshopping/response.mapper';
import { LatamApiError, LatamBusinessError } from './errors';
import { parseLatamXml } from './http/latam-http.client';
import { mapOfferPriceResponse } from './offerprice/response.mapper';
import { mapOrderChangePaymentResponse } from './orderchange/response.mapper';
import { buildOrderCreateRequest } from './ordercreate/request.builder';
import { mapOrderCreateResponse } from './ordercreate/response.mapper';
import { mapOrderCancelResponse, mapOrderRetrieveResponse } from './ordermanage/response.mappers';

const TENANT = '00000000-0000-4000-8000-000000000001';
const fixture = (name: string): unknown =>
  parseLatamXml(readFileSync(join(__dirname, '__fixtures__', name), 'utf8'));
const xml = (body: string): unknown =>
  parseLatamXml(`<?xml version="1.0" encoding="UTF-8"?>${body}`);

const criteria: FlightSearchCriteria = {
  origin: 'BOG',
  destination: 'LIM',
  departureDate: '2026-12-10',
  returnDate: '2026-12-17',
  paxCount: { adults: 2, children: 1, infants: 1 },
  currency: 'COP',
};

function searchOffer(): Offer {
  const { offers } = mapAirShoppingResponse(
    fixture('airshopping-rt-multipax.xml'),
    criteria,
    TENANT,
  );
  expect(offers).toHaveLength(1);
  return offers[0]!;
}

describe('AirShopping v2', () => {
  it('lee la hora con el offset que declara TimeZoneCode, no como UTC', () => {
    const seg = searchOffer().itineraries![0]!.segments[0]!;
    expect(seg.departureAt).toBe('2026-12-10T06:50:00-05:00');
    expect(seg.arrivalAt).toBe('2026-12-10T10:05:00-05:00');
    expect(seg.durationMinutes).toBe(195);
  });

  it('ordena los itinerarios por salida aunque LATAM liste primero la vuelta', () => {
    const route = searchOffer().itineraries!.map(
      (i) => `${i.segments[0]!.origin}-${i.segments[0]!.destination}`,
    );
    expect(route).toEqual(['BOG-LIM', 'LIM-BOG']);
  });

  it('toma la clase de reserva del FareComponent de cada trayecto', () => {
    const its = searchOffer().itineraries!;
    expect(its[0]!.segments[0]!.bookingClass).toBe('S');
    expect(its[1]!.segments[0]!.bookingClass).toBe('V');
  });

  it('mapea operador distinto y avión', () => {
    const its = searchOffer().itineraries!;
    expect(its[0]!.segments[0]!.operatingCarrier).toBeUndefined();
    expect(its[0]!.segments[0]!.aircraft).toBe('320');
    expect(its[1]!.segments[0]!.operatingCarrier).toBe('4C');
  });

  it('lee cambios y reembolsos de la LISTA por pasajero', () => {
    expect(searchOffer().policies).toEqual({ changeable: true, refundable: false });
  });

  it('total de todos los pasajeros, impuestos declarados, marca y equipaje', () => {
    const offer = searchOffer();
    expect(offer.total).toEqual({ amountMinor: 350_000_000, currency: 'COP' });
    expect(offer.taxes).toEqual({ amountMinor: 70_000_000, currency: 'COP' });
    expect(offer.fareFamily).toEqual({ name: 'LIGHT', cabin: 'economy' });
    expect(offer.baggage).toEqual({
      personalItem: 1,
      carryOn: { qty: 1, weightKg: 10 },
      checked: { qty: 0 },
    });
    expect(offer.expiresAtSource).toBe('platform-policy');
  });

  it('offerRef lleva sólo el OfferID; los OfferItemID van en raw (un ida y vuelta pasaba de 255)', () => {
    const provider = searchOffer().provider;
    expect(provider.offerRef).toBe('3f0c2a9e-6b7d-4c1e-9a55-1d2e3f4a5b6c');
    expect(provider.raw).toEqual({
      offerItemIds: ['SEI|T1VUQk9VTkQ=|QkxPQ0sx|MXwx', 'SEI|SU5CT1VORA==|QkxPQ0sy|MXwx'],
    });
  });

  it('con OfferItemID reales (largos) el offerRef sigue dentro de los 255 del canónico', () => {
    const largo = 'SEI|' + 'Q'.repeat(160) + '|' + 'U'.repeat(120) + '|MnwxfDE=';
    const source = readFileSync(
      join(__dirname, '__fixtures__', 'airshopping-rt-multipax.xml'),
      'utf8',
    )
      .replace('SEI|T1VUQk9VTkQ=|QkxPQ0sx|MXwx', largo)
      .replace('SEI|SU5CT1VORA==|QkxPQ0sy|MXwx', largo + 'X');
    const offer = mapAirShoppingResponse(parseLatamXml(source), criteria, TENANT).offers[0]!;
    expect(OfferSchema.safeParse(offer).success).toBe(true);
    const body = buildOfferPriceRequest(offer, criteria, {
      apiUrl: 'x',
      agencyId: 'A',
      agencyIata: '1',
      agencyName: 'N',
      country: 'CO',
    });
    expect(body).toContain(`<OfferItemRefID>${largo}</OfferItemRefID>`);
    expect(body).toContain(`<OfferItemRefID>${largo}X</OfferItemRefID>`);
  });

  it('una oferta guardada con la forma vieja (OfferID|items) se sigue leyendo', () => {
    expect(readLatamOfferRef({ name: 'latam-ndc', offerRef: 'o-1|SEI|A|B,SEI|C|D' })).toEqual({
      offerId: 'o-1',
      offerItemIds: ['SEI|A|B', 'SEI|C|D'],
    });
  });

  it('lanza los errores de negocio, todos, en vez de devolver 0 vuelos', () => {
    const raw = xml(`<IATA_AirShoppingRS>
      <Error><Code>400122006</Code><DescText>Departure date can't be before today</DescText></Error>
      <Error><Code>400122005</Code><DescText>Not chronological</DescText></Error>
    </IATA_AirShoppingRS>`);
    try {
      mapAirShoppingResponse(raw, criteria, TENANT, 'track-1');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(LatamBusinessError);
      expect((err as LatamBusinessError).errors.map((e) => e.code)).toEqual([
        '400122006',
        '400122005',
      ]);
      expect((err as LatamBusinessError).trackId).toBe('track-1');
      // LATAM respondió: no cuenta como caída para el circuit breaker.
      expect((err as LatamBusinessError).failure.circuit).toBe('IGNORE');
    }
  });

  it('«ruta no operada» es una búsqueda sin vuelos, no una falla', () => {
    const raw = xml(`<IATA_AirShoppingRS>
      <Error><Code>404122006</Code><DescText>We don't sell the BOG-XYZ segment.</DescText></Error>
    </IATA_AirShoppingRS>`);
    expect(mapAirShoppingResponse(raw, criteria, TENANT).offers).toEqual([]);
  });

  it('sin raíz NDC es una falla de proveedor', () => {
    expect(() => mapAirShoppingResponse({ html: {} }, criteria, TENANT)).toThrow(LatamApiError);
  });

  it('descarta el segmento sin offset en vez de inventarlo', () => {
    const source = readFileSync(
      join(__dirname, '__fixtures__', 'airshopping-rt-multipax.xml'),
      'utf8',
    );
    const raw = parseLatamXml(
      source.replace('TimeZoneCode="-05:00">2026-12-10T06:50:00', '>2026-12-10T06:50:00'),
    );
    const { warnings, offers } = mapAirShoppingResponse(raw, criteria, TENANT);
    expect(warnings.join(' ')).toMatch(/no times with TimeZoneCode/);
    expect(offers[0]!.itineraries!.map((i) => i.segments[0]!.origin)).toEqual(['LIM']);
  });
});

describe('Tarifa por trayecto (fareComponents) y desglose', () => {
  it('un componente por trayecto, con marca, base, clase e índices sobre los segmentos aplanados', () => {
    const fc = searchOffer().fareComponents!;
    expect(
      fc.map((c) => [c.brand?.name, c.fareBasisCode, c.bookingClasses, c.segmentRefs]),
    ).toEqual([
      ['LIGHT', 'SLEX0C3E', ['S'], [0]],
      ['LIGHT', 'SLEX0C3E', ['V'], [1]],
    ]);
  });

  it('lo que incluye la marca: equipaje del trayecto, maleta no incluida, cambios con cargo, sin reembolso', () => {
    const ida = searchOffer().fareComponents![0]!.includes!;
    expect(ida.map((i) => [i.kind, i.status])).toEqual([
      ['personal-item', 'included'],
      ['carry-on', 'included'],
      ['checked-bag', 'not-offered'],
      ['change', 'charge'],
      ['refund', 'not-offered'],
    ]);
  });

  it('el desglose por pasajero sólo sale si cuadra con el total', () => {
    // La vuelta del fixture no trae precio por pasajero: no se puede afirmar un desglose.
    expect(searchOffer().fareBreakdown).toBeUndefined();

    const raw = xml(`<IATA_AirShoppingRS><Response>
      <DataLists>
        <PaxJourneyList><PaxJourney><PaxJourneyID>J1</PaxJourneyID><PaxSegmentRefID>S1</PaxSegmentRefID></PaxJourney></PaxJourneyList>
        <PaxList><Pax><PaxID>ADT_1</PaxID><PTC>ADT</PTC></Pax><Pax><PaxID>ADT_2</PaxID><PTC>ADT</PTC></Pax><Pax><PaxID>INF_1</PaxID><PTC>INF</PTC></Pax></PaxList>
        <PaxSegmentList><PaxSegment>
          <Arrival><AircraftScheduledDateTime TimeZoneCode="-05:00">2026-12-10T10:05:00</AircraftScheduledDateTime><IATA_LocationCode>LIM</IATA_LocationCode></Arrival>
          <Dep><AircraftScheduledDateTime TimeZoneCode="-05:00">2026-12-10T06:50:00</AircraftScheduledDateTime><IATA_LocationCode>BOG</IATA_LocationCode></Dep>
          <MarketingCarrierInfo><CarrierDesigCode>LA</CarrierDesigCode><MarketingCarrierFlightNumberText>2580</MarketingCarrierFlightNumberText></MarketingCarrierInfo>
          <PaxSegmentID>S1</PaxSegmentID>
        </PaxSegment></PaxSegmentList>
      </DataLists>
      <OffersGroup><CarrierOffers><Offer>
        <OfferID>o1</OfferID>
        <OfferItem>
          <FareDetail>
            <FarePriceType><Price><BaseAmount CurCode="COP">400000</BaseAmount><TotalAmount CurCode="COP">500000</TotalAmount></Price></FarePriceType>
            <PaxRefID>ADT_1</PaxRefID><PaxRefID>ADT_2</PaxRefID>
          </FareDetail>
          <FareDetail>
            <FarePriceType><Price><BaseAmount CurCode="COP">40000</BaseAmount><TotalAmount CurCode="COP">60000</TotalAmount></Price></FarePriceType>
            <PaxRefID>INF_1</PaxRefID>
          </FareDetail>
          <OfferItemID>I1</OfferItemID>
          <Service><ServiceAssociations><PaxJourneyRefID>J1</PaxJourneyRefID></ServiceAssociations></Service>
        </OfferItem>
        <TotalPrice><BaseAmount CurCode="COP">840000</BaseAmount><TotalAmount CurCode="COP">1060000</TotalAmount></TotalPrice>
      </Offer></CarrierOffers></OffersGroup>
    </Response></IATA_AirShoppingRS>`);
    const offer = mapAirShoppingResponse(raw, criteria, TENANT).offers[0]!;
    expect(offer.fareBreakdown).toEqual([
      {
        paxType: 'ADT',
        paxCount: 2,
        basePerPax: { amountMinor: 40_000_000, currency: 'COP' },
        taxesPerPax: { amountMinor: 10_000_000, currency: 'COP' },
      },
      {
        paxType: 'INF',
        paxCount: 1,
        basePerPax: { amountMinor: 4_000_000, currency: 'COP' },
        taxesPerPax: { amountMinor: 2_000_000, currency: 'COP' },
      },
    ]);
  });
});

describe('OfferPrice', () => {
  it('impuestos por línea: base + impuestos vuelve a dar el total', () => {
    const raw = xml(`<IATA_OfferPriceRS><Response><PricedOffer>
      <OfferID>3f0c2a9e-6b7d-4c1e-9a55-1d2e3f4a5b6c</OfferID>
      <OfferItem>
        <ChangeRestrictions><AllowedModificationInd>true</AllowedModificationInd><PaxRefID>ADT_1</PaxRefID></ChangeRestrictions>
        <OfferItemID>SEI|A</OfferItemID>
      </OfferItem>
      <TotalPrice>
        <BaseAmount CurCode="COP">2900000</BaseAmount>
        <TaxSummary><Tax><Amount CurCode="COP">450000</Amount></Tax><Tax><Amount CurCode="COP">250000</Amount></Tax></TaxSummary>
        <TotalAmount CurCode="COP">3600000</TotalAmount>
      </TotalPrice>
    </PricedOffer></Response></IATA_OfferPriceRS>`);
    const original = searchOffer();
    const { offer, priceChanged } = mapOfferPriceResponse(raw, original);
    expect(priceChanged).toBe(true);
    expect(offer.total.amountMinor).toBe(360_000_000);
    expect(offer.baseFare.amountMinor + offer.taxes.amountMinor).toBe(offer.total.amountMinor);
    expect(offer.provider.offerRef).toBe(original.provider.offerRef);
  });

  it('un OfferID largo en OfferPrice (sandbox: SEI|… de 334) no reemplaza la referencia', () => {
    const largo = 'SEI|' + 'Q'.repeat(330);
    const raw = xml(`<IATA_OfferPriceRS><Response><PricedOffer>
      <OfferID>${largo}</OfferID>
      <TotalPrice><BaseAmount CurCode="COP">2800000</BaseAmount><TotalAmount CurCode="COP">3500000</TotalAmount></TotalPrice>
    </PricedOffer></Response></IATA_OfferPriceRS>`);
    const original = searchOffer();
    const { offer } = mapOfferPriceResponse(raw, original);
    expect(offer.provider.offerRef).toBe(original.provider.offerRef);
    expect(offer.provider.raw?.['pricedOfferId']).toBe(largo);
    expect(offer.provider.raw?.['offerItemIds']).toEqual(original.provider.raw?.['offerItemIds']);
    expect(OfferSchema.safeParse(offer).success).toBe(true);
  });

  it('la multa de cambio con monto llega a policies.changeFee; un porcentaje no', () => {
    const raw = xml(`<IATA_OfferPriceRS><Response>
      <DataLists><PenaltyList>
        <Penalty><ChangeFeeInd>true</ChangeFeeInd><PenaltyID>CHANGE_PDE_TRUE_COP_150000_0</PenaltyID><Price><TotalAmount CurCode="COP">150000.0</TotalAmount></Price></Penalty>
        <Penalty><CancelFeeInd>true</CancelFeeInd><PenaltyID>REFUND_PDE_TRUE_PERCENT_100</PenaltyID><Price><TotalAmount CurCode="PERCENT">100</TotalAmount></Price></Penalty>
      </PenaltyList></DataLists>
      <PricedOffer>
        <OfferID>3f0c2a9e-6b7d-4c1e-9a55-1d2e3f4a5b6c</OfferID>
        <OfferItem>
          <FareDetail><FareComponent><FareRule><PenaltyRefID>CHANGE_PDE_TRUE_COP_150000_0</PenaltyRefID><PenaltyRefID>REFUND_PDE_TRUE_PERCENT_100</PenaltyRefID></FareRule></FareComponent><PaxRefID>ADT_1</PaxRefID></FareDetail>
          <OfferItemID>SEI|A</OfferItemID>
        </OfferItem>
        <TotalPrice><BaseAmount CurCode="COP">2800000</BaseAmount><TotalAmount CurCode="COP">3500000</TotalAmount></TotalPrice>
      </PricedOffer>
    </Response></IATA_OfferPriceRS>`);
    const { offer } = mapOfferPriceResponse(raw, searchOffer());
    expect(offer.policies?.changeFee).toEqual({ amountMinor: 15_000_000, currency: 'COP' });
    expect(offer.policies?.refundFee).toBeUndefined();
    expect(offer.fareComponents).toEqual(searchOffer().fareComponents);
  });

  it('un error de LATAM se lanza: nunca devuelve la oferta original como confirmada', () => {
    const raw = xml(`<IATA_OfferPriceRS><Error><Code>400116010</Code>
      <DescText>The number of SelectedOfferItems does not match the original AirShopping offer</DescText>
    </Error></IATA_OfferPriceRS>`);
    expect(() => mapOfferPriceResponse(raw, searchOffer())).toThrow(LatamBusinessError);
  });
});

const PAID = `<IATA_OrderViewRS><Response>
  <Order>
    <BookingRef><BookingEntity/><BookingID>QWERTY</BookingID></BookingRef>
    <OrderID>LA0000001ABCD</OrderID>
    <OrderItem><OrderItemID>SEI|AAA</OrderItemID></OrderItem>
    <OwnerCode>LA</OwnerCode>
    <StatusCode>CLOSED</StatusCode>
  </Order>
  <TicketDocInfo>
    <BookingRef><BookingID>LA0000001ABCD</BookingID></BookingRef>
    <Ticket>
      <Coupon><CouponNumber>1</CouponNumber><CouponStatusCode>OK</CouponStatusCode></Coupon>
      <TicketDocTypeCode>VCR</TicketDocTypeCode>
      <TicketNumber>0459990000001</TicketNumber>
    </Ticket>
  </TicketDocInfo>
  <TicketDocInfo>
    <Ticket>
      <Coupon><CouponNumber>1</CouponNumber><CouponStatusCode>OK</CouponStatusCode></Coupon>
      <TicketNumber>0459990000002</TicketNumber>
    </Ticket>
  </TicketDocInfo>
</Response></IATA_OrderViewRS>`;

describe('OrderRetrieve', () => {
  it('orden pagada: ticketed, tiquetes al lado de Order y localizador de 6 letras', () => {
    const view = mapOrderRetrieveResponse(xml(PAID));
    expect(view.status).toBe('ticketed');
    expect(view.ticketNumbers).toEqual(['0459990000001', '0459990000002']);
    expect(view.documents?.every((d) => d.status === 'ISSUED' && d.kind === 'TICKET')).toBe(true);
    expect(view.airlineLocators).toEqual([{ carrierCode: 'LA', locator: 'QWERTY' }]);
    expect(view.pnr).toBe('LA0000001ABCD');
  });

  it('orden sin pagar: confirmed, plazo de pago en UTC y aviso de recotización', () => {
    const view = mapOrderRetrieveResponse(
      xml(`<IATA_OrderViewRS><Response>
      <Order>
        <BookingRef><BookingID>ZXCVBN</BookingID></BookingRef>
        <OrderID>LA0000002EFGH</OrderID>
        <OrderItem><OrderItemID>X</OrderItemID><PaymentTimeLimitDateTime>2026-12-01T16:45:00</PaymentTimeLimitDateTime></OrderItem>
        <StatusCode>OPENED</StatusCode>
      </Order>
      <Warning><Code>70K</Code><DescText>A reprice has occurred.</DescText></Warning>
    </Response></IATA_OrderViewRS>`),
    );
    expect(view.status).toBe('confirmed');
    expect(view.ticketingDeadline).toEqual({ date: '2026-12-01', time: '16:45', zone: 'UTC' });
    expect(view.warnings).toEqual(['70K: A reprice has occurred.']);
  });

  it('CLOSED con aviso 111 es una orden anulada', () => {
    const view = mapOrderRetrieveResponse(
      xml(`<IATA_OrderViewRS><Response>
      <Order><OrderID>LA0000003IJKL</OrderID><StatusCode>CLOSED</StatusCode></Order>
      <TicketDocInfo><Ticket>
        <Coupon><CouponStatusCode>VOID</CouponStatusCode></Coupon><TicketNumber>0459990000003</TicketNumber>
      </Ticket></TicketDocInfo>
      <Warning><Code>111</Code><DescText>Your order is Voided</DescText></Warning>
    </Response></IATA_OrderViewRS>`),
    );
    expect(view.status).toBe('cancelled');
    expect(view.documents?.[0]?.status).toBe('VOIDED');
  });

  it('«Order Id not found» es found:false; cualquier otro error se lanza', () => {
    const notFound = mapOrderRetrieveResponse(
      xml(
        '<IATA_OrderViewRS><Error><Code>404107001</Code><DescText>Order Id not found.</DescText></Error></IATA_OrderViewRS>',
      ),
    );
    expect(notFound.found).toBe(false);
    expect(() =>
      mapOrderRetrieveResponse(
        xml(
          '<IATA_OrderViewRS><Error><Code>500000001</Code><DescText>Timeout</DescText></Error></IATA_OrderViewRS>',
        ),
      ),
    ).toThrow(LatamBusinessError);
  });
});

describe('Pago (OrderChange)', () => {
  it('CLOSED → ticketed: nunca el código crudo de LATAM', () => {
    const r = mapOrderChangePaymentResponse(xml(PAID));
    expect(r).toMatchObject({ success: true, status: 'ticketed', orderId: 'LA0000001ABCD' });
  });

  it('FROZEN es un pago rechazado', () => {
    const r = mapOrderChangePaymentResponse(
      xml(
        '<IATA_OrderViewRS><Response><Order><OrderID>LA4</OrderID><StatusCode>FROZEN</StatusCode></Order></Response></IATA_OrderViewRS>',
      ),
    );
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/rechazó el pago/);
  });
});

describe('Cancelación', () => {
  it('el VOID exitoso no trae Order y es éxito', () => {
    const r = mapOrderCancelResponse(
      xml(`<IATA_OrderCancelRS><Response>
      <OrderCancelProcessing><MarketingMessage><Desc><DescText>VOID completed successfully</DescText></Desc></MarketingMessage></OrderCancelProcessing>
      <OrderRefID>LA0000003IJKL</OrderRefID>
    </Response></IATA_OrderCancelRS>`),
    );
    expect(r).toEqual({ success: true, warnings: [] });
  });

  it('el reembolso informa el monto devuelto', () => {
    const r = mapOrderCancelResponse(
      xml(`<IATA_OrderCancelRS><Response>
      <OrderRefID>LA0000001ABCD</OrderRefID>
      <TicketDocInfo>
        <PaymentInfo><Amount CurCode="COP">1250000.00</Amount><PaymentStatusCode>REFUNDED</PaymentStatusCode></PaymentInfo>
      </TicketDocInfo>
    </Response></IATA_OrderCancelRS>`),
    );
    expect(r).toEqual({
      success: true,
      refundAmount: { amountMinor: 125_000_000, currency: 'COP' },
      warnings: [],
    });
  });

  it('un error de LATAM no es éxito', () => {
    const r = mapOrderCancelResponse(
      xml(
        '<IATA_OrderCancelRS><Error><Code>409107014</Code><DescText>Use OrderRetrieve</DescText></Error></IATA_OrderCancelRS>',
      ),
    );
    expect(r.success).toBe(false);
    expect(r.error).toContain('409107014');
  });
});

describe('OrderCreate', () => {
  it('lee todos los errores', () => {
    const r = mapOrderCreateResponse(
      xml(`<IATA_OrderViewRS>
      <Error><Code>400112028</Code><DescText>Missing passenger gender</DescText></Error>
      <Error><Code>400112093</Code><DescText>Missing EmailAddress</DescText></Error>
    </IATA_OrderViewRS>`),
    );
    expect(r.outcome).toBe('FAILED');
    expect(r.issues.map((i) => i.type)).toEqual(['400112028', '400112093']);
  });

  it('la recotización 70K queda como aviso visible', () => {
    const r = mapOrderCreateResponse(
      xml(`<IATA_OrderViewRS><Response>
      <Order><OrderID>LA0000002EFGH</OrderID><StatusCode>OPENED</StatusCode></Order>
      <Warning><Code>70K</Code><DescText>A reprice has occurred. The new price is: 3650000.0</DescText></Warning>
    </Response></IATA_OrderViewRS>`),
    );
    expect(r.outcome).toBe('CONFIRMED');
    expect(r.issues).toEqual([expect.objectContaining({ severity: 'WARNING', type: 'REPRICE' })]);
  });
});

describe('Requests', () => {
  const cfg = { apiUrl: 'x', agencyId: 'A', agencyIata: '1', agencyName: 'N', country: 'CO' };

  it('el punto de venta es el país de la cuenta aunque la moneda pedida sea BRL (IATA Validation Failed)', () => {
    const brl = { ...criteria, currency: 'BRL' };
    expect(buildAirShoppingRequest(brl, cfg).replace(/s+/g, '')).toContain(
      '<CountryCode>CO</CountryCode>',
    );
    const offer = searchOffer();
    expect(buildOfferPriceRequest(offer, brl, cfg).replace(/s+/g, '')).toContain(
      '<CountryCode>CO</CountryCode>',
    );
  });

  it('AirShopping manda POS/City y Country', () => {
    const body = buildAirShoppingRequest(criteria, cfg).replace(/\s+/g, '');
    expect(body).toContain(
      '<POS><City><IATA_LocationCode>BOG</IATA_LocationCode></City><Country><CountryCode>CO</CountryCode>',
    );
  });

  it('OrderCreate manda todos los pasajeros en cada trayecto, como el ejemplo oficial', () => {
    const offer = searchOffer();
    const body = buildOrderCreateRequest(
      offer,
      [
        { paxId: 'ADT_1', paxType: 'ADT' },
        { paxId: 'INF_1', paxType: 'INF' },
      ].map((p) => ({
        ...p,
        givenName: 'Ana',
        surname: 'Paz',
        birthdate: '1990-01-01',
        gender: 'F',
        citizenshipCountryCode: 'CO',
        identityDoc: { type: 'P', number: 'X1', issuingCountryCode: 'CO' },
      })) as never,
      { email: 'a@b.co', phone: '3001234567' },
      cfg,
      'COP',
    ).replace(/\s+/g, '');
    const items = body.match(/<SelectedOfferItem>.*?<\/SelectedOfferItem>/g) ?? [];
    expect(items).toHaveLength(2);
    for (const item of items)
      expect(item).toContain('<PaxRefID>ADT_1</PaxRefID><PaxRefID>INF_1</PaxRefID>');
    expect(body).toContain('<OfferRefID>3f0c2a9e-6b7d-4c1e-9a55-1d2e3f4a5b6c</OfferRefID>');
    expect(body).toContain('<City><IATA_LocationCode>BOG</IATA_LocationCode></City>');
  });
});
