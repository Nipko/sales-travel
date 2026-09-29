import { describe, expect, it } from 'vitest';
import { describePolicy, policyBadge, policyState } from './fare-policy';

const fmt = (amountMinor: number, currency: string) => `${currency} ${amountMinor / 100}`;

describe('policyState', () => {
  it('sin políticas o sin el campo es «no informado», nunca «no»', () => {
    expect(policyState(undefined, 'refund')).toEqual({ kind: 'unknown' });
    expect(policyState({ refundable: false }, 'change')).toEqual({ kind: 'unknown' });
  });

  it('no permitido es «no» aunque traiga cargo', () => {
    expect(
      policyState(
        { refundable: false, refundFee: { amountMinor: 900, currency: 'USD' } },
        'refund',
      ),
    ).toEqual({ kind: 'no' });
  });

  it('permitido con cargo 0 es «sin cargo»; sin cargo informado no se promete gratis', () => {
    expect(
      policyState({ changeable: true, changeFee: { amountMinor: 0, currency: 'USD' } }, 'change'),
    ).toEqual({ kind: 'free' });
    expect(policyState({ changeable: true }, 'change')).toEqual({ kind: 'allowed' });
  });

  it('permitido con multa lleva el cargo', () => {
    const fee = { amountMinor: 15000, currency: 'USD' };
    expect(policyState({ refundable: true, refundFee: fee }, 'refund')).toEqual({
      kind: 'fee',
      fee,
    });
  });
});

describe('describePolicy y policyBadge', () => {
  it('la multa se dice por pasajero y con su moneda', () => {
    const state = policyState(
      { refundable: true, refundFee: { amountMinor: 15000, currency: 'USD' } },
      'refund',
    );
    expect(describePolicy(state, 'refund', fmt)).toBe(
      'Reembolsable con cargo de USD 150 por pasajero',
    );
    expect(policyBadge(state, fmt)).toBe('Cargo USD 150');
  });

  it('los estados sin cargo tienen texto propio por tipo', () => {
    expect(describePolicy({ kind: 'no' }, 'change', fmt)).toBe('No permitidos');
    expect(describePolicy({ kind: 'no' }, 'refund', fmt)).toBe('No reembolsable');
    expect(describePolicy({ kind: 'unknown' }, 'refund', fmt)).toBe('No informado');
    expect(describePolicy({ kind: 'allowed' }, 'change', fmt)).toBe(
      'Permitidos, cargo a confirmar',
    );
    expect(policyBadge({ kind: 'no' }, fmt)).toBeUndefined();
  });
});
