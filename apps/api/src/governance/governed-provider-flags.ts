import { governedProvider } from '@sales-travel/domain';
import type { ProviderEnablementDecision, ProviderFlagsPort } from '../providers/provider.types.js';
import { effective, type GovernanceDecision } from './governance.policy.js';
import type { GovernanceSource } from './governance.store.js';

/**
 * La habilitación de proveedores que leen los registries de vuelos y hoteles, ya con el gobierno
 * (docs/platform/17-opciones-de-pago.md).
 *
 * Para un proveedor del catálogo, una vez sembrado el gobierno, decide SIEMPRE: reglas a mano y
 * perfiles por la cadena del tenant, y apagado si nadie dice nada. Se acaba el «encendido por
 * defecto» de `callPolicy: 'always'`.
 *
 * Antes de la siembra (una base nueva, los tests) y para códigos que no están en el catálogo, decide
 * como antes el decisor de siempre (`inner`: ajustes de 0048, variable legado, política).
 */
export class GovernedProviderFlags implements ProviderFlagsPort {
  constructor(
    private readonly governance: GovernanceSource,
    private readonly inner: ProviderFlagsPort,
  ) {}

  async decisionFor(
    tenantId: string,
    providerCode: string,
  ): Promise<ProviderEnablementDecision | undefined> {
    if (governedProvider(providerCode) === undefined) {
      return this.inner.decisionFor(tenantId, providerCode);
    }
    const snapshot = await this.governance.snapshotFor(tenantId);
    if (!snapshot.bootstrapped) return this.inner.decisionFor(tenantId, providerCode);
    return toEnablement(effective(snapshot.rows, { provider: providerCode, method: '' }));
  }
}

function toEnablement(decision: GovernanceDecision): ProviderEnablementDecision {
  const o = decision.origin;
  if ((o.kind === 'rule' || o.kind === 'profile') && o.tenantId) {
    return { enabled: decision.enabled, origin: 'tenant', tenantId: o.tenantId };
  }
  // Regla global, o nadie dijo nada (apagado por gobierno): para los registries es una decisión de
  // la plataforma.
  return { enabled: decision.enabled, origin: 'global' };
}
