import type { Route } from 'next';
import {
  DEFAULT_APPROVALS_FILTERS,
  carterasHref,
  defaultFinancedBy,
  sinceLabel,
} from './deposit-approvals';
import { formatMinor, isCurrencyCode, isUuid, type Tone } from './wallets';

/**
 * Agencias en números (`GET /admin/tenants/stats` y `GET /admin/tenants/:id/impact`): la lectura de
 * las respuestas, lo que muestra cada fila de la red (puestos, ventas, última reserva, depósitos por
 * aprobar) y los textos del diálogo que suspende o reactiva un nodo. Sin I/O.
 *
 * Nunca se suman montos de monedas distintas: lo retenido va por moneda.
 */

/** Lo retenido en una moneda. */
export interface HeldAmount {
  readonly currency: string;
  readonly exponent: number | null;
  readonly amountMinor: number;
}

/** Un nodo en números. */
export interface NodeStats {
  readonly tenantId: string;
  /** `null`: el nodo no fija cupo propio y comparte el de su red. */
  readonly seatLimit: number | null;
  readonly seatsUsed: number | null;
  readonly liveSessions: number;
  readonly activeUsers: number;
  /** Órdenes de 30 días en cualquier estado (fallidas y canceladas incluidas): actividad. */
  readonly orders30d: number;
  /** Ventas de 30 días: confirmadas o emitidas, como las cuenta el Resumen. */
  readonly sales30d: number;
  /** La última reserva, en cualquier estado: ISO 8601, o `null` si nunca reservó. */
  readonly lastOrderAt: string | null;
  readonly openOrders: number;
  readonly pendingDepositReports: number;
  readonly pendingInvitations: number;
  readonly held: readonly HeldAmount[];
}

/** Qué arrastraría suspender un nodo con su red (el nodo incluido). */
export interface NodeImpact {
  readonly tenant: {
    readonly id: string;
    readonly name: string;
    readonly tenantType: string;
    readonly isBranch: boolean;
    readonly status: string;
  };
  readonly descendants: number;
  readonly activeUsers: number;
  readonly liveSessions: number;
  readonly openOrders: number;
  readonly held: readonly HeldAmount[];
  readonly pendingDepositReports: number;
  readonly pendingInvitations: number;
}

// ───────────────────────────── Lectura ─────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function nullableCount(value: unknown): number | null | undefined {
  return value === null ? null : count(value);
}

/** Lo retenido por moneda; `undefined` si algún monto no se puede leer. */
export function parseHeld(value: unknown): HeldAmount[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: HeldAmount[] = [];
  for (const item of value) {
    const r = asRecord(item);
    const currency = r?.['currency'];
    const amountMinor = r?.['amountMinor'];
    const exponent = r?.['exponent'];
    if (
      !isCurrencyCode(currency) ||
      typeof amountMinor !== 'number' ||
      !Number.isSafeInteger(amountMinor)
    ) {
      return undefined;
    }
    out.push({
      currency,
      amountMinor,
      exponent:
        typeof exponent === 'number' && Number.isInteger(exponent) && exponent >= 0
          ? exponent
          : null,
    });
  }
  return out;
}

/** Un nodo en números: una fila de `stats` o el `own` de la ficha; `undefined` si no se lee. */
export function parseNodeStats(value: unknown): NodeStats | undefined {
  const r = asRecord(value);
  if (r === undefined) return undefined;
  const tenantId = r['tenantId'];
  const seatLimit = nullableCount(r['seatLimit']);
  const seatsUsed = nullableCount(r['seatsUsed']);
  const lastOrderAt = r['lastOrderAt'];
  const held = parseHeld(r['held']);
  const numbers = {
    liveSessions: count(r['liveSessions']),
    activeUsers: count(r['activeUsers']),
    orders30d: count(r['orders30d']),
    sales30d: count(r['sales30d']),
    openOrders: count(r['openOrders']),
    pendingDepositReports: count(r['pendingDepositReports']),
    pendingInvitations: count(r['pendingInvitations']),
  };
  if (!isUuid(tenantId) || seatLimit === undefined || seatsUsed === undefined) return undefined;
  if (held === undefined || (lastOrderAt !== null && typeof lastOrderAt !== 'string')) {
    return undefined;
  }
  if (Object.values(numbers).some((n) => n === undefined)) return undefined;
  return {
    tenantId: tenantId.toLowerCase(),
    seatLimit,
    seatsUsed,
    liveSessions: numbers.liveSessions ?? 0,
    activeUsers: numbers.activeUsers ?? 0,
    orders30d: numbers.orders30d ?? 0,
    sales30d: numbers.sales30d ?? 0,
    lastOrderAt,
    openOrders: numbers.openOrders ?? 0,
    pendingDepositReports: numbers.pendingDepositReports ?? 0,
    pendingInvitations: numbers.pendingInvitations ?? 0,
    held,
  };
}

/**
 * Los números de cada nodo (`{ nodes: [...] }`), por id. Una fila que no se puede leer se descarta:
 * ese nodo se muestra sin números, el resto sí. `undefined` si la forma no es la esperada.
 */
export function parseNodeStatsList(value: unknown): ReadonlyMap<string, NodeStats> | undefined {
  const list = asRecord(value)?.['nodes'];
  if (!Array.isArray(list)) return undefined;
  const byId = new Map<string, NodeStats>();
  for (const item of list) {
    const stats = parseNodeStats(item);
    if (stats !== undefined) byId.set(stats.tenantId, stats);
  }
  return byId;
}

export function parseNodeImpact(value: unknown): NodeImpact | undefined {
  const r = asRecord(value);
  const t = asRecord(r?.['tenant']);
  if (r === undefined || t === undefined) return undefined;
  const id = t['id'];
  const name = t['name'];
  const tenantType = t['tenantType'];
  const status = t['status'];
  if (!isUuid(id) || typeof name !== 'string' || typeof tenantType !== 'string') return undefined;
  if (typeof status !== 'string') return undefined;
  const held = parseHeld(r['held']);
  const numbers = {
    descendants: count(r['descendants']),
    activeUsers: count(r['activeUsers']),
    liveSessions: count(r['liveSessions']),
    openOrders: count(r['openOrders']),
    pendingDepositReports: count(r['pendingDepositReports']),
    pendingInvitations: count(r['pendingInvitations']),
  };
  if (held === undefined || Object.values(numbers).some((n) => n === undefined)) return undefined;
  return {
    tenant: { id: id.toLowerCase(), name, tenantType, isBranch: t['isBranch'] === true, status },
    descendants: numbers.descendants ?? 0,
    activeUsers: numbers.activeUsers ?? 0,
    liveSessions: numbers.liveSessions ?? 0,
    openOrders: numbers.openOrders ?? 0,
    held,
    pendingDepositReports: numbers.pendingDepositReports ?? 0,
    pendingInvitations: numbers.pendingInvitations ?? 0,
  };
}

// ───────────────────────────── La fila de la red ─────────────────────────────

/** Desde qué ocupación un cupo está al límite: la misma regla que el Resumen (90 %). */
export const SEAT_SATURATION_RATIO = 0.9;

export interface SeatsCell {
  /** "3/5". */
  readonly text: string;
  readonly tone: Extract<Tone, 'neutral' | 'warning'>;
  /** "al límite" cuando el tono es de advertencia: el color nunca va solo. */
  readonly note: string | null;
  /** Para un lector de pantalla: "3 de 5 puestos en uso". */
  readonly label: string;
}

/**
 * Los puestos del nodo contra su cupo propio. Al 90 % o más (redondeando hacia arriba, como el
 * Resumen: con 5 puestos, 5 de 5) va en ámbar y dice "al límite". `null` si el nodo no fija cupo
 * propio: comparte el de su red.
 */
export function seatsCell(stats: Pick<NodeStats, 'seatLimit' | 'seatsUsed'>): SeatsCell | null {
  const limit = stats.seatLimit;
  if (limit === null || limit <= 0) return null;
  const used = stats.seatsUsed ?? 0;
  const saturated = used >= Math.ceil(SEAT_SATURATION_RATIO * limit);
  return {
    text: `${used}/${limit}`,
    tone: saturated ? 'warning' : 'neutral',
    note: saturated ? 'al límite' : null,
    label: `${used} de ${limit} ${limit === 1 ? 'puesto' : 'puestos'} en uso${saturated ? ', al límite' : ''}`,
  };
}

/** Lo que se lee sin cupo propio. */
export const SHARED_SEATS_LABEL = 'Comparte el cupo de su red';

/**
 * La última reserva, en cualquier estado: "hace 3 días", "ayer"; sin ninguna, "Nunca". No se llama
 * "última venta" porque una reserva fallida o cancelada también cuenta.
 */
export function lastOrderLabel(lastOrderAt: string | null, now: number): string {
  if (lastOrderAt === null) return 'Nunca';
  const since = sinceLabel(lastOrderAt, now);
  return since === '' ? 'Nunca' : since;
}

/** "1 depósito por aprobar", "3 depósitos por aprobar"; nada si no hay. */
export function pendingDepositsLabel(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? '1 depósito por aprobar' : `${n} depósitos por aprobar`;
}

/** Plataforma → Carteras acotada al nodo y su red (`?nodo=`), con todo lo que espera ahí. */
export function nodeDepositsHref(tenantId: string): Route {
  const id = tenantId.toLowerCase();
  return carterasHref({
    ...DEFAULT_APPROVALS_FILTERS,
    tenantId: id,
    financedBy: defaultFinancedBy(id),
  });
}

// ───────────────────────────── Suspender y reactivar ─────────────────────────────

/** El motivo, como lo exige el API al suspender (UpdateTenantSchema). */
export const NODE_STATUS_REASON_MIN = 5;
export const NODE_STATUS_REASON_MAX = 500;
export const NODE_STATUS_REASON_LABEL = 'Motivo (queda en la auditoría)';

/** Un carácter de control que no es salto de línea ni tabulación (el motivo se escribe en un área). */
const CONTROL_CHARACTER = /(?![\n\r\t])\p{Cc}/u;

/**
 * Qué le falta al motivo, o `undefined` si sirve. Se mide recortado, como el API. Al reactivar es
 * opcional: vacío sirve.
 */
export function nodeReasonError(reason: string, required: boolean): string | undefined {
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    return required ? 'Escribe el motivo de la suspensión: queda en la auditoría.' : undefined;
  }
  if (trimmed.length < NODE_STATUS_REASON_MIN) {
    return `Escribe al menos ${NODE_STATUS_REASON_MIN} caracteres.`;
  }
  if (trimmed.length > NODE_STATUS_REASON_MAX) {
    return `El motivo puede tener hasta ${NODE_STATUS_REASON_MAX} caracteres.`;
  }
  if (CONTROL_CHARACTER.test(trimmed)) return 'El motivo tiene caracteres no válidos.';
  return undefined;
}

/** "$ 1.500 · US$ 20": cada moneda por su lado. */
export function heldLabel(held: readonly HeldAmount[]): string {
  return held.map((h) => formatMinor(h.amountMinor, h.currency, h.exponent)).join(' · ');
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export interface NodeStatusCopy {
  readonly title: string;
  /** El párrafo principal: qué se corta (o qué vuelve). */
  readonly body: string;
  /** Líneas aparte: el saldo retenido y los depósitos por aprobar, si los hay. */
  readonly details: readonly string[];
  readonly confirmLabel: string;
  readonly pendingLabel: string;
  readonly destructive: boolean;
  readonly reasonRequired: boolean;
}

/** Si no se pudo calcular el impacto, el diálogo sigue, sin números. */
export const IMPACT_UNAVAILABLE = 'No pudimos calcular el impacto.';

/**
 * Suspender `name` con lo que arrastra. Sin el impacto (cargando o falló), la misma advertencia sin
 * números: suspender no espera a que se pueda contar.
 */
export function suspendCopy(name: string, impact: NodeImpact | null): NodeStatusCopy {
  const base = {
    title: `Suspender ${name}`,
    confirmLabel: `Suspender ${name}`,
    pendingLabel: 'Suspendiendo…',
    destructive: true,
    reasonRequired: true,
  };
  if (impact === null) {
    return {
      ...base,
      body: `Se corta de inmediato el acceso a ${name} y a los nodos que cuelgan de él: sus personas dejan de poder operar y sus sesiones abiertas dejan de funcionar. Las reservas vigentes no se cancelan, pero nadie del nodo podrá gestionarlas mientras siga suspendido.`,
      details: [],
    };
  }

  const d = impact.descendants;
  const nodes =
    d === 0
      ? `el acceso a ${name}`
      : d === 1
        ? `el acceso a ${name} y al nodo que cuelga de él`
        : `el acceso a ${name} y a los ${d} nodos que cuelgan de él`;
  const u = impact.activeUsers;
  const s = impact.liveSessions;
  const people =
    u === 0
      ? 'no hay personas con acceso activo'
      : `${u} ${plural(u, 'persona deja', 'personas dejan')} de poder operar`;
  const sessions =
    s === 0 || u === 0
      ? ''
      : s === 1
        ? ' y su sesión abierta deja de funcionar'
        : ` y sus ${s} sesiones abiertas dejan de funcionar`;
  const o = impact.openOrders;
  const orders =
    o === 0
      ? 'No tiene reservas vigentes.'
      : o === 1
        ? 'La reserva vigente no se cancela, pero nadie del nodo podrá gestionarla mientras siga suspendido.'
        : `Las ${o} reservas vigentes no se cancelan, pero nadie del nodo podrá gestionarlas mientras siga suspendido.`;

  const details: string[] = [];
  if (impact.held.length > 0) details.push(`Saldo retenido: ${heldLabel(impact.held)}.`);
  if (impact.pendingDepositReports > 0) {
    details.push(`Depósitos por aprobar: ${impact.pendingDepositReports}.`);
  }
  return {
    ...base,
    body: `Se corta de inmediato ${nodes}: ${people}${sessions}. ${orders}`,
    details,
  };
}

/**
 * Reactivar `name`. Si un ancestro sigue suspendido, el nodo queda activo pero no opera: se dice
 * antes de confirmarlo.
 */
export function reactivateCopy(name: string, suspendedAncestor: string | null): NodeStatusCopy {
  return {
    title: `Reactivar ${name}`,
    body:
      suspendedAncestor === null
        ? `Vuelven a poder ingresar las personas con acceso activo a ${name} y a su red.`
        : `${name} queda activo, pero nadie de su red podrá operar mientras ${suspendedAncestor} siga suspendido.`,
    details: [],
    confirmLabel: 'Reactivar',
    pendingLabel: 'Reactivando…',
    destructive: false,
    reasonRequired: false,
  };
}

/** El aviso que confirma el cambio. */
export function statusDoneToast(name: string, next: 'active' | 'suspended'): string {
  return next === 'suspended' ? `${name} quedó suspendido.` : `${name} quedó activo.`;
}
