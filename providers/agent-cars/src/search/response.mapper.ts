import { Money } from '@sales-travel/canonical';
import type { CarOffer, CarSelection, PaymentType } from '../types.js';
import { bool, num, str } from '../internal/coerce.js';

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
  uniqid?: string;
}

export function mapMatrixOffers(raw: RawCarOffer[]): CarOffer[] {
  return raw.map(mapCarOffer);
}

export function mapSelection(raw: RawCarOffer): CarSelection {
  return {
    ...mapCarOffer(raw),
    uniqid: str(raw.uniqid),
  };
}

function mapCarOffer(r: RawCarOffer): CarOffer {
  const currency = str(r.currency) || 'USD';
  const convertedCurrency = str(r.convertedCurrency);

  return {
    category: str(r.category),
    sippCode: str(r.sippCode),
    companyCode: str(r.companyCode),
    companyName: str(r.companyName),
    rateAmount: Money.fromMajor(num(r.rateAmount), currency),
    paymentOption: mapPaymentOption(str(r.payment_option)),
    carModel: str(r.carModel),
    doors: num(r.doors),
    passengers: num(r.passengers),
    bags: num(r.bags),
    trans: str(r.trans),
    air: bool(r.air),
    kmIncluded: str(r.km_included),
    base: Money.fromMajor(num(r.baseAprox), currency),
    tax: Money.fromMajor(num(r.taxAprox), currency),
    ...(convertedCurrency &&
      r.convertedRateAmount !== undefined && {
        convertedRateAmount: Money.fromMajor(num(r.convertedRateAmount), convertedCurrency),
      }),
    ...(r.ccrc && { ccrc: str(r.ccrc) }),
  };
}

function mapPaymentOption(raw: string): PaymentType {
  return raw === 'pod' ? 'pod' : 'ppd';
}
