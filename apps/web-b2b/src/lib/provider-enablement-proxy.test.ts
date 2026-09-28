import { describe, expect, it } from 'vitest';
import { enablementProxyPlan, tenantProvidersPath } from './provider-enablement-proxy';

const AGENCIA = '10000000-0000-4000-8000-000000000002';

describe('enablementProxyPlan', () => {
  it('arma la ruta global y reenvía sólo `enabled` y `reason`', () => {
    expect(
      enablementProxyPlan(
        'PUT',
        { scope: 'global', code: 'tbo-hotels' },
        { enabled: true, reason: ' Piloto ', tenantId: 'otro' },
      ),
    ).toEqual({
      ok: true,
      path: '/admin/providers/tbo-hotels/global',
      body: { enabled: true, reason: 'Piloto' },
    });
  });

  it('arma la ruta del tenant en minúsculas, como la guarda el API', () => {
    expect(
      enablementProxyPlan(
        'PUT',
        { scope: 'tenant', code: 'sabre', tenantId: AGENCIA.toUpperCase() },
        { enabled: false },
      ),
    ).toEqual({
      ok: true,
      path: `/admin/providers/sabre/tenants/${AGENCIA}`,
      body: { enabled: false, reason: null },
    });
  });

  it('un DELETE no lleva cuerpo', () => {
    expect(
      enablementProxyPlan(
        'DELETE',
        { scope: 'tenant', code: 'sabre', tenantId: AGENCIA },
        {
          enabled: true,
        },
      ),
    ).toEqual({ ok: true, path: `/admin/providers/sabre/tenants/${AGENCIA}` });
  });

  it('un segmento que compondría otra ruta del API se frena', () => {
    expect(enablementProxyPlan('DELETE', { scope: 'global', code: '..%2Ftenants' }, null).ok).toBe(
      false,
    );
    expect(
      enablementProxyPlan('DELETE', { scope: 'tenant', code: 'sabre', tenantId: '../global' }, null)
        .ok,
    ).toBe(false);
  });

  it('un PUT sin `enabled` booleano se frena antes de llegar al API', () => {
    expect(enablementProxyPlan('PUT', { scope: 'global', code: 'sabre' }, undefined).ok).toBe(
      false,
    );
    expect(enablementProxyPlan('PUT', { scope: 'global', code: 'sabre' }, { enabled: 1 }).ok).toBe(
      false,
    );
  });
});

describe('tenantProvidersPath', () => {
  it('sólo con un UUID', () => {
    expect(tenantProvidersPath(AGENCIA)).toBe(`/admin/providers/tenants/${AGENCIA}`);
    expect(tenantProvidersPath('mi-agencia')).toBeUndefined();
  });
});
