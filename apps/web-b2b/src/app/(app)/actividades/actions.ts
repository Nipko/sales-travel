'use server';

import { api } from '../../../lib/api';
import type {
  ActivitiesStatus,
  ActivityDetail,
  ActivityOffer,
  ActivityPackageItemInput,
  ActivitySummary,
  Participants,
} from './_components/activity-model';

type Result<T> = { ok: true; data: T } | { ok: false; error: string; status?: number };

function fail(status: number, message: string): { ok: false; error: string; status: number } {
  return { ok: false, error: message, status };
}

export async function activitiesStatusAction(): Promise<ActivitiesStatus> {
  const res = await api<ActivitiesStatus>('/activities/status');
  // Sin respuesta del API, la sección se muestra apagada: nunca se ofrece vender a ciegas.
  return res.ok ? res.data : { enabled: false };
}

export async function searchActivitiesAction(
  destination: string,
): Promise<Result<ActivitySummary[]>> {
  const code = destination.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    return fail(400, 'Elige un destino de la lista o escribe el código de la ciudad (p. ej. ORL).');
  }
  const res = await api<{ activities: ActivitySummary[] }>(
    `/activities/search?destination=${encodeURIComponent(code)}`,
  );
  if (!res.ok) return fail(res.error.status, res.error.message);
  return { ok: true, data: res.data.activities };
}

export async function modalitiesAction(id: string): Promise<Result<ActivityDetail>> {
  const res = await api<ActivityDetail>(`/activities/${encodeURIComponent(id)}/modalities`);
  if (!res.ok) return fail(res.error.status, res.error.message);
  return { ok: true, data: res.data };
}

export interface AvailabilityInput {
  activityId: string;
  modalityId: string;
  date: string;
  participants: Participants;
  schedule?: string;
  currency?: string;
}

export async function availabilityAction(input: AvailabilityInput): Promise<Result<ActivityOffer>> {
  const res = await api<{ offer: ActivityOffer }>('/activities/availability', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!res.ok) return fail(res.error.status, res.error.message);
  return { ok: true, data: res.data.offer };
}

export interface PrebookOutcome {
  prebookId: string;
  expiresAt?: string;
  total?: { amountMinor: number; currency: string };
  exchangePolicies: {
    title?: string;
    conditions: { title?: string; answers: { question?: string; answer?: string }[] }[];
    disclaimers: { title?: string; description?: string }[];
    summaries: { title?: string; description?: string }[];
  }[];
  hints: { requirements: string[] }[];
  currentAccountAvailable: boolean;
}

export async function prebookAction(choiceId: string): Promise<Result<PrebookOutcome>> {
  const res = await api<PrebookOutcome>('/activities/prebook', {
    method: 'POST',
    body: JSON.stringify({ choiceId }),
  });
  if (!res.ok) return fail(res.error.status, res.error.message);
  return { ok: true, data: res.data };
}

export interface TravelerInput {
  firstName: string;
  lastName: string;
  birthDate: string;
  nationality?: string;
  identification?: { type: 'LOCAL' | 'PASSPORT'; number: string };
}

export interface BookInput {
  prebookId: string;
  offer: {
    choiceId: string;
    activityId: string;
    modalityId?: string;
    name: string;
    modalityName?: string;
    category: 'ticket' | 'tour';
    date: string;
    startAt?: string;
    currency: string;
    netMinor: number;
  };
  contact: { email: string };
  travelers: TravelerInput[];
}

export interface BookOutcome {
  reservationId: string;
  status: 'SUCCESS' | 'PROCESSING';
  pnr?: string;
  recorded: boolean;
  saleMinor: number;
  currency: string;
}

export async function bookActivityAction(input: BookInput): Promise<Result<BookOutcome>> {
  const res = await api<BookOutcome>('/activities/book', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!res.ok) return fail(res.error.status, res.error.message);
  return { ok: true, data: res.data };
}

export interface ActivityReservation {
  productId: string;
  status: string;
  pnr?: string;
  useDate?: string;
  voucherUrl?: string;
  passengers: { type?: string; firstName?: string; lastName?: string }[];
}

export async function reservationAction(
  reservationId: string,
): Promise<Result<ActivityReservation>> {
  const res = await api<ActivityReservation>(
    `/activities/reservations/${encodeURIComponent(reservationId)}`,
  );
  if (!res.ok) return fail(res.error.status, res.error.message);
  return { ok: true, data: res.data };
}

// ───────────────────────── Paquetes ─────────────────────────

export interface PackageOption {
  id: string;
  title: string;
  currency: string;
  status?: string;
}

/** Los paquetes en borrador de la agencia, para elegir a cuál agregar la actividad. */
export async function draftPackagesAction(): Promise<Result<PackageOption[]>> {
  const res = await api<{ items?: PackageOption[]; packages?: PackageOption[] } | PackageOption[]>(
    '/packages',
  );
  if (!res.ok) return fail(res.error.status, res.error.message);
  const list = Array.isArray(res.data) ? res.data : (res.data.items ?? res.data.packages ?? []);
  return {
    ok: true,
    data: list.filter((p) => p.status === undefined || p.status === 'draft'),
  };
}

/**
 * Agrega la actividad a un paquete con el contrato de Paquetes (`vertical: 'activities'`,
 * `providerName: 'despegar-activities'`). Una moneda distinta a la del paquete la rechaza el API
 * con 409.
 */
export async function addActivityToPackageAction(
  packageId: string,
  item: ActivityPackageItemInput,
): Promise<Result<{ id: string }>> {
  if (!/^[0-9a-f-]{36}$/i.test(packageId)) return fail(400, 'Paquete inválido.');
  const res = await api<unknown>(`/packages/${packageId}/items`, {
    method: 'POST',
    body: JSON.stringify(item),
  });
  if (!res.ok) return fail(res.error.status, res.error.message);
  return { ok: true, data: { id: packageId } };
}
