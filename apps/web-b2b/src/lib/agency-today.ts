import type { Route } from 'next';
import { verticalLabel } from './platform-health';
import { providerLabel } from './platform-system';
import type { ProviderStatus } from './provider-status';
import type { Tone, Wallet } from './wallets';

/**
 * Inicio → Hoy: lo que la agencia tiene que atender, de `GET /reports/operations` (plazos de emisión,
 * reservas en creación o fallidas, cotizaciones que vencen), su cartera (`GET /portfolios`) y sus
 * proveedores (`GET /search/provider-status`). La regla de cada número vive en el API; aquí se valida
 * y se arma la lista de cosas por hacer, de la más urgente a la menos.
 */

export type OperationsLevel = 'ok' | 'warn' | 'critical';

export interface DeadlineItem {
  readonly orderId: string;
  readonly orderNumber: number;
  readonly deadlineAt: string;
  readonly overdue: boolean;
}

export interface QuotationItem {
  readonly quotationId: string;
  readonly quoteNumber: number;
  readonly expiresAt: string;
}

export interface AgencyOperations {
  readonly generatedAt: string;
  readonly level: OperationsLevel;
  readonly deadlines: {
    readonly windowHours: number;
    readonly overdue: number;
    readonly within24h: number;
    readonly later: number;
    readonly items: readonly DeadlineItem[];
  };
  readonly pendingOrders: {
    readonly count: number;
    readonly stuck: number;
    readonly oldestAt: string | null;
  };
  readonly failedOrders: { readonly days: number; readonly count: number };
  readonly quotationsExpiring: {
    readonly windowHours: number;
    readonly count: number;
    readonly items: readonly QuotationItem[];
  };
}

const LEVELS: readonly OperationsLevel[] = ['ok', 'warn', 'critical'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isString = (v: unknown): v is string => typeof v === 'string';

function parseDeadline(raw: unknown): DeadlineItem | undefined {
  if (!isRecord(raw)) return undefined;
  const { orderId, orderNumber, deadlineAt, overdue } = raw;
  if (!isString(orderId) || !isCount(orderNumber) || !isString(deadlineAt)) return undefined;
  if (typeof overdue !== 'boolean') return undefined;
  return { orderId, orderNumber, deadlineAt, overdue };
}

function parseQuotation(raw: unknown): QuotationItem | undefined {
  if (!isRecord(raw)) return undefined;
  const { quotationId, quoteNumber, expiresAt } = raw;
  if (!isString(quotationId) || !isCount(quoteNumber) || !isString(expiresAt)) return undefined;
  return { quotationId, quoteNumber, expiresAt };
}

/** Valida lo que llega del API; `undefined` si algo no tiene la forma esperada. */
export function parseAgencyOperations(body: unknown): AgencyOperations | undefined {
  if (!isRecord(body)) return undefined;
  const { generatedAt, level, deadlines, pendingOrders, failedOrders, quotationsExpiring } = body;
  if (!isString(generatedAt) || !LEVELS.includes(level as OperationsLevel)) return undefined;
  if (!isRecord(deadlines) || !isRecord(pendingOrders) || !isRecord(failedOrders)) return undefined;
  if (!isRecord(quotationsExpiring)) return undefined;
  if (
    !isCount(deadlines['windowHours']) ||
    !isCount(deadlines['overdue']) ||
    !isCount(deadlines['within24h']) ||
    !isCount(deadlines['later']) ||
    !Array.isArray(deadlines['items'])
  ) {
    return undefined;
  }
  if (!isCount(pendingOrders['count']) || !isCount(pendingOrders['stuck'])) return undefined;
  const oldestAt = pendingOrders['oldestAt'];
  if (oldestAt !== null && !isString(oldestAt)) return undefined;
  if (!isCount(failedOrders['days']) || !isCount(failedOrders['count'])) return undefined;
  if (
    !isCount(quotationsExpiring['windowHours']) ||
    !isCount(quotationsExpiring['count']) ||
    !Array.isArray(quotationsExpiring['items'])
  ) {
    return undefined;
  }
  const deadlineItems = (deadlines['items'] as unknown[]).map(parseDeadline);
  const quotationItems = (quotationsExpiring['items'] as unknown[]).map(parseQuotation);
  if (deadlineItems.some((d) => d === undefined) || quotationItems.some((q) => q === undefined)) {
    return undefined;
  }
  return {
    generatedAt,
    level: level as OperationsLevel,
    deadlines: {
      windowHours: deadlines['windowHours'],
      overdue: deadlines['overdue'],
      within24h: deadlines['within24h'],
      later: deadlines['later'],
      items: deadlineItems as DeadlineItem[],
    },
    pendingOrders: { count: pendingOrders['count'], stuck: pendingOrders['stuck'], oldestAt },
    failedOrders: { days: failedOrders['days'], count: failedOrders['count'] },
    quotationsExpiring: {
      windowHours: quotationsExpiring['windowHours'],
      count: quotationsExpiring['count'],
      items: quotationItems as QuotationItem[],
    },
  };
}

/** Una cosa por atender en el bloque Hoy. */
export interface TodayItem {
  readonly id: string;
  readonly tone: Tone;
  readonly title: string;
  readonly detail: string;
  /** Adónde ir a resolverlo; `null` si no hay nada que hacer desde la agencia. */
  readonly href: Route | null;
  readonly cta: string;
}

const HOUR_MS = 3_600_000;

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** «en 3 h», «en 2 días», «hace 1 h». */
export function relativeLabel(iso: string, now: number): string {
  const diff = Date.parse(iso) - now;
  if (Number.isNaN(diff)) return '';
  const hours = Math.round(Math.abs(diff) / HOUR_MS);
  const text =
    hours < 1
      ? 'menos de 1 h'
      : hours < 48
        ? `${String(hours)} h`
        : `${String(Math.round(hours / 24))} días`;
  return diff >= 0 ? `en ${text}` : `hace ${text}`;
}

/** Una cartera que ya no deja reservar, o a la que le queda menos de esta fracción del cupo. */
export const WALLET_LOW_RATIO = 0.1;

/**
 * La lista de Hoy, de lo más urgente a lo menos: plazos vencidos o de 24 h, reservas trabadas, una
 * cartera que no deja reservar, un proveedor que falla, y después lo que puede esperar unas horas.
 * Vacía si no hay nada que hacer.
 */
export function todayItems(
  ops: AgencyOperations | undefined,
  wallets: readonly Wallet[],
  providers: readonly ProviderStatus[],
  now: number,
): TodayItem[] {
  const urgent: TodayItem[] = [];
  const soon: TodayItem[] = [];

  if (ops !== undefined) {
    const { deadlines, pendingOrders, failedOrders, quotationsExpiring } = ops;
    const next = deadlines.items[0];
    if (deadlines.overdue > 0) {
      urgent.push({
        id: 'deadline-overdue',
        tone: 'danger',
        title: `${plural(deadlines.overdue, 'reserva con el plazo de emisión vencido', 'reservas con el plazo de emisión vencido')}`,
        detail:
          'La aerolínea puede haberla cancelado. Revisa si sigue viva y emite o cancela para liberar la cartera.',
        href:
          next?.overdue === true ? `/reservas/${encodeURIComponent(next.orderId)}` : '/reservas',
        cta:
          next?.overdue === true ? `Abrir la reserva #${String(next.orderNumber)}` : 'Ver reservas',
      });
    }
    if (deadlines.within24h > 0) {
      const first = deadlines.items.find((d) => !d.overdue);
      urgent.push({
        id: 'deadline-24h',
        tone: 'danger',
        title: `${plural(deadlines.within24h, 'reserva vence', 'reservas vencen')} en menos de 24 h sin emitir`,
        detail:
          first === undefined
            ? 'Emite antes del plazo o la aerolínea cancela la reserva.'
            : `La primera es la #${String(first.orderNumber)}, que vence ${relativeLabel(first.deadlineAt, now)}. Emite antes del plazo o la aerolínea cancela la reserva.`,
        href: first === undefined ? '/reservas' : `/reservas/${encodeURIComponent(first.orderId)}`,
        cta:
          first === undefined ? 'Ver reservas' : `Abrir la reserva #${String(first.orderNumber)}`,
      });
    }
    if (pendingOrders.stuck > 0) {
      urgent.push({
        id: 'pending-stuck',
        tone: 'danger',
        title: `${plural(pendingOrders.stuck, 'reserva lleva', 'reservas llevan')} más de 30 minutos en creación`,
        detail:
          'No sabemos si el proveedor la confirmó. Ábrela para ver su estado antes de volver a reservar.',
        href: '/reservas',
        cta: 'Ver reservas',
      });
    }
    if (deadlines.later > 0) {
      soon.push({
        id: 'deadline-later',
        tone: 'warning',
        title: `${plural(deadlines.later, 'reserva vence', 'reservas vencen')} en los próximos ${String(Math.round(deadlines.windowHours / 24))} días sin emitir`,
        detail: 'Todavía hay tiempo, pero no lo dejes para el último día.',
        href: '/reservas',
        cta: 'Ver reservas',
      });
    }
    if (quotationsExpiring.count > 0) {
      const first = quotationsExpiring.items[0];
      soon.push({
        id: 'quotations',
        tone: 'warning',
        title: `${plural(quotationsExpiring.count, 'cotización vence', 'cotizaciones vencen')} en las próximas ${String(quotationsExpiring.windowHours)} h`,
        detail:
          first === undefined
            ? 'Escríbele al cliente antes de que la tarifa cambie.'
            : `La primera es la #${String(first.quoteNumber)}, que vence ${relativeLabel(first.expiresAt, now)}. Escríbele al cliente antes de que la tarifa cambie.`,
        href: '/cotizaciones/guardadas',
        cta: 'Ver cotizaciones',
      });
    }
    if (failedOrders.count > 0) {
      soon.push({
        id: 'failed',
        tone: 'neutral',
        title: `${plural(failedOrders.count, 'reserva falló', 'reservas fallaron')} en los últimos ${String(failedOrders.days)} días`,
        detail: 'Si el cliente sigue interesado, búscale otra opción.',
        href: '/reservas',
        cta: 'Ver reservas',
      });
    }
  }

  for (const w of wallets) {
    const blocked = w.status !== 'active' || w.availableMinor <= 0;
    const low =
      !blocked &&
      w.creditLimitMinor > 0 &&
      w.availableMinor < w.creditLimitMinor * WALLET_LOW_RATIO;
    if (!blocked && !low) continue;
    (blocked ? urgent : soon).push({
      id: `wallet-${w.currency}`,
      tone: blocked ? 'danger' : 'warning',
      title: blocked
        ? `La cartera en ${w.currency} no deja reservar`
        : `A la cartera en ${w.currency} le queda menos del 10 % del cupo`,
      detail: blocked
        ? 'Informa un depósito o pide más cupo a quien te financia.'
        : 'Informa un depósito antes de que una reserva no pueda retener.',
      href: '/carteras',
      cta: 'Abrir Cartera B2B',
    });
  }

  for (const p of providers) {
    if (p.status !== 'provider' && p.status !== 'internal' && p.status !== 'paused') continue;
    (p.status === 'paused' ? soon : urgent).push({
      id: `provider-${p.providerCode}-${p.vertical}`,
      tone: p.status === 'paused' ? 'warning' : 'danger',
      title: `${providerLabel(p.providerCode)} · ${verticalLabel(p.vertical)}: ${
        p.status === 'internal'
          ? 'falla nuestra'
          : p.status === 'paused'
            ? 'en pausa'
            : 'falla del proveedor'
      }`,
      detail: p.message || 'Las búsquedas con este proveedor pueden venir vacías.',
      href: null,
      cta: '',
    });
  }

  return [...urgent, ...soon];
}
