import { describe, expect, it } from 'vitest';
import { TboRequestBuildError } from '../errors';
import { buildTboCityHotelsRequest } from './tbo-hotel-code-list.request.builder';

/** El body de TBOHotelCodeList contra docs/tbo/05 §2.5 y §6.3 E3 (p. 65; Q-63). */

describe('buildTboCityHotelsRequest', () => {
  it('p. 65: CityCode string e IsDetailedResponse "true" como string, igual que PDF y Postman', () => {
    expect(buildTboCityHotelsRequest('130452')).toEqual({
      CityCode: '130452',
      IsDetailedResponse: 'true',
    });
  });

  it('"false" es configuración, no código (CE-08)', () => {
    expect(buildTboCityHotelsRequest('130543', { detailedResponse: false })).toEqual({
      CityCode: '130543',
      IsDetailedResponse: 'false',
    });
  });

  it('nunca manda booleanos ni números JSON hasta que la sonda confirme que TBO los acepta', () => {
    const body = buildTboCityHotelsRequest('130452', { detailedResponse: true });
    expect(typeof body.CityCode).toBe('string');
    expect(typeof body.IsDetailedResponse).toBe('string');
  });

  it.each(['', '13 0452', '130452,1', 'x'.repeat(65)])('%j se rechaza antes del cable', (code) => {
    expect(() => buildTboCityHotelsRequest(code)).toThrow(TboRequestBuildError);
  });
});
