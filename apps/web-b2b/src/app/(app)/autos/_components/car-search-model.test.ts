import { describe, expect, it } from 'vitest';
import type { CarLocation } from '../actions';
import {
  HOUR_SLOTS,
  buildSearchValues,
  hourLabel,
  nowAt,
  placeLabel,
  rentalDays,
  searchSummaryView,
  type CarSearchDraft,
} from './car-search-model';

const BOG: CarLocation = {
  airport: true,
  cityLoc: false,
  countryCode: 'co',
  hasOffice: 12,
  iata: 'BOG',
  latitude: 4.7,
  longitude: -74.14,
  timezone: 'America/Bogota',
  value: 'Aeropuerto El Dorado, BOG, Colombia',
};

const MEDELLIN: CarLocation = {
  airport: false,
  cityLoc: true,
  countryCode: 'CO',
  hasOffice: 4,
  latitude: 6.24,
  longitude: -75.58,
  timezone: 'America/Bogota',
  value: 'Medellín, Antioquia, Colombia',
};

/** 2026-09-30 08:00 en Bogotá (13:00 UTC). */
const NOW = new Date(Date.UTC(2026, 8, 30, 13, 0, 0));

function draft(extra: Partial<CarSearchDraft> = {}): CarSearchDraft {
  return {
    pickup: BOG,
    dropoff: null,
    otherDropoff: false,
    pickUpDate: '2026-10-22',
    dropOffDate: '2026-10-29',
    pickUpTime: '10:00',
    dropOffTime: '10:00',
    paymentType: 'ppd',
    rateType: 'best',
    ...extra,
  };
}

describe('HOUR_SLOTS', () => {
  it('cada media hora, todo el día', () => {
    expect(HOUR_SLOTS).toHaveLength(48);
    expect(HOUR_SLOTS[0]).toBe('00:00');
    expect(HOUR_SLOTS[21]).toBe('10:30');
    expect(HOUR_SLOTS.at(-1)).toBe('23:30');
  });
});

describe('buildSearchValues', () => {
  it('aeropuerto: va por IATA, el país en mayúsculas y la devolución en el mismo lugar', () => {
    const built = buildSearchValues(draft(), NOW);
    expect(built).toEqual({
      ok: true,
      values: {
        pickUpLocation: 'BOG',
        dropOffLocation: 'BOG',
        country: 'CO',
        pickUpDate: '2026-10-22',
        dropOffDate: '2026-10-29',
        pickUpHour: '10:00',
        dropOffHour: '10:00',
        rateType: 'best',
        paymentType: 'ppd',
      },
    });
  });

  it('ciudad sin IATA: "City"/"City2" con las coordenadas de cada lugar', () => {
    const built = buildSearchValues(
      draft({ pickup: MEDELLIN, otherDropoff: true, dropoff: MEDELLIN }),
      NOW,
    );
    if (!built.ok) throw new Error(built.error);
    expect(built.values).toMatchObject({
      pickUpLocation: 'City',
      dropOffLocation: 'City2',
      lat: 6.24,
      lng: -75.58,
      latDropOff: 6.24,
      lngDropOff: -75.58,
    });
  });

  it('devolver en otro aeropuerto', () => {
    const built = buildSearchValues(
      draft({ otherDropoff: true, dropoff: { ...BOG, iata: 'MDE' } }),
      NOW,
    );
    if (!built.ok) throw new Error(built.error);
    expect(built.values.dropOffLocation).toBe('MDE');
  });

  it.each([
    [{ pickup: null }, 'pickup'],
    [{ otherDropoff: true, dropoff: null }, 'dropoff'],
    [{ pickUpDate: '' }, 'pickUpDate'],
    [{ dropOffDate: '' }, 'dropOffDate'],
    [{ pickUpDate: '2026-09-29' }, 'pickUpDate'],
    [{ pickUpDate: '2026-09-30', pickUpTime: '07:30' }, 'pickUpTime'],
    [{ dropOffDate: '2026-10-22', dropOffTime: '09:00' }, 'dropOffDate'],
  ] as const)('%o → falta o está mal %s, en "tú"', (extra, field) => {
    const built = buildSearchValues(draft(extra), NOW);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.field).toBe(field);
    expect(built.error).not.toMatch(/Elegí|Ingresá|Probá/);
  });

  it('hoy más tarde sí se puede', () => {
    expect(
      buildSearchValues(draft({ pickUpDate: '2026-09-30', pickUpTime: '12:00' }), NOW).ok,
    ).toBe(true);
  });
});

describe('nowAt', () => {
  it('la hora del mostrador, no la del vendedor', () => {
    expect(nowAt(NOW, 'America/Bogota')).toEqual({ date: '2026-09-30', time: '08:00' });
    expect(nowAt(NOW, 'Europe/Madrid')).toEqual({ date: '2026-09-30', time: '15:00' });
  });

  it('una zona que no existe no rompe', () => {
    expect(nowAt(NOW, 'Marte/Olympus').date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('rentalDays', () => {
  const base = { pickUpDate: '2026-10-22', dropOffDate: '2026-10-29' };

  it('períodos de 24 h desde la hora de recogida, redondeando hacia arriba', () => {
    expect(rentalDays({ ...base, pickUpHour: '1000', dropOffHour: '1000' })).toBe(7);
    expect(rentalDays({ ...base, pickUpHour: '10:00', dropOffHour: '11:00' })).toBe(8);
    expect(rentalDays({ ...base, pickUpHour: '1000', dropOffHour: '0900' })).toBe(7);
  });

  it('mínimo un día', () => {
    expect(
      rentalDays({
        pickUpDate: '2026-10-22',
        dropOffDate: '2026-10-22',
        pickUpHour: '0900',
        dropOffHour: '1800',
      }),
    ).toBe(1);
  });
});

describe('resumen de la búsqueda', () => {
  it('lugar legible, fechas con día de la semana, días y forma de pago', () => {
    const built = buildSearchValues(draft(), NOW);
    if (!built.ok) throw new Error(built.error);
    expect(searchSummaryView({ values: built.values, pickup: BOG })).toEqual({
      place: 'Aeropuerto El Dorado (BOG)',
      pickUp: 'jue 22 oct · 10:00',
      dropOff: 'jue 29 oct · 10:00',
      days: '7 días',
      payment: 'Prepago',
    });
  });

  it('con otro lugar de devolución, se nombra', () => {
    const built = buildSearchValues(draft({ otherDropoff: true, dropoff: MEDELLIN }), NOW);
    if (!built.ok) throw new Error(built.error);
    expect(
      searchSummaryView({ values: built.values, pickup: BOG, dropoff: MEDELLIN }).dropoffPlace,
    ).toBe('Medellín');
  });

  it('placeLabel y hourLabel', () => {
    expect(
      placeLabel({ value: 'Miami International Airport, MIA, Florida, US', iata: 'MIA' }),
    ).toBe('Miami International Airport (MIA)');
    expect(hourLabel('0930')).toBe('09:30');
  });
});
