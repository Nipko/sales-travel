import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TboRequestBuildError } from '../errors';
import { TboCancelRequestSchema, buildTboCancelRequest } from './cancel.request.builder';

/** El builder de Cancel (docs/tbo/04 §4.1; 08 RF-25): sólo `ConfirmationNumber`, como en p. 41. */

const REQUEST_911 = JSON.parse(
  readFileSync(join(__dirname, '..', '__fixtures__', 'pdf', 'cancel-request.p41.json'), 'utf8'),
) as Record<string, unknown>;

function issuesOf(run: () => unknown): readonly string[] {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(TboRequestBuildError);
    const error = err as TboRequestBuildError;
    expect(error.path).toBe('/Cancel');
    expect(error.reason).toBe('SCHEMA');
    return error.issues;
  }
  throw new Error('el builder no lanzó');
}

describe('9.1.1 Sample Request (p. 41)', () => {
  it('el mismo body, byte a byte', () => {
    const body = buildTboCancelRequest('FL1IMA');
    expect(JSON.stringify(body)).toBe(JSON.stringify(REQUEST_911));
  });

  it('sin PaymentMode ni ninguna otra clave: el contrato no las declara (p. 41)', () => {
    expect(Object.keys(buildTboCancelRequest('FL1IMA'))).toEqual(['ConfirmationNumber']);
    expect(
      TboCancelRequestSchema.safeParse({ ConfirmationNumber: 'FL1IMA', PaymentMode: 'Limit' })
        .success,
    ).toBe(false);
  });
});

describe('un localizador sin forma no sale', () => {
  it.each([' FL1IMA', 'FL1IMA ', 'FL 1IMA', '', 'FL1IMA;', 'x'.repeat(65)])('%j', (value) => {
    expect(issuesOf(() => buildTboCancelRequest(value))).toEqual([
      'ConfirmationNumber:invalid_string',
    ]);
  });

  it('el issue nombra la clave, nunca el valor', () => {
    const error = (() => {
      try {
        buildTboCancelRequest('secreto con espacios');
      } catch (err) {
        return err as TboRequestBuildError;
      }
      throw new Error('no lanzó');
    })();
    expect(error.message).not.toContain('secreto');
  });
});
