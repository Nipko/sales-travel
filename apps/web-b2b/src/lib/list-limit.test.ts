import { describe, expect, it } from 'vitest';
import { LIST_MAX, LIST_PAGE, listLimitOf, nextListLimit } from './list-limit';

describe('listLimitOf (QA-H-15)', () => {
  it('sin limit, la primera página', () => {
    expect(listLimitOf(new URLSearchParams())).toBe(LIST_PAGE);
    expect(listLimitOf(new URLSearchParams('limit='))).toBe(LIST_PAGE);
  });

  it('un entero de 1 a 1000 pasa; lo demás no', () => {
    expect(listLimitOf(new URLSearchParams('limit=200'))).toBe(200);
    expect(listLimitOf(new URLSearchParams('limit=1000'))).toBe(1000);
    for (const malo of ['0', '1001', '-1', '1e3', '10.5', 'diez', '00001000']) {
      expect(listLimitOf(new URLSearchParams(`limit=${malo}`)), malo).toBeNull();
    }
  });
});

describe('nextListLimit', () => {
  it('suma una página y se queda en el tope', () => {
    expect(nextListLimit(100)).toBe(200);
    expect(nextListLimit(950)).toBe(LIST_MAX);
    expect(nextListLimit(LIST_MAX)).toBe(LIST_MAX);
  });
});
