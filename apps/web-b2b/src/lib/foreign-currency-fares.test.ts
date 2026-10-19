import { describe, expect, it } from 'vitest';
import {
  foreignCurrencyFaresHint,
  foreignCurrencyFaresPlan,
  foreignCurrencyFaresTarget,
  parseForeignCurrencyFares,
} from './foreign-currency-fares';

const ID = '11111111-1111-4111-8111-111111111111';

describe('proxy de tarifas en otra moneda', () => {
  it('lee y cambia sólo con un id de nodo válido', () => {
    expect(foreignCurrencyFaresTarget(ID)).toEqual({
      ok: true,
      path: `/admin/tenants/${ID}/foreign-currency-fares`,
    });
    expect(foreignCurrencyFaresTarget('../users').ok).toBe(false);
    expect(foreignCurrencyFaresPlan('nope', { enabled: true }).ok).toBe(false);
  });

  it('el cuerpo se reconstruye: sólo `enabled`, y booleano', () => {
    expect(foreignCurrencyFaresPlan(ID, { enabled: true, currency: 'USD' })).toEqual({
      ok: true,
      path: `/admin/tenants/${ID}/foreign-currency-fares`,
      body: { enabled: true },
    });
    expect(foreignCurrencyFaresPlan(ID, { enabled: 'true' }).ok).toBe(false);
    expect(foreignCurrencyFaresPlan(ID, undefined).ok).toBe(false);
  });
});

describe('vista', () => {
  it('lee la respuesta del API y rechaza lo que no cuadra', () => {
    expect(parseForeignCurrencyFares({ tenantId: ID, enabled: false, currency: 'COP' })).toEqual({
      tenantId: ID,
      enabled: false,
      currency: 'COP',
    });
    expect(parseForeignCurrencyFares({ tenantId: ID, enabled: 'no', currency: 'COP' })).toBe(
      undefined,
    );
    expect(parseForeignCurrencyFares({ tenantId: ID, enabled: true, currency: 'cop ' })).toBe(
      undefined,
    );
  });

  it('el texto dice qué pasa en cada estado, con la moneda de la agencia', () => {
    const off = foreignCurrencyFaresHint({ tenantId: ID, enabled: false, currency: 'COP' });
    const on = foreignCurrencyFaresHint({ tenantId: ID, enabled: true, currency: 'COP' });
    expect(off).toContain('Sólo se muestran tarifas en COP');
    expect(on).toContain('sin convertir a COP');
    expect(on).toContain('Apágalo al terminar');
  });
});
