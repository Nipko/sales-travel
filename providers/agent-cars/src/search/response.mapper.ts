import { Money } from '@sales-travel/canonical';
import type { CarOffer, CarSelection, PaymentType } from '../types.js';
import { bool, num, str } from '../internal/coerce.js';

// ──────────── GetMatrix ────────────
// La respuesta real de get-matrix es un OBJETO agrupado por categoría:
//   { "Economy Automatic": [ {car}, {car} ], "Compact": [ {car} ], ... }
// (no un array plano). Se aplanan todos los grupos antes de mapear.

interface RawCarOffer {
  category?: string;
  sippCode?: string;
  companyCode?: string;
  companyName?: string;
  rateAmount?: number | string;
  payment_option?: string;
  currency?: string;
  carModel?: string;
  doors?: number | string;
  passengers?: number | string;
  bags?: number | string;
  trans?: string;
  air?: string | boolean;
  km_included?: string;
  baseAprox?: number | string;
  taxAprox?: number | string;
  convertedCurrency?: string;
  convertedRateAmount?: number | string;
  ccrc?: string;
}

export function mapMatrixOffers(raw: Record<string, RawCarOffer[]>): CarOffer[] {
  // Object.values aplana tanto el objeto-por-categoría como, defensivamente, un array plano.
  return Object.values(raw ?? {})
    .flat()
    .filter((c): c is RawCarOffer => c != null && typeof c === 'object')
    .map(mapCarOffer);
}

function mapCarOffer(r: RawCarOffer): CarOffer {
  const currency = str(r.currency) || 'USD';
  const convertedCurrency = str(r.convertedCurrency);

  const offer: CarOffer = {
    category: str(r.category),
    sippCode: str(r.sippCode),
    companyCode: str(r.companyCode),
    companyName: str(r.companyName),
    rateAmount: Money.fromMajor(num(r.rateAmount), currency),
    // payment_option en la matriz es un índice de tarifa ("3"), NO el modo de pago. El modo de pago
    // real lo elige el usuario / se resuelve en la selección (rates.{ppd|pod}); acá default 'ppd'.
    paymentOption: 'ppd',
    carModel: str(r.carModel),
    doors: num(r.doors),
    passengers: num(r.passengers),
    bags: num(r.bags),
    trans: str(r.trans),
    air: bool(r.air),
    kmIncluded: str(r.km_included),
    base: Money.fromMajor(num(r.baseAprox), currency),
    tax: Money.fromMajor(num(r.taxAprox), currency),
  };
  if (convertedCurrency && r.convertedRateAmount !== undefined) {
    offer.convertedRateAmount = Money.fromMajor(num(r.convertedRateAmount), convertedCurrency);
  }
  if (r.ccrc) offer.ccrc = str(r.ccrc);
  return offer;
}

// ──────────── GetSelection ────────────
// La respuesta real de get-selection es ANIDADA:
//   { uniqid, carInfo: { <SIPP>: {...} }, rates: { <rateId>: { ppd?: {...}, pod?: {...} } }, currency }
// El auto vive en carInfo[SIPP] y el precio en rates[rateId][ppd|pod].

interface RawSelectionCarInfo {
  sippCode?: string;
  doors?: number | string;
  passengers?: number | string;
  bags?: number | string;
  air_conditioner?: string | boolean;
  transmission?: string;
  categoryName?: string;
  companyCode?: string;
  companyName?: string;
  carModel?: string;
  km_included?: string;
}

interface RawSelectionRate {
  rateTypeId?: string;
  payment_option?: string;
  companyCode?: string;
  sippCode?: string;
  currency?: string;
  baseAprox?: number | string;
  taxAprox?: number | string;
  totalAprox?: number | string;
  amount?: number | string;
  convertedCurrency?: string;
  convertedTotalAprox?: number | string;
}

interface RawSelection {
  uniqid?: string;
  carInfo?: Record<string, RawSelectionCarInfo>;
  rates?: Record<string, Partial<Record<PaymentType, RawSelectionRate>>>;
  currency?: string;
}

export function mapSelection(raw: RawSelection): CarSelection {
  const carInfo = Object.values(raw.carInfo ?? {})[0];
  // Toma la primera tarifa; prefiere prepago (ppd) y cae a pago en destino (pod).
  const rateGroup = Object.values(raw.rates ?? {})[0] ?? {};
  const isPpd = rateGroup.ppd != null;
  const rate = rateGroup.ppd ?? rateGroup.pod;
  const rateId = Object.keys(raw.rates ?? {})[0] ?? str(rate?.rateTypeId);
  const currency = str(rate?.currency) || str(raw.currency) || 'USD';
  const convertedCurrency = str(rate?.convertedCurrency);
  const total = num(rate?.totalAprox ?? rate?.amount);

  const selection: CarSelection = {
    category: str(carInfo?.categoryName),
    sippCode: str(carInfo?.sippCode) || str(rate?.sippCode),
    companyCode: str(carInfo?.companyCode) || str(rate?.companyCode),
    companyName: str(carInfo?.companyName),
    rateAmount: Money.fromMajor(total, currency),
    paymentOption: isPpd ? 'ppd' : 'pod',
    carModel: str(carInfo?.carModel),
    doors: num(carInfo?.doors),
    passengers: num(carInfo?.passengers),
    bags: num(carInfo?.bags),
    trans: str(carInfo?.transmission),
    air: bool(carInfo?.air_conditioner),
    kmIncluded: str(carInfo?.km_included),
    base: Money.fromMajor(num(rate?.baseAprox), currency),
    tax: Money.fromMajor(num(rate?.taxAprox), currency),
    uniqid: str(raw.uniqid),
  };
  if (rateId) selection.rateCode = rateId;
  if (convertedCurrency && rate?.convertedTotalAprox !== undefined) {
    selection.convertedRateAmount = Money.fromMajor(
      num(rate.convertedTotalAprox),
      convertedCurrency,
    );
  }
  return selection;
}
