import { killLevel, type KillLevel } from '../search/circuit-breaker.service.js';

export const ACTIVITIES_PROVIDER = 'despegar-activities';
export const ACTIVITIES_VERTICAL = 'activities';

/**
 * Registro de capacidades del proveedor de actividades: qué sabe hacer la integración. Lo lee la web
 * para mostrar u ocultar acciones y la consola para decir qué hay. `validated: false` mientras no
 * se haya probado contra la API real (docs/despegar/03 § Revalidar).
 */
export interface ActivityProviderCapabilities {
  readonly search: boolean;
  readonly modalities: boolean;
  /** Una llamada por fecha. */
  readonly availability: boolean;
  /** Orlando por `/shopping` (7 días × modalidades). */
  readonly shopping: boolean;
  readonly book: boolean;
  /** Formas de pago implementadas. */
  readonly paymentMethods: readonly 'CURRENT_ACCOUNT'[];
  /** Cancelación de la reserva entera (Despegar no admite cancelar a un participante). */
  readonly cancel: boolean;
  readonly voucher: boolean;
  /** Si el proveedor informa un piso de venta. Despegar no lo informa para actividades. */
  readonly providerFloor: boolean;
  readonly validatedAgainstApi: boolean;
}

export const DESPEGAR_ACTIVITIES_CAPABILITIES: ActivityProviderCapabilities = {
  search: true,
  modalities: true,
  availability: true,
  shopping: true,
  book: true,
  paymentMethods: ['CURRENT_ACCOUNT'],
  cancel: true,
  voucher: true,
  providerFloor: false,
  validatedAgainstApi: false,
};

export type ActivitiesOperation = 'read' | 'sale';

export type ActivitiesGate =
  | { readonly enabled: true }
  | { readonly enabled: false; readonly reason: 'flag-off' | 'kill-switch' };

/**
 * ¿Se puede usar el proveedor para esta operación?
 *
 * - `DESPEGAR_ACTIVITIES_ENABLED=true` lo enciende. APAGADO por defecto: la clave de sandbox no
 *   tiene acceso a actividades (403) y nada sin validar se vende.
 * - El apagado de emergencia (`PROVIDERS_DISABLED` o el panel) le gana. `despegar-activities:ventas`
 *   frena búsqueda y reserva, pero deja leer y cancelar lo ya vendido.
 */
export function activitiesGate(
  op: ActivitiesOperation,
  panel: KillLevel | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ActivitiesGate {
  const level = killLevel(ACTIVITIES_PROVIDER, panel);
  if (level === 'all' || (level === 'sales' && op === 'sale')) {
    return { enabled: false, reason: 'kill-switch' };
  }
  // La post-venta de lo ya vendido sigue aunque el flag se apague.
  if (op === 'sale' && (env['DESPEGAR_ACTIVITIES_ENABLED'] ?? '').trim().toLowerCase() !== 'true') {
    return { enabled: false, reason: 'flag-off' };
  }
  return { enabled: true };
}
