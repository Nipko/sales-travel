import type { CarOffice, OfficeScheduleDay } from '../types.js';
import { num, str } from '../internal/coerce.js';

interface RawScheduleDay {
  opening?: string;
  close?: string;
}

interface RawOffice {
  office_code?: string;
  company_code?: string;
  company_name?: string;
  address?: string;
  city_name?: string;
  state?: string;
  country_code?: string;
  lat?: number | string;
  lng?: number | string;
  zip_code?: string;
  distance?: number | string;
  // El schedule puede venir como objeto por día { "1": {opening,close} } o como array por día
  // { "1": [{opening,close}] } (igual que el suggest). Se tolera ambas formas.
  schedule?: Record<string, RawScheduleDay | RawScheduleDay[]>;
}

/**
 * find-offices puede devolver un array plano de oficinas, o un objeto (indexado / agrupado /
 * envuelto), igual que get-matrix. Se aplana defensivamente con Object.values para no romper
 * con `raw.map is not a function`.
 */
export function mapOffices(raw: unknown): CarOffice[] {
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? Object.values(raw as Record<string, unknown>).flat()
      : [];
  return list.filter((o): o is RawOffice => o != null && typeof o === 'object').map(mapOffice);
}

function mapOffice(r: RawOffice): CarOffice {
  const schedule: Record<string, OfficeScheduleDay> = {};
  for (const [day, s] of Object.entries(r.schedule ?? {})) {
    const entry = Array.isArray(s) ? s[0] : s;
    schedule[day] = { opening: str(entry?.opening), close: str(entry?.close) };
  }
  return {
    officeCode: str(r.office_code),
    companyCode: str(r.company_code),
    companyName: str(r.company_name),
    address: str(r.address),
    cityName: str(r.city_name),
    state: str(r.state),
    countryCode: str(r.country_code),
    lat: num(r.lat),
    lng: num(r.lng),
    zipCode: str(r.zip_code),
    distance: num(r.distance),
    schedule,
  };
}
