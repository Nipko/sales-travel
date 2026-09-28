import { describe, expect, it } from 'vitest';
import { TboRequestBuildError } from '../errors';
import { TBO_OPERATIONS } from '../http/operations';
import { buildTboCityListRequest } from './city-list.request.builder';

/** El body de CityList contra docs/tbo/05 §2.3 (p. 53; Postman: `CityList`). */

describe('buildTboCityListRequest', () => {
  it('p. 53: {"CountryCode":"AT"}; Postman: {"CountryCode":"MV"}', () => {
    expect(buildTboCityListRequest('AT')).toEqual({ CountryCode: 'AT' });
    expect(buildTboCityListRequest('MV')).toEqual({ CountryCode: 'MV' });
  });

  it.each(['at', 'AUT', 'A', '', ' AT', '12'])('%j se rechaza antes del cable', (code) => {
    let caught: unknown;
    try {
      buildTboCityListRequest(code);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TboRequestBuildError);
    const error = caught as TboRequestBuildError;
    expect(error.reason).toBe('SCHEMA');
    expect(error.path).toBe(TBO_OPERATIONS.cityList.path);
    // El issue es `ruta:código`: nunca el valor recibido.
    expect(error.issues).toEqual(['CountryCode:invalid_string']);
    expect(error.message).not.toContain(`'${code}'`);
  });
});
