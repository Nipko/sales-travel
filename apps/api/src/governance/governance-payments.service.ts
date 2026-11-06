import { ForbiddenException, Injectable } from '@nestjs/common';
import { governedProvider, type GovernedPaymentMethod } from '@sales-travel/domain';
import { effective } from './governance.policy.js';
import { GovernanceStore } from './governance.store.js';

/**
 * La forma de pago pedida no está habilitada para el tenant. 403 con un mensaje que el vendedor
 * entiende: no es un error suyo ni del proveedor, es una decisión de la plataforma.
 */
export class PaymentMethodNotEnabledError extends ForbiddenException {
  constructor(
    readonly providerCode: string,
    readonly method: string,
  ) {
    const p = governedProvider(providerCode);
    const label = p?.paymentMethods.find((m) => m.code === method)?.label ?? method;
    super(
      `La forma de pago «${label}» no está habilitada para tu agencia en ${p?.label ?? providerCode}. Pide al administrador de la plataforma que la habilite.`,
    );
    this.name = 'PaymentMethodNotEnabledError';
  }
}

/**
 * Qué formas de pago puede usar un tenant, según el gobierno (docs/platform/17-opciones-de-pago.md).
 * Lo consultan el pago y el enlace de pago de una orden, la emisión de Sabre y las reservas de autos.
 *
 * Antes de la siembra del gobierno (una base nueva, los tests) no restringe nada, como era antes.
 * Un proveedor fuera del catálogo tampoco: el catálogo es lo que se gobierna.
 */
@Injectable()
export class GovernancePaymentsService {
  constructor(private readonly store: GovernanceStore) {}

  async isEnabled(tenantId: string, providerCode: string, method: string): Promise<boolean> {
    const provider = governedProvider(providerCode);
    if (!provider) return true;
    const snapshot = await this.store.snapshotFor(tenantId);
    if (!snapshot.bootstrapped) return true;
    return effective(snapshot.rows, { provider: providerCode, method }).enabled;
  }

  async assertEnabled(tenantId: string, providerCode: string, method: string): Promise<void> {
    if (!(await this.isEnabled(tenantId, providerCode, method))) {
      throw new PaymentMethodNotEnabledError(providerCode, method);
    }
  }

  /** Las formas de pago del proveedor habilitadas para el tenant, con su ficha del catálogo. */
  async enabledMethods(tenantId: string, providerCode: string): Promise<GovernedPaymentMethod[]> {
    const provider = governedProvider(providerCode);
    if (!provider) return [];
    const out: GovernedPaymentMethod[] = [];
    for (const m of provider.paymentMethods) {
      if (await this.isEnabled(tenantId, providerCode, m.code)) out.push(m);
    }
    return out;
  }
}
