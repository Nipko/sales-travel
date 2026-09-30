import { describe, expect, it } from 'vitest';
import { parseTenantSwitchMessage } from './tenant-sync';

describe('parseTenantSwitchMessage', () => {
  it('acepta sólo el aviso de cambio de agencia bien formado', () => {
    expect(parseTenantSwitchMessage({ type: 'tenant-switched', tenantId: 't1', at: 1 })).toEqual({
      type: 'tenant-switched',
      tenantId: 't1',
      at: 1,
    });
  });

  it('descarta otros mensajes (el canal de sesión usa otro nombre, pero igual)', () => {
    expect(parseTenantSwitchMessage({ type: 'logout', motivo: null, at: 1 })).toBeNull();
    expect(parseTenantSwitchMessage({ type: 'tenant-switched', tenantId: 1, at: 1 })).toBeNull();
    expect(
      parseTenantSwitchMessage({ type: 'tenant-switched', tenantId: 't', at: NaN }),
    ).toBeNull();
    expect(parseTenantSwitchMessage('tenant-switched')).toBeNull();
    expect(parseTenantSwitchMessage(null)).toBeNull();
  });
});
