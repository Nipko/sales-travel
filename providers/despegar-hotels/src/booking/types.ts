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
  /** `extended_info.exchange_policies` (clave `H0` del hotel), tal cual. */
  exchangePolicies?: unknown;
  /** `extended_info.hints`: esquema y validaciones del formulario de reserva, tal cual. */
  hints?: unknown;
}

// ───────────────────────── Payments ─────────────────────────

export interface PaymentOptionsQuery {
  prebookId: string;
  inputPoints?: number;
  includeHints?: boolean;
}

export type PaymentOptionType = 'ONE_CARD' | 'CURRENT_ACCOUNT' | 'DEFERRED';

/** Un plan de pago de `group_plans[].plans[]`. Su `id` es el `plan_id` del Book. */
export interface PaymentPlan {
  id: string;
  /** Tipo del grupo (`CARD`, `DEFERRED`). */
  groupType?: string;
  /** Tipo del plan (`CREDIT`, `DEFERRED`). */
  type?: string;
  price?: Money;
  installments?: number;
  cardBrand?: string;
  /** Sólo DEFERRED: hasta cuándo se puede pagar, y por qué (`REMOTE`). */
  deferredDeadline?: string;
  deferredReason?: string;
}

export interface PaymentOptionChoice {
  optionType: string; // 'ONE_CARD' | 'CURRENT_ACCOUNT' | 'DEFERRED'
  /**
   * El `id` del primer plan, por compatibilidad. `CURRENT_ACCOUNT` no trae planes: el Book va sin
   * `plan_id`.
   */
  planId?: string;
  plans: PaymentPlan[];
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

/**
 * Una unidad de pago. Qué campos lleva depende de `BookPayment.optionType`:
 * - `CURRENT_ACCOUNT`: ninguno (sólo el tipo).
 * - `DEFERRED`: `planId`.
 * - `ONE_CARD`: `planId`, `secureToken`, `invoiceReference` y el documento del titular.
 */
export interface BookPaymentUnit {
  planId?: string;
  /** Token PCI de la tokenización hosted (SAQ-A). NUNCA PAN/CVV. */
  secureToken?: string;
  type?: string;
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
  street?: string;
  number?: string;
  apartment?: string;
  floor?: string;
  /** Sale como `neighbourhood`, como lo escribe Despegar. */
  neighborhood?: string;
  cityId?: string;
  zipCode?: string;
}

/**
 * Datos de facturación fiscal. Obligatorios con `CURRENT_ACCOUNT` y `ONE_CARD`; Despegar exige
 * `fiscal_status` y `fiscal_identification`, el resto es opcional.
 */
export interface BookInvoice {
  reference?: number;
  fiscalName?: string;
  firstName?: string;
  lastName?: string;
  fiscalStatus: string;
  fiscalIdentification: BookInvoiceFiscalId;
  fiscalAddress?: BookInvoiceAddress;
}

export interface BookPayment {
  optionType: string; // 'CURRENT_ACCOUNT' | 'ONE_CARD' | 'DEFERRED'
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
  /** El `reservationId` del Book (o la `external_booking_reference`). */
  reservationId: string;
  reason?: CancelReason; // default OTHER
}

export interface CancelReservationResult {
  /** La cancelación se aceptó (no es recuperable). */
  success: boolean;
  flowId?: string;
  productId?: string;
  productType?: string;
  /** La cotización con la que se canceló (paso 2), si se pidió. */
  quote?: CancelQuote;
}

// ───────────────────────── Post-venta: reservas ─────────────────────────

/** Estado de un producto en `/reservations`. */
export type AftersaleStatus = 'IN_PROCESS' | 'ISSUED' | 'CANCELLED' | 'DELETED' | 'UNKNOWN';

export interface ReservationsQuery {
  reservationId?: string;
  productId?: string;
  externalTransactionId?: string;
  flowId?: string;
  /** Lista las reservas de la cuenta (la api key) por fecha de compra, YYYY-MM-DD. */
  fromPurchaseDate?: string;
  toPurchaseDate?: string;
  productType?: 'HOTEL';
  limit?: number;
  page?: number;
}

export interface AftersaleRoom {
  code?: string;
  mealPlanCode?: string;
  mealPlanDescription?: string;
  description?: string;
  bedTypeDescription?: string;
  holderFirstName?: string;
  holderLastName?: string;
  adults?: number;
  minorAges: number[];
}

/** Un producto de `/reservations`: lo que piden la cancelación y los pedidos especiales. */
export interface AftersaleReservation {
  /** `items[].id`. */
  id: string;
  productId: string;
  productType: string;
  /** Lo que pide la cotización de la cancelación. */
  transactionId?: string;
  status: AftersaleStatus;
  /** Valor crudo de `status`. */
  rawStatus: string;
  reservationId?: string;
  externalReservationId?: string;
  /** Localizador del hotel para el check-in. */
  pnr?: string;
  purchaseDateTime?: string;
  salePrice?: Money;
  checkIn?: string;
  checkOut?: string;
  hotelId?: string;
  hotelName?: string;
  rooms: AftersaleRoom[];
  downloadVoucherUrl?: string;
}

// ───────────────────────── Post-venta: cancelación en tres pasos ─────────────────────────

export type CancelAllowanceValue = 'ALLOWED' | 'DISALLOWED' | 'UNKNOWN';

export interface CancelAllowance {
  productId: string;
  productType?: string;
  allowance: CancelAllowanceValue;
  /** `ALREADY_CANCELLED`, `CANCEL_IN_PROCESS`, `INVALID_MINIMUM_HOURS`… */
  disallowedReason?: string;
  /** `TOTAL_REFUND`, `WITH_PENALTY`, `TAX_ONLY`, `NO_REFUND`. */
  refundPolicy?: string;
  policy?: string;
  expiresAt?: string;
}

export interface CancelQuoteRefund {
  paymentAmount?: Money;
  appliedPenalty?: Money;
  refundAmount?: Money;
}

export interface CancelQuote {
  quoteId?: string;
  status?: string; // QUOTING | QUOTED
  refundPolicy?: string;
  /** `AUTOMATIC` o `MANUAL` (la resuelve un agente de Despegar). */
  resolution?: string;
  guaranteed?: boolean;
  currency?: string;
  refunds: CancelQuoteRefund[];
  /** La habilitación que vino con la cotización. */
  allowance?: CancelAllowance;
}

// ───────────────────────── Comisión ─────────────────────────

export interface CommissionUpdateRequest {
  prebookId: string;
  /** En unidades mayores, entre `min_amount` y `max_amount` del prebook. */
  commission: number;
}

export interface CommissionUpdateResult {
  commission: PrebookCommission;
  total: Money;
}

// ───────────────────────── Pedidos especiales ─────────────────────────

export interface SpecialRequestCatalogItem {
  code: string;
  description: string;
  requiresValue: boolean;
}

export interface SpecialRequestInput {
  productId: string;
  code: string;
  value?: string;
}

export interface SpecialRequestResult {
  flowId?: string;
  productId?: string;
}

// ───────────────────────── Recuperación (lectura) ─────────────────────────

export interface PriceJumpInfo {
  reservationId: string;
  status: BookStatus;
  subStatus?: string;
  difference?: Money;
  priceBefore?: Money;
  priceAfter?: Money;
  timeout?: string;
  messageType?: string;
  /** `flavor_id` a confirmar o rechazar. */
  flavorIds: string[];
  paymentSelectionTimeout?: string;
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
  /** `PRICE_JUMP` o `WAITING_PAYMENT_SELECTION`, como lo devuelve la lectura de recovery. */
  messageType: string;
  confirmations: PriceJumpConfirmation[];
  /** Sólo con `WAITING_PAYMENT_SELECTION` (reserva en espera). Con tarjeta no se admite aquí. */
  paymentType?: 'CURRENT_ACCOUNT';
  testCase?: 'pricejump';
}

export interface RecoveryResult {
  item?: Record<string, unknown>;
}
