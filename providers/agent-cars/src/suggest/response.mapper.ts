import type { CarLocation } from '../types.js';
import { num, str } from '../internal/coerce.js';

interface RawSuggestItem {
  airport?: boolean;
  cityLoc?: boolean;
  countryCode?: string;
  hasoffice?: number | string;
  iata?: string;
  latitude?: number | string;
  longitude?: number | string;
  timezone?: string;
  value?: string;
}

export function mapSuggestResults(raw: RawSuggestItem[]): CarLocation[] {
  return raw.map(mapLocation);
}

function mapLocation(r: RawSuggestItem): CarLocation {
  return {
    airport: Boolean(r.airport),
    cityLoc: Boolean(r.cityLoc),
    countryCode: str(r.countryCode),
    hasOffice: num(r.hasoffice),
    iata: r.iata ?? undefined,
    latitude: num(r.latitude),
    longitude: num(r.longitude),
    timezone: str(r.timezone),
    value: str(r.value),
  };
}
