import type { CarSearchQuery, CarSelectionQuery } from '../types.js';

type QueryParams = Record<string, string | number | undefined>;

export function buildMatrixParams(q: CarSearchQuery): QueryParams {
  return {
    pickUpLocation: q.pickUpLocation,
    dropOffLocation: q.dropOffLocation,
    pickUpDate: q.pickUpDate,
    dropOffDate: q.dropOffDate,
    pickUpHour: q.pickUpHour,
    dropOffHour: q.dropOffHour,
    rateType: q.rateType,
    country: q.country,
    source: q.source,
    ...(q.paymentType && { paymentType: q.paymentType }),
    ...(q.companyCode && { companyCode: q.companyCode }),
    ...(q.cdCode && { cdCode: q.cdCode }),
    ...(q.pcCode && { pcCode: q.pcCode }),
    ...(q.language && { language: q.language }),
    ...(q.lat !== undefined && { lat: q.lat }),
    ...(q.lng !== undefined && { lng: q.lng }),
    ...(q.latDropOff !== undefined && { latDropOff: q.latDropOff }),
    ...(q.lngDropOff !== undefined && { lngDropOff: q.lngDropOff }),
  };
}

export function buildSelectionParams(q: CarSelectionQuery): QueryParams {
  return {
    ...buildMatrixParams(q),
    companyCode: q.companyCode,
    sippCode: q.sippCode,
    ...(q.ccrc && { ccrc: q.ccrc }),
    ...(q.coupon && { coupon: q.coupon }),
    ...(q.tp && { tp: q.tp }),
  };
}
