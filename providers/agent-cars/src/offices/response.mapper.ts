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
  schedule?: Record<string, RawScheduleDay>;
}

export function mapOffices(raw: RawOffice[]): CarOffice[] {
  return raw.map(mapOffice);
}

function mapOffice(r: RawOffice): CarOffice {
  const schedule: Record<string, OfficeScheduleDay> = {};
  for (const [day, s] of Object.entries(r.schedule ?? {})) {
    schedule[day] = { opening: str(s?.opening), close: str(s?.close) };
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
