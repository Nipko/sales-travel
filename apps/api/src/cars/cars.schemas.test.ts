import { describe, expect, it } from 'vitest';
import {
  CancelBodySchema,
  CarSearchInputSchema,
  CarSelectionInputSchema,
  CarSuggestQuerySchema,
  ConfirmInputSchema,
  DailyReportQuerySchema,
  FindOfficesQuerySchema,
  MyReservationBodySchema,
  RateDetailQuerySchema,
  RatesQuerySchema,
  ReleaseBodySchema,
} from './cars.schemas.js';

// Base válida de búsqueda, reutilizada por search/selection/confirm.
const validSearch = {
  pickUpLocation: 'MIA',
  dropOffLocation: 'MIA',
  pickUpDate: '2026-07-01',
  dropOffDate: '2026-07-05',
  pickUpHour: '1000',
  dropOffHour: '1600',
  country: 'US',
};

const validConfirm = {
  uniqid: '58e7a97b506d4',
  paymentType: 'ppd',
  rateType: 'best',
  companyCode: 'ZT',
  sippCode: 'CCAR',
  pickUpLocation: 'LAX',
  dropOffLocation: 'LAX',
  pickUpDate: '2026-07-01',
  dropOffDate: '2026-07-05',
  pickUpHour: '1200',
  dropOffHour: '1200',
  firstName: 'Ada',
  lastName: 'Lovelace',
  age: 1 as const,
  email: 'ada@example.com',
  realBase: 118.0,
  realTax: 20.0,
  total: 138.0,
  currency: 'USD',
};

// ───────────────────────── CarSuggestQuerySchema ─────────────────────────

describe('CarSuggestQuerySchema', () => {
  it('acepta query mínima sin lang', () => {
    expect(CarSuggestQuerySchema.parse({ q: 'miami' })).toEqual({ q: 'miami' });
  });

  it('acepta lang opcional', () => {
    const parsed = CarSuggestQuerySchema.parse({ q: 'miami', lang: 'es' });
    expect(parsed.lang).toBe('es');
  });

  it('rechaza q vacía', () => {
    expect(CarSuggestQuerySchema.safeParse({ q: '' }).success).toBe(false);
  });

  it('rechaza q que excede 120 caracteres', () => {
    expect(CarSuggestQuerySchema.safeParse({ q: 'a'.repeat(121) }).success).toBe(false);
  });

  it('rechaza lang demasiado corto (< 2)', () => {
    expect(CarSuggestQuerySchema.safeParse({ q: 'miami', lang: 'e' }).success).toBe(false);
  });

  it('rechaza lang demasiado largo (> 5)', () => {
    expect(CarSuggestQuerySchema.safeParse({ q: 'miami', lang: 'es-419' }).success).toBe(false);
  });
});

// ───────────────────────── FindOfficesQuerySchema ─────────────────────────

describe('FindOfficesQuerySchema', () => {
  it('acepta coordenadas (lat + lng) sin cityCode', () => {
    const parsed = FindOfficesQuerySchema.parse({ distance: 25, lat: 25.79, lng: -80.29 });
    expect(parsed.lat).toBe(25.79);
    expect(parsed.lng).toBe(-80.29);
  });

  it('acepta cityCode sin coordenadas', () => {
    const parsed = FindOfficesQuerySchema.parse({ distance: 25, cityCode: 'MIA' });
    expect(parsed.cityCode).toBe('MIA');
  });

  it('coacciona distance string a número', () => {
    const parsed = FindOfficesQuerySchema.parse({ distance: '25', cityCode: 'MIA' });
    expect(parsed.distance).toBe(25);
  });

  it('coacciona lat/lng string a número', () => {
    const parsed = FindOfficesQuerySchema.parse({
      distance: 25,
      lat: '25.79',
      lng: '-80.29',
    });
    expect(parsed.lat).toBe(25.79);
    expect(parsed.lng).toBe(-80.29);
  });

  it('rechaza distance no positiva', () => {
    expect(FindOfficesQuerySchema.safeParse({ distance: 0, cityCode: 'MIA' }).success).toBe(false);
    expect(FindOfficesQuerySchema.safeParse({ distance: -5, cityCode: 'MIA' }).success).toBe(false);
  });

  it('rechaza source que no es alpha-2 (length 2)', () => {
    expect(
      FindOfficesQuerySchema.safeParse({ distance: 25, cityCode: 'MIA', source: 'COL' }).success,
    ).toBe(false);
  });

  it('acepta source alpha-2 válido', () => {
    const parsed = FindOfficesQuerySchema.parse({ distance: 25, cityCode: 'MIA', source: 'CO' });
    expect(parsed.source).toBe('CO');
  });

  // refine: XOR coordenadas vs cityCode
  it('rechaza cuando no hay ni coordenadas ni cityCode', () => {
    const result = FindOfficesQuerySchema.safeParse({ distance: 25 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['cityCode']);
    }
  });

  it('rechaza cuando hay lat pero falta lng (coordenadas incompletas y sin cityCode)', () => {
    expect(FindOfficesQuerySchema.safeParse({ distance: 25, lat: 25.79 }).success).toBe(false);
  });

  it('rechaza cuando hay lng pero falta lat (coordenadas incompletas y sin cityCode)', () => {
    expect(FindOfficesQuerySchema.safeParse({ distance: 25, lng: -80.29 }).success).toBe(false);
  });

  it('acepta lat incompleto si se provee cityCode (el refine se satisface por cityCode)', () => {
    const parsed = FindOfficesQuerySchema.parse({ distance: 25, lat: 25.79, cityCode: 'MIA' });
    expect(parsed.cityCode).toBe('MIA');
    expect(parsed.lat).toBe(25.79);
  });

  it('acepta companyCode opcional', () => {
    const parsed = FindOfficesQuerySchema.parse({
      distance: 25,
      cityCode: 'MIA',
      companyCode: 'ZI',
    });
    expect(parsed.companyCode).toBe('ZI');
  });
});

// ───────────────────────── RatesQuerySchema ─────────────────────────

describe('RatesQuerySchema', () => {
  it('exige country (destino): rechaza objeto vacío o sólo source', () => {
    expect(RatesQuerySchema.safeParse({}).success).toBe(false);
    expect(RatesQuerySchema.safeParse({ source: 'CO' }).success).toBe(false);
  });

  it('acepta sólo country (source opcional, lo completa el adapter desde la cuenta BYOC)', () => {
    expect(RatesQuerySchema.parse({ country: 'US' })).toEqual({ country: 'US' });
  });

  it('acepta country/source alpha-2 y language', () => {
    const parsed = RatesQuerySchema.parse({ country: 'US', source: 'CO', language: 'es' });
    expect(parsed).toEqual({ country: 'US', source: 'CO', language: 'es' });
  });

  it('rechaza country que no es alpha-2', () => {
    expect(RatesQuerySchema.safeParse({ country: 'USA' }).success).toBe(false);
  });

  it('rechaza source que no es alpha-2', () => {
    expect(RatesQuerySchema.safeParse({ source: 'C' }).success).toBe(false);
  });

  it('rechaza language fuera de rango (2..5)', () => {
    expect(RatesQuerySchema.safeParse({ language: 'e' }).success).toBe(false);
    expect(RatesQuerySchema.safeParse({ language: 'es-419' }).success).toBe(false);
  });
});

// ───────────────────────── CarSearchInputSchema ─────────────────────────

describe('CarSearchInputSchema', () => {
  it('aplica default rateType="best" cuando no se envía', () => {
    const parsed = CarSearchInputSchema.parse(validSearch);
    expect(parsed.rateType).toBe('best');
  });

  it('respeta rateType explícito', () => {
    const parsed = CarSearchInputSchema.parse({ ...validSearch, rateType: '3' });
    expect(parsed.rateType).toBe('3');
  });

  it('coacciona lat/lng/latDropOff/lngDropOff string a número', () => {
    const parsed = CarSearchInputSchema.parse({
      ...validSearch,
      lat: '25.79',
      lng: '-80.29',
      latDropOff: '26.0',
      lngDropOff: '-80.0',
    });
    expect(parsed.lat).toBe(25.79);
    expect(parsed.lng).toBe(-80.29);
    expect(parsed.latDropOff).toBe(26.0);
    expect(parsed.lngDropOff).toBe(-80.0);
  });

  it('acepta paymentType "ppd" y "pod"', () => {
    expect(CarSearchInputSchema.parse({ ...validSearch, paymentType: 'ppd' }).paymentType).toBe(
      'ppd',
    );
    expect(CarSearchInputSchema.parse({ ...validSearch, paymentType: 'pod' }).paymentType).toBe(
      'pod',
    );
  });

  it('rechaza paymentType inválido', () => {
    expect(CarSearchInputSchema.safeParse({ ...validSearch, paymentType: 'cash' }).success).toBe(
      false,
    );
  });

  // Fechas YYYY-MM-DD
  it.each([
    ['2026/07/01', 'separador con barra'],
    ['26-07-01', 'año de 2 dígitos'],
    ['2026-7-1', 'mes/día sin cero a la izquierda'],
    ['2026-07-01T00:00', 'con tiempo'],
    ['', 'vacío'],
  ])('rechaza pickUpDate inválida: %s (%s)', (pickUpDate) => {
    expect(CarSearchInputSchema.safeParse({ ...validSearch, pickUpDate }).success).toBe(false);
  });

  it('rechaza dropOffDate con formato inválido', () => {
    expect(
      CarSearchInputSchema.safeParse({ ...validSearch, dropOffDate: '07-01-2026' }).success,
    ).toBe(false);
  });

  // Horas HHMM (4 dígitos)
  it.each([
    ['800', '3 dígitos'],
    ['10000', '5 dígitos'],
    ['10:00', 'con dos puntos'],
    ['abcd', 'no numérico'],
    ['', 'vacío'],
  ])('rechaza pickUpHour inválida: %s (%s)', (pickUpHour) => {
    expect(CarSearchInputSchema.safeParse({ ...validSearch, pickUpHour }).success).toBe(false);
  });

  it('acepta horas HHMM de 4 dígitos', () => {
    const parsed = CarSearchInputSchema.parse({
      ...validSearch,
      pickUpHour: '0800',
      dropOffHour: '2359',
    });
    expect(parsed.pickUpHour).toBe('0800');
    expect(parsed.dropOffHour).toBe('2359');
  });

  it('rechaza source/country que no son alpha-2', () => {
    expect(CarSearchInputSchema.safeParse({ ...validSearch, source: 'COL' }).success).toBe(false);
    expect(CarSearchInputSchema.safeParse({ ...validSearch, country: 'U' }).success).toBe(false);
  });

  it('rechaza pickUpLocation vacío', () => {
    expect(CarSearchInputSchema.safeParse({ ...validSearch, pickUpLocation: '' }).success).toBe(
      false,
    );
  });

  it('exige country (destino, requerido)', () => {
    const { country: _omit, ...withoutCountry } = validSearch;
    expect(CarSearchInputSchema.safeParse(withoutCountry).success).toBe(false);
  });

  // Búsqueda por ciudad: coordenadas requeridas (refine cityCoordsOk)
  it('rechaza pickUpLocation="City" sin lat/lng', () => {
    expect(CarSearchInputSchema.safeParse({ ...validSearch, pickUpLocation: 'City' }).success).toBe(
      false,
    );
  });

  it('acepta pickUpLocation="City" con lat/lng', () => {
    const parsed = CarSearchInputSchema.parse({
      ...validSearch,
      pickUpLocation: 'City',
      lat: 25.79,
      lng: -80.29,
    });
    expect(parsed.lat).toBe(25.79);
  });

  it('rechaza dropOffLocation="City2" sin latDropOff/lngDropOff', () => {
    expect(
      CarSearchInputSchema.safeParse({ ...validSearch, dropOffLocation: 'City2' }).success,
    ).toBe(false);
  });

  it('acepta dropOffLocation="City2" con coordenadas de devolución', () => {
    const parsed = CarSearchInputSchema.parse({
      ...validSearch,
      dropOffLocation: 'City2',
      latDropOff: 26.0,
      lngDropOff: -80.0,
    });
    expect(parsed.latDropOff).toBe(26.0);
  });
});

// ───────────────────────── CarSelectionInputSchema ─────────────────────────

describe('CarSelectionInputSchema', () => {
  const validSelection = { ...validSearch, companyCode: 'ZT', sippCode: 'CCAR' };

  it('acepta selección válida y hereda default rateType="best"', () => {
    const parsed = CarSelectionInputSchema.parse(validSelection);
    expect(parsed.companyCode).toBe('ZT');
    expect(parsed.sippCode).toBe('CCAR');
    expect(parsed.rateType).toBe('best');
  });

  it('exige companyCode (requerido, no opcional como en search)', () => {
    const { companyCode: _omit, ...withoutCompany } = validSelection;
    expect(CarSelectionInputSchema.safeParse(withoutCompany).success).toBe(false);
  });

  it('exige sippCode', () => {
    const { sippCode: _omit, ...withoutSipp } = validSelection;
    expect(CarSelectionInputSchema.safeParse(withoutSipp).success).toBe(false);
  });

  it('acepta ccrc, coupon y tp opcionales', () => {
    const parsed = CarSelectionInputSchema.parse({
      ...validSelection,
      ccrc: 'tok-1',
      coupon: 'PROMO',
      tp: 'X',
    });
    expect(parsed.ccrc).toBe('tok-1');
    expect(parsed.coupon).toBe('PROMO');
    expect(parsed.tp).toBe('X');
  });

  it('hereda la validación de fechas del schema base', () => {
    expect(
      CarSelectionInputSchema.safeParse({ ...validSelection, pickUpDate: 'bad' }).success,
    ).toBe(false);
  });
});

// ───────────────────────── RateDetailQuerySchema ─────────────────────────

describe('RateDetailQuerySchema', () => {
  it('acepta input válido', () => {
    const parsed = RateDetailQuerySchema.parse({
      uniqid: 'abc',
      paymentType: 'pod',
      rateType: '3',
    });
    expect(parsed).toEqual({ uniqid: 'abc', paymentType: 'pod', rateType: '3' });
  });

  it('rechaza paymentType fuera de ppd|pod', () => {
    expect(
      RateDetailQuerySchema.safeParse({ uniqid: 'abc', paymentType: 'ppd2', rateType: '3' })
        .success,
    ).toBe(false);
  });

  it('rechaza uniqid vacío', () => {
    expect(
      RateDetailQuerySchema.safeParse({ uniqid: '', paymentType: 'ppd', rateType: '3' }).success,
    ).toBe(false);
  });

  it('rateType es requerido (sin default aquí)', () => {
    expect(RateDetailQuerySchema.safeParse({ uniqid: 'abc', paymentType: 'ppd' }).success).toBe(
      false,
    );
  });
});

// ───────────────────────── ConfirmInputSchema ─────────────────────────

describe('ConfirmInputSchema', () => {
  it('aplica defaults pickUpAddress="NA" y dropOffAddress="NA"', () => {
    const parsed = ConfirmInputSchema.parse(validConfirm);
    expect(parsed.pickUpAddress).toBe('NA');
    expect(parsed.dropOffAddress).toBe('NA');
  });

  it('respeta direcciones explícitas', () => {
    const parsed = ConfirmInputSchema.parse({
      ...validConfirm,
      pickUpAddress: '123 Main St',
      dropOffAddress: '456 Ocean Dr',
    });
    expect(parsed.pickUpAddress).toBe('123 Main St');
    expect(parsed.dropOffAddress).toBe('456 Ocean Dr');
  });

  // Coerción numérica de montos
  it('coacciona realBase/realTax/total string a número', () => {
    const parsed = ConfirmInputSchema.parse({
      ...validConfirm,
      realBase: '118.00',
      realTax: '20.00',
      total: '138.00',
    });
    expect(parsed.realBase).toBe(118);
    expect(parsed.realTax).toBe(20);
    expect(parsed.total).toBe(138);
  });

  it('acepta montos en cero (nonnegative)', () => {
    const parsed = ConfirmInputSchema.parse({
      ...validConfirm,
      realBase: 0,
      realTax: 0,
      total: 0,
    });
    expect(parsed.realBase).toBe(0);
  });

  it('rechaza montos negativos', () => {
    expect(ConfirmInputSchema.safeParse({ ...validConfirm, realBase: -1 }).success).toBe(false);
    expect(ConfirmInputSchema.safeParse({ ...validConfirm, realTax: -0.5 }).success).toBe(false);
    expect(ConfirmInputSchema.safeParse({ ...validConfirm, total: -100 }).success).toBe(false);
  });

  it('rechaza montos no numéricos (no coercibles)', () => {
    expect(ConfirmInputSchema.safeParse({ ...validConfirm, total: 'abc' }).success).toBe(false);
  });

  // age = edad LITERAL del conductor (1..99); el API real espera la edad real, no un código.
  it.each([18, 27, 30, 99])('acepta edad literal %s', (age) => {
    expect(ConfirmInputSchema.parse({ ...validConfirm, age }).age).toBe(age);
  });

  it('coacciona age string "27" → 27', () => {
    expect(ConfirmInputSchema.parse({ ...validConfirm, age: '27' }).age).toBe(27);
  });

  it.each([0, -1, 100, 'abc'])('rechaza age inválida: %s', (age) => {
    expect(ConfirmInputSchema.safeParse({ ...validConfirm, age }).success).toBe(false);
  });

  it('acepta paymentType "ppd" y "pod", rechaza otros', () => {
    expect(ConfirmInputSchema.parse({ ...validConfirm, paymentType: 'pod' }).paymentType).toBe(
      'pod',
    );
    expect(ConfirmInputSchema.safeParse({ ...validConfirm, paymentType: 'later' }).success).toBe(
      false,
    );
  });

  it('rechaza email inválido', () => {
    expect(ConfirmInputSchema.safeParse({ ...validConfirm, email: 'not-an-email' }).success).toBe(
      false,
    );
  });

  it('rechaza currency que no es de 3 caracteres', () => {
    expect(ConfirmInputSchema.safeParse({ ...validConfirm, currency: 'US' }).success).toBe(false);
    expect(ConfirmInputSchema.safeParse({ ...validConfirm, currency: 'USDD' }).success).toBe(false);
  });

  it('normaliza currency a mayúsculas (contrato canónico)', () => {
    expect(ConfirmInputSchema.parse({ ...validConfirm, currency: 'usd' }).currency).toBe('USD');
  });

  it('rechaza currency con caracteres no alfabéticos', () => {
    expect(ConfirmInputSchema.safeParse({ ...validConfirm, currency: 'U$D' }).success).toBe(false);
  });

  it('rechaza fechas y horas con formato inválido', () => {
    expect(
      ConfirmInputSchema.safeParse({ ...validConfirm, pickUpDate: '01-07-2026' }).success,
    ).toBe(false);
    expect(ConfirmInputSchema.safeParse({ ...validConfirm, dropOffHour: '120' }).success).toBe(
      false,
    );
  });

  it('acepta frequentFlyer válido', () => {
    const parsed = ConfirmInputSchema.parse({
      ...validConfirm,
      frequentFlyer: { number: 'FF123', carrier: 'AA' },
    });
    expect(parsed.frequentFlyer).toEqual({ number: 'FF123', carrier: 'AA' });
  });

  it('rechaza frequentFlyer incompleto (falta carrier)', () => {
    expect(
      ConfirmInputSchema.safeParse({ ...validConfirm, frequentFlyer: { number: 'FF123' } }).success,
    ).toBe(false);
  });

  it('acepta extras parciales con booleanos', () => {
    const parsed = ConfirmInputSchema.parse({
      ...validConfirm,
      extras: { gps: true, childBoosterSeat: false },
    });
    expect(parsed.extras).toEqual({ gps: true, childBoosterSeat: false });
  });

  it('rechaza extras con valor no booleano', () => {
    expect(ConfirmInputSchema.safeParse({ ...validConfirm, extras: { gps: 'yes' } }).success).toBe(
      false,
    );
  });

  it('acepta onHold booleano opcional', () => {
    expect(ConfirmInputSchema.parse({ ...validConfirm, onHold: true }).onHold).toBe(true);
  });

  it('rechaza campos requeridos faltantes (firstName)', () => {
    const { firstName: _omit, ...withoutFirstName } = validConfirm;
    expect(ConfirmInputSchema.safeParse(withoutFirstName).success).toBe(false);
  });
});

// ───────────────────────── MyReservationBodySchema ─────────────────────────

describe('MyReservationBodySchema', () => {
  it('acepta lastName + confirmationCode', () => {
    const parsed = MyReservationBodySchema.parse({
      lastName: 'Lovelace',
      confirmationCode: 'ABC123',
    });
    expect(parsed).toEqual({ lastName: 'Lovelace', confirmationCode: 'ABC123' });
  });

  it('acepta language opcional', () => {
    const parsed = MyReservationBodySchema.parse({
      lastName: 'Lovelace',
      confirmationCode: 'ABC123',
      language: 'pt',
    });
    expect(parsed.language).toBe('pt');
  });

  it('rechaza lastName vacío', () => {
    expect(
      MyReservationBodySchema.safeParse({ lastName: '', confirmationCode: 'ABC123' }).success,
    ).toBe(false);
  });

  it('rechaza confirmationCode faltante', () => {
    expect(MyReservationBodySchema.safeParse({ lastName: 'Lovelace' }).success).toBe(false);
  });
});

// ───────────────────────── CancelBodySchema ─────────────────────────

describe('CancelBodySchema', () => {
  it('acepta lastName + confirmationCode', () => {
    const parsed = CancelBodySchema.parse({ lastName: 'Lovelace', confirmationCode: 'ABC123' });
    expect(parsed).toEqual({ lastName: 'Lovelace', confirmationCode: 'ABC123' });
  });

  it('rechaza confirmationCode vacío', () => {
    expect(CancelBodySchema.safeParse({ lastName: 'Lovelace', confirmationCode: '' }).success).toBe(
      false,
    );
  });

  it('rechaza lastName faltante', () => {
    expect(CancelBodySchema.safeParse({ confirmationCode: 'ABC123' }).success).toBe(false);
  });
});

// ───────────────────────── ReleaseBodySchema ─────────────────────────

describe('ReleaseBodySchema', () => {
  it('acepta lastName + referenceCode (no confirmationCode)', () => {
    const parsed = ReleaseBodySchema.parse({ lastName: 'Lovelace', referenceCode: 'REF-9' });
    expect(parsed).toEqual({ lastName: 'Lovelace', referenceCode: 'REF-9' });
  });

  it('rechaza referenceCode vacío', () => {
    expect(ReleaseBodySchema.safeParse({ lastName: 'Lovelace', referenceCode: '' }).success).toBe(
      false,
    );
  });

  it('rechaza payload con confirmationCode pero sin referenceCode', () => {
    expect(
      ReleaseBodySchema.safeParse({ lastName: 'Lovelace', confirmationCode: 'ABC123' }).success,
    ).toBe(false);
  });
});

// ───────────────────────── DailyReportQuerySchema ─────────────────────────

describe('DailyReportQuerySchema', () => {
  it('acepta objeto vacío (todos opcionales)', () => {
    expect(DailyReportQuerySchema.parse({})).toEqual({});
  });

  it('acepta date YYYY-MM-DD y language', () => {
    const parsed = DailyReportQuerySchema.parse({ date: '2026-06-15', language: 'es' });
    expect(parsed).toEqual({ date: '2026-06-15', language: 'es' });
  });

  it('rechaza date con formato inválido', () => {
    expect(DailyReportQuerySchema.safeParse({ date: '15/06/2026' }).success).toBe(false);
  });

  it('rechaza language fuera de rango (2..5)', () => {
    expect(DailyReportQuerySchema.safeParse({ language: 'e' }).success).toBe(false);
  });
});
