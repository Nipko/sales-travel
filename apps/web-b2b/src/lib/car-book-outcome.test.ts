import { describe, expect, it } from 'vitest';
import { isUncertainBookStatus } from './car-book-outcome';

describe('isUncertainBookStatus', () => {
  it('trata como incierto lo que no es una respuesta del API', () => {
    expect(isUncertainBookStatus(503)).toBe(true);
    expect(isUncertainBookStatus(504)).toBe(true);
    expect(isUncertainBookStatus(500)).toBe(true);
  });

  it('deja el mensaje del API cuando el API contestó', () => {
    expect(isUncertainBookStatus(502)).toBe(false);
    expect(isUncertainBookStatus(400)).toBe(false);
    expect(isUncertainBookStatus(409)).toBe(false);
  });
});
