import { describe, expect, it } from 'vitest';
import {
  ageOn,
  cancellationSummary,
  parseAges,
  participantsLabel,
  saleOf,
  toActivitySnapshot,
  toPackageItemInput,
  travelersMismatch,
  type ActivityOffer,
} from './activity-model';

const usd = (amountMinor: number) => ({ amountMinor, currency: 'USD' });
const brl = (amountMinor: number) => ({ amountMinor, currency: 'BRL' });

const OFFER: ActivityOffer = {
  choiceId: 'choice-1',
  activityId: 'UN_ORL',
  modalityId: 'ORL_1P1D_EPIC',
  category: 'ticket',
  name: 'Universal Orlando Resort',
  modalityName: '1 parque, 1 día',
  date: '2026-12-10',
  startAt: '2026-12-10T09:00:00-05:00',
  endAt: '2026-12-10T21:00:00-05:00',
  participants: { adults: 2, childrenAges: [7, 1] },
  prices: [
    { currency: 'USD', net: usd(38000), tax: usd(3700), gross: usd(41700) },
    { currency: 'BRL', net: brl(209290), tax: brl(20360), gross: brl(229650) },
  ],
  price: { currency: 'BRL', net: brl(209290), tax: brl(20360), gross: brl(229650) },
  cancellation: {
    refundable: true,
    tiers: [
      { from: '2026-11-23', to: '2026-12-05', percentage: 0, label: 'Gratis', penalties: [] },
      { from: '2026-12-09', percentage: 100, penalties: [usd(41700)] },
    ],
    conditions: ['La cancelación aplica a todos los participantes.'],
  },
  ticketValidity: { useDate: '2026-12-10', expirationDate: '2026-12-10T23:59:59Z' },
  highlights: [],
};

const DETAIL = {
  images: [
    'https://a/1.jpg',
    'https://a/2.jpg',
    'https://a/3.jpg',
    'https://a/4.jpg',
    'https://a/5.jpg',
  ],
  description: 'Entradas a Universal.',
};

describe('ítem de paquete (contrato con Paquetes)', () => {
  it('snapshot `kind: activity` con participantes propios, tramos, validez e imágenes', () => {
    expect(toActivitySnapshot(OFFER, DETAIL, true)).toEqual({
      kind: 'activity',
      title: 'Universal Orlando Resort',
      category: 'ticket',
      modality: '1 parque, 1 día',
      date: '2026-12-10',
      startAt: '2026-12-10T09:00:00-05:00',
      endAt: '2026-12-10T21:00:00-05:00',
      participants: { adults: 2, childrenAges: [7, 1] },
      cancellation: {
        refundable: true,
        tiers: [
          { from: '2026-11-23', to: '2026-12-05', percentage: 0, label: 'Gratis' },
          { from: '2026-12-09', percentage: 100 },
        ],
      },
      ticketValidity: { useDate: '2026-12-10', expirationDate: '2026-12-10T23:59:59Z' },
      images: ['https://a/1.jpg', 'https://a/2.jpg', 'https://a/3.jpg', 'https://a/4.jpg'],
      description: 'Entradas a Universal.',
      test: true,
    });
  });

  it('sin detalle ni prueba: sin descripción, sin imágenes y sin `test`', () => {
    const s = toActivitySnapshot(OFFER);
    expect(s.images).toEqual([]);
    expect(s).not.toHaveProperty('description');
    expect(s).not.toHaveProperty('test');
  });

  it('toma el precio en la moneda del PAQUETE: neto e impuestos del proveedor', () => {
    expect(toPackageItemInput(OFFER, 'usd')).toMatchObject({
      vertical: 'activities',
      providerName: 'despegar-activities',
      providerItemId: 'choice-1',
      baseFareMinor: 38000,
      taxesMinor: 3700,
      currency: 'USD',
      rawDetails: { kind: 'activity' },
    });
    expect(toPackageItemInput(OFFER, 'BRL')?.baseFareMinor).toBe(209290);
  });

  it('sin precio en la moneda del paquete no arma el ítem (no se convierte)', () => {
    expect(toPackageItemInput(OFFER, 'COP')).toBeUndefined();
  });

  it('el snapshot entra en el tope de 64 KB del paquete', () => {
    const item = toPackageItemInput(OFFER, 'USD', { ...DETAIL, description: 'x'.repeat(10_000) });
    expect(JSON.stringify(item?.rawDetails).length).toBeLessThan(64 * 1024);
    expect(item?.rawDetails.description).toHaveLength(1000);
  });
});

describe('formato y participantes', () => {
  it('precio de venta: el final de la cascada o el bruto', () => {
    expect(saleOf(OFFER)).toEqual(brl(229650));
    expect(
      saleOf({
        ...OFFER,
        pricing: { costMinor: 1, finalMinor: 250000, ownMarkupMinor: 5, currency: 'BRL' },
      }),
    ).toEqual(brl(250000));
  });

  it('resumen de cancelación', () => {
    expect(cancellationSummary(OFFER.cancellation)).toMatch(/^Cancelación gratis hasta el /);
    expect(cancellationSummary({ refundable: false, tiers: [], conditions: [] })).toBe(
      'No reembolsable',
    );
  });

  it('participantes en una línea', () => {
    expect(participantsLabel({ adults: 2, childrenAges: [] })).toBe('2 adultos');
    expect(participantsLabel({ adults: 1, childrenAges: [7, 1] })).toBe(
      '1 adulto · 2 menores (7, 1 años)',
    );
  });

  it('edades: 0 a 17, separadas por coma o espacio', () => {
    expect(parseAges('7, 1')).toEqual({ ok: true, ages: [7, 1] });
    expect(parseAges('')).toEqual({ ok: true, ages: [] });
    expect(parseAges('5 9')).toEqual({ ok: true, ages: [5, 9] });
    expect(parseAges('18').ok).toBe(false);
    expect(parseAges('siete').ok).toBe(false);
  });

  it('edad cumplida al día de la actividad', () => {
    expect(ageOn('2019-12-11', '2026-12-10')).toBe(6);
    expect(ageOn('2019-12-10', '2026-12-10')).toBe(7);
  });

  it('los participantes cargados tienen que coincidir con las edades de la tarifa', () => {
    const p = { adults: 2, childrenAges: [7, 1] };
    expect(
      travelersMismatch(p, ['1990-01-01', '1992-01-01', '2019-05-01', '2025-06-01'], '2026-12-10'),
    ).toBeUndefined();
    expect(travelersMismatch(p, ['1990-01-01'], '2026-12-10')).toMatch(/4 participantes/);
    expect(
      travelersMismatch(p, ['1990-01-01', '1992-01-01', '2015-05-01', '2025-06-01'], '2026-12-10'),
    ).toMatch(/no coinciden/);
  });
});
