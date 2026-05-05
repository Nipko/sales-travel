import type { SearchContext } from './flight-search.port';
import type { BookingContactInfo, Passenger, PaymentInfo } from './order-create.port';

export interface OrderRetrieveResult {
  found: boolean;
  orderId?: string;
  status?: string;
  ticketNumbers?: string[];
  warnings: string[];
}

export interface OrderCancelResult {
  success: boolean;
  refundAmount?: { amountMinor: number; currency: string };
  warnings: string[];
  error?: string;
}

export interface OrderPayRequest {
  orderId: string;
  payment: PaymentInfo;
  contactInfo: BookingContactInfo;
  passengers: { paxId: string; paxType: string }[];
}

export interface OrderPayResult {
  success: boolean;
  orderId?: string;
  status?: string;
  warnings: string[];
  error?: string;
}

export interface ServiceListRequest {
  offerId?: string;
  orderId?: string;
  passengers: { paxId: string; paxType: string }[];
  itemType?: 'BAGGAGE';
}

export interface ServiceItem {
  offerItemId: string;
  serviceId: string;
  serviceDefinitionId: string;
  description: string;
  journeyRefId?: string;
  paxRefIds: string[];
  price: { amount: number; currency: string };
  cancellable: boolean;
}

export interface ServiceListResult {
  services: ServiceItem[];
  warnings: string[];
}

export interface OrderReshopRequest {
  paidOrderId: string;
  bnplOrderId: string;
  ticketDocIds: string[];
}

export interface OrderReshopResult {
  success: boolean;
  offerRefId?: string;
  amountDue: { amount: number; currency: string };
  isResidualValue: boolean;
  warnings: string[];
  error?: string;
}

export interface OrderManagePort {
  retrieveOrder(orderId: string, ctx: SearchContext): Promise<OrderRetrieveResult>;
  cancelOrder(orderId: string, ctx: SearchContext): Promise<OrderCancelResult>;
  cancelBnplOrder(orderId: string, ctx: SearchContext): Promise<OrderCancelResult>;
  payOrder(request: OrderPayRequest, ctx: SearchContext): Promise<OrderPayResult>;
  listServices(request: ServiceListRequest, ctx: SearchContext): Promise<ServiceListResult>;
  reshopWithTickets(request: OrderReshopRequest, ctx: SearchContext): Promise<OrderReshopResult>;
}

export const ORDER_MANAGE_PORT = 'ORDER_MANAGE_PORT';
