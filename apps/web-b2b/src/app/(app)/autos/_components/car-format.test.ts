import { describe, expect, it } from 'vitest';
import {
  carClassOf,
  fuelOf,
  hasUnlimitedKm,
  kmLabel,
  modelLabel,
  saleOf,
  transmissionOf,
} from './car-format';

describe('carClassOf (SIPP/ACRISS)', () => {
  it.each([
    ['MCMR', 'mini'],
    ['ECAR', 'economico'],
    ['EDMR', 'economico'],
    ['CCAR', 'compacto'],
    ['ICAR', 'intermedio'],
    ['SCAR', 'estandar'],
    ['FCAR', 'grande'],
    ['PCAR', 'premium'],
    ['LCAR', 'lujo'],
    ['xcar', 'especial'],
  ])('%s → %s por el tamaño', (sipp, expected) => {
    expect(carClassOf(sipp)).toBe(expected);
  });

  it.each([
    ['IFAR', 'suv'],
    ['CFAR', 'suv'],
    ['SGAR', 'suv'],
    ['MVAR', 'van'],
    ['FVAR', 'van'],
    ['STAR', 'convertible'],
    ['PPAR', 'pickup'],
    ['FQAR', 'pickup'],
  ])('%s → %s: la carrocería pesa más que el tamaño', (sipp, expected) => {
    expect(carClassOf(sipp)).toBe(expected);
  });

  it('un código vacío o raro cae en "especial", no rompe', () => {
    expect(carClassOf('')).toBe('especial');
    expect(carClassOf('??')).toBe('especial');
  });
});

describe('transmissionOf', () => {
  it('la tercera letra del SIPP manda', () => {
    expect(transmissionOf({ sippCode: 'ECAR', trans: 'Manual' })).toBe('automatica');
    expect(transmissionOf({ sippCode: 'ECMR', trans: '' })).toBe('manual');
    expect(transmissionOf({ sippCode: 'IFBR', trans: '' })).toBe('automatica');
  });

  it('sin letra conocida, el texto del proveedor; sin nada, no se inventa', () => {
    expect(transmissionOf({ sippCode: 'EC', trans: 'Automatic' })).toBe('automatica');
    expect(transmissionOf({ sippCode: '', trans: 'Mecánica' })).toBe('manual');
    expect(transmissionOf({ sippCode: '', trans: '' })).toBeUndefined();
  });
});

describe('fuelOf', () => {
  it('sólo destaca eléctricos e híbridos', () => {
    expect(fuelOf('ECAE')).toBe('electrico');
    expect(fuelOf('ICAH')).toBe('hibrido');
    expect(fuelOf('ECAR')).toBeUndefined();
    expect(fuelOf('ECAD')).toBeUndefined();
  });
});

describe('kilometraje', () => {
  it('reconoce el ilimitado en inglés y en español', () => {
    expect(hasUnlimitedKm('Unlimited mileage')).toBe(true);
    expect(hasUnlimitedKm('Kilometraje ilimitado')).toBe(true);
    expect(hasUnlimitedKm('200 km por día')).toBe(false);
  });

  it('lo muestra en español; lo limitado, como lo informa el proveedor', () => {
    expect(kmLabel('UNLIMITED')).toBe('Kilometraje ilimitado');
    expect(kmLabel(' 200 km/day ')).toBe('200 km/day');
    expect(kmLabel('')).toBe('');
  });
});

describe('modelLabel', () => {
  it('el modelo nunca está garantizado: "o similar"', () => {
    expect(modelLabel('Chevrolet Spark')).toBe('Chevrolet Spark o similar');
    expect(modelLabel('Kia Rio or similar')).toBe('Kia Rio o similar');
    expect(modelLabel('  ')).toBe('');
  });
});

describe('saleOf', () => {
  const rateAmount = { amountMinor: 100_00, currency: 'USD' };

  it('con reglas de precio, el final de la cascada', () => {
    expect(
      saleOf({
        rateAmount,
        pricing: { costMinor: 105_00, finalMinor: 115_00, ownMarkupMinor: 10_00, currency: 'USD' },
      }),
    ).toEqual({ amountMinor: 115_00, currency: 'USD' });
  });

  it('sin reglas, el neto del proveedor', () => {
    expect(saleOf({ rateAmount })).toEqual(rateAmount);
  });
});
