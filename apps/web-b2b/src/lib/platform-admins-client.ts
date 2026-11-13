import {
  parseChangeRequest,
  parseChangeRequests,
  parsePlatformAdmins,
  parseViewer,
  type ChangeRequest,
  type ChangeRequestAction,
  type ChangeRequestStatus,
  type PlatformAdmin,
  type PlatformViewer,
} from './platform-admins';
import { readJson } from './read-json';
import { reasonOf, withStepUp, type StepUpAware, type StepUpCancelled } from './step-up';

/**
 * Las llamadas del navegador a Plataforma → Superadmins (`/api/admin/platform-admins`,
 * `/api/admin/change-requests`). Cada una devuelve datos validados o un mensaje; nunca lanza. Las
 * que cambian algo pasan por `withStepUp`: el API pide el 2FA de los últimos minutos.
 */

const UNREADABLE = 'El servidor respondió algo que no pudimos leer. Recarga la página.';
const OFFLINE = 'No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.';

/** Lo pidió un supervisado: quedó como solicitud (409 del API). */
export const CHANGE_REQUEST_PENDING = 'CHANGE_REQUEST_PENDING';

function errorOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const e = (body as Record<string, unknown>)['error'];
  return typeof e === 'string' && e.trim() !== '' ? e : undefined;
}

export function platformAdminsErrorMessage(status: number, message: string | undefined): string {
  if (status === 401) return 'Tu sesión venció. Vuelve a iniciar sesión.';
  if (message !== undefined) return message;
  if (status === 403) return 'Sólo un superadmin puede ver y cambiar esto.';
  return 'No se pudo completar. Inténtalo de nuevo.';
}

async function call<T>(
  url: string,
  init: RequestInit,
  parse: (value: unknown) => T | undefined,
): Promise<StepUpAware<T>> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store', ...init });
  } catch {
    return { ok: false, message: OFFLINE };
  }
  const read = await readJson<unknown>(res);
  if (!read.ok) return { ok: false, message: read.message };
  if (!res.ok) {
    const reason = reasonOf(read.data);
    return {
      ok: false,
      message: platformAdminsErrorMessage(res.status, errorOf(read.data)),
      ...(reason !== undefined ? { reason } : {}),
    };
  }
  const data = parse(read.data);
  return data === undefined ? { ok: false, message: UNREADABLE } : { ok: true, data };
}

function json(method: 'POST' | 'PUT', body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

type Mutation<T> = Promise<StepUpAware<T> | StepUpCancelled>;

export function loadPlatformAdmins(): Promise<StepUpAware<PlatformAdmin[]>> {
  return call('/api/admin/platform-admins', {}, parsePlatformAdmins);
}

export function loadViewer(): Promise<StepUpAware<PlatformViewer>> {
  return call('/api/admin/platform-admins/me', {}, parseViewer);
}

export function loadChangeRequests(
  status: ChangeRequestStatus | null,
): Promise<StepUpAware<ChangeRequest[]>> {
  const query = status === null ? '' : `?status=${status}`;
  return call(`/api/admin/change-requests${query}`, {}, parseChangeRequests);
}

export function grantPlatformAdmin(input: {
  email: string;
  supervised: boolean;
  reason: string;
  /** Sin cuenta con ese correo: crearla y enviarle el correo para activar su acceso. */
  createAccount?: boolean;
  name?: string;
}): Mutation<PlatformAdmin[]> {
  return withStepUp(() =>
    call('/api/admin/platform-admins', json('POST', input), parsePlatformAdmins),
  );
}

export function setSupervision(
  userId: string,
  supervised: boolean,
  reason: string,
): Mutation<PlatformAdmin[]> {
  return withStepUp(() =>
    call(
      `/api/admin/platform-admins/${encodeURIComponent(userId)}/supervision`,
      json('PUT', { supervised, reason }),
      parsePlatformAdmins,
    ),
  );
}

export function revokePlatformAdmin(userId: string, reason: string): Mutation<PlatformAdmin[]> {
  return withStepUp(() =>
    call(
      `/api/admin/platform-admins/${encodeURIComponent(userId)}/revoke`,
      json('POST', { reason }),
      parsePlatformAdmins,
    ),
  );
}

export function decideChangeRequest(
  id: string,
  action: ChangeRequestAction,
  note: string,
): Mutation<ChangeRequest> {
  return withStepUp(() =>
    call(
      `/api/admin/change-requests/${encodeURIComponent(id)}/${action}`,
      json('POST', action === 'cancel' ? {} : { note }),
      parseChangeRequest,
    ),
  );
}
