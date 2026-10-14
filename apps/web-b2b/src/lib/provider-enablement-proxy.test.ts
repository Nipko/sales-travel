import { describe, expect, it } from 'vitest';
import {
  circuitResetPlan,
  enablementProxyPlan,
  killSwitchClearPlan,
  killSwitchPlan,
  tenantProvidersPath,
} from './provider-enablement-proxy';

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

describe('las palancas de un incidente', () => {
  it('apagar: la ruta del proveedor y sólo nivel, motivo y vencimiento', () => {
    expect(
      killSwitchPlan('tbo-hotels', {
        level: 'sales',
        reason: ' Cobra de más ',
        expiresInMinutes: 240,
        setBy: 'otro',
      }),
    ).toEqual({
      ok: true,
      path: '/admin/providers/tbo-hotels/kill-switch',
      body: { level: 'sales', reason: 'Cobra de más', expiresInMinutes: 240 },
    });
  });

  it('levantar y cerrar el circuito: sus rutas, con el motivo rearmado', () => {
    expect(killSwitchClearPlan('sabre', undefined)).toEqual({
      ok: true,
      path: '/admin/providers/sabre/kill-switch/clear',
      body: { reason: null },
    });
    expect(circuitResetPlan('sabre', { reason: ' Sabre volvió ', force: true })).toEqual({
      ok: true,
      path: '/admin/providers/sabre/circuit/reset',
      body: { reason: 'Sabre volvió' },
    });
  });

  it('un código que compondría otra ruta del API se frena', () => {
    const body = { level: 'all', reason: 'Responde basura', expiresInMinutes: null };
    expect(killSwitchPlan('..%2Fglobal', body).ok).toBe(false);
    expect(killSwitchClearPlan('sabre/../x', {}).ok).toBe(false);
    expect(circuitResetPlan('Sabre', { reason: 'Sabre volvió' }).ok).toBe(false);
  });

  it('un cuerpo inválido se frena antes de llegar al API, con un mensaje para la pantalla', () => {
    expect(killSwitchPlan('sabre', { level: 'all', reason: 'x' })).toEqual({
      ok: false,
      error:
        'El apagado tiene que decir si corta sólo las ventas o todo, con un motivo de 5 a 500 caracteres y su vencimiento.',
    });
    expect(killSwitchClearPlan('sabre', { reason: 'x'.repeat(501) }).ok).toBe(false);
    expect(circuitResetPlan('sabre', {}).ok).toBe(false);
  });
});
