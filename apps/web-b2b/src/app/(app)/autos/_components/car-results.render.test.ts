import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CarLocation, CarOffer, CarSelection } from '../actions';
import { CarCheckout } from './car-checkout';
import { CarResultCard } from './car-result-card';
import { resultCarsOf } from './car-results-filters';
import { CarResults } from './car-results';
import type { CarSearchCriteria } from './car-search-model';

/*
 * La tarjeta, la lista y el resumen del checkout en su primer pintado: que el vendedor vea lo que
 * decide la venta y que el neto del proveedor no aparezca en ningún lado.
 */

const noop = () => undefined;
const usd = (major: number) => ({ amountMinor: Math.round(major * 100), currency: 'USD' });
const money = (s: string) => new RegExp(s.replace('.', '\\.') + '\\s*US\\$');

function auto(sippCode: string, netMajor: number, extra: Partial<CarOffer> = {}): CarOffer {
  return {
    category: 'Economy Automatic',
    sippCode,
    companyCode: 'ZE',
    companyName: 'Hertz',
    rateAmount: usd(netMajor),
    paymentOption: 'ppd',
    carModel: 'Kia Rio',
    doors: 4,
    passengers: 5,
    bags: 2,
    trans: 'Automatic',
    air: true,
    kmIncluded: 'Unlimited mileage',
    base: usd(netMajor - 10),
    tax: usd(10),
    imageUrl: 'https://cdn.agentcars.com/images/cars/kia-rio.jpg',
    ...extra,
  };
}

const CON_MARKUP = auto('ECAR', 100, {
  pricing: { costMinor: 110_00, finalMinor: 130_00, ownMarkupMinor: 20_00, currency: 'USD' },
});

describe('CarResultCard', () => {
  function card(offer: CarOffer, days = 7): string {
    const [item] = resultCarsOf([offer]);
    return renderToStaticMarkup(
      createElement(CarResultCard, { item: item!, days, onSelect: noop }),
    );
  }

  it('clase por el SIPP, modelo "o similar", arrendadora y características', () => {
    const html = card(CON_MARKUP);
    expect(html).toContain('Económico');
    expect(html).toContain('ECAR');
    expect(html).toContain('Kia Rio o similar');
    expect(html).toContain('Hertz');
    expect(html).toContain('5 pasajeros');
    expect(html).toContain('2 maletas');
    expect(html).toContain('Transmisión automática');
    expect(html).toContain('Aire acondicionado');
    expect(html).toContain('Kilometraje ilimitado');
    expect(html).toContain('Prepago');
  });

  it('precio de venta del alquiler, cuánto sale por día y el markup propio', () => {
    const html = card(CON_MARKUP);
    expect(html).toMatch(money('130,00'));
    expect(html).toContain('Total 7 días');
    expect(html).toMatch(/18,57\s*US\$ por día/);
    expect(html).toMatch(/neto 110,00\s*US\$/);
    expect(html).toMatch(/\+ markup 20,00\s*US\$/);
  });

  it('nunca el neto del proveedor', () => {
    expect(card(CON_MARKUP)).not.toMatch(money('100,00'));
  });

  it('un día: sin "por día"', () => {
    expect(card(CON_MARKUP, 1)).not.toContain('por día');
  });
});

describe('CarResults', () => {
  const offers = [
    auto('IFAR', 420, { carModel: 'Toyota RAV4' }),
    auto('ECAR', 210),
    auto('ECMR', 180, { companyCode: 'ZI', companyName: 'Avis', trans: 'Manual' }),
  ];
  const html = renderToStaticMarkup(
    createElement(CarResults, { offers, days: 7, searching: false, onSelect: noop }),
  );

  it('cuántos autos y por cuántos días', () => {
    expect(html).toContain('3 autos');
    expect(html).toContain('precios de venta por 7 días en USD');
  });

  it('las clases con su precio "desde", para comparar de un vistazo', () => {
    expect(html).toMatch(/Económico.*desde 180,00\s*US\$/);
    expect(html).toMatch(/SUV.*desde 420,00\s*US\$/);
  });

  it('del más barato al más caro por defecto', () => {
    const cards = html.split('<article').slice(1);
    expect(cards).toHaveLength(3);
    expect(cards[0]).toContain('Avis');
    expect(cards[0]).toMatch(money('180,00'));
    expect(cards[2]).toContain('Toyota RAV4 o similar');
  });
});

describe('CarCheckout', () => {
  const BOG: CarLocation = {
    airport: true,
    cityLoc: false,
    countryCode: 'CO',
    hasOffice: 3,
    iata: 'BOG',
    latitude: 4.7,
    longitude: -74.14,
    timezone: 'America/Bogota',
    value: 'Aeropuerto El Dorado, BOG, Colombia',
  };
  const criteria: CarSearchCriteria = {
    pickup: BOG,
    values: {
      pickUpLocation: 'BOG',
      dropOffLocation: 'BOG',
      country: 'CO',
      pickUpDate: '2030-10-22',
      dropOffDate: '2030-10-29',
      pickUpHour: '10:00',
      dropOffHour: '10:00',
      rateType: 'best',
      paymentType: 'ppd',
    },
  };
  const selection: CarSelection = { ...CON_MARKUP, uniqid: 'abc123', rateCode: '3' };

  function checkout(selectedAt: number): string {
    return renderToStaticMarkup(
      createElement(CarCheckout, {
        criteria,
        selection,
        rateDetail: {
          base: usd(90),
          tax: usd(10),
          charges: [{ code: '1', name: 'CRF - CONCESSION RECOUP FEE', amount: usd(2.3) }],
        },
        selectedAt,
        booking: false,
        renewing: false,
        onBack: noop,
        onRenew: noop,
        onConfirm: noop,
      }),
    );
  }

  it('reparto del precio de venta: al reservar, en el mostrador, y el total', () => {
    const html = checkout(Date.now());
    expect(html).toContain('Se paga al reservar');
    expect(html).toMatch(money('120,00'));
    expect(html).toContain('Se paga en el mostrador');
    expect(html).toContain('CRF - CONCESSION RECOUP FEE');
    expect(html).toContain('Total de venta');
    expect(html).toMatch(money('130,00'));
    expect(html).not.toMatch(money('90,00'));
    expect(html).not.toMatch(money('100,00'));
  });

  it('con la tarifa vigente: contador y botón de confirmar', () => {
    const html = checkout(Date.now());
    expect(html).toContain('Tarifa reservada por 15:00');
    expect(html).toContain('Confirmar reserva');
    expect(html).not.toContain('Renovar tarifa');
  });

  it('con la tarifa vencida: no confirma, ofrece renovarla', () => {
    const html = checkout(Date.now() - 16 * 60_000);
    expect(html).toContain('La tarifa venció.');
    expect(html).toContain('Renovar tarifa');
    expect(html).not.toContain('Confirmar reserva');
  });

  it('con tiempo al retiro ofrece reservar en espera, con el plazo para activarla', () => {
    expect(checkout(Date.now())).toContain('antes del dom 20 oct · 10:00');
  });
});
