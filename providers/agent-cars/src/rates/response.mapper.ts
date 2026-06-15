import type { RateType } from '../types.js';
import { str } from '../internal/coerce.js';

interface RawRateItem {
  id?: string | number;
  name?: string;
}

export function mapRates(raw: RawRateItem[]): RateType[] {
  return raw.map((r) => ({
    // El id puede llegar como número (ej: 123) o string; lo normalizamos a string.
    id: r.id == null ? '' : String(r.id),
    name: str(r.name),
  }));
}
