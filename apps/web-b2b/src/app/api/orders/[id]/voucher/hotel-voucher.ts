import {
  addressLine,
  type HotelContent,
} from '../../../../(app)/hoteles/[hotelKey]/_components/hotel-content-view';
import { rateBoardLabel } from '../../../../(app)/hoteles/_components/hotel-format';
import {
  atHotelCharges,
  type AtHotelCharge,
} from '../../../../(app)/hoteles/_components/hotel-rate-view';
import {
  cancelPolicyView,
  conditionGroups,
  type ConditionGroup,
} from '../../../../(app)/hoteles/checkout/_components/conditions-view';
import {
  hcnViewOf,
  hotelConditionsOf,
  hotelNonRefundableOf,
  hotelOrderStateOf,
  hotelPackOf,
  hotelRoomsOf,
  hotelStayOf,
  hotelVoucherAvailable,
  type HcnView,
  type HotelOrderInput,
  type HotelRoomView,
  type HotelStayView,
} from '../../../../(app)/reservas/hotel-order-view';
import { isHotelOrder } from '../../../../../lib/order-vertical';

/*
 * El voucher de una reserva de hotel sin PDF (docs/tbo/09 PR-6.5; U-15; 07 CK-08, CK-13): lo que el
 * huésped lleva al hotel. Localizador del proveedor, número de confirmación del hotel ("pendiente"
 * hasta que llega), estado, estadía, habitaciones con sus huéspedes, política de cancelación,
 * condiciones del hotel y lo que se paga en el hotel (KP-4: "visible to end customer").
 *
 * No lleva ningún importe de la reserva: lo recibe el cliente final, y ni el neto del proveedor ni
 * el margen de la agencia son asunto suyo. Los únicos importes son los que paga en el hotel, cada
 * uno en su moneda. Los suplementos ya incluidos van sin importe: el suyo es parte del neto.
 *
 * Una tarifa no reembolsable lo dice arriba, a la vista (pedido del 2026-09-29, punto d): sin el
 * monto, por lo mismo, pero sin dejar dudas de que cancelar, cambiar o no presentarse no tiene
 * reembolso.
 */

export interface VoucherPolicyTier {
  readonly when: string;
  readonly charge: string;
}

export interface VoucherPolicy {
  readonly headline: string;
  /** Sólo el PreBook la da por definitiva. */
  readonly final: boolean;
  readonly tiers: readonly VoucherPolicyTier[];
  readonly hotelLocalTime: boolean;
  readonly notes?: string;
}

export interface VoucherHotel {
  readonly name?: string;
  readonly stars?: number;
  readonly address?: string;
  readonly phone?: string;
  readonly checkInTime?: string;
  readonly checkOutTime?: string;
}

export interface HotelVoucher {
  readonly orderNumber: number;
  /** `ConfirmationNumber` del proveedor. */
  readonly locator: string;
  readonly hcn: HcnView;
  readonly statusLabel: string;
  readonly hotel: VoucherHotel;
  readonly stay?: HotelStayView;
  readonly board?: string;
  readonly rooms: readonly HotelRoomView[];
  /** La tarifa es no reembolsable: el voucher lo dice arriba. */
  readonly nonRefundable: boolean;
  readonly policy?: VoucherPolicy;
  readonly conditions: readonly ConditionGroup[];
  readonly atHotel: readonly AtHotelCharge[];
  readonly included: readonly string[];
}

export type HotelVoucherResult =
  | { readonly ok: true; readonly voucher: HotelVoucher }
  | { readonly ok: false; readonly status: number; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Lo mínimo para tratar el cuerpo como una orden: sin esto no hay de qué hacer un voucher. */
function orderOf(value: unknown): HotelOrderInput | undefined {
  if (!isRecord(value)) return undefined;
  const { id, orderNumber, status, pnr, totalAmount, currency, createdAt } = value;
  if (typeof id !== 'string' || typeof orderNumber !== 'number' || typeof status !== 'string') {
    return undefined;
  }
  return {
    id,
    orderNumber,
    status,
    pnr: typeof pnr === 'string' ? pnr : null,
    ...(typeof value['provider'] === 'string' ? { provider: value['provider'] } : {}),
    searchCriteria: value['searchCriteria'],
    selectedOffer: value['selectedOffer'],
    passengers: value['passengers'],
    providerTracking: value['providerTracking'],
    totalAmount: typeof totalAmount === 'number' ? totalAmount : 0,
    currency: typeof currency === 'string' ? currency : '',
    createdAt: typeof createdAt === 'string' ? createdAt : '',
  };
}

function hotelOf(content: HotelContent | undefined): VoucherHotel {
  if (content === undefined) return {};
  const address = addressLine(content);
  return {
    ...(content.name ? { name: content.name } : {}),
    ...(content.stars !== null && content.stars > 0 ? { stars: content.stars } : {}),
    ...(address ? { address } : {}),
    ...(content.phone ? { phone: content.phone } : {}),
    ...(content.checkInTime ? { checkInTime: content.checkInTime } : {}),
    ...(content.checkOutTime ? { checkOutTime: content.checkOutTime } : {}),
  };
}

/**
 * El voucher de la orden, o por qué no hay: la orden no es de hotel, o todavía no es una reserva
 * confirmada (verificándose, cancelándose, fallida o cancelada).
 */
export function hotelVoucherOf(order: unknown, content?: HotelContent): HotelVoucherResult {
  const o = orderOf(order);
  if (o === undefined) {
    return { ok: false, status: 404, message: 'No encontramos la reserva.' };
  }
  if (!isHotelOrder(o)) {
    return {
      ok: false,
      status: 400,
      message: 'El voucher de hotel sólo existe para reservas de hotel.',
    };
  }
  if (!hotelVoucherAvailable(o)) {
    return {
      ok: false,
      status: 409,
      message:
        'El voucher está disponible cuando la reserva está confirmada por el proveedor. Revisá su estado en Mis Reservas.',
    };
  }

  const pack = hotelPackOf(o);
  const stay = hotelStayOf(o);
  const hcn = hcnViewOf(o) ?? { label: 'Pendiente' };
  const nonRefundable = hotelNonRefundableOf(o) !== undefined;
  const policy = pack === undefined ? undefined : cancelPolicyView(pack, nonRefundable);
  const included = [
    ...new Set(
      (pack?.includedSupplements ?? [])
        .map((f) => (typeof f.description === 'string' ? f.description.trim() : ''))
        .filter((d) => d.length > 0),
    ),
  ];

  return {
    ok: true,
    voucher: {
      orderNumber: o.orderNumber,
      locator: o.pnr ?? '',
      hcn,
      statusLabel: hotelOrderStateOf(o).label,
      hotel: hotelOf(content),
      ...(stay === undefined ? {} : { stay }),
      ...(pack === undefined ? {} : { board: rateBoardLabel(pack) }),
      rooms: hotelRoomsOf(o),
      nonRefundable,
      ...(policy === undefined
        ? {}
        : {
            policy: {
              headline: policy.headline,
              final: policy.final,
              // Sin la penalidad estimada en precio de venta: es una ayuda para el vendedor.
              tiers: policy.tiers.map((t) => ({ when: t.when, charge: t.charge })),
              hotelLocalTime: policy.hotelLocalTime,
              ...(policy.notes ? { notes: policy.notes } : {}),
            },
          }),
      conditions: conditionGroups(hotelConditionsOf(o)),
      atHotel: pack === undefined ? [] : atHotelCharges(pack),
      included,
    },
  };
}

/**
 * Las fuentes estándar del PDF sólo tienen el juego de caracteres de Windows-1252: lo que la
 * pantalla escribe con símbolos que ahí no existen se reescribe con letras.
 */
/** El aviso del voucher de una tarifa no reembolsable: para el huésped, sin importes. */
export const VOUCHER_NON_REFUNDABLE = {
  title: 'Tarifa no reembolsable',
  detail:
    'Si la reserva se cancela, se modifica o el huésped no se presenta, se cobra el total y no hay reembolso.',
} as const;

export function pdfText(value: string): string {
  return value.replace(/≈\s?/g, 'aprox. ').replace(/→/g, '-');
}
