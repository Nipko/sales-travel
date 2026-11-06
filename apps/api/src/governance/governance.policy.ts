import {
  GOVERNANCE_CATALOG,
  governanceItems,
  isGovernedItem,
  type GovernanceItemKey,
} from '@sales-travel/domain';

/*
 * Gobierno de proveedores y formas de pago: el plegado, sin I/O (docs/platform/17-opciones-de-pago.md).
 *
 * Para un tenant y un elemento (proveedor, o proveedor + forma de pago):
 *   1. gana el nodo MÁS CERCANO de la cadena que diga algo;
 *   2. en el mismo nodo, la regla a mano le gana al perfil asignado;
 *   3. las reglas globales cuentan como del nodo plataforma (profundidad 1);
 *   4. si nadie dice nada: APAGADO (cuando el gobierno ya está sembrado).
 * Una forma de pago además exige su proveedor encendido.
 */

/** Una fila de `governance_chain` (0089). */
export interface GovernanceRow {
  readonly source: 'rule' | 'profile';
  readonly provider: string;
  /** `''` = el proveedor mismo. */
  readonly method: string;
  /** `null` = regla global. */
  readonly tenantId: string | null;
  /** `nlevel` del nodo (la plataforma es 1; las globales también). */
  readonly depth: number;
  readonly enabled: boolean;
  readonly profileId: string | null;
  readonly profileName: string | null;
}

/** De dónde sale una decisión, para mostrarlo en el panel. */
export type GovernanceOrigin =
  | { readonly kind: 'rule'; readonly tenantId: string | null }
  | {
      readonly kind: 'profile';
      readonly tenantId: string;
      readonly profileId: string;
      readonly profileName: string;
    }
  | { readonly kind: 'default' }
  | { readonly kind: 'provider-off' };

export interface GovernanceDecision {
  readonly enabled: boolean;
  readonly origin: GovernanceOrigin;
}

/** Lo que dicen las filas sobre UN elemento, o `undefined` si nadie dice nada. */
export function decide(
  rows: readonly GovernanceRow[],
  key: GovernanceItemKey,
): GovernanceDecision | undefined {
  let best: GovernanceRow | undefined;
  for (const row of rows) {
    if (row.provider !== key.provider || row.method !== key.method) continue;
    if (
      best === undefined ||
      row.depth > best.depth ||
      (row.depth === best.depth && row.source === 'rule' && best.source === 'profile')
    ) {
      best = row;
    }
  }
  if (best === undefined) return undefined;
  if (best.source === 'rule') {
    return { enabled: best.enabled, origin: { kind: 'rule', tenantId: best.tenantId } };
  }
  return {
    enabled: best.enabled,
    origin: {
      kind: 'profile',
      tenantId: best.tenantId ?? '',
      profileId: best.profileId ?? '',
      profileName: best.profileName ?? '',
    },
  };
}

/**
 * Estado efectivo de un elemento del catálogo. Sin decisión, apagado: nada se enciende solo. Una
 * forma de pago con su proveedor apagado queda apagada aunque la regla diga lo contrario.
 */
export function effective(
  rows: readonly GovernanceRow[],
  key: GovernanceItemKey,
): GovernanceDecision {
  if (key.method !== '') {
    const provider = effective(rows, { provider: key.provider, method: '' });
    const own = decide(rows, key) ?? { enabled: false, origin: { kind: 'default' } };
    if (!provider.enabled && own.enabled) {
      return { enabled: false, origin: { kind: 'provider-off' } };
    }
    return own;
  }
  return decide(rows, key) ?? { enabled: false, origin: { kind: 'default' } };
}

/** Una celda de la matriz efectiva de un tenant. */
export interface GovernanceCell extends GovernanceItemKey {
  readonly enabled: boolean;
  readonly origin: GovernanceOrigin;
}

/** La matriz efectiva de un tenant: cada proveedor del catálogo y cada una de sus formas de pago. */
export function effectiveMatrix(rows: readonly GovernanceRow[]): GovernanceCell[] {
  return governanceItems().map((key) => ({ ...key, ...effective(rows, key) }));
}

/** Formas de pago efectivas de un proveedor para el tenant. */
export function enabledPaymentMethods(rows: readonly GovernanceRow[], provider: string): string[] {
  const governed = GOVERNANCE_CATALOG.find((p) => p.code === provider);
  if (!governed) return [];
  return governed.paymentMethods
    .map((m) => m.code)
    .filter((method) => effective(rows, { provider, method }).enabled);
}

export { isGovernedItem };
