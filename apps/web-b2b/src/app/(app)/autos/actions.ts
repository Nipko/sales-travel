'use server';

import { api } from '../../../lib/api';

// ─────────────────────────── Tipos (espejo del contrato /cars) ───────────────────────────

export interface Money {
  amountMinor: number;
  currency: string;
}

export interface CarLocation {
  airport: boolean;
  cityLoc: boolean;
  countryCode: string;
  hasOffice: number;
  iata?: string;
  latitude: number;
  longitude: number;
  timezone: string;
  value: string;
}

export type PaymentType = 'ppd' | 'pod';

export interface WaterfallStep {
  tenantId: string;
  tenantName: string;
  level: number;
  ruleType: string;
  addedMinor: number;
}

/** Pricing waterfall del consolidador: `finalMinor` es el precio de venta (neto + markups). */
export interface CarPricing {
  /** Costo para esta agencia: neto del proveedor + markup de su red por encima. */
  costMinor: number;
  finalMinor: number;
  /** Margen propio. No incluye el de los ancestros. */
  ownMarkupMinor: number;
  currency: string;
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
  ccrc?: string;
  /** rateType real del auto (índice de tarifa); se usa en la selección, no 'best'. */
  rateType?: string;
  imageUrl?: string;
  companyImageUrl?: string;
  pricing?: CarPricing;
}

export interface CarSelection extends CarOffer {
  uniqid: string;
  /** ID de la tarifa efectiva; usar en rate-detail y confirmación (no reusar 'best'). */
  rateCode?: string;
}

export interface RateChargeItem {
  code: string;
  name: string;
  amount: Money;
}

export interface CarRateDetail {
  base: Money;
  tax: Money;
  charges: RateChargeItem[];
}

export type BookingStatus = 'confirmed' | 'on_hold' | 'on_request';

export interface CarBookResult {
  confirmationCode: string;
  sippCode: string;
  rateCode: string;
  status: BookingStatus;
}

export interface CarReservation {
  confirmationCode: string;
  firstName: string;
  lastName: string;
  sippCode: string;
  rateCode: string;
  status: string;
  /** Debe mostrarse completo al cliente (requisito AgentCars). */
  voucherInformation: Record<string, unknown>;
  voucherNumber?: string;
}

export interface CancelResult {
  success: boolean;
  confirmationCode: string;
  message?: string;
}

/** Resultado de activar (release) una reserva ON HOLD. */
export interface ReleaseResult {
  confirmationCode: string;
  sippCode: string;
  rateCode: string;
  status: string;
}

/** Tipo de tarifa del catálogo del consolidador (GET /cars/rates). */
export interface RateType {
  id: string;
  name: string;
}

/** Valores comunes de búsqueda, threaded a selección y reserva. */
export interface CarSearchValues {
  pickUpLocation: string;
  dropOffLocation: string;
  country: string;
  pickUpDate: string;
  dropOffDate: string;
  pickUpHour: string;
  dropOffHour: string;
  rateType: string;
  paymentType?: PaymentType;
  /** Coordenadas de recogida; requeridas cuando pickUpLocation === 'City'. */
  lat?: number;
  lng?: number;
  /** Coordenadas de devolución; requeridas cuando dropOffLocation === 'City2'. */
  latDropOff?: number;
  lngDropOff?: number;
}

export interface DriverValues {
  firstName: string;
  lastName: string;
  email: string;
  /** Edad real del conductor (el API espera la edad literal, ej: 30). */
  age: number;
}

// ─────────────────────────── Helpers de validación ───────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HOUR_RE = /^\d{4}$/;

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Normaliza "HH:MM" o "1000" a HHMM de 4 dígitos. */
function normalizeHour(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  return digits.padStart(4, '0').slice(0, 4);
}

function validSearch(v: CarSearchValues): string | null {
  if (!v.pickUpLocation) return 'Elegí el lugar de recogida.';
  if (!v.dropOffLocation) return 'Elegí el lugar de devolución.';
  if (!/^[A-Z]{2}$/.test(v.country)) return 'No pudimos determinar el país de destino.';
  if (!DATE_RE.test(v.pickUpDate)) return 'Ingresá una fecha de recogida válida.';
  if (!DATE_RE.test(v.dropOffDate)) return 'Ingresá una fecha de devolución válida.';
  if (v.pickUpDate < todayISO()) return 'La recogida no puede ser anterior a hoy.';
  if (v.dropOffDate < v.pickUpDate)
    return 'La devolución debe ser igual o posterior a la recogida.';
  if (!HOUR_RE.test(v.pickUpHour)) return 'Hora de recogida inválida.';
  if (!HOUR_RE.test(v.dropOffHour)) return 'Hora de devolución inválida.';
  // Búsqueda por ciudad: AgentCars exige coordenadas si la ubicación es genérica.
  if (v.pickUpLocation === 'City' && (v.lat == null || v.lng == null))
    return 'Falta la ubicación de recogida (coordenadas de la ciudad).';
  if (v.dropOffLocation === 'City2' && (v.latDropOff == null || v.lngDropOff == null))
    return 'Falta la ubicación de devolución (coordenadas de la ciudad).';
  return null;
}

/** Agrega lat/lng/latDropOff/lngDropOff al body sólo cuando aplica (búsqueda por ciudad). */
function withCityCoords(body: Record<string, unknown>, v: CarSearchValues): void {
  if (v.pickUpLocation === 'City' && v.lat != null && v.lng != null) {
    body.lat = v.lat;
    body.lng = v.lng;
  }
  if (v.dropOffLocation === 'City2' && v.latDropOff != null && v.lngDropOff != null) {
    body.latDropOff = v.latDropOff;
    body.lngDropOff = v.lngDropOff;
  }
}

// ─────────────────────────── Actions ───────────────────────────

/** Autocomplete de ubicaciones (aeropuertos/ciudades con oficinas). */
export async function suggestCarLocationsAction(query: string): Promise<CarLocation[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const res = await api<{ items: CarLocation[] }>(`/cars/suggestions?q=${encodeURIComponent(q)}`);
  return res.ok ? res.data.items : [];
}

/** Catálogo de tipos de tarifa para el país destino (GET /cars/rates). */
export async function getRatesAction(country: string, source?: string): Promise<RateType[]> {
  const c = country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return [];
  const qs = new URLSearchParams({ country: c });
  const src = source?.trim().toUpperCase();
  if (src && /^[A-Z]{2}$/.test(src)) qs.set('source', src);
  const res = await api<{ rates: RateType[] }>(`/cars/rates?${qs.toString()}`);
  return res.ok ? res.data.rates : [];
}

export interface CarSearchResult {
  ok: boolean;
  cars: CarOffer[];
  error?: string;
}

export async function searchCarsAction(values: CarSearchValues): Promise<CarSearchResult> {
  const v: CarSearchValues = {
    ...values,
    pickUpHour: normalizeHour(values.pickUpHour),
    dropOffHour: normalizeHour(values.dropOffHour),
    rateType: values.rateType || 'best',
  };
  const error = validSearch(v);
  if (error) return { ok: false, cars: [], error };

  const body: Record<string, unknown> = {
    pickUpLocation: v.pickUpLocation,
    dropOffLocation: v.dropOffLocation,
    country: v.country,
    pickUpDate: v.pickUpDate,
    dropOffDate: v.dropOffDate,
    pickUpHour: v.pickUpHour,
    dropOffHour: v.dropOffHour,
    rateType: v.rateType,
  };
  if (v.paymentType) body.paymentType = v.paymentType;
  withCityCoords(body, v);

  const res = await api<{ cars: CarOffer[] }>('/cars/search', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) return { ok: false, cars: [], error: res.error.message };
  return { ok: true, cars: res.data.cars };
}

export interface CarSelectionResult {
  ok: boolean;
  selection?: CarSelection;
  error?: string;
}

/** Selecciona un auto concreto y abre la sesión (uniqid, TTL 15 min). */
export async function selectCarAction(
  search: CarSearchValues,
  car: { companyCode: string; sippCode: string; ccrc?: string; rateType?: string },
): Promise<CarSelectionResult> {
  const body: Record<string, unknown> = {
    pickUpLocation: search.pickUpLocation,
    dropOffLocation: search.dropOffLocation,
    country: search.country,
    pickUpDate: search.pickUpDate,
    dropOffDate: search.dropOffDate,
    pickUpHour: normalizeHour(search.pickUpHour),
    dropOffHour: normalizeHour(search.dropOffHour),
    // El rateType REAL del auto elegido (índice de tarifa), no el 'best' de la búsqueda:
    // get-selection exige el rateType específico de la oferta.
    rateType: car.rateType || search.rateType || 'best',
    companyCode: car.companyCode,
    sippCode: car.sippCode,
  };
  if (search.paymentType) body.paymentType = search.paymentType;
  if (car.ccrc) body.ccrc = car.ccrc;
  withCityCoords(body, search);

  const res = await api<CarSelection>('/cars/selection', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) return { ok: false, error: res.error.message };
  return { ok: true, selection: res.data };
}

export interface RateDetailResult {
  ok: boolean;
  detail?: CarRateDetail;
  error?: string;
}

export async function rateDetailAction(
  uniqid: string,
  paymentType: PaymentType,
  rateType: string,
): Promise<RateDetailResult> {
  const qs = new URLSearchParams({ uniqid, paymentType, rateType: rateType || 'best' });
  const res = await api<CarRateDetail>(`/cars/rate-detail?${qs.toString()}`);
  if (!res.ok) return { ok: false, error: res.error.message };
  return { ok: true, detail: res.data };
}

export interface BookResult {
  ok: boolean;
  result?: CarBookResult;
  error?: string;
}

/** Extras y opciones de la reserva (todos opcionales). */
export interface BookOptions {
  gps?: boolean;
  childToddlerSeat?: boolean;
  childBoosterSeat?: boolean;
  skyracks?: boolean;
  flightNumber?: string;
  /** Crea la reserva en estado ON HOLD (hay que activarla ≥48h antes del pickup). */
  onHold?: boolean;
}

/** Confirma la reserva. Convierte los Money de la selección a montos mayores para el API. */
export async function bookCarAction(
  search: CarSearchValues,
  selection: CarSelection,
  driver: DriverValues,
  options: BookOptions = {},
): Promise<BookResult> {
  if (!driver.firstName.trim() || !driver.lastName.trim()) {
    return { ok: false, error: 'Nombre y apellido del conductor son requeridos.' };
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(driver.email)) {
    return { ok: false, error: 'Ingresá un email válido.' };
  }

  const major = (m: Money): number => m.amountMinor / 100;
  const body: Record<string, unknown> = {
    uniqid: selection.uniqid,
    paymentType: search.paymentType ?? selection.paymentOption,
    // Tarifa efectiva de la selección (no reusar 'best' de la búsqueda).
    rateType: selection.rateCode || search.rateType || 'best',
    companyCode: selection.companyCode,
    sippCode: selection.sippCode,
    pickUpLocation: search.pickUpLocation,
    dropOffLocation: search.dropOffLocation,
    pickUpDate: search.pickUpDate,
    dropOffDate: search.dropOffDate,
    pickUpHour: normalizeHour(search.pickUpHour),
    dropOffHour: normalizeHour(search.dropOffHour),
    firstName: driver.firstName.trim(),
    lastName: driver.lastName.trim(),
    age: driver.age,
    email: driver.email.trim(),
    // realBase = base comisionable; realTax = impuestos no comisionables; total = tarifa.
    realBase: major(selection.base),
    realTax: major(selection.tax),
    total: major(selection.rateAmount),
    currency: selection.rateAmount.currency,
    // Datos legibles para persistir en la orden (no se mandan al proveedor).
    ...(selection.category && { category: selection.category }),
    ...(selection.carModel && { carModel: selection.carModel }),
    ...(selection.companyName && { companyName: selection.companyName }),
  };
  if (selection.ccrc) body.ccrc = selection.ccrc;
  if (options.flightNumber?.trim()) body.flightNumber = options.flightNumber.trim();
  if (options.onHold) body.onHold = true;
  const extras: Record<string, boolean> = {};
  if (options.gps) extras.gps = true;
  if (options.childToddlerSeat) extras.childToddlerSeat = true;
  if (options.childBoosterSeat) extras.childBoosterSeat = true;
  if (options.skyracks) extras.skyracks = true;
  if (Object.keys(extras).length > 0) body.extras = extras;

  const res = await api<CarBookResult>('/cars/book', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) return { ok: false, error: res.error.message };
  return { ok: true, result: res.data };
}

export interface ReservationResult {
  ok: boolean;
  reservation?: CarReservation;
  error?: string;
}

/** Consulta una reserva por apellido + código (devuelve el voucher completo). */
export async function getCarReservationAction(
  lastName: string,
  confirmationCode: string,
): Promise<ReservationResult> {
  const ln = lastName.trim();
  const code = confirmationCode.trim();
  if (!ln || !code)
    return { ok: false, error: 'Apellido y código de confirmación son requeridos.' };
  const res = await api<CarReservation>('/cars/reservation', {
    method: 'POST',
    body: JSON.stringify({ lastName: ln, confirmationCode: code }),
  });
  if (!res.ok) return { ok: false, error: res.error.message };
  return { ok: true, reservation: res.data };
}

export interface CancelReservationResult {
  ok: boolean;
  result?: CancelResult;
  error?: string;
}

/** Cancela una reserva por apellido + código. */
export async function cancelCarReservationAction(
  lastName: string,
  confirmationCode: string,
): Promise<CancelReservationResult> {
  const ln = lastName.trim();
  const code = confirmationCode.trim();
  if (!ln || !code)
    return { ok: false, error: 'Apellido y código de confirmación son requeridos.' };
  const res = await api<CancelResult>('/cars/reservations/cancel', {
    method: 'POST',
    body: JSON.stringify({ lastName: ln, confirmationCode: code }),
  });
  if (!res.ok) return { ok: false, error: res.error.message };
  return { ok: true, result: res.data };
}

export interface ReleaseReservationResult {
  ok: boolean;
  result?: ReleaseResult;
  error?: string;
}

/** Activa (release) una reserva ON HOLD. referenceCode = confirmationCode de la reserva. */
export async function releaseReservationAction(
  lastName: string,
  referenceCode: string,
): Promise<ReleaseReservationResult> {
  const ln = lastName.trim();
  const code = referenceCode.trim();
  if (!ln || !code)
    return { ok: false, error: 'Apellido y código de confirmación son requeridos.' };
  const res = await api<ReleaseResult>('/cars/reservations/release', {
    method: 'POST',
    body: JSON.stringify({ lastName: ln, referenceCode: code }),
  });
  if (!res.ok) return { ok: false, error: res.error.message };
  return { ok: true, result: res.data };
}
