import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TboRequestBuildError } from '../errors';
import {
  TboBookingDetailRequestSchema,
  buildTboBookingDetailRequest,
  type TboBookingDetailInput,
} from './booking-detail.request.builder';

/**
 * El builder de BookingDetail (docs/tbo/04 §3.1; 08 RF-24; RNF-04 capas 1 y 2): exactamente un
 * identificador más `PaymentMode: "Limit"`.
 */

const REQUESTS_1011_1012 = JSON.parse(
  readFileSync(
    join(__dirname, '..', '__fixtures__', 'pdf', 'booking-detail-request.p44.json'),
    'utf8',
  ),
) as Record<'byConfirmationNumber' | 'byBookingReferenceId', Record<string, unknown>>;

const REFERENCE = 'STT7K2M9QX4D8R1VZ6AB';

function issuesOf(run: () => unknown): readonly string[] {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(TboRequestBuildError);
    const error = err as TboRequestBuildError;
    expect(error.path).toBe('/BookingDetail');
    expect(error.reason).toBe('SCHEMA');
    return error.issues;
  }
  throw new Error('el builder no lanzó');
}

describe('los dos ejemplos de p. 44', () => {
  it('10.1.1, por ConfirmationNumber: el mismo body, en el mismo orden', () => {
    const body = buildTboBookingDetailRequest({ confirmationNumber: 'YOSUR8' });
    expect(JSON.stringify(body)).toBe(JSON.stringify(REQUESTS_1011_1012.byConfirmationNumber));
  });

  it('10.1.2, por BookingReferenceId: la misma forma, con una referencia nuestra', () => {
    const body = buildTboBookingDetailRequest({ bookingReferenceId: REFERENCE });
    expect(Object.keys(body)).toEqual(Object.keys(REQUESTS_1011_1012.byBookingReferenceId));
    expect(body).toEqual({ BookingReferenceId: REFERENCE, PaymentMode: 'Limit' });
  });

  it('la referencia del PDF (`AVw12118`) no es nuestra y no sale', () => {
    expect(
      issuesOf(() =>
        buildTboBookingDetailRequest({
          bookingReferenceId: String(REQUESTS_1011_1012.byBookingReferenceId['BookingReferenceId']),
        }),
      ),
    ).toEqual(['BookingReferenceId:invalid_string']);
  });
});

describe('exactamente un identificador (Q-45)', () => {
  it('los dos juntos no salen', () => {
    const both = {
      confirmationNumber: 'YOSUR8',
      bookingReferenceId: REFERENCE,
    } as unknown as TboBookingDetailInput;
    expect(issuesOf(() => buildTboBookingDetailRequest(both))).toEqual(['<root>:both_identifiers']);
  });

  it('ninguno no sale', () => {
    expect(issuesOf(() => buildTboBookingDetailRequest({} as TboBookingDetailInput))).toEqual([
      '<root>:missing_identifier',
    ]);
  });

  it.each([' YOSUR8', 'YOSUR8 ', 'YO SUR8', '', 'x'.repeat(65)])(
    'un localizador sin forma (%j) no sale',
    (confirmationNumber) => {
      expect(issuesOf(() => buildTboBookingDetailRequest({ confirmationNumber }))).toEqual([
        'ConfirmationNumber:invalid_string',
      ]);
    },
  );
});

describe('D1', () => {
  it('el modo no se elige y la tarjeta no pasa: la entrada sólo aporta el identificador', () => {
    const smuggled = {
      confirmationNumber: 'YOSUR8',
      PaymentMode: 'NewCard',
      PaymentInfo: { CardNumber: '4111111111111111' },
    } as unknown as TboBookingDetailInput;
    expect(buildTboBookingDetailRequest(smuggled)).toEqual({
      ConfirmationNumber: 'YOSUR8',
      PaymentMode: 'Limit',
    });
  });

  it('el esquema de salida es estricto en las dos formas', () => {
    for (const extra of [{ PaymentInfo: {} }, { BookingReferenceId: REFERENCE }]) {
      expect(
        TboBookingDetailRequestSchema.safeParse({
          ConfirmationNumber: 'YOSUR8',
          PaymentMode: 'Limit',
          ...extra,
        }).success,
      ).toBe(false);
    }
    expect(
      TboBookingDetailRequestSchema.safeParse({
        ConfirmationNumber: 'YOSUR8',
        PaymentMode: 'Other',
      }).success,
    ).toBe(false);
  });
});
