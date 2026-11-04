import { describe, expect, it } from 'vitest';
import type { ProviderFlagsPort } from '../providers/provider.types.js';
import { GovernedProviderFlags } from './governed-provider-flags.js';
import {
  effective,
  effectiveMatrix,
  enabledPaymentMethods,
  type GovernanceRow,
} from './governance.policy.js';
import type { GovernanceSource } from './governance.store.js';

const ROOT = 'root';
const CONSOLIDADOR = 'cons';
const AGENCIA = 'agen';

function profile(
  tenantId: string,
  depth: number,
  provider: string,
  method: string,
  enabled: boolean,
  name = 'Perfil',
): GovernanceRow {
  return {
    source: 'profile',
    provider,
    method,
    tenantId,
    depth,
    enabled,
    profileId: `p-${name}`,
    profileName: name,
  };
}

function rule(
  tenantId: string | null,
  depth: number,
  provider: string,
  method: string,
  enabled: boolean,
): GovernanceRow {
  return {
    source: 'rule',
    provider,
    method,
    tenantId,
    depth,
    enabled,
    profileId: null,
    profileName: null,
  };
}

describe('gobierno: plegado', () => {
  it('sin nada que decida, apagado: nada se enciende solo', () => {
    expect(effective([], { provider: 'latam-ndc', method: '' })).toEqual({
      enabled: false,
      origin: { kind: 'default' },
    });
  });

  it('el nodo más cercano gana: la agencia hereda del consolidador y puede tener su excepción', () => {
    const rows = [
      profile(ROOT, 1, 'sabre', '', false, 'Global'),
      profile(CONSOLIDADOR, 2, 'sabre', '', true, 'Consolidador'),
    ];
    expect(effective(rows, { provider: 'sabre', method: '' })).toMatchObject({
      enabled: true,
      origin: { kind: 'profile', tenantId: CONSOLIDADOR, profileName: 'Consolidador' },
    });
    const conExcepcion = [...rows, rule(AGENCIA, 3, 'sabre', '', false)];
    expect(effective(conExcepcion, { provider: 'sabre', method: '' })).toMatchObject({
      enabled: false,
      origin: { kind: 'rule', tenantId: AGENCIA },
    });
  });

  it('en el mismo nodo, la regla a mano le gana al perfil; la global cuenta como de la plataforma', () => {
    const rows = [profile(ROOT, 1, 'latam-ndc', '', true), rule(null, 1, 'latam-ndc', '', false)];
    expect(effective(rows, { provider: 'latam-ndc', method: '' })).toMatchObject({
      enabled: false,
      origin: { kind: 'rule', tenantId: null },
    });
  });

  it('una forma de pago exige su proveedor encendido', () => {
    const rows = [
      profile(ROOT, 1, 'latam-ndc', '', false),
      profile(ROOT, 1, 'latam-ndc', 'payment_link', true),
    ];
    expect(effective(rows, { provider: 'latam-ndc', method: 'payment_link' })).toEqual({
      enabled: false,
      origin: { kind: 'provider-off' },
    });
    const conProveedor = [...rows, rule(AGENCIA, 3, 'latam-ndc', '', true)];
    expect(enabledPaymentMethods(conProveedor, 'latam-ndc')).toEqual(['payment_link']);
  });

  it('la matriz trae cada proveedor del catálogo y cada forma de pago', () => {
    const matrix = effectiveMatrix([]);
    expect(matrix.some((c) => c.provider === 'latam-ndc' && c.method === 'payment_link')).toBe(
      true,
    );
    expect(matrix.some((c) => c.provider === 'tbo-hotels' && c.method === '')).toBe(true);
    expect(matrix.every((c) => !c.enabled)).toBe(true);
  });
});

describe('GovernedProviderFlags', () => {
  const inner: ProviderFlagsPort = {
    decisionFor: () => Promise.resolve({ enabled: true, origin: 'legacy-env' }),
  };
  const source = (bootstrapped: boolean, rows: GovernanceRow[]): GovernanceSource => ({
    snapshotFor: () => Promise.resolve({ bootstrapped, rows }),
  });

  it('sembrado: decide siempre para el catálogo, y apaga lo que nadie encendió', async () => {
    const flags = new GovernedProviderFlags(source(true, []), inner);
    expect(await flags.decisionFor(AGENCIA, 'latam-ndc')).toEqual({
      enabled: false,
      origin: 'global',
    });
  });

  it('sembrado: un perfil de un ancestro enciende para la agencia', async () => {
    const flags = new GovernedProviderFlags(
      source(true, [profile(CONSOLIDADOR, 2, 'latam-ndc', '', true)]),
      inner,
    );
    expect(await flags.decisionFor(AGENCIA, 'latam-ndc')).toEqual({
      enabled: true,
      origin: 'tenant',
      tenantId: CONSOLIDADOR,
    });
  });

  it('sin sembrar, o fuera del catálogo, decide el decisor de siempre', async () => {
    expect(
      await new GovernedProviderFlags(source(false, []), inner).decisionFor(AGENCIA, 'latam-ndc'),
    ).toEqual({ enabled: true, origin: 'legacy-env' });
    expect(
      await new GovernedProviderFlags(source(true, []), inner).decisionFor(AGENCIA, 'stub-air'),
    ).toEqual({ enabled: true, origin: 'legacy-env' });
  });
});
