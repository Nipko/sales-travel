import type { Money } from '@sales-travel/canonical';

// ─────────────────────────── Suggest ───────────────────────────

export interface SuggestQuery {
  query: string;
  lang?: string;
}

export interface CarLocation {
  airport: boolean;
  cityLoc: boolean;
  countryCode: string;
  /** Cantidad de oficinas cercanas disponibles. */
  hasOffice: number;
  iata?: string;
  latitude: number;
  longitude: number;
  timezone: string;
  /** Nombre display: "Miami International Airport, MIA, Florida, US" */
  value: string;
}

// ─────────────────────────── Oficinas ───────────────────────────

export interface FindOfficesQuery {
  distance: number;
  /** País origen alpha-2. Si se omite, el adapter usa `cfg.sourceCountry` (cuenta BYOC). */
  source?: string;
  /** Coordenadas (mutuamente excluyente con cityCode). */
  lat?: number;
  lng?: number;
  /** Código ciudad IATA (mutuamente excluyente con lat/lng). */
  cityCode?: string;
  companyCode?: string;
}

export interface OfficeScheduleDay {
  opening: string;
  close: string;
}

export interface CarOffice {
  officeCode: string;
  companyCode: string;
  companyName: string;
  address: string;
  cityName: string;
  state: string;
  countryCode: string;
  lat: number;
  lng: number;
  zipCode: string;
  distance: number;
  /** Llave: 1=Lunes … 7=Domingo. */
  schedule: Record<string, OfficeScheduleDay>;
}

// ─────────────────────────── Tarifas ───────────────────────────

export interface RatesQuery {
  country: string;
  /** País origen alpha-2. Si se omite, el adapter usa `cfg.sourceCountry` (cuenta BYOC). */
  source?: string;
  language?: string;
}

export interface RateType {
  id: string;
  name: string;
}

// ─────────────────────────── Búsqueda (Matrix) ───────────────────────────

export type PaymentType = 'ppd' | 'pod';

export interface CarSearchQuery {
  pickUpLocation: string;
  dropOffLocation: string;
  pickUpDate: string;
  dropOffDate: string;
  /** Formato militar HHMM, ej: "1000". */
  pickUpHour: string;
  dropOffHour: string;
  /** "best" o ID de /rates. */
  rateType: string;
  /** País destino alpha-2. */
  country: string;
  /** País origen alpha-2. Si se omite, el adapter usa `cfg.sourceCountry` (cuenta BYOC). */
  source?: string;
  paymentType?: PaymentType;
  companyCode?: string;
  cdCode?: string;
  pcCode?: string;
  language?: string;
  /** Requerido si pickUpLocation = "City". */
  lat?: number;
  lng?: number;
  /** Requerido si dropOffLocation = "City2". */
  latDropOff?: number;
  lngDropOff?: number;
}

export interface CarOffer {
  category: string;
  sippCode: string;
  companyCode: string;
  companyName: string;
  rateAmount: Money;
  paymentOption: PaymentType;
  carModel: string;
  doors: number;
  passengers: number;
  bags: number;
  trans: string;
  air: boolean;
  kmIncluded: string;
  base: Money;
  tax: Money;
  convertedRateAmount?: Money;
  /** Token opaco requerido en GetSelection y Confirmation. */
  ccrc?: string;
}

// ─────────────────────────── Selección ───────────────────────────

export interface CarSelectionQuery extends CarSearchQuery {
  companyCode: string;
  sippCode: string;
  ccrc?: string;
  coupon?: string;
  tp?: string;
}

export interface CarSelection extends CarOffer {
  /** ID de sesión. TTL: 15 minutos. */
  uniqid: string;
  /** ID de la tarifa efectiva (rates[rateId]); usar en get-rate-information y confirmación. */
  rateCode?: string;
}

// ─────────────────────────── Detalle de tarifa ───────────────────────────

export interface RateDetailQuery {
  uniqid: string;
  paymentType: PaymentType;
  rateType: string;
}

export interface RateChargeItem {
  code: string;
  name: string;
  amount: Money;
}

export interface CarRateDetail {
  /** Monto que el cliente paga ahora. */
  base: Money;
  /** Monto a pagar en mostrador. */
  tax: Money;
  charges: RateChargeItem[];
}

// ─────────────────────────── Confirmación / Booking ───────────────────────────

/**
 * Edad del conductor. El API real (Postman oficial) espera la edad LITERAL (ej: 27, 30), no un
 * código. Se mantiene el alias por compatibilidad pero el campo en ConfirmCarRequest es `number`.
 */
export type DriverAgeGroup = number;

export interface CarExtras {
  childBoosterSeat?: boolean;
  childToddlerSeat?: boolean;
  gps?: boolean;
  skyracks?: boolean;
}

export interface FrequentFlyer {
  number: string;
  carrier: string;
}

export interface ConfirmCarRequest {
  uniqid: string;
  paymentType: PaymentType;
  rateType: string;
  companyCode: string;
  sippCode: string;
  pickUpLocation: string;
  dropOffLocation: string;
  pickUpDate: string;
  dropOffDate: string;
  pickUpHour: string;
  dropOffHour: string;
  pickUpAddress: string;
  dropOffAddress: string;
  firstName: string;
  lastName: string;
  age: DriverAgeGroup;
  email: string;
  /** Base comisionable. */
  realBase: Money;
  /** Impuestos no comisionables. */
  realTax: Money;
  total: Money;
  ccrc?: string;
  cdCode?: string;
  pcCode?: string;
  extras?: CarExtras;
  flightNumber?: string;
  frequentFlyer?: FrequentFlyer;
  membershipNumber?: string;
  /** Si `true`, crea la reserva en estado ON HOLD (requiere /release antes del pickup -48h). */
  onHold?: boolean;
  language?: string;
}

export type BookingStatus = 'confirmed' | 'on_hold' | 'on_request';

export interface CarBookResult {
  confirmationCode: string;
  sippCode: string;
  rateCode: string;
  status: BookingStatus;
}

// ─────────────────────────── My Reservation ───────────────────────────

export interface MyReservationQuery {
  lastName: string;
  confirmationCode: string;
  language?: string;
}

export interface VoucherInfo {
  [key: string]: unknown;
}

export interface CarReservation {
  confirmationCode: string;
  firstName: string;
  lastName: string;
  sippCode: string;
  rateCode: string;
  status: string;
  /** Debe mostrarse completo al cliente. */
  voucherInformation: VoucherInfo;
  /** Solo en reservas PPD. */
  voucherNumber?: string;
}

// ─────────────────────────── Cancelación ───────────────────────────

export interface CancelQuery {
  lastName: string;
  confirmationCode: string;
}

export interface CancelResult {
  success: boolean;
  confirmationCode: string;
  message?: string;
}

// ─────────────────────────── Release (ON HOLD) ───────────────────────────

export interface ReleaseQuery {
  lastName: string;
  referenceCode: string;
}

export interface ReleaseResult {
  confirmationCode: string;
  sippCode: string;
  rateCode: string;
  status: string;
}

// ─────────────────────────── Reporte diario ───────────────────────────

export interface DailyReportQuery {
  date?: string;
  language?: string;
}

export interface DailyReportEntry {
  confirmationCode: string;
  pickUpDate: string;
  dropOffDate: string;
  status: string;
}
