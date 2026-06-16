'use server';

import { api } from '../../../../lib/api';

// ─────────────────────────── Tipos (espejo del contrato /cars/offices) ───────────────────────────

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

/** Valores del formulario de búsqueda de oficinas. */
export interface FindOfficesValues {
  /** Código ciudad IATA (mutuamente excluyente con coordenadas). */
  cityCode?: string;
  /** Coordenadas (mutuamente excluyente con cityCode). */
  lat?: number;
  lng?: number;
  /** Radio de búsqueda en millas. */
  distance: number;
  companyCode?: string;
  source?: string;
}

export interface FindOfficesResult {
  ok: boolean;
  offices: CarOffice[];
  error?: string;
}

function validValues(v: FindOfficesValues): string | null {
  if (!Number.isFinite(v.distance) || v.distance <= 0) {
    return 'Ingresá una distancia válida (en millas).';
  }
  const hasCoords = v.lat != null && v.lng != null;
  const hasCity = !!v.cityCode && v.cityCode.trim().length > 0;
  if (!hasCoords && !hasCity) {
    return 'Indicá un código de ciudad (IATA) o coordenadas (lat y lng).';
  }
  if (v.source && !/^[A-Za-z]{2}$/.test(v.source)) {
    return 'El país origen debe ser un código de 2 letras (ej: CO).';
  }
  return null;
}

/** Busca oficinas de renta cercanas a una ciudad (IATA) o coordenadas. */
export async function findOfficesAction(values: FindOfficesValues): Promise<FindOfficesResult> {
  const error = validValues(values);
  if (error) return { ok: false, offices: [], error };

  const qs = new URLSearchParams();
  qs.set('distance', String(values.distance));
  if (values.cityCode && values.cityCode.trim()) {
    qs.set('cityCode', values.cityCode.trim());
  } else if (values.lat != null && values.lng != null) {
    qs.set('lat', String(values.lat));
    qs.set('lng', String(values.lng));
  }
  if (values.companyCode && values.companyCode.trim()) {
    qs.set('companyCode', values.companyCode.trim());
  }
  if (values.source && values.source.trim()) {
    qs.set('source', values.source.trim().toUpperCase());
  }

  const res = await api<{ offices: CarOffice[] }>(`/cars/offices?${qs.toString()}`);
  if (!res.ok) return { ok: false, offices: [], error: res.error.message };
  return { ok: true, offices: res.data.offices };
}
