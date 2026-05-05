import type { SearchContext } from './flight-search.port';

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

export interface OrderManagePort {
  retrieveOrder(orderId: string, ctx: SearchContext): Promise<OrderRetrieveResult>;
  cancelOrder(orderId: string, ctx: SearchContext): Promise<OrderCancelResult>;
}

export const ORDER_MANAGE_PORT = 'ORDER_MANAGE_PORT';
