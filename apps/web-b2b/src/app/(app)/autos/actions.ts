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
  netMinor: number;
  finalMinor: number;
  totalMarkupMinor: number;
  currency: string;
  breakdown: WaterfallStep[];
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
  pricing?: CarPricing;
}

export interface CarSelection extends CarOffer {
  uniqid: string;
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
}

export interface DriverValues {
  firstName: string;
  lastName: string;
  email: string;
  age: 1 | 2 | 3;
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
  return null;
}

// ─────────────────────────── Actions ───────────────────────────

/** Autocomplete de ubicaciones (aeropuertos/ciudades con oficinas). */
export async function suggestCarLocationsAction(query: string): Promise<CarLocation[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const res = await api<{ items: CarLocation[] }>(`/cars/suggestions?q=${encodeURIComponent(q)}`);
  return res.ok ? res.data.items : [];
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
  car: { companyCode: string; sippCode: string; ccrc?: string },
): Promise<CarSelectionResult> {
  const body: Record<string, unknown> = {
    pickUpLocation: search.pickUpLocation,
    dropOffLocation: search.dropOffLocation,
    country: search.country,
    pickUpDate: search.pickUpDate,
    dropOffDate: search.dropOffDate,
    pickUpHour: normalizeHour(search.pickUpHour),
    dropOffHour: normalizeHour(search.dropOffHour),
    rateType: search.rateType || 'best',
    companyCode: car.companyCode,
    sippCode: car.sippCode,
  };
  if (search.paymentType) body.paymentType = search.paymentType;
  if (car.ccrc) body.ccrc = car.ccrc;

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

/** Confirma la reserva. Convierte los Money de la selección a montos mayores para el API. */
export async function bookCarAction(
  search: CarSearchValues,
  selection: CarSelection,
  driver: DriverValues,
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
    rateType: search.rateType || 'best',
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
  };
  if (selection.ccrc) body.ccrc = selection.ccrc;

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
