import { describe, expect, it } from 'vitest';
import { toMembershipViews, type MembershipRow } from './membership-view.js';

function row(overrides: Partial<MembershipRow> & { tenantId: string }): MembershipRow {
  return {
    id: `m-${overrides.tenantId}`,
    role: 'vendedor',
    status: 'active',
    tenantSlug: overrides.tenantId,
    tenantName: `Agencia ${overrides.tenantId}`,
    tenantStatus: 'active',
    tenantType: 'agency',
    logoUrl: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    blockerId: null,
    blockerName: null,
    ...overrides,
  };
}

const JAN = new Date('2026-01-01T00:00:00Z');
const FEB = new Date('2026-02-01T00:00:00Z');
const MAR = new Date('2026-03-01T00:00:00Z');

describe('toMembershipViews', () => {
  it('conserva el orden de entrada (alfabético) aunque el criterio mire la antigüedad', () => {
    const views = toMembershipViews(
      [row({ tenantId: 'a', createdAt: MAR }), row({ tenantId: 'b', createdAt: JAN })],
      null,
    );
    expect(views.map((v) => v.tenantId)).toEqual(['a', 'b']);
    // La más antigua es la por defecto, no la primera de la lista: el bug del panel.
    expect(views.find((v) => v.isDefault)?.tenantId).toBe('b');
  });

  it('la última con la que operó es la por defecto', () => {
    const views = toMembershipViews(
      [row({ tenantId: 'a', createdAt: JAN }), row({ tenantId: 'b', createdAt: FEB })],
      'b',
    );
    expect(views.filter((v) => v.isDefault).map((v) => v.tenantId)).toEqual(['b']);
  });

  it('una membership no activa nunca es la por defecto ni opera', () => {
    const views = toMembershipViews(
      [
        row({ tenantId: 'invited', status: 'invited', createdAt: JAN }),
        row({ tenantId: 'ok', createdAt: FEB }),
      ],
      'invited',
    );
    const invited = views.find((v) => v.tenantId === 'invited');
    expect(invited?.isDefault).toBe(false);
    expect(invited?.operable).toBe(false);
    expect(views.find((v) => v.isDefault)?.tenantId).toBe('ok');
  });

  it('la propia agencia suspendida: motivo propio, no opera, sin nombre de bloqueante', () => {
    const [view] = toMembershipViews(
      [row({ tenantId: 's', tenantStatus: 'suspended', blockerId: 's', blockerName: 'Agencia s' })],
      null,
    );
    expect(view).toMatchObject({
      operable: false,
      unavailableReason: 'tenant_suspended',
      blockedByName: null,
    });
  });

  it('archivada se distingue de suspendida', () => {
    const [view] = toMembershipViews(
      [row({ tenantId: 'x', tenantStatus: 'archived', blockerId: 'x', blockerName: 'Agencia x' })],
      null,
    );
    expect(view?.unavailableReason).toBe('tenant_archived');
  });

  it('un ancestro suspendido bloquea y se nombra', () => {
    const [view] = toMembershipViews(
      [row({ tenantId: 'sub', blockerId: 'cons', blockerName: 'Consolidador Andino' })],
      null,
    );
    expect(view).toMatchObject({
      operable: false,
      unavailableReason: 'ancestor_suspended',
      blockedByName: 'Consolidador Andino',
    });
  });

  it('una suspendida no es la por defecto aunque sea la última usada', () => {
    const views = toMembershipViews(
      [
        row({ tenantId: 'last', createdAt: JAN, blockerId: 'last', tenantStatus: 'suspended' }),
        row({ tenantId: 'next', createdAt: FEB }),
      ],
      'last',
    );
    expect(views.find((v) => v.isDefault)?.tenantId).toBe('next');
  });

  it('sin memberships activas, ninguna por defecto', () => {
    const views = toMembershipViews([row({ tenantId: 'i', status: 'invited' })], null);
    expect(views.some((v) => v.isDefault)).toBe(false);
  });
});
