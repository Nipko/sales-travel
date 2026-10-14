import { describe, expect, it } from 'vitest';
import { adminAuditTarget } from './platform-audit-proxy';

const NODO = '11111111-1111-4111-8111-111111111111';

const q = (query: string) => new URLSearchParams(query);

describe('adminAuditTarget', () => {
  it('rearma la query parámetro por parámetro', () => {
    expect(
      adminAuditTarget(
        'list',
        q(
          `from=2026-10-01&to=2026-10-13&category=orders&eventType=OrderCreated&actorEmail=Ana@X.com&tenantId=${NODO.toUpperCase()}&includePlatform=false&aggregateType=order&aggregateId=abc&cursor=a_b-1&limit=50`,
        ),
      ),
    ).toEqual({
      ok: true,
      path: `/admin/audit?from=2026-10-01&to=2026-10-13&category=orders&eventType=OrderCreated&actorEmail=ana%40x.com&tenantId=${NODO}&includePlatform=false&aggregateType=order&aggregateId=abc&cursor=a_b-1&limit=50`,
    });
    expect(adminAuditTarget('list', q(''))).toEqual({ ok: true, path: '/admin/audit' });
  });

  it('la exportación va a su ruta y no lleva página', () => {
    expect(adminAuditTarget('export', q('category=system'))).toEqual({
      ok: true,
      path: '/admin/audit/export?category=system',
    });
    expect(adminAuditTarget('export', q('cursor=abc'))).toMatchObject({ ok: false });
    expect(adminAuditTarget('export', q('limit=10'))).toMatchObject({ ok: false });
  });

  it.each([
    'otro=1',
    'category=orders&category=system',
    'from=2026-02-30',
    'from=2026-10-13&to=2026-10-01',
    'from=2026-01-01&to=2026-10-13',
    'category=pricing',
    "eventType=a'b",
    'actorEmail=ana',
    'actorEmail=ana @x.com',
    'tenantId=nodo',
    'includePlatform=si',
    'aggregateType=Order',
    `aggregateId=${'x'.repeat(101)}`,
    'cursor=no%20vale',
    'limit=0',
    'limit=201',
  ])('%s no llega al API', (query) => {
    expect(adminAuditTarget('list', q(query))).toMatchObject({ ok: false });
  });
});
