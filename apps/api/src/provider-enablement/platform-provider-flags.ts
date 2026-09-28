import type { ProviderEnablementDecision, ProviderFlagsPort } from '../providers/provider.types.js';
import { platformDecision } from './provider-enablement.policy.js';
import type { EnablementSettingsSource } from './provider-enablement.store.js';

/**
 * La habilitación de proveedores que consumen los registries de vuelos y hoteles: los ajustes del
 * superadmin (`provider_enablement`, 0048) y, sólo cuando la base no tiene ninguno para ese
 * proveedor y ese tenant, la variable de entorno LEGADO de la vertical (`legacy`).
 *
 * La variable legado sigue contando para no apagar, el día del despliegue, lo que hoy está
 * encendido por entorno (el stack de certificación, los despliegues con `*_PROVIDERS_OPT_IN`). En
 * cuanto el superadmin pone un ajuste —global o para la cadena del tenant—, el ajuste manda.
 *
 * El kill-switch (`PROVIDERS_DISABLED`) no pasa por aquí: lo aplica el breaker en cada llamada.
 */
export class PlatformProviderFlags implements ProviderFlagsPort {
  constructor(
    private readonly settings: EnablementSettingsSource,
    private readonly legacy: ProviderFlagsPort,
  ) {}

  async decisionFor(
    tenantId: string,
    providerCode: string,
  ): Promise<ProviderEnablementDecision | undefined> {
    const decision = platformDecision(await this.settings.settingsFor(tenantId), providerCode);
    return decision ?? this.legacy.decisionFor(tenantId, providerCode);
  }
}
