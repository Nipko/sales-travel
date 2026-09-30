import { describe, expect, it } from 'vitest';
import type { HotelSearchCriteriaView } from '../actions';
import { searchSummaryView, stayDatesLabel } from './search-summary';

const CRITERIA: HotelSearchCriteriaView = {
  checkinDate: '2026-10-12',
  checkoutDate: '2026-10-15',
  nights: 3,
  rooms: 1,
  guests: 2,
  guestNationality: 'CO',
  occupancy: [{ adults: 2, childrenAges: [] }],
  refundableOnly: false,
  currency: 'COP',
  destinationLabel: 'Bogotá, Colombia',
};

describe('stayDatesLabel', () => {
  it('sin repetir el mes ni el año que comparten', () => {
    expect(stayDatesLabel('2026-10-12', '2026-10-15')).toBe('12 – 15 oct 2026');
    expect(stayDatesLabel('2026-10-30', '2026-11-02')).toBe('30 oct – 2 nov 2026');
    expect(stayDatesLabel('2026-12-28', '2027-01-02')).toBe('28 dic 2026 – 2 ene 2027');
  });

  it('una fecha ilegible se muestra tal cual', () => {
    expect(stayDatesLabel('x', '2026-10-15')).toBe('x – 2026-10-15');
  });
});

describe('searchSummaryView — lo que se buscó, en una línea', () => {
  it('destino, fechas, noches, huéspedes y moneda', () => {
    expect(searchSummaryView(CRITERIA)).toEqual({
      destination: 'Bogotá, Colombia',
      dates: '12 – 15 oct 2026',
      nights: '3 noches',
      guests: '2 huéspedes · 1 habitación',
      currency: 'COP',
    });
  });

  it('singulares y plurales', () => {
    const view = searchSummaryView({ ...CRITERIA, nights: 1, guests: 1, rooms: 2 });
    expect(view.nights).toBe('1 noche');
    expect(view.guests).toBe('1 huésped · 2 habitaciones');
  });

  it('una búsqueda por IDs de hotel lo dice', () => {
    const { destinationLabel: _omit, ...rest } = CRITERIA;
    expect(searchSummaryView({ ...rest, hotelIdsCount: 3 }).destination).toBe('3 hoteles por ID');
    expect(searchSummaryView(rest).destination).toBe('Destino elegido');
  });
});
