import type { Offer } from '@sales-travel/canonical';
import type { FlightSearchCriteria, SearchContext } from './flight-search.port';

export interface Passenger {
  paxId: string;
  paxType: 'ADT' | 'CHD' | 'INF';
  givenName: string;
  surname: string;
  birthdate: string;
  gender: 'M' | 'F';
  citizenshipCountryCode: string;
  identityDoc: {
    type: 'P' | 'DNI' | 'CC' | 'CE';
    number: string;
    issuingCountryCode: string;
    expiryDate: string;
  };
}

export interface BookingContactInfo {
  email: string;
  phone: string;
}

export interface OrderCreateRequest {
  offer: Offer;
  criteria: FlightSearchCriteria;
  passengers: Passenger[];
  contactInfo: BookingContactInfo;
}

export interface OrderCreateResult {
  success: boolean;
  orderId?: string;
  pnr?: string;
  warnings: string[];
  error?: string;
}

export interface OrderCreatePort {
  createOrder(request: OrderCreateRequest, ctx: SearchContext): Promise<OrderCreateResult>;
}

export const ORDER_CREATE_PORT = 'ORDER_CREATE_PORT';
