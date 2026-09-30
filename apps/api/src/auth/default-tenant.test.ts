import { describe, expect, it } from 'vitest';
import { pickDefaultMembership, type TenantCandidate } from './default-tenant.js';

const OLDEST: TenantCandidate = { tenantId: 't-oldest', operable: true };
const MIDDLE: TenantCandidate = { tenantId: 't-middle', operable: true };
const SUSPENDED: TenantCandidate = { tenantId: 't-suspended', operable: false };
const NEWEST: TenantCandidate = { tenantId: 't-newest', operable: true };

describe('pickDefaultMembership', () => {
  it('sin preferencias, la más antigua que opera', () => {
    expect(pickDefaultMembership([OLDEST, MIDDLE, NEWEST])).toBe(OLDEST);
  });

  it('la última con la que operó gana sobre la más antigua', () => {
    expect(pickDefaultMembership([OLDEST, MIDDLE, NEWEST], { last: 't-newest' })).toBe(NEWEST);
  });

  it('lo pedido explícitamente gana sobre la última', () => {
    const picked = pickDefaultMembership([OLDEST, MIDDLE, NEWEST], {
      requested: 't-middle',
      last: 't-newest',
    });
    expect(picked).toBe(MIDDLE);
  });

  it('una última que ya no opera (suspendida) cae a la más antigua que opera', () => {
    expect(pickDefaultMembership([SUSPENDED, MIDDLE], { last: 't-suspended' })).toBe(MIDDLE);
  });

  it('una última de la que ya no es miembro cae a la más antigua que opera', () => {
    expect(pickDefaultMembership([OLDEST, NEWEST], { last: 't-borrada' })).toBe(OLDEST);
  });

  it('lo pedido que no opera no se honra', () => {
    expect(pickDefaultMembership([SUSPENDED, NEWEST], { requested: 't-suspended' })).toBe(NEWEST);
  });

  it('salta las suspendidas aunque sean las más antiguas', () => {
    expect(pickDefaultMembership([SUSPENDED, MIDDLE, NEWEST])).toBe(MIDDLE);
  });

  it('si ninguna opera, la más antigua igual: el panel explica por qué y deja elegir', () => {
    const other: TenantCandidate = { tenantId: 't-other', operable: false };
    expect(pickDefaultMembership([SUSPENDED, other], { last: 't-other' })).toBe(SUSPENDED);
  });

  it('sin memberships, ninguna', () => {
    expect(pickDefaultMembership([], { last: 't-oldest' })).toBeUndefined();
  });

  it('conserva el tipo de quien llama (rol incluido)', () => {
    const rows = [{ tenantId: 't-1', operable: true, role: 'vendedor' as const }];
    expect(pickDefaultMembership(rows)?.role).toBe('vendedor');
  });
});
