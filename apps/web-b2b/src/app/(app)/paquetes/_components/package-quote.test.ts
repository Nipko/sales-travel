import { describe, expect, it } from 'vitest';
import type { PackageItem, PackageSummary } from '../actions';
import {
  excludedList,
  includedList,
  quoteModel,
  quoteRefOf,
  shownStatus,
  travelersText,
  whatsappText,
} from './package-quote';

const pkg: PackageSummary = {
  id: '3f9a1c2b-0000-4000-8000-000000000001',
  status: 'draft',
  title: 'Cartagena · 5 noches',
  totalAmountMinor: 1_000_000_00,
  currency: 'COP',
  customerId: null,
  notes: null,
  searchCriteria: {
    origin: 'BOG',
    destination: 'CTG',
    destinationLabel: 'Cartagena de Indias, Colombia',
    departureDate: '2026-12-10',
    returnDate: '2026-12-15',
    rooms: [{ adults: 2, childrenAges: [7, 1] }],
  },
  showBreakdown: false,
  expiresAt: '2026-11-30T23:59:00Z',
  createdAt: '2026-11-23T15:00:00Z',
};

function item(id: string, position: number, details: unknown, vertical = 'hotels'): PackageItem {
  return {
    id,
    vertical,
    providerName: 'x',
    providerItemId: id,
    details,
    position,
    baseFareMinor: 0,
    taxesMinor: 0,
    totalMinor: 100,
  };
}

const hotel = {
  kind: 'hotel',
  name: 'Hotel Caribe',
  stars: 4,
  images: ['/api/hotels/images/abc'],
  board: 'BB',
  refundable: true,
  checkin: '2026-12-10',
  checkout: '2026-12-15',
  rooms: 1,
};

describe('quoteModel', () => {
  it('ordena por posición, descarta snapshots ilegibles y toma la portada del hotel', () => {
    const m = quoteModel(pkg, [
      item('b', 1, { kind: 'manual', title: 'Tour' }, 'activities'),
      item('a', 0, hotel),
      item('c', 2, { foo: 'bar' }),
    ]);
    expect(m.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(m.coverImage).toBe('/api/hotels/images/abc');
    expect(m.extras).toHaveLength(1);
    expect(m.nights).toBe(5);
  });

  it('el precio por persona no divide entre el infante en brazos', () => {
    const m = quoteModel(pkg, [item('a', 0, hotel)]);
    expect(m.travelers).toBe(3);
    expect(m.perPersonMinor).toBe(Math.round(1_000_000_00 / 3));
    expect(travelersText(m)).toBe('2 adultos y 2 niños');
  });

  it('marca el contenido de prueba', () => {
    expect(quoteModel(pkg, [item('a', 0, { ...hotel, test: true })]).hasTestContent).toBe(true);
  });
});

describe('textos para el cliente', () => {
  const m = quoteModel(pkg, [item('a', 0, hotel)]);

  it('incluye y no incluye', () => {
    expect(includedList(m)).toEqual(['5 noches en Hotel Caribe', 'Desayuno incluido']);
    expect(excludedList(m)).toContain('Traslados no mencionados');
  });

  it('WhatsApp con total, por persona, vigencia y la agencia', () => {
    const text = whatsappText(m, 'Viajes Caribe');
    expect(text).toContain('*Cartagena · 5 noches*');
    expect(text).toContain('Hotel Caribe');
    expect(text).toContain('*Total:');
    expect(text).toContain('por persona');
    expect(text).toContain('Válida hasta');
    expect(text.endsWith('Viajes Caribe')).toBe(true);
  });

  it('referencia corta y estable', () => {
    expect(quoteRefOf(pkg.id)).toBe('PQ-3F9A1C');
  });
});

describe('shownStatus', () => {
  const now = Date.parse('2026-11-28T12:00:00Z');
  it('una cotización no aceptada con la fecha pasada se ve vencida', () => {
    expect(shownStatus({ status: 'draft', expiresAt: '2026-11-27T12:00:00Z' }, now)).toBe(
      'expired',
    );
    expect(shownStatus({ status: 'sent', expiresAt: '2026-11-27T12:00:00Z' }, now)).toBe('expired');
  });
  it('aceptada o vigente se ve como está', () => {
    expect(shownStatus({ status: 'accepted', expiresAt: '2026-11-27T12:00:00Z' }, now)).toBe(
      'accepted',
    );
    expect(shownStatus({ status: 'sent', expiresAt: '2026-11-29T12:00:00Z' }, now)).toBe('sent');
  });
});
