import { describe, expect, it } from 'vitest';
import {
  mapBookResult,
  mapCancelResult,
  mapDailyReport,
  mapMatrixOffers,
  mapOffices,
  mapRateDetail,
  mapRates,
  mapReleaseResult,
  mapReservation,
  mapSelection,
  mapSuggestResults,
} from '@sales-travel/agent-cars';

/**
 * Fixtures = JSON crudo tal como lo devuelve AgentCars v2 (snake_case, montos como string,
 * booleans como "1"/"0"). Verifican la conversión al modelo canónico: Money.fromMajor,
 * air string→boolean, status confirmed|on_hold|on_request, schedule por día, y vacíos → [].
 */

// ─────────────────────────── Suggest ───────────────────────────

describe('mapSuggestResults', () => {
  it('mapea un aeropuerto y coacciona hasoffice/lat/lng numéricos', () => {
    const raw = [
      {
        airport: true,
        cityLoc: false,
        countryCode: 'US',
        hasoffice: '5',
        iata: 'MIA',
        latitude: '25.7959',
        longitude: '-80.287',
        timezone: 'America/New_York',
        value: 'Miami International Airport, MIA, Florida, US',
      },
    ];
    expect(mapSuggestResults(raw)).toEqual([
      {
        airport: true,
        cityLoc: false,
        countryCode: 'US',
        hasOffice: 5,
        iata: 'MIA',
        latitude: 25.7959,
        longitude: -80.287,
        timezone: 'America/New_York',
        value: 'Miami International Airport, MIA, Florida, US',
      },
    ]);
  });

  it('sin iata → undefined y campos faltantes con defaults', () => {
    const [loc] = mapSuggestResults([{ value: 'Some City', countryCode: 'CO' }]);
    expect(loc?.iata).toBeUndefined();
    expect(loc?.hasOffice).toBe(0);
    expect(loc?.latitude).toBe(0);
    expect(loc?.airport).toBe(false);
    expect(loc?.cityLoc).toBe(false);
  });

  it('respuesta vacía → []', () => {
    expect(mapSuggestResults([])).toEqual([]);
  });
});

// ─────────────────────────── Offices ───────────────────────────

describe('mapOffices', () => {
  const raw = [
    {
      office_code: 'MIAE08',
      company_code: 'ZE',
      company_name: 'Hertz',
      address: '3900 NW 25th St',
      city_name: 'Miami',
      state: 'FL',
      country_code: 'US',
      lat: '25.795',
      lng: '-80.27',
      zip_code: '33142',
      distance: '1.4',
      schedule: {
        '1': { opening: '08:00', close: '18:00' },
        '7': { opening: '09:00', close: '13:00' },
      },
    },
  ];

  it('mapea snake_case → camelCase y conserva el schedule por día', () => {
    const [office] = mapOffices(raw);
    expect(office?.officeCode).toBe('MIAE08');
    expect(office?.companyCode).toBe('ZE');
    expect(office?.companyName).toBe('Hertz');
    expect(office?.cityName).toBe('Miami');
    expect(office?.countryCode).toBe('US');
    expect(office?.zipCode).toBe('33142');
    expect(office?.lat).toBe(25.795);
    expect(office?.lng).toBe(-80.27);
    expect(office?.distance).toBe(1.4);
    expect(office?.schedule['1']).toEqual({ opening: '08:00', close: '18:00' });
    expect(office?.schedule['7']).toEqual({ opening: '09:00', close: '13:00' });
  });

  it('oficina sin schedule → objeto vacío', () => {
    const [office] = mapOffices([{ office_code: 'BOGE01' }]);
    expect(office?.schedule).toEqual({});
  });

  it('respuesta vacía → []', () => {
    expect(mapOffices([])).toEqual([]);
  });
});

// ─────────────────────────── Rates ───────────────────────────

describe('mapRates', () => {
  it('coacciona id numérico a string', () => {
    expect(
      mapRates([
        { id: 'best', name: 'Mejor tarifa' },
        { id: 123, name: 'Corporativa' },
      ]),
    ).toEqual([
      { id: 'best', name: 'Mejor tarifa' },
      { id: '123', name: 'Corporativa' },
    ]);
  });

  it('respuesta vacía → []', () => {
    expect(mapRates([])).toEqual([]);
  });
});

// ─────────────────────────── Matrix / Selection ───────────────────────────

describe('mapMatrixOffers', () => {
  // La respuesta real es un objeto agrupado por categoría, no un array plano.
  const raw = {
    Economy: [
      {
        category: 'Economy',
        sippCode: 'ECMR',
        companyCode: 'ZE',
        companyName: 'Hertz',
        rateAmount: '118.00',
        payment_option: 'ppd',
        currency: 'USD',
        carModel: 'Chevrolet Spark o similar',
        doors: '4',
        passengers: '5',
        bags: '2',
        trans: 'Automatic',
        air: '1',
        km_included: 'Unlimited',
        baseAprox: '100.00',
        taxAprox: '18.00',
        convertedCurrency: 'COP',
        convertedRateAmount: '470000.00',
        ccrc: 'token-ccrc-abc',
      },
    ],
  };

  it('convierte rateAmount/base/tax con Money.fromMajor (118.00 → 11800 USD)', () => {
    const [offer] = mapMatrixOffers(raw);
    expect(offer?.rateAmount).toEqual({ amountMinor: 11800, currency: 'USD' });
    expect(offer?.base).toEqual({ amountMinor: 10000, currency: 'USD' });
    expect(offer?.tax).toEqual({ amountMinor: 1800, currency: 'USD' });
  });

  it('mapea air "1" → true y coacciona doors/passengers/bags', () => {
    const [offer] = mapMatrixOffers(raw);
    expect(offer?.air).toBe(true);
    expect(offer?.doors).toBe(4);
    expect(offer?.passengers).toBe(5);
    expect(offer?.bags).toBe(2);
    expect(offer?.trans).toBe('Automatic');
    expect(offer?.kmIncluded).toBe('Unlimited');
  });

  it('mapea payment_option y conserva el token ccrc', () => {
    const [offer] = mapMatrixOffers(raw);
    expect(offer?.paymentOption).toBe('ppd');
    expect(offer?.ccrc).toBe('token-ccrc-abc');
  });

  it('incluye convertedRateAmount con su moneda convertida', () => {
    const [offer] = mapMatrixOffers(raw);
    expect(offer?.convertedRateAmount).toEqual({ amountMinor: 47000000, currency: 'COP' });
  });

  it('air "0" → false, payment_option desconocido cae a ppd y sin moneda convertida → omite el campo', () => {
    const [offer] = mapMatrixOffers({
      Compact: [
        {
          sippCode: 'CDMR',
          rateAmount: '90.50',
          payment_option: 'unknown',
          currency: 'USD',
          air: '0',
          baseAprox: '90.50',
          taxAprox: '0',
        },
      ],
    });
    expect(offer?.air).toBe(false);
    expect(offer?.paymentOption).toBe('ppd');
    expect(offer?.rateAmount).toEqual({ amountMinor: 9050, currency: 'USD' });
    expect(offer).not.toHaveProperty('convertedRateAmount');
    expect(offer).not.toHaveProperty('ccrc');
  });

  it('aplana múltiples grupos de categoría a un solo array', () => {
    const offers = mapMatrixOffers({
      Economy: [{ sippCode: 'A', rateAmount: '10', currency: 'USD', air: true }],
      Compact: [{ sippCode: 'B', rateAmount: '20', currency: 'USD', air: true }],
    });
    expect(offers).toHaveLength(2);
    expect(offers.map((o) => o.sippCode)).toEqual(['A', 'B']);
  });

  it('sin currency → default USD', () => {
    const [offer] = mapMatrixOffers({ G: [{ sippCode: 'X', rateAmount: '10', air: true }] });
    expect(offer?.rateAmount.currency).toBe('USD');
  });

  it('monto convertido con separador de miles se parsea bien', () => {
    const [offer] = mapMatrixOffers({
      G: [
        {
          sippCode: 'X',
          rateAmount: '374.78',
          currency: 'USD',
          air: true,
          convertedCurrency: 'COP',
          convertedRateAmount: '1,180,729',
        },
      ],
    });
    expect(offer?.convertedRateAmount).toEqual({ amountMinor: 118072900, currency: 'COP' });
  });

  it('respuesta vacía → []', () => {
    expect(mapMatrixOffers({})).toEqual([]);
  });
});

describe('mapSelection', () => {
  it('lee carInfo[SIPP] y rates[id][ppd] de la respuesta anidada real', () => {
    const selection = mapSelection({
      uniqid: 'sess-uniqid-123',
      carInfo: {
        MCMR: {
          sippCode: 'MCMR',
          doors: '2',
          passengers: '4',
          bags: '1',
          air_conditioner: 'Si',
          transmission: 'Manual',
          categoryName: 'Mini',
          companyCode: 'ZE',
          companyName: 'HERTZ',
          carModel: 'A Fiat 500 or similar',
          km_included: 'Unlimited Km',
        },
      },
      rates: {
        '7': {
          ppd: {
            rateTypeId: '7',
            currency: 'EUR',
            baseAprox: '132.96',
            taxAprox: 0,
            totalAprox: '132.96',
            amount: '132.96',
          },
        },
      },
      currency: 'USD',
    });
    expect(selection.uniqid).toBe('sess-uniqid-123');
    expect(selection.sippCode).toBe('MCMR');
    expect(selection.category).toBe('Mini');
    expect(selection.carModel).toBe('A Fiat 500 or similar');
    expect(selection.companyName).toBe('HERTZ');
    expect(selection.trans).toBe('Manual');
    expect(selection.air).toBe(true);
    expect(selection.paymentOption).toBe('ppd');
    expect(selection.rateCode).toBe('7');
    expect(selection.rateAmount).toEqual({ amountMinor: 13296, currency: 'EUR' });
    expect(selection.base).toEqual({ amountMinor: 13296, currency: 'EUR' });
    expect(selection.tax).toEqual({ amountMinor: 0, currency: 'EUR' });
  });
});

// ─────────────────────────── RateDetail ───────────────────────────

describe('mapRateDetail', () => {
  it('lee los cargos del objeto detail{} y la moneda de realCurrency', () => {
    const detail = mapRateDetail({
      base: '20.00',
      tax: '11.92',
      realCurrency: 'USD',
      detail: {
        '1': { amount: '2.30', comment: 'CRF - CONCESSION RECOUP FEE' },
        '2': { amount: '4.85', comment: 'SCG - RENTAL CAR FACILITY CHG' },
      },
    });
    expect(detail.base).toEqual({ amountMinor: 2000, currency: 'USD' });
    expect(detail.tax).toEqual({ amountMinor: 1192, currency: 'USD' });
    expect(detail.charges).toHaveLength(2);
    expect(detail.charges[0]).toEqual({
      code: '1',
      name: 'CRF - CONCESSION RECOUP FEE',
      amount: { amountMinor: 230, currency: 'USD' },
    });
    expect(detail.charges[1]?.amount).toEqual({ amountMinor: 485, currency: 'USD' });
  });

  it('sin detail → arreglo vacío y currency default USD', () => {
    const detail = mapRateDetail({ base: '50', tax: '0' });
    expect(detail.charges).toEqual([]);
    expect(detail.base).toEqual({ amountMinor: 5000, currency: 'USD' });
  });
});

// ─────────────────────────── BookResult ───────────────────────────

describe('mapBookResult', () => {
  it.each([
    ['Activo', 'confirmed'],
    ['Active', 'confirmed'],
    ['confirmed', 'confirmed'],
    ['on_hold', 'on_hold'],
    ['on_request', 'on_request'],
  ])('status "%s" → %s', (input, expected) => {
    const result = mapBookResult({
      confirmationCode: 'ABC123',
      sippCode: 'ECMR',
      rateCode: 'RT-9',
      status: input,
    });
    expect(result.status).toBe(expected);
    expect(result.confirmationCode).toBe('ABC123');
    expect(result.sippCode).toBe('ECMR');
    expect(result.rateCode).toBe('RT-9');
  });

  it('status desconocido o ausente → on_request (default conservador)', () => {
    expect(mapBookResult({ confirmationCode: 'X', status: 'weird' }).status).toBe('on_request');
    expect(mapBookResult({ confirmationCode: 'X' }).status).toBe('on_request');
  });
});

// ─────────────────────────── Reservation ───────────────────────────

describe('mapReservation', () => {
  it('mapea PPD conservando voucherInformation y voucherNumber', () => {
    const reservation = mapReservation({
      confirmationCode: 'ABC123',
      firstName: 'Ana',
      lastName: 'García',
      sippCode: 'ECMR',
      rateCode: 'RT-9',
      status: 'confirmed',
      voucherInformation: { pickup: 'Counter A', terms: 'Show passport' },
      voucherNumber: 'VCH-777',
    });
    expect(reservation.firstName).toBe('Ana');
    expect(reservation.lastName).toBe('García');
    expect(reservation.voucherInformation).toEqual({ pickup: 'Counter A', terms: 'Show passport' });
    expect(reservation.voucherNumber).toBe('VCH-777');
  });

  it('sin voucherNumber (POD) → omite el campo y voucherInformation default {}', () => {
    const reservation = mapReservation({
      confirmationCode: 'ABC123',
      firstName: 'Ana',
      lastName: 'García',
      status: 'confirmed',
    });
    expect(reservation).not.toHaveProperty('voucherNumber');
    expect(reservation.voucherInformation).toEqual({});
  });
});

// ─────────────────────────── Cancel ───────────────────────────

describe('mapCancelResult', () => {
  it('marca success=true y propaga el mensaje', () => {
    expect(
      mapCancelResult({ confirmationCode: 'ABC123', message: 'Cancelado sin penalidad' }),
    ).toEqual({
      success: true,
      confirmationCode: 'ABC123',
      message: 'Cancelado sin penalidad',
    });
  });

  it('sin mensaje → omite el campo message', () => {
    const result = mapCancelResult({ confirmationCode: 'ABC123' });
    expect(result).not.toHaveProperty('message');
    expect(result.success).toBe(true);
  });
});

// ─────────────────────────── Release ───────────────────────────

describe('mapReleaseResult', () => {
  it('mapea la reserva liberada (ON HOLD → confirmada)', () => {
    expect(
      mapReleaseResult({
        confirmationCode: 'ABC123',
        sippCode: 'ECMR',
        rateCode: 'RT-9',
        status: 'confirmed',
      }),
    ).toEqual({
      confirmationCode: 'ABC123',
      sippCode: 'ECMR',
      rateCode: 'RT-9',
      status: 'confirmed',
    });
  });
});

// ─────────────────────────── DailyReport ───────────────────────────

describe('mapDailyReport', () => {
  it('mapea cada entrada del reporte', () => {
    expect(
      mapDailyReport([
        {
          confirmationCode: 'ABC123',
          pickUpDate: '2026-07-01',
          dropOffDate: '2026-07-05',
          status: 'confirmed',
        },
        {
          confirmationCode: 'DEF456',
          pickUpDate: '2026-07-02',
          dropOffDate: '2026-07-04',
          status: 'on_hold',
        },
      ]),
    ).toEqual([
      {
        confirmationCode: 'ABC123',
        pickUpDate: '2026-07-01',
        dropOffDate: '2026-07-05',
        status: 'confirmed',
      },
      {
        confirmationCode: 'DEF456',
        pickUpDate: '2026-07-02',
        dropOffDate: '2026-07-04',
        status: 'on_hold',
      },
    ]);
  });

  it('respuesta vacía → []', () => {
    expect(mapDailyReport([])).toEqual([]);
  });
});
