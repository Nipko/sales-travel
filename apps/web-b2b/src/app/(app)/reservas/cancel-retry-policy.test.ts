import { describe, expect, it } from 'vitest';
import {
  canRetryCancelOperation,
  directCancellationBlock,
  type OrderOperationView,
} from './cancel-retry-policy';

function operation(overrides: Partial<OrderOperationView> = {}): OrderOperationView {
  return {
    id: 'op-1',
    type: 'cancel',
    status: 'failed',
    attempts: 1,
    last_error: 'falló',
    created_at: '2026-08-27T12:00:00.000Z',
    retryable: false,
    outcome: 'FAILED',
    reconciliationRequired: false,
    ...overrides,
  };
}

describe('canRetryCancelOperation', () => {
  it('sólo habilita un fallo pre-write marcado explícitamente como retryable', () => {
    expect(canRetryCancelOperation(operation({ retryable: true }))).toBe(true);
    expect(canRetryCancelOperation(operation({ retryable: false }))).toBe(false);
    expect(
      canRetryCancelOperation(
        operation({ retryable: true, outcome: 'UNVERIFIED', reconciliationRequired: true }),
      ),
    ).toBe(false);
  });

  it('no ofrece retry para otra operación o una cancelación exitosa', () => {
    expect(canRetryCancelOperation(operation({ type: 'pay', retryable: true }))).toBe(false);
    expect(
      canRetryCancelOperation(
        operation({ status: 'success', outcome: 'SUCCEEDED', retryable: true }),
      ),
    ).toBe(false);
  });
});

describe('directCancellationBlock', () => {
  it('bloquea y manda a conciliación ante UNVERIFIED', () => {
    expect(
      directCancellationBlock([operation({ outcome: 'UNVERIFIED', reconciliationRequired: true })]),
    ).toMatch(/conciliar/i);
  });

  it('conduce al retry durable en lugar de iniciar otro write', () => {
    expect(directCancellationBlock([operation({ retryable: true })])).toMatch(/historial/i);
  });

  it('permite la primera cancelación y no bloquea una ya exitosa', () => {
    expect(directCancellationBlock([])).toBeNull();
    expect(
      directCancellationBlock([operation({ status: 'success', outcome: 'SUCCEEDED' })]),
    ).toBeNull();
  });
});
