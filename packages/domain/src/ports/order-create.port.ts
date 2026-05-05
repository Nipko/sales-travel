import type { Offer } from '@sales-travel/canonical';
import type { FlightSearchCriteria, SearchContext } from './flight-search.port';

export interface Passenger {
  paxId: string;
  paxType: 'ADT' | 'CHD' | 'INF';
  title?: 'Mr' | 'Mrs' | 'Miss' | 'Dr';
  givenName: string;
  surname: string;
  birthdate: string;
  gender: 'M' | 'F';
  citizenshipCountryCode: string;
  identityDoc: {
    type: 'P' | 'DNI' | 'CC' | 'CE';
    number: string;
    issuingCountryCode: string;
    issueDate?: string;
    expiryDate: string;
  };
  loyaltyProgramAccount?: {
    accountNumber: string;
    airlineDesigCode?: string;
  };
}

export interface BookingContactInfo {
  email: string;
  phone: string;
  countryDialingCode?: string;
  areaCode?: string;
  postalAddress?: {
    countryCode: string;
    postalCode: string;
    street: string;
  };
}

export type CardBrandCode = 'VI' | 'AX' | 'CA' | 'DC' | 'TN' | 'HC' | 'EL' | 'TP';
export type PaymentTypeCode = 'Credit Card' | 'Cash' | 'GOV';

export interface PaymentInfo {
  type: PaymentTypeCode;
  card?: {
    brandCode: CardBrandCode;
    holderName: string;
    number: string;
    expirationDate: string;
    securityCode?: string;
  };
  payer?: {
    name: string;
    surname: string;
    taxId?: string;
  };
  amount: number;
  currency: string;
}

export interface OrderCreateRequest {
  offer: Offer;
  criteria: FlightSearchCriteria;
  passengers: Passenger[];
  contactInfo: BookingContactInfo;
  payment?: PaymentInfo;
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
