import { vi, type Mock } from 'vitest';
import type { ProviderEnablementDecision, ProviderFlagsPort } from '../provider.types.js';

/** Encendido como lo encendía la variable legado: lo que antes era `isEnabledForTenant → true`. */
export const ENCENDIDO: ProviderEnablementDecision = { enabled: true, origin: 'legacy-env' };

/** Apagado por el superadmin para todos. */
export const APAGADO_GLOBAL: ProviderEnablementDecision = { enabled: false, origin: 'global' };

/** Apagado por el superadmin para un tenant (o un ancestro suyo). */
export function apagadoPara(tenantId: string): ProviderEnablementDecision {
  return { enabled: false, origin: 'tenant', tenantId };
}

type Decide = (tenantId: string, code: string) => boolean | ProviderEnablementDecision | undefined;

export interface FakeProviderFlags extends ProviderFlagsPort {
  readonly decisionFor: Mock<
    (tenantId: string, code: string) => Promise<ProviderEnablementDecision | undefined>
  >;
}

/**
 * Habilitación para los tests.
 *
 * - `false` (o `undefined` desde la función): nadie decidió y manda la política del proveedor. Es
 *   lo que antes era `isEnabledForTenant → false`: un `opt-in` apagado, el resto encendido.
 * - `true`: {@link ENCENDIDO}.
 * - una decisión: tal cual, para probar el apagado de la plataforma.
 */
export function providerFlags(decide: boolean | Decide = false): FakeProviderFlags {
  const decisionFor = vi.fn((tenantId: string, code: string) => {
    const d = typeof decide === 'function' ? decide(tenantId, code) : decide;
    return Promise.resolve(d === true ? ENCENDIDO : d === false ? undefined : d);
  });
  return { decisionFor };
}
