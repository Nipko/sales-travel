import { describe, expect, it } from 'vitest';
import type { CallPolicy } from '../providers/provider.types.js';
import type { KillLevel } from '../search/circuit-breaker.service.js';
import {
  effectiveEnablement,
  platformDecision,
  resolveEnablement,
  type EffectiveEnablement,
  type EnablementSetting,
} from './provider-enablement.policy.js';

/*
 * La regla del founder, en datos: el superadmin enciende o apaga un proveedor para todos o para un
 * tenant, y puede apagarlo para uno puntual. El árbol es consolidador (1) → agencia (2) →
 * sub-agencia (3); se resuelve siempre para la sub-agencia.
 */

const CONSOLIDADOR = '10000000-0000-4000-8000-000000000001';
const AGENCIA = '10000000-0000-4000-8000-000000000002';
const SUB = '10000000-0000-4000-8000-000000000003';
const P = 'alfa-hotels';

function tenant(tenantId: string, depth: number, enabled: boolean): EnablementSetting {
  return { providerCode: P, tenantId, depth, enabled };
}

function global(enabled: boolean): EnablementSetting {
  return { providerCode: P, tenantId: null, depth: 0, enabled };
}

interface Caso {
  readonly caso: string;
  readonly killSwitch?: KillLevel;
  readonly settings?: readonly EnablementSetting[];
  readonly legacy?: boolean;
  readonly policy: CallPolicy;
  readonly esperado: EffectiveEnablement;
}

const TABLA: readonly Caso[] = [
  // 5. Nadie decidió: la política del proveedor.
  {
    caso: 'default `always`: encendido',
    policy: 'always',
    esperado: { enabled: true, origin: 'default' },
  },
  {
    caso: 'default `fallback`: encendido (se llama cuando hace falta)',
    policy: 'fallback',
    esperado: { enabled: true, origin: 'default' },
  },
  {
    caso: 'default `opt-in`: apagado',
    policy: 'opt-in',
    esperado: { enabled: false, origin: 'default' },
  },
  // 4. Variable legado: sólo enciende, y sólo sin ajustes en la base.
  {
    caso: 'legado enciende un `opt-in` sin ajustes',
    legacy: true,
    policy: 'opt-in',
    esperado: { enabled: true, origin: 'legacy-env' },
  },
  {
    caso: 'el global apagado le gana al legado',
    legacy: true,
    settings: [global(false)],
    policy: 'opt-in',
    esperado: { enabled: false, origin: 'global' },
  },
  {
    caso: 'un ajuste de la cadena le gana al legado',
    legacy: true,
    settings: [tenant(AGENCIA, 2, false)],
    policy: 'opt-in',
    esperado: { enabled: false, origin: 'tenant', originTenantId: AGENCIA },
  },
  // 3. Global.
  {
    caso: 'global encendido enciende un `opt-in`',
    settings: [global(true)],
    policy: 'opt-in',
    esperado: { enabled: true, origin: 'global' },
  },
  {
    caso: 'global apagado apaga un `always`',
    settings: [global(false)],
    policy: 'always',
    esperado: { enabled: false, origin: 'global' },
  },
  // 2. Override de tenant: propio, de ancestro, el más cercano gana.
  {
    caso: 'override propio encendido sobre global apagado',
    settings: [global(false), tenant(SUB, 3, true)],
    policy: 'always',
    esperado: { enabled: true, origin: 'tenant', originTenantId: SUB },
  },
  {
    caso: 'override propio apagado sobre global encendido',
    settings: [global(true), tenant(SUB, 3, false)],
    policy: 'opt-in',
    esperado: { enabled: false, origin: 'tenant', originTenantId: SUB },
  },
  {
    caso: 'override del consolidador cubre a su red (ancestro)',
    settings: [tenant(CONSOLIDADOR, 1, true)],
    policy: 'opt-in',
    esperado: { enabled: true, origin: 'tenant', originTenantId: CONSOLIDADOR },
  },
  {
    caso: 'el más cercano gana: consolidador encendido, agencia apagada',
    settings: [tenant(CONSOLIDADOR, 1, true), tenant(AGENCIA, 2, false)],
    policy: 'opt-in',
    esperado: { enabled: false, origin: 'tenant', originTenantId: AGENCIA },
  },
  {
    caso: 'el más cercano gana: agencia apagada, la sub-agencia vuelve a encender',
    settings: [tenant(CONSOLIDADOR, 1, true), tenant(AGENCIA, 2, false), tenant(SUB, 3, true)],
    policy: 'opt-in',
    esperado: { enabled: true, origin: 'tenant', originTenantId: SUB },
  },
  {
    caso: 'el orden de las filas no importa: gana la profundidad',
    settings: [tenant(SUB, 3, false), tenant(CONSOLIDADOR, 1, true), global(true)],
    policy: 'always',
    esperado: { enabled: false, origin: 'tenant', originTenantId: SUB },
  },
  // 1. Kill-switch: le gana a todo.
  {
    caso: 'kill-switch le gana a un override propio encendido',
    killSwitch: 'all',
    settings: [tenant(SUB, 3, true), global(true)],
    policy: 'always',
    esperado: { enabled: false, origin: 'kill-switch', killSwitch: 'all' },
  },
  {
    caso: 'kill-switch de ventas también apaga la venta (la post-venta la deja el breaker)',
    killSwitch: 'sales',
    legacy: true,
    policy: 'opt-in',
    esperado: { enabled: false, origin: 'kill-switch', killSwitch: 'sales' },
  },
];

describe('resolveEnablement: tabla de verdad', () => {
  it.each(TABLA)('$caso', ({ killSwitch, settings = [], legacy = false, policy, esperado }) => {
    expect(
      resolveEnablement({
        providerCode: P,
        settings,
        legacyEnabled: legacy,
        callPolicy: policy,
        killSwitch,
      }),
    ).toEqual(esperado);
  });
});

describe('platformDecision', () => {
  it('sólo mira las filas de SU proveedor', () => {
    const otro: EnablementSetting = {
      providerCode: 'beta-hotels',
      tenantId: SUB,
      depth: 3,
      enabled: false,
    };
    expect(platformDecision([otro, global(true)], P)).toEqual({ enabled: true, origin: 'global' });
    expect(platformDecision([otro], P)).toBeUndefined();
  });

  it('sin filas, no opina: decide el legado o la política', () => {
    expect(platformDecision([], P)).toBeUndefined();
  });
});

describe('effectiveEnablement', () => {
  it('no inventa un tenant de origen para lo que no es un override', () => {
    expect(
      effectiveEnablement({
        killSwitch: undefined,
        decision: { enabled: true, origin: 'legacy-env' },
        callPolicy: 'opt-in',
      }),
    ).toEqual({ enabled: true, origin: 'legacy-env' });
  });
});
