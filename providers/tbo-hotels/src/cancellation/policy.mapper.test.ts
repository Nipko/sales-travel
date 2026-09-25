import { HotelCancellationSchema } from '@sales-travel/canonical';
import { describe, expect, it } from 'vitest';
import {
  mapTboCancellation,
  type TboCancelPolicyInput,
  type TboCancellationInput,
  type TboCancellationMapping,
} from './policy.mapper';

/**
 * `CancelPolicies` + `IsRefundable` → cancelación neutral (docs/tbo/02 §9.6; 08 RF-11). Los tramos
 * de los ejemplos son los de PreBook y BookingDetail (p. 24, 28, 50): Search sólo los trae con
 * `IsDetailedResponse: true` y ningún ejemplo de Search los muestra.
 */

function input(overrides: Partial<TboCancellationInput> = {}): TboCancellationInput {
  return {
    isRefundable: true,
    policies: [],
    currency: 'USD',
    roomCount: 1,
    source: 'search-indicative',
    ...overrides,
  };
}

function ok(mapping: TboCancellationMapping) {
  if (!mapping.ok) throw new Error(`se esperaba ok: ${mapping.issues.join(', ')}`);
  expect(HotelCancellationSchema.safeParse(mapping.cancellation).success).toBe(true);
  return mapping;
}

const P24: TboCancelPolicyInput[] = [
  { FromDate: '05-05-2022 00:00:00', ChargeType: 'Fixed', CancellationCharge: 0.0 },
  { FromDate: '12-05-2022 00:00:00', ChargeType: 'Percentage', CancellationCharge: 100.0 },
];

const P50: TboCancelPolicyInput[] = [
  { FromDate: '12-07-2021 00:00:00', ChargeType: 'Fixed', CancellationCharge: '0.00' },
  { FromDate: '11-10-2021 00:00:00', ChargeType: 'Fixed', CancellationCharge: '0.00' },
  { FromDate: '15-10-2021 00:00:00', ChargeType: 'Percentage', CancellationCharge: '100.00' },
];

describe('IsRefundable y los tramos', () => {
  it('p. 24: reembolsable con un primer tramo de cargo 0 → fully_refundable hasta el primer cargo', () => {
    const { cancellation } = ok(mapTboCancellation(input({ policies: P24 })));
    expect(cancellation).toMatchObject({
      refundable: true,
      status: 'fully_refundable',
      policySource: 'search-indicative',
      freeCancellationUntilLocal: '2022-05-12T00:00:00',
    });
    expect(cancellation.rules).toEqual([
      {
        type: 'Fixed',
        fromLocalDateTime: '2022-05-05T00:00:00',
        fromDateRaw: '05-05-2022 00:00:00',
        penaltyAmount: { amountMinor: 0, currency: 'USD' },
      },
      {
        type: 'Percentage',
        fromLocalDateTime: '2022-05-12T00:00:00',
        fromDateRaw: '12-05-2022 00:00:00',
        penaltyPercentage: 100,
      },
    ]);
  });

  it('p. 28: no reembolsable con un único tramo del 100 %', () => {
    const { cancellation } = ok(
      mapTboCancellation(
        input({
          isRefundable: false,
          roomCount: 2,
          policies: [
            {
              FromDate: '05-05-2022 00:00:00',
              ChargeType: 'Percentage',
              CancellationCharge: 100.0,
            },
          ],
        }),
      ),
    );
    expect(cancellation).toMatchObject({ refundable: false, status: 'non_refundable' });
    expect(cancellation.rules).toHaveLength(1);
    expect(cancellation.freeCancellationUntilLocal).toBeUndefined();
  });

  it('p. 50: IsRefundable false con dos tramos de 0 se guarda tal cual, sin derivar uno del otro', () => {
    const { cancellation } = ok(
      mapTboCancellation(input({ isRefundable: false, policies: P50, source: 'prebook-final' })),
    );
    expect(cancellation.refundable).toBe(false);
    expect(cancellation.status).toBe('non_refundable');
    expect(cancellation.policySource).toBe('prebook-final');
    expect(cancellation.rules.map((rule) => rule.fromLocalDateTime)).toEqual([
      '2021-07-12T00:00:00',
      '2021-10-11T00:00:00',
      '2021-10-15T00:00:00',
    ]);
    // "Cancelación gratuita" en una tarifa que TBO declara no reembolsable sería una promesa que
    // contradice al proveedor.
    expect(cancellation.freeCancellationUntilLocal).toBeUndefined();
  });

  it('sin tramos: sólo se sabe si es reembolsable, con origen none (RF-11 CA-1)', () => {
    expect(ok(mapTboCancellation(input({ policies: undefined }))).cancellation).toEqual({
      refundable: true,
      status: 'partially_refundable',
      rules: [],
      policySource: 'none',
    });
    expect(
      ok(mapTboCancellation(input({ isRefundable: null, policies: null }))).cancellation,
    ).toEqual({
      refundable: false,
      status: 'non_refundable',
      rules: [],
      policySource: 'none',
    });
  });

  it('reembolsable con un primer tramo que ya cobra → partially_refundable, sin fecha gratuita', () => {
    const { cancellation } = ok(
      mapTboCancellation(
        input({
          policies: [
            { FromDate: '01-05-2022 00:00:00', ChargeType: 'Percentage', CancellationCharge: 50 },
            { FromDate: '10-05-2022 00:00:00', ChargeType: 'Percentage', CancellationCharge: 100 },
          ],
        }),
      ),
    );
    expect(cancellation.status).toBe('partially_refundable');
    expect(cancellation.freeCancellationUntilLocal).toBeUndefined();
  });

  it('reembolsable y ningún tramo cobra: fully_refundable, pero sin fecha que TBO no dio', () => {
    const { cancellation } = ok(
      mapTboCancellation(
        input({
          policies: [
            { FromDate: '01-05-2022 00:00:00', ChargeType: 'Fixed', CancellationCharge: 0 },
          ],
        }),
      ),
    );
    expect(cancellation.status).toBe('fully_refundable');
    expect(cancellation.freeCancellationUntilLocal).toBeUndefined();
  });

  it('dos habitaciones que arrancan a la vez y una ya cobra: no hay cancelación gratuita', () => {
    const { cancellation } = ok(
      mapTboCancellation(
        input({
          roomCount: 2,
          policies: [
            {
              Index: 1,
              FromDate: '05-05-2022 00:00:00',
              ChargeType: 'Fixed',
              CancellationCharge: 0,
            },
            {
              Index: 2,
              FromDate: '05-05-2022 00:00:00',
              ChargeType: 'Percentage',
              CancellationCharge: 100,
            },
          ],
        }),
      ),
    );
    expect(cancellation.status).toBe('partially_refundable');
    expect(cancellation.freeCancellationUntilLocal).toBeUndefined();
  });

  it('los tramos se ordenan por su inicio aunque lleguen desordenados', () => {
    const { cancellation } = ok(mapTboCancellation(input({ policies: [...P24].reverse() })));
    expect(cancellation.rules.map((rule) => rule.type)).toEqual(['Fixed', 'Percentage']);
    expect(cancellation.status).toBe('fully_refundable');
  });
});

describe('cada tramo', () => {
  it('ChargeType sin distinguir mayúsculas; el literal se conserva', () => {
    const { cancellation } = ok(
      mapTboCancellation(
        input({
          policies: [
            {
              FromDate: '01-05-2022 00:00:00',
              ChargeType: 'PERCENTAGE',
              CancellationCharge: '33.335',
            },
          ],
        }),
      ),
    );
    expect(cancellation.rules[0]).toMatchObject({ type: 'PERCENTAGE', penaltyPercentage: 33.34 });
  });

  it('un ChargeType desconocido cuenta como 100 % y se informa para medirlo', () => {
    const mapping = ok(
      mapTboCancellation(
        input({
          policies: [
            { FromDate: '01-05-2022 00:00:00', ChargeType: 'Fixed', CancellationCharge: 0 },
            { FromDate: '03-05-2022 00:00:00', ChargeType: 'PerNight', CancellationCharge: 1 },
          ],
        }),
      ),
    );
    expect(mapping.unknownChargeTypes).toBe(1);
    expect(mapping.cancellation.rules[1]).toMatchObject({
      type: 'PerNight',
      penaltyPercentage: 100,
    });
    expect(mapping.cancellation.freeCancellationUntilLocal).toBe('2022-05-03T00:00:00');
  });

  it('Fixed va en la moneda del hotel (Q-24) y con decimal exacto', () => {
    const mapping = ok(
      mapTboCancellation(
        input({
          currency: 'EUR',
          policies: [
            { FromDate: '01-05-2022 00:00:00', ChargeType: 'Fixed', CancellationCharge: '85.822' },
          ],
        }),
      ),
    );
    expect(mapping.cancellation.rules[0]?.penaltyAmount).toEqual({
      amountMinor: 8582,
      currency: 'EUR',
    });
    expect(mapping.precisionLoss).toBe(true);
  });

  it('Index como texto o número, base 1; ausente o vacío aplica a toda la reserva', () => {
    const { cancellation } = ok(
      mapTboCancellation(
        input({
          roomCount: 2,
          policies: [
            {
              Index: '2',
              FromDate: '01-05-2022 00:00:00',
              ChargeType: 'Fixed',
              CancellationCharge: 0,
            },
            {
              Index: 1,
              FromDate: '02-05-2022 00:00:00',
              ChargeType: 'Fixed',
              CancellationCharge: 0,
            },
            {
              Index: '',
              FromDate: '03-05-2022 00:00:00',
              ChargeType: 'Fixed',
              CancellationCharge: 0,
            },
          ],
        }),
      ),
    );
    expect(cancellation.rules.map((rule) => rule.roomIndex)).toEqual([2, 1, undefined]);
  });

  it.each<[string, TboCancelPolicyInput, string]>([
    [
      'una fecha que no existe',
      { FromDate: '31-02-2022 00:00:00', ChargeType: 'Fixed', CancellationCharge: 0 },
      'CancelPolicies.0.FromDate:invalid_date',
    ],
    [
      'un Index fuera del pack',
      { Index: '3', FromDate: '01-05-2022 00:00:00', ChargeType: 'Fixed', CancellationCharge: 0 },
      'CancelPolicies.0.Index:out_of_range',
    ],
    [
      'un Index 0 (la base no está confirmada, Q-24)',
      { Index: 0, FromDate: '01-05-2022 00:00:00', ChargeType: 'Fixed', CancellationCharge: 0 },
      'CancelPolicies.0.Index:out_of_range',
    ],
    [
      'un porcentaje sobre 100',
      { FromDate: '01-05-2022 00:00:00', ChargeType: 'Percentage', CancellationCharge: 100.5 },
      'CancelPolicies.0.CancellationCharge:too_big',
    ],
    [
      'un cargo fijo negativo',
      { FromDate: '01-05-2022 00:00:00', ChargeType: 'Fixed', CancellationCharge: -1 },
      'CancelPolicies.0.CancellationCharge:negative',
    ],
    [
      'un porcentaje negativo',
      { FromDate: '01-05-2022 00:00:00', ChargeType: 'Percentage', CancellationCharge: -5 },
      'CancelPolicies.0.CancellationCharge:negative',
    ],
  ])('%s invalida la política entera, sin eco del valor', (_name, policy, issue) => {
    const mapping = mapTboCancellation(
      input({ roomCount: 2, policies: [P24[0] as TboCancelPolicyInput, policy] }),
    );
    expect(mapping.ok).toBe(false);
    if (mapping.ok) return;
    expect(mapping.issues).toEqual([issue.replace('CancelPolicies.0', 'CancelPolicies.1')]);
  });
});
