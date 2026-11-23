'use server';

import { api } from '../../../lib/api';
import { hotelContentAction } from '../hoteles/[hotelKey]/actions';
import { suggestDestinationsAction, type GeoSuggestion } from '../hoteles/actions';
import { plainDescription, type PackageItemPayload } from './_components/package-model';

/**
 * Lecturas y escrituras de la sección «Paquetes» contra `/packages` del API. Las búsquedas NO
 * viven acá: la pantalla reutiliza las acciones de vuelos, hoteles y autos, cada una con su cuota,
 * caché, circuit breaker y pricing ya resueltos (docs/platform/20-paquetes.md).
 */

export interface PackageSearchCriteria {
  origin?: string;
  originLabel?: string;
  destination?: string;
  destinationLabel?: string;
  departureDate: string;
  returnDate: string;
  rooms: { adults: number; childrenAges: number[] }[];
  includes?: string[];
}

export interface PackageSummary {
  id: string;
  /** `draft`, `sent`, `accepted` o `expired`. */
  status: string;
  title: string;
  totalAmountMinor: number;
  currency: string;
  customerId: string | null;
  notes: string | null;
  searchCriteria: PackageSearchCriteria | null;
  showBreakdown: boolean;
  expiresAt: string;
  createdAt: string;
}

export interface PackageItem {
  id: string;
  vertical: string;
  providerName: string;
  providerItemId: string;
  details: unknown;
  position: number;
  baseFareMinor: number;
  taxesMinor: number;
  totalMinor: number;
}

export interface CreatePackageInput {
  title: string;
  currency: string;
  searchCriteria: PackageSearchCriteria;
  items: PackageItemPayload[];
  notes?: string;
}

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

export async function createPackageAction(
  input: CreatePackageInput,
): Promise<ActionResult<{ id: string }>> {
  if (input.items.length === 0) return { ok: false, error: 'Elige al menos un servicio.' };
  const res = await api<{ package: PackageSummary }>('/packages', {
    method: 'POST',
    body: JSON.stringify({
      title: input.title.slice(0, 200),
      currency: input.currency,
      searchCriteria: input.searchCriteria,
      items: input.items,
      ...(input.notes ? { notes: input.notes } : {}),
    }),
  });
  return res.ok
    ? { ok: true, data: { id: res.data.package.id } }
    : { ok: false, error: res.error.message };
}

export async function getPackageAction(
  id: string,
): Promise<ActionResult<{ package: PackageSummary; items: PackageItem[] }>> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, error: 'Paquete no encontrado.' };
  const res = await api<{ package: PackageSummary; items: PackageItem[] }>(`/packages/${id}`);
  return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error.message };
}

export async function listPackagesAction(): Promise<ActionResult<PackageSummary[]>> {
  const res = await api<{ packages: PackageSummary[] }>('/packages');
  return res.ok ? { ok: true, data: res.data.packages } : { ok: false, error: res.error.message };
}

export async function updatePackageAction(
  id: string,
  patch: {
    title?: string;
    notes?: string | null;
    status?: 'draft' | 'sent' | 'accepted';
    showBreakdown?: boolean;
  },
): Promise<ActionResult<PackageSummary>> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, error: 'Paquete no encontrado.' };
  const res = await api<{ package: PackageSummary }>(`/packages/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return res.ok ? { ok: true, data: res.data.package } : { ok: false, error: res.error.message };
}

export async function addPackageItemAction(
  id: string,
  item: PackageItemPayload,
): Promise<ActionResult<PackageSummary>> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, error: 'Paquete no encontrado.' };
  const res = await api<{ package: PackageSummary }>(`/packages/${id}/items`, {
    method: 'POST',
    body: JSON.stringify(item),
  });
  return res.ok ? { ok: true, data: res.data.package } : { ok: false, error: res.error.message };
}

export async function removePackageItemAction(
  id: string,
  itemId: string,
): Promise<ActionResult<PackageSummary>> {
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f-]{36}$/i.test(itemId)) {
    return { ok: false, error: 'Servicio no encontrado.' };
  }
  const res = await api<{ package: PackageSummary }>(`/packages/${id}/items/${itemId}`, {
    method: 'DELETE',
  });
  return res.ok ? { ok: true, data: res.data.package } : { ok: false, error: res.error.message };
}

/**
 * El destino de hotel que corresponde a la ciudad del aeropuerto de llegada. No hay mapeo
 * IATA → ciudad de hotel, así que se busca por el nombre de la ciudad y se prefiere una del mismo
 * país. La pantalla lo muestra para que el vendedor lo confirme o lo cambie (Rionegro/Medellín).
 */
export async function resolveHotelDestinationAction(
  city: string,
  countryName?: string,
): Promise<GeoSuggestion | null> {
  const res = await suggestDestinationsAction(city);
  if (res.items.length === 0) return null;
  const norm = (s: string | undefined) =>
    (s ?? '')
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase();
  const sameCountry = countryName
    ? res.items.find(
        (i) => norm(i.country) === norm(countryName) || norm(i.display).includes(norm(countryName)),
      )
    : undefined;
  return sameCountry ?? res.items[0] ?? null;
}

/** Galería y descripción del hotel elegido, para la cotización. Lo que falle queda vacío. */
export async function hotelGalleryAction(
  hotelKey: string,
): Promise<{ images: string[]; description?: string }> {
  try {
    const res = await hotelContentAction(hotelKey);
    const content = res.outcomes.find((o) => o.content)?.content;
    if (!content) return { images: [] };
    const description = plainDescription(content.descriptionHtml);
    return {
      images: content.images.slice(0, 6),
      ...(description ? { description } : {}),
    };
  } catch {
    return { images: [] };
  }
}
