import { billingDraftFromQuotation } from '../../../lib/billing';
import { describeTicketingDeadline } from '../../../lib/ticketing-deadline';
import { parseFlightTracking, orderTicketingDeadline } from './flight-order-view';
import { canIssueTicket } from './issue-ticket-view';
import type { Order } from './order-model';
import { supportsOrderCancellation, supportsOrderCapability } from './order-capabilities';
import { pendingOrderReconciliationMessage } from './pending-order-reconciliation';
import { canManageServices } from './services-view';
import { canEditTravelers } from './travelers-view';

/*
 * El detalle de una reserva de vuelo (`/reservas/[id]`) sin React: en qué estado está y cómo se
 * dice, cuál es el código que el vendedor le da al pasajero, cuánto falta para el plazo y qué
 * acciones se ofrecen —la principal a la vista, el resto en un menú—. Las reglas de cada acción
 * son las mismas de la lista de Reservas: se reusan, no se copian.
 */

export type HeroKind =
  | 'reconciliation'
  | 'cancelled'
  | 'failed'
  | 'ticketed'
  | 'awaiting-payment'
  | 'awaiting-issue'
  | 'confirmed'
  | 'pending';

export type HeroTone = 'success' | 'warning' | 'danger' | 'info';

export interface ReservationHero {
  readonly kind: HeroKind;
  readonly label: string;
  readonly tone: HeroTone;
  readonly description: string;
}

type HeroOrder = Pick<
  Order,
  'status' | 'pnr' | 'errorMessage' | 'capabilities' | 'flightTracking' | 'selectedOffer'
>;

/** El estado de la reserva como titular: lo primero que se lee al abrirla. */
export function reservationHero(order: HeroOrder, now: Date = new Date()): ReservationHero {
  const reconciliation = pendingOrderReconciliationMessage(order);
  if (reconciliation !== null) {
    return {
      kind: 'reconciliation',
      label: 'Pendiente de conciliación',
      tone: 'warning',
      description: `${reconciliation} No vuelvas a reservar hasta conciliarla.`,
    };
  }
  switch (order.status) {
    case 'cancelled':
      return {
        kind: 'cancelled',
        label: 'Cancelada',
        tone: 'danger',
        description: 'La reserva está cancelada. Ya no se puede pagar ni emitir.',
      };
    case 'failed':
      return {
        kind: 'failed',
        label: 'Fallida',
        tone: 'danger',
        description: order.errorMessage?.trim() || 'El proveedor no creó la reserva.',
      };
    case 'ticketed':
      return {
        kind: 'ticketed',
        label: 'Emitida',
        tone: 'success',
        description: 'Los tiquetes están emitidos. El pasajero ya puede volar.',
      };
    case 'confirmed': {
      const deadline = orderTicketingDeadline(order);
      const when =
        deadline === null
          ? undefined
          : describeTicketingDeadline(deadline.deadline, now, {
              fromOrder: deadline.fromOrder,
              clock: deadline.clock,
            });
      if (supportsOrderCapability(order.capabilities, 'pay')) {
        return {
          kind: 'awaiting-payment',
          label: 'Pendiente de pago',
          tone: 'warning',
          description: when ?? 'Confirmada con la aerolínea. Falta pagarla para emitir.',
        };
      }
      if (canIssueTicket({ ...order, totalAmount: 0, currency: '' })) {
        return {
          kind: 'awaiting-issue',
          label: 'Pendiente de emisión',
          tone: 'warning',
          description: when ?? 'Confirmada con la aerolínea. Falta emitir los tiquetes.',
        };
      }
      return {
        kind: 'confirmed',
        label: 'Confirmada',
        tone: 'info',
        description: when ?? 'Confirmada con la aerolínea.',
      };
    }
    default:
      return {
        kind: 'pending',
        label: 'Pendiente',
        tone: 'warning',
        description: 'El proveedor todavía no confirmó la reserva. Consulta su estado más tarde.',
      };
  }
}

/**
 * La cuenta regresiva del plazo, cuando hay un instante. Con la hora de la oficina sin zona no se
 * puede calcular cuánto falta: `null`, y se muestra el plazo escrito.
 */
export function deadlineCountdown(
  order: Pick<Order, 'status' | 'flightTracking' | 'selectedOffer'>,
  now: Date = new Date(),
): { readonly text: string; readonly expired: boolean; readonly urgent: boolean } | null {
  if (order.status !== 'confirmed') return null;
  const deadline = orderTicketingDeadline(order);
  if (deadline === null || deadline.deadline.kind !== 'instant') return null;
  const left = Date.parse(deadline.deadline.at) - now.getTime();
  if (!Number.isFinite(left)) return null;
  if (left <= 0) return { text: 'Plazo vencido', expired: true, urgent: true };
  const minutes = Math.floor(left / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const text =
    days > 0
      ? `Quedan ${days} d ${hours} h`
      : hours > 0
        ? `Quedan ${hours} h ${mins} min`
        : `Quedan ${Math.max(1, mins)} min`;
  return { text, expired: false, urgent: left < 24 * 60 * 60_000 };
}

export interface ReservationLocator {
  readonly code: string;
  readonly label: string;
  /** El otro código, si lo hay: el del proveedor cuando arriba va el de la aerolínea. */
  readonly secondary?: { readonly code: string; readonly label: string };
  /** Más localizadores de aerolínea (itinerario con varias). */
  readonly others: readonly { readonly code: string; readonly label: string }[];
}

/**
 * El código que se le da al pasajero: el localizador de la aerolínea si ya se conoce (con él hace
 * el check-in), si no el de la reserva en el proveedor. `null` si todavía no hay ninguno.
 */
export function reservationLocator(
  order: Pick<Order, 'pnr' | 'flightTracking'>,
): ReservationLocator | null {
  const locators = parseFlightTracking(order.flightTracking)?.airlineLocators ?? [];
  const pnr = order.pnr?.trim() || undefined;
  const [first, ...rest] = locators;
  if (first) {
    return {
      code: first.locator,
      label: `Localizador de la aerolínea (${first.carrierCode})`,
      ...(pnr && pnr !== first.locator
        ? { secondary: { code: pnr, label: 'Reserva en el proveedor' } }
        : {}),
      others: rest.map((l) => ({ code: l.locator, label: `Aerolínea ${l.carrierCode}` })),
    };
  }
  if (pnr) return { code: pnr, label: 'Código de reserva', others: [] };
  return null;
}

export type ReservationAction =
  | 'pay'
  | 'issue'
  | 'retrieve'
  | 'services'
  | 'travelers'
  | 'resend'
  | 'cancel';

export const ACTION_LABELS: Readonly<Record<ReservationAction, string>> = {
  pay: 'Pagar',
  issue: 'Emitir tiquete',
  retrieve: 'Consultar estado',
  services: 'Servicios adicionales',
  travelers: 'Editar pasajeros',
  resend: 'Reenviar confirmación',
  cancel: 'Cancelar reserva',
};

export interface ActionContext {
  /** Hay una emisión de esta reserva siguiéndose en la página. */
  readonly issueInFlight: boolean;
  /**
   * El historial no deja cancelar: todavía carga, no se pudo leer o hay una cancelación anterior
   * sin resolver. Sin historial no se sabe, y se falla cerrado.
   */
  readonly cancelBlocked: boolean;
}

type ActionOrder = Pick<
  Order,
  'status' | 'pnr' | 'capabilities' | 'contactInfo' | 'totalAmount' | 'currency'
>;

/**
 * Qué se puede hacer con la reserva. La principal —la que el estado pide— va a la vista; el resto
 * en «Más acciones», con «Cancelar reserva» siempre al final.
 */
export function reservationActions(
  order: ActionOrder,
  context: ActionContext,
): { readonly primary: ReservationAction | null; readonly secondary: ReservationAction[] } {
  const hasPnr = typeof order.pnr === 'string' && order.pnr.length > 0;
  const live = hasPnr && order.status !== 'cancelled' && order.status !== 'failed';
  const available: ReservationAction[] = [];
  if (
    hasPnr &&
    (order.status === 'pending' || order.status === 'confirmed') &&
    supportsOrderCapability(order.capabilities, 'pay')
  ) {
    available.push('pay');
  }
  if (canIssueTicket(order) && !context.issueInFlight) available.push('issue');
  if (live && supportsOrderCapability(order.capabilities, 'retrieve')) available.push('retrieve');
  if (canManageServices(order) && !context.issueInFlight) available.push('services');
  if (canEditTravelers(order) && !context.issueInFlight) available.push('travelers');
  if (hasPnr && order.status !== 'failed' && !!order.contactInfo?.email) available.push('resend');
  if (
    live &&
    supportsOrderCancellation(order.capabilities, order.status) &&
    !context.cancelBlocked
  ) {
    available.push('cancel');
  }

  const primary =
    (['pay', 'issue', 'retrieve'] as const).find((action) => available.includes(action)) ?? null;
  return { primary, secondary: available.filter((action) => action !== primary) };
}

export interface BillingView {
  readonly name: string;
  readonly document?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly address?: string;
  readonly company: boolean;
}

/**
 * A nombre de quién se factura, de la cotización de la que salió la reserva. `null` si no hay
 * nada guardado. Facturar «al pasajero» sin nombre guardado toma el del pasajero 1.
 */
export function billingView(
  quotation: {
    readonly billing?: unknown;
    readonly customerName?: string | null;
    readonly customerEmail?: string | null;
    readonly customerPhone?: string | null;
  } | null,
  passenger1?: { readonly givenName?: string; readonly surname?: string },
): BillingView | null {
  if (quotation === null) return null;
  const draft = billingDraftFromQuotation(quotation.billing, {
    customerName: quotation.customerName ?? null,
    customerEmail: quotation.customerEmail ?? null,
    customerPhone: quotation.customerPhone ?? null,
  });
  const passengerName = [passenger1?.givenName, passenger1?.surname]
    .filter((part) => typeof part === 'string' && part.trim().length > 0)
    .join(' ');
  const name = draft.name.trim() || (draft.mode === 'passenger' ? passengerName : '');
  const document = draft.documentNumber.trim()
    ? `${draft.documentType} ${draft.documentNumber.trim()}`.trim()
    : undefined;
  const address = [draft.address, draft.city, draft.countryCode]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(', ');
  const email = draft.email.trim();
  const phone = draft.phone.trim();
  if (!name && !document && !email && !phone && !address) return null;
  return {
    name: name || 'Sin nombre',
    company: draft.customerType === 'company',
    ...(document ? { document } : {}),
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    ...(address ? { address } : {}),
  };
}

/** «CC ••••4821 · Adulto»: el documento enmascarado tal como lo manda el API. */
export function maskedDocument(doc: { type?: string; numberLast4?: string } | undefined): string {
  if (!doc?.type) return '';
  return doc.numberLast4 !== undefined ? `${doc.type} ••••${doc.numberLast4}` : doc.type;
}

/**
 * Lo que se cobró hasta ahora. La reserva sale sin cobro (D1): lo que pase después lo dicen el
 * estado y la retención de cartera (SAB-10).
 */
export function chargeSummary(order: Pick<Order, 'status' | 'walletHold'>): string {
  if (order.status === 'cancelled' || order.status === 'failed') return 'Sin cobro';
  if (order.walletHold === 'captured') return 'Cobrado de la cartera de la agencia';
  if (order.walletHold === 'held') return 'Saldo retenido en la cartera hasta emitir o cancelar';
  if (order.status === 'ticketed') return 'Pagada y emitida';
  return 'Sin cobro todavía: la reserva se creó sin pagar';
}
