import {
  isProviderEnabled,
  type CallPolicy,
  type ProviderEnablementDecision,
  type ProviderEnablementOrigin,
} from '../providers/provider.types.js';
import type { KillLevel } from '../search/circuit-breaker.service.js';

/*
 * Qué proveedores puede usar un tenant: el plegado de los ajustes del superadmin (0048), sin I/O.
 *
 * Vive aparte del almacén y del servicio para que la regla —kill-switch, luego el ajuste más
 * cercano en el árbol, luego el global, luego la variable legado, luego la política del proveedor—
 * se pruebe con datos, igual que la divulgación de proveedor (provider-disclosure.policy.ts).
 */

/** Una fila de `provider_enablement_chain` (0048). */
export interface EnablementSetting {
  readonly providerCode: string;
  /** `null` = ajuste global. */
  readonly tenantId: string | null;
  /** `nlevel` del tenant del ajuste (la raíz es 1); 0 en el global. */
  readonly depth: number;
  readonly enabled: boolean;
}

/**
 * Lo que dicen los ajustes de la BASE sobre un proveedor para el tenant de la cadena: el de tenant
 * más profundo (el más cercano al tenant) y, sin ninguno, el global. `undefined` = la base no
 * opina, y decide la variable legado o la política.
 */
export function platformDecision(
  settings: readonly EnablementSetting[],
  providerCode: string,
): ProviderEnablementDecision | undefined {
  let nearest:
    | { readonly tenantId: string; readonly depth: number; readonly enabled: boolean }
    | undefined;
  let global: EnablementSetting | undefined;
  for (const s of settings) {
    if (s.providerCode !== providerCode) continue;
    if (s.tenantId === null) global = s;
    else if (nearest === undefined || s.depth > nearest.depth) {
      nearest = { tenantId: s.tenantId, depth: s.depth, enabled: s.enabled };
    }
  }
  if (nearest !== undefined) {
    return { enabled: nearest.enabled, origin: 'tenant', tenantId: nearest.tenantId };
  }
  if (global !== undefined) return { enabled: global.enabled, origin: 'global' };
  return undefined;
}

/**
 * De dónde sale el estado efectivo. `kill-switch` y `default` se suman a los orígenes de la
 * decisión: el primero porque le gana a todo, el segundo porque es lo que queda sin decisión.
 */
export type EffectiveEnablementOrigin = 'kill-switch' | ProviderEnablementOrigin | 'default';

export interface EffectiveEnablement {
  /** ¿Puede este tenant buscar y vender con el proveedor? */
  readonly enabled: boolean;
  readonly origin: EffectiveEnablementOrigin;
  /** Sólo en `origin: 'tenant'`: el tenant cuyo ajuste decidió (el propio o un ancestro). */
  readonly originTenantId?: string;
  /**
   * Sólo en `origin: 'kill-switch'`. `sales` (`código:ventas`) corta las ventas y deja la
   * post-venta; `all` corta todo.
   */
  readonly killSwitch?: KillLevel;
}

/**
 * El estado efectivo de un proveedor para un tenant, en el orden del diseño:
 *
 * 1. `PROVIDERS_DISABLED` (kill-switch de operaciones): le gana a todo. Lo sigue aplicando el
 *    breaker en cada llamada; aquí sólo se informa.
 * 2-4. La decisión de la plataforma: el ajuste más cercano en el árbol, el global o la variable
 *    legado (ver {@link platformDecision} y `PlatformProviderFlags`).
 * 5. Sin decisión, la política del proveedor: `opt-in` apagado, `always`/`fallback` encendido.
 */
export function effectiveEnablement(input: {
  readonly killSwitch: KillLevel | undefined;
  readonly decision: ProviderEnablementDecision | undefined;
  readonly callPolicy: CallPolicy;
}): EffectiveEnablement {
  const { killSwitch, decision, callPolicy } = input;
  if (killSwitch !== undefined) return { enabled: false, origin: 'kill-switch', killSwitch };
  if (decision === undefined) {
    return { enabled: isProviderEnabled(undefined, callPolicy), origin: 'default' };
  }
  return {
    enabled: decision.enabled,
    origin: decision.origin,
    ...(decision.origin === 'tenant' && decision.tenantId !== undefined
      ? { originTenantId: decision.tenantId }
      : {}),
  };
}

/**
 * La regla entera en una llamada: los ajustes de la cadena, la variable legado y la política. Es
 * lo que componen, por partes, `PlatformProviderFlags` (2-4) y el panel (1 y 5).
 */
export function resolveEnablement(input: {
  readonly providerCode: string;
  readonly settings: readonly EnablementSetting[];
  readonly legacyEnabled: boolean;
  readonly callPolicy: CallPolicy;
  readonly killSwitch: KillLevel | undefined;
}): EffectiveEnablement {
  const decision =
    platformDecision(input.settings, input.providerCode) ??
    (input.legacyEnabled ? { enabled: true, origin: 'legacy-env' as const } : undefined);
  return effectiveEnablement({
    killSwitch: input.killSwitch,
    decision,
    callPolicy: input.callPolicy,
  });
}
