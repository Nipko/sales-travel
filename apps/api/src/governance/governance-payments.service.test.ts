import { describe, expect, it } from 'vitest';
import {
  GovernancePaymentsService,
  PaymentMethodNotEnabledError,
} from './governance-payments.service.js';
import type { GovernanceRow } from './governance.policy.js';
import type { GovernanceStore } from './governance.store.js';

function service(bootstrapped: boolean, rows: GovernanceRow[]): GovernancePaymentsService {
  return new GovernancePaymentsService({
    snapshotFor: () => Promise.resolve({ bootstrapped, rows }),
  } as unknown as GovernanceStore);
}

const root = (provider: string, method: string, enabled: boolean): GovernanceRow => ({
  source: 'profile',
  provider,
  method,
  tenantId: 'root',
  depth: 1,
  enabled,
  profileId: 'p',
  profileName: 'Configuración vigente',
});

describe('GovernancePaymentsService', () => {
  it('antes de sembrar el gobierno no restringe nada', async () => {
    await expect(
      service(false, []).assertEnabled('t', 'latam-ndc', 'card'),
    ).resolves.toBeUndefined();
  });

  it('sembrado: una forma de pago no habilitada se rechaza con 403 y mensaje claro', async () => {
    const s = service(true, [root('latam-ndc', '', true), root('latam-ndc', 'card', true)]);
    await expect(s.assertEnabled('t', 'latam-ndc', 'card')).resolves.toBeUndefined();
    const err = await s.assertEnabled('t', 'latam-ndc', 'payment_link').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentMethodNotEnabledError);
    expect((err as Error).message).toContain('Enlace de pago LATAM');
  });

  it('con el proveedor apagado, ninguna de sus formas de pago', async () => {
    const s = service(true, [root('latam-ndc', '', false), root('latam-ndc', 'card', true)]);
    expect(await s.enabledMethods('t', 'latam-ndc')).toEqual([]);
  });

  it('lista las habilitadas con su ficha del catálogo', async () => {
    const s = service(true, [
      root('latam-ndc', '', true),
      root('latam-ndc', 'payment_link', true),
      root('latam-ndc', 'cash', true),
    ]);
    expect((await s.enabledMethods('t', 'latam-ndc')).map((m) => [m.code, m.pci])).toEqual([
      ['payment_link', 'saq-a'],
      ['cash', 'none'],
    ]);
  });

  it('un proveedor fuera del catálogo no se gobierna', async () => {
    expect(await service(true, []).isEnabled('t', 'stub-air', 'x')).toBe(true);
  });
});
