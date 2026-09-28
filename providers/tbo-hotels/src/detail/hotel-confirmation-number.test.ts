import { describe, expect, it } from 'vitest';
import { TBO_HCN_PLACEHOLDERS, isTboHcnPlaceholder } from './hotel-confirmation-number';

/**
 * Un HCN de relleno no es un HCN (docs/tbo/04 PV-05; Q-47 de docs/tbo/10).
 */

describe('isTboHcnPlaceholder', () => {
  it.each([
    'NA',
    'na',
    'N/A',
    'n/a',
    'N.A.',
    ' N A ',
    'Pending',
    'PENDING',
    'pending confirmation',
    'TBA',
    't.b.a.',
    'TBC',
    'To Be Confirmed',
    'Not Available',
    'None',
    'null',
    'NIL',
    'On Request',
    '0',
    '00',
    '000000',
    '-',
    '--',
    '.',
    '/',
    '*',
    '?',
    '#',
  ])('"%s" es relleno', (value) => {
    expect(isTboHcnPlaceholder(value)).toBe(true);
  });

  it.each([
    'HCN-778899',
    '4711',
    '0042',
    'NA-4711',
    'PENDING7',
    'TBA2026',
    'ABC123',
    // Un hotel que confirma en su alfabeto no manda relleno.
    '確認番号',
  ])('"%s" es un número del hotel', (value) => {
    expect(isTboHcnPlaceholder(value)).toBe(false);
  });

  it('la lista está normalizada: mayúsculas, sin espacios ni signos', () => {
    for (const word of TBO_HCN_PLACEHOLDERS) expect(word).toMatch(/^[A-Z]+$/);
  });
});
