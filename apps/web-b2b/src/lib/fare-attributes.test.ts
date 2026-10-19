import { describe, expect, it } from 'vitest';
import type { FareInclusion, Offer } from '../app/(app)/cotizaciones/actions';
import { fareAttributes, legInclusions } from './fare-attributes';

const fmt = (amountMinor: number, currency: string) => `${currency} ${amountMinor / 100}`;
const money = (amountMinor: number) => ({ amountMinor, currency: 'USD' });

function segmento(origin: string, destination: string) {
  return {
    carrier: 'LA',
    flightNumber: '1',
    origin,
    destination,
    departureAt: '2026-12-01T08:00:00-05:00',
    arrivalAt: '2026-12-01T10:00:00-05:00',
    durationMinutes: 120,
    cabin: 'economy',
    bookingClass: 'Y',
  };
}

/** Ida BOG-LIM (LIGHT) y vuelta LIM-BOG (FULL), con equipaje de la oferta entera aparte. */
function oferta(ida?: FareInclusion[], vuelta?: FareInclusion[]): Offer {
  return {
    id: 'o',
    tenantId: 't',
    products: ['flight'],
    provider: { name: 'sabre', offerRef: 'r' },
    total: money(1),
    baseFare: money(1),
    taxes: money(0),
    itineraries: [
      { segments: [segmento('BOG', 'LIM')], totalDurationMinutes: 120, stops: 0 },
      { segments: [segmento('LIM', 'BOG')], totalDurationMinutes: 120, stops: 0 },
    ],
    fareComponents: [
      { segmentRefs: [0], brand: { code: 'LIGHT' }, ...(ida ? { includes: ida } : {}) },
      { segmentRefs: [1], brand: { code: 'FULL' }, ...(vuelta ? { includes: vuelta } : {}) },
    ],
    baggage: { checked: { qty: 1, weightKg: 23 } },
    policies: { changeable: true, refundable: true },
    fetchedAt: '',
    expiresAt: '',
  };
}

const LIGHT: FareInclusion[] = [
  { kind: 'carry-on', status: 'included', label: '1 CABIN BAG UP TO 10KG' },
  { kind: 'checked-bag', status: 'charge', label: 'CHECKED BAG 23KG' },
  { kind: 'refund', status: 'not-offered', label: 'REFUND' },
  { kind: 'other', status: 'included', label: 'MILES ACCRUAL' },
];
const FULL: FareInclusion[] = [
  { kind: 'carry-on', status: 'included', label: '1 CABIN BAG UP TO 10KG' },
  { kind: 'checked-bag', status: 'included', label: 'CHECKED BAG 23KG' },
  { kind: 'checked-bag', status: 'charge', label: '2ND CHECKED BAG' },
  { kind: 'change', status: 'included', label: 'CHANGES' },
  { kind: 'refund', status: 'charge', label: 'REFUND WITH FEE' },
  { kind: 'seat', status: 'included', label: 'SEAT SELECTION' },
];

describe('fareAttributes — lo que incluye ESA tarifa en ESE trayecto', () => {
  it('la ida LIGHT no hereda la maleta ni el reembolso de la oferta entera', () => {
    const a = fareAttributes(oferta(LIGHT, FULL), 0, fmt);
    expect(a.source).toBe('leg');
    expect(a.carryOn).toEqual({ value: 'yes', detail: '1 cabin bag up to 10kg' });
    expect(a.checked).toEqual({ value: 'partial', detail: 'Con cargo' });
    expect(a.refund).toEqual({ value: 'no' });
    expect(a.extras).toEqual(['Miles accrual']);
  });

  it('«no informado» no es «no incluye»: el tipo que la marca no lista queda unknown', () => {
    const a = fareAttributes(oferta(LIGHT, FULL), 0, fmt);
    expect(a.change.value).toBe('unknown');
    expect(a.personalItem.value).toBe('unknown');
  });

  it('la vuelta FULL: la 1ra maleta incluida manda sobre la 2da con cargo', () => {
    const a = fareAttributes(oferta(LIGHT, FULL), 1, fmt);
    expect(a.checked).toEqual({ value: 'yes', detail: 'Checked bag 23kg' });
    expect(a.change.value).toBe('yes');
    expect(a.refund.value).toBe('partial');
    expect(a.seat?.value).toBe('yes');
  });

  it('sin atributos de marca en el trayecto cae a la oferta entera, y lo dice', () => {
    const a = fareAttributes(oferta(undefined, FULL), 0, fmt);
    expect(a.source).toBe('offer');
    expect(a.checked).toEqual({ value: 'yes', detail: '23 kg' });
    expect(a.seat).toBeUndefined();
  });

  it('sin trayecto elegido es siempre la oferta entera', () => {
    expect(fareAttributes(oferta(LIGHT, FULL), undefined, fmt).source).toBe('offer');
  });

  it('dos vuelos en un trayecto: se promete sólo lo que ambos cumplen', () => {
    const o = oferta(LIGHT, FULL);
    o.itineraries = [
      {
        segments: [segmento('BOG', 'LIM'), segmento('LIM', 'SCL')],
        totalDurationMinutes: 240,
        stops: 1,
      },
    ];
    o.fareComponents = [
      { segmentRefs: [0], includes: FULL },
      { segmentRefs: [1], includes: LIGHT },
    ];
    const a = fareAttributes(o, 0, fmt);
    expect(a.checked.value).toBe('partial');
    expect(a.change.value).toBe('unknown');
    expect(legInclusions(o, 1)).toBeNull();
  });
});
