import type { Money } from '@sales-travel/canonical';
import type { HotelTax } from '../types';

// ───────────────────────── Prebook ─────────────────────────

export type PrebookInclude = 'EXCHANGE_POLICIES' | 'IMPORTANT_DATA' | 'HINTS';

export interface PrebookQuery {
  /** Token cifrado del room/choice obtenido en el detalle (availability/{hotel_id}). */
  choiceId: string;
  lang?: 'pt' | 'en' | 'es';
  include?: PrebookInclude[];
}

export interface PrebookCommission {
  amount: Money;
  maxAmount?: Money;
  minAmount?: Money;
}

export interface PrebookResult {
  prebookId: string;
  status: string;
  /** ISO-8601: vencimiento del prebook. Hay que reservar antes de esta marca (si no, 410 Gone). */
  expiration?: string;
  flow?: string;
  total: Money;
  /** Comisión B2B confirmada para el waterfall del consolidador. */
  commission?: PrebookCommission;
}

// ───────────────────────── Payments ─────────────────────────

export interface PaymentOptionsQuery {
  prebookId: string;
  inputPoints?: number;
  includeHints?: boolean;
}

export interface PaymentOptionChoice {
  optionType: string; // p.ej. 'ONE_CARD'
  /** Referencia de plan que el book exige en payment_units[].plan_id. */
  planId?: string;
}

export interface PaymentModality {
  modality: string; // p.ej. 'PAYINADVANCE'
  total: Money;
  base?: Money;
  taxes?: Money;
  fees?: Money;
  discount?: Money;
  processingCost?: Money;
  taxBreakdown: HotelTax[];
  options: PaymentOptionChoice[];
}

// ───────────────────────── Book ─────────────────────────

export type IdentificationType = 'LOCAL' | 'PASSPORT';

export interface BookIdentification {
  type: IdentificationType;
  number: string;
  /** Requerido sólo para PASSPORT. */
  issueCountry?: string;
}

export interface BookTraveler {
  referenceId: string;
  firstName: string;
  lastName: string;
  gender?: 'MALE' | 'FEMALE';
  /** ISO-3166 alpha-2. */
  nationality?: string;
  /** yyyy-MM-dd. */
  birthDate?: string;
  identification?: BookIdentification;
}

export type PhoneType = 'HOME' | 'MOBILE' | 'WORK';

export interface BookPhone {
  countryCode: string;
  areaCode?: string;
  number: string;
  type?: PhoneType;
}

export interface BookContact {
  email: string;
  phones?: BookPhone[];
}

export interface BookPaymentUnit {
  planId: string;
  /** Token PCI de la tokenización hosted (SAQ-A). NUNCA PAN/CVV. */
  secureToken: string;
  type?: string; // 'ONE_CARD'
  invoiceReference?: number;
  cardHolderIdentification?: { type: IdentificationType; number: string };
}

export interface BookInvoiceFiscalId {
  type: string;
  number: string;
  issueCountry?: string;
  expirationDate?: string;
}

export interface BookInvoiceAddress {
  street: string;
  number: string;
  apartment?: string;
  floor?: string;
  neighborhood?: string;
  cityId: string;
  zipCode: string;
}

/** Datos de facturación fiscal (DIAN/SUNAT/NF-e). Opcional en el book. */
export interface BookInvoice {
  reference: number;
  fiscalName: string;
  firstName?: string;
  lastName?: string;
  fiscalStatus: string;
  fiscalIdentification: BookInvoiceFiscalId;
  fiscalAddress: BookInvoiceAddress;
}

export interface BookPayment {
  optionType: string; // 'ONE_CARD'
  units: BookPaymentUnit[];
  invoices?: BookInvoice[];
}

export interface BookContext {
  clientIp?: string;
  userAgent?: string;
}

export interface BookRequest {
  prebookId: string;
  /** Referencia única del partner (idempotencia). Formato ISO-XXXX. */
  externalBookingReference: string;
  modality?: string; // 'PAYINADVANCE'
  contact: BookContact;
  /** Hoteles: un único lead traveler por habitación. */
  travelers: BookTraveler[];
  payment: BookPayment;
  context?: BookContext;
  /** true → responde ~2s con PROCESSING; false/omitido espera el estado final (hasta 45s). */
  disableSyncResult?: boolean;
  /** Sólo sandbox: fuerza el escenario de price-jump. */
  testCase?: 'pricejump';
}

export type BookStatus = 'SUCCESS' | 'PROCESSING' | 'ERROR';

export interface BookedProduct {
  type: string; // 'HOTEL'
  platformId?: string;
  pnr?: string;
}

export interface BookResult {
  reservationId: string;
  status: BookStatus;
  /** Detalle cuando el estado no es SUCCESS (p.ej. PRICE_JUMP, UNAVAILABLE, PROVIDER_ERROR). */
  subStatus?: string;
  message?: string;
  products: BookedProduct[];
}

// ───────────────────────── Cancel ─────────────────────────

export type CancelReason =
  | 'FAMILY_OR_WORK_PROBLEM'
  | 'TRAVEL_ANOTHER_DESTINATION'
  | 'NATURAL_DISASTER'
  | 'WRONG_PURCHASE_DATA'
  | 'ILLNESS'
  | 'DEATH'
  | 'DUPLICATE_RESERVATION'
  | 'CHANGE_PROBLEM'
  | 'CREDIT_CARD_PROBLEM'
  | 'HOTEL_PROBLEM'
  | 'OTHER';

export interface CancelReservationRequest {
  reservationId: string;
  reason?: CancelReason; // default OTHER
}

export interface CancelReservationResult {
  /** La cancelación se aceptó (no es recuperable). El proveedor no devuelve montos en este endpoint. */
  success: boolean;
  flowId?: string;
  productId?: string;
  productType?: string;
}

// ───────────────────────── Recovery (price-jump) ─────────────────────────

export interface PriceJumpConfirmation {
  /** Identificador del producto (p.ej. 'H0' para hotel). */
  flavorId: string;
  /** true acepta el nuevo precio; false lo rechaza. */
  confirm: boolean;
}

export interface RecoveryRequest {
  reservationId: string;
  /** Valor devuelto por getReservation cuando hay price-jump. */
  messageType: string;
  confirmations: PriceJumpConfirmation[];
  testCase?: 'pricejump';
}

export interface RecoveryResult {
  item?: Record<string, unknown>;
}
